import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import {
  createParsingJob,
  fillParsedJob,
  markJobFailed,
  setPartImageUrlDirect,
  updateJob,
  type NewJobInput,
} from '@/lib/db'
import { canEditProductionFields, currentUser } from '@/lib/auth'
import { uploadSourceFile } from '@/lib/source-file'
import { extractWorkbookImages } from '@/lib/xlsx-images'
import { uploadComponentImage, MAX_IMAGE_BYTES } from '@/lib/component-image'
import { today } from '@/lib/today'
import { errMessage } from '@/lib/err'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/*
 * 清单导入 step 2 — commit the hand-mapped rows as a normal import draft.
 *
 * Deliberately lands in the SAME place the AI import lands: a `draft` job on
 * /import/[id], with the full review machinery (工号 collision caution, stage
 * chips, batch photo uploader, 发往工段) — 确认导入 is still the only gate
 * onto the board. This route is fillParsedJob without the Gemini step.
 *
 * Images: the client re-sends the original workbook and each mapped row's
 * `imageRef` (from the parse step's `<<IMG:ref>>` markers); we re-extract the
 * bytes here and upload them AFTER responding, exactly like /api/ingest —
 * the review page picks thumbnails up progressively via revalidate. Rows
 * pasted from a web table may instead carry a small `imageDataUri`.
 */

const MAX_COMPONENTS = 500
const IMAGE_UPLOAD_CONCURRENCY = 8

type CommitComponent = {
  name?: unknown
  qty?: unknown
  material?: unknown
  surfaceTreatment?: unknown
  process?: unknown
  partNo?: unknown
  notes?: unknown
  unitPriceCny?: unknown
  lineTotalCny?: unknown
  imageRef?: unknown
  imageDataUri?: unknown
}

type CommitPayload = {
  jobNo?: unknown
  customer?: unknown
  product?: unknown
  amountCny?: unknown
  dueDate?: unknown
  notes?: unknown
  components?: unknown
}

function asText(v: unknown, max = 2000): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function asOptText(v: unknown, max = 2000): string | undefined {
  const s = asText(v, max)
  return s ? s : undefined
}

function asMoney(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined
}

export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user || !canEditProductionFields(user)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let payload: CommitPayload
  let file: File | null = null
  try {
    const form = await request.formData()
    payload = JSON.parse(String(form.get('payload') ?? '{}')) as CommitPayload
    const f = form.get('file')
    if (f instanceof File) file = f
  } catch (err) {
    return Response.json(
      { ok: false, error: `payload: ${errMessage(err)}` },
      { status: 400 },
    )
  }

  const jobNo = asText(payload.jobNo, 120)
  if (!jobNo) {
    return Response.json({ ok: false, error: '缺少工号' }, { status: 400 })
  }
  const rawComponents = Array.isArray(payload.components)
    ? (payload.components as CommitComponent[])
    : []
  const components = rawComponents
    .slice(0, MAX_COMPONENTS)
    .map((c) => {
      const qtyN = typeof c.qty === 'number' && Number.isFinite(c.qty) ? c.qty : 1
      return {
        name: asText(c.name, 300),
        qty: Math.max(1, Math.round(qtyN)),
        material: asOptText(c.material, 300),
        surfaceTreatment: asOptText(c.surfaceTreatment, 300),
        process: asOptText(c.process, 300),
        partNo: asOptText(c.partNo, 300),
        notes: asOptText(c.notes),
        unitPriceCny: asMoney(c.unitPriceCny),
        lineTotalCny: asMoney(c.lineTotalCny),
        imageRef: asOptText(c.imageRef, 40),
        imageDataUri:
          typeof c.imageDataUri === 'string' &&
          c.imageDataUri.startsWith('data:image/') &&
          c.imageDataUri.length < MAX_IMAGE_BYTES
            ? c.imageDataUri
            : undefined,
      }
    })
    .filter((c) => c.name)
  if (components.length === 0) {
    return Response.json({ ok: false, error: '没有可导入的零件行' }, { status: 400 })
  }

  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(asText(payload.dueDate, 10))
    ? asText(payload.dueDate, 10)
    : today()
  const sourceFileName = file?.name

  const job = await createParsingJob({
    sourceFile: sourceFileName ?? '清单导入（粘贴）',
  })

  try {
    if (file) {
      // Non-fatal, same policy as /api/ingest — the mapped rows are the value.
      try {
        const buf = await file.arrayBuffer()
        const url = await uploadSourceFile({
          jobId: job.id,
          buf,
          fileName: file.name,
          contentType: file.type,
        })
        await updateJob(job.id, { sourceFileUrl: url })
      } catch (err) {
        console.error('[qingdan/commit] source-file upload failed', err)
      }
    }

    const input: NewJobInput = {
      jobNo,
      customer: asText(payload.customer, 200),
      product: asText(payload.product, 200) || '—',
      amountCny: asMoney(payload.amountCny),
      dueDate,
      notes: asOptText(payload.notes),
      components: components.map(
        ({ imageRef: _r, imageDataUri: _d, ...rest }) => rest,
      ),
    }
    await fillParsedJob(job.id, input)
  } catch (err) {
    const message = errMessage(err)
    console.error('[qingdan/commit] fill failed', { jobId: job.id, message })
    await markJobFailed(job.id, message)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }

  // Image attachment — BEFORE the response. The user just SAW these 图纸 in
  // the mapping workspace; landing them on a review page with empty frames
  // that fill in later reads as "my images vanished". Uploads run chunked at
  // concurrency 8, which fits comfortably inside maxDuration on the VM.
  const wantsFileImages = components.some((c) => c.imageRef)
  const fileForImages = wantsFileImages ? file : null
  {
    try {
      const pending: { partIndexes: number[]; bytes: Uint8Array; mime: string; name: string }[] = []

      if (fileForImages) {
        const buf = await fileForImages.arrayBuffer()
        const { images } = extractWorkbookImages(buf)
        // Excel/WPS store a copy-pasted picture once and anchor it in many
        // rows, so one ref can belong to several parts. Upload the bytes once
        // and stamp the URL onto every row in the group — same policy as the
        // AI import.
        const groupByRef = new Map<string, number[]>()
        components.forEach((c, i) => {
          if (!c.imageRef) return
          const img = images.get(c.imageRef)
          if (!img) return
          const group = groupByRef.get(c.imageRef)
          if (group) group.push(i)
          else {
            const fresh = [i]
            groupByRef.set(c.imageRef, fresh)
            pending.push({
              partIndexes: fresh,
              bytes: img.bytes,
              mime: img.mime,
              name: `${c.imageRef}.${img.ext}`,
            })
          }
        })
      }

      components.forEach((c, i) => {
        if (!c.imageDataUri) return
        const m = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i.exec(c.imageDataUri)
        if (!m) return
        try {
          pending.push({
            partIndexes: [i],
            bytes: new Uint8Array(Buffer.from(m[2], 'base64')),
            mime: m[1].toLowerCase(),
            name: `paste-${i + 1}`,
          })
        } catch {
          // bad base64 — skip this row's image
        }
      })

      for (let i = 0; i < pending.length; i += IMAGE_UPLOAD_CONCURRENCY) {
        const chunk = pending.slice(i, i + IMAGE_UPLOAD_CONCURRENCY)
        await Promise.all(
          chunk.map(async ({ partIndexes, bytes, mime, name }) => {
            const componentId = `p${partIndexes[0] + 1}`
            // One retry — a transient storage hiccup shouldn't cost a 图纸
            // the user already delivered inside the workbook.
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const imageUrl = await uploadComponentImage({
                  jobId: job.id,
                  componentId,
                  bytes,
                  mime,
                  fallbackName: name,
                  skipStaleCheck: true,
                })
                for (const partIndex of partIndexes) {
                  await setPartImageUrlDirect(`${job.id}:p${partIndex + 1}`, imageUrl)
                }
                return
              } catch (err) {
                if (attempt === 1) {
                  console.error('[qingdan/commit] image upload failed', {
                    jobId: job.id,
                    componentId,
                    err: errMessage(err),
                  })
                }
              }
            }
          }),
        )
        revalidatePath(`/import/${job.id}`)
      }
    } catch (err) {
      // Non-fatal — the draft is committed; the review page's uploaders can
      // fill any photo the pass dropped.
      console.error('[qingdan/commit] image pass failed', {
        jobId: job.id,
        err: errMessage(err),
      })
    }
  }

  revalidatePath('/')
  revalidatePath(`/import/${job.id}`)
  return Response.json({ ok: true, jobId: job.id })
}
