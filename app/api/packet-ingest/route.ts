import { revalidatePath } from 'next/cache'
import { currentUser } from '@/lib/auth'
import { TRACKING_STAGES, type Stage } from '@/lib/data'
import { fallbackDueDate } from '@/lib/gemini'
import { extractPacket, type PacketExtract } from '@/lib/packet-extract'
import {
  createComponentFromPacket,
  markPageRegistered,
  packetPageKey,
  uploadPacketPageImage,
} from '@/lib/packets'
import { registerPage } from '@/lib/matcher'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const MAX_PAGES = 12
const MAX_BYTES = 8 * 1024 * 1024
const OP_STAGES = TRACKING_STAGES.filter(
  (stage) => stage !== '丝印' && stage !== '检验',
)

type PageBytes = { bytes: Uint8Array; contentType: string }
type ReviewDraft = PacketExtract & { completedStage?: Stage }

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length > 0 ? text : undefined
}

function reviewStages(opCount: number, includeMilling: boolean): Stage[] {
  return [
    ...OP_STAGES.slice(0, opCount),
    ...(includeMilling ? (['丝印'] as Stage[]) : []),
    '检验',
  ]
}

function normalizeDraft(value: unknown, pageCount: number): ReviewDraft {
  if (!value || typeof value !== 'object') throw new Error('核对内容格式不正确')
  const raw = value as Record<string, unknown>
  const name = clean(raw.name)
  if (!name) throw new Error('请填写零件名称')

  const qty = Math.max(1, Math.min(1_000_000, Math.floor(Number(raw.qty) || 1)))
  const opCount = Math.max(1, Math.min(6, Math.floor(Number(raw.opCount) || 1)))
  const includeMilling = raw.includeMilling !== false
  const dueDate = clean(raw.dueDate) ?? fallbackDueDate()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new Error('交期格式不正确')

  const rawPages = Array.isArray(raw.pages) ? raw.pages : []
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const page = rawPages.find(
      (candidate) =>
        candidate &&
        typeof candidate === 'object' &&
        Number((candidate as Record<string, unknown>).index) === index,
    ) as Record<string, unknown> | undefined
    const rawKind = page?.kind
    const kind: 'drawing' | 'program' | 'other' =
      rawKind === 'drawing' || rawKind === 'program' || rawKind === 'other'
        ? rawKind
        : 'other'
    const rawOpNo = Number(page?.opNo)
    return {
      index,
      kind,
      opNo:
        Number.isFinite(rawOpNo) && rawOpNo > 0
          ? Math.min(6, Math.floor(rawOpNo))
          : undefined,
    }
  })

  const requestedStage = clean(raw.completedStage) as Stage | undefined
  const completedStage =
    requestedStage && reviewStages(opCount, includeMilling).includes(requestedStage)
      ? requestedStage
      : undefined

  return {
    partNo: clean(raw.partNo),
    name,
    drawingNo: clean(raw.drawingNo),
    qty,
    dueDate,
    material: clean(raw.material),
    customer: clean(raw.customer),
    opCount,
    includeMilling,
    pages,
    notes: clean(raw.notes),
    completedStage,
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    const candidate = err as { message?: unknown; error_description?: unknown }
    if (typeof candidate.message === 'string') return candidate.message
    if (typeof candidate.error_description === 'string') return candidate.error_description
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err || '录入失败')
}

async function readPages(fd: FormData): Promise<PageBytes[]> {
  let files = fd.getAll('images').filter((file): file is File => file instanceof File)
  if (files.length === 0) throw new Error('没有照片')
  if (files.length > MAX_PAGES) files = files.slice(0, MAX_PAGES)

  const pages: PageBytes[] = []
  for (const file of files) {
    if (file.size > MAX_BYTES) throw new Error('单张照片超过 8MB')
    pages.push({
      bytes: new Uint8Array(await file.arrayBuffer()),
      contentType: file.type || 'image/jpeg',
    })
  }
  return pages
}

// Two explicit phases:
//   extract — Gemini only; no DB/storage writes, so abandoning review is clean.
//   commit  — uploads originals and creates the user-confirmed live job.
export async function POST(req: Request): Promise<Response> {
  const user = await currentUser()
  if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  try {
    const fd = await req.formData()
    const action = String(fd.get('action') ?? 'extract')
    const pages = await readPages(fd)

    if (action === 'extract') {
      const extract = await extractPacket(
        pages.map((page) => ({
          mimeType: page.contentType,
          data: Buffer.from(page.bytes).toString('base64'),
        })),
      )
      const dueDateEstimated = !extract.dueDate
      return Response.json({
        ok: true,
        draft: {
          ...extract,
          dueDate: extract.dueDate ?? fallbackDueDate(),
          includeMilling: true,
        },
        dueDateEstimated,
      })
    }

    if (action !== 'commit') {
      return Response.json({ ok: false, error: 'unknown action' }, { status: 400 })
    }

    const rawDraft = fd.get('draft')
    if (typeof rawDraft !== 'string') throw new Error('缺少核对内容')
    const draft = normalizeDraft(JSON.parse(rawDraft), pages.length)
    const packetId = `pk_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`

    const pageKeys = await Promise.all(
      pages.map(async (page, index) => {
        const key = packetPageKey(packetId, index)
        await uploadPacketPageImage(key, page.bytes, page.contentType)
        return key
      }),
    )

    const result = await createComponentFromPacket({
      extract: draft,
      pageKeys,
      packetId,
      createdBy: user.name,
      completedStage: draft.completedStage,
    })

    // Matcher registration stays best-effort. Every uploaded photo becomes a
    // valid reference for this part; later photos can match drawings, program
    // sheets, labels, products, fixtures, or any other enrolled view.
    await Promise.all(
      result.pageIds.map(async (pageId, index) => {
        const kind = draft.pages.find((page) => page.index === index)?.kind ?? 'other'
        const ok = await registerPage({
          pageId,
          partId: result.partId,
          kind,
          bytes: pages[index].bytes,
          contentType: pages[index].contentType,
        })
        if (ok) await markPageRegistered(pageId)
      }),
    )

    revalidatePath('/')
    revalidatePath(`/jobs/${result.jobId}`)
    return Response.json({
      ok: true,
      jobId: result.jobId,
      jobNo: result.jobNo,
      name: draft.name,
      partNo: draft.partNo,
      qty: draft.qty,
      opCount: draft.opCount,
      dueDate: draft.dueDate,
      completedStage: draft.completedStage,
      attached: result.attached,
    })
  } catch (err) {
    console.error('[packet-ingest] failed:', err)
    return Response.json({ ok: false, error: errorMessage(err) }, { status: 500 })
  }
}
