import { revalidatePath } from 'next/cache'
import { currentUser } from '@/lib/auth'
import { extractPacket } from '@/lib/packet-extract'
import {
  createComponentFromPacket,
  markPageRegistered,
  packetPageKey,
  uploadPacketPageImage,
} from '@/lib/packets'
import { registerPage } from '@/lib/matcher'

export const dynamic = 'force-dynamic'
// Whole packets arrive as one multipart POST (client downscales to ~2000px
// JPEG per page first, so 12 pages stay well under this).
export const maxDuration = 120

const MAX_PAGES = 12
const MAX_BYTES = 8 * 1024 * 1024

// 拍照录入 — the programmer photographs every page of the printed packet and
// walks away. Everything else (extraction, component creation, route sizing,
// QR mint, matcher registration) happens here in one shot.
export async function POST(req: Request): Promise<Response> {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let files: File[]
  try {
    const fd = await req.formData()
    files = fd.getAll('images').filter((f): f is File => f instanceof File)
  } catch {
    return Response.json({ ok: false, error: 'bad form data' }, { status: 400 })
  }
  if (files.length === 0) {
    return Response.json({ ok: false, error: '没有照片' }, { status: 400 })
  }
  if (files.length > MAX_PAGES) files = files.slice(0, MAX_PAGES)

  const pages: { bytes: Uint8Array; contentType: string }[] = []
  for (const f of files) {
    if (f.size > MAX_BYTES) {
      return Response.json({ ok: false, error: '单张照片超过 8MB' }, { status: 400 })
    }
    pages.push({
      bytes: new Uint8Array(await f.arrayBuffer()),
      contentType: f.type || 'image/jpeg',
    })
  }

  const packetId = `pk_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`

  try {
    // 1. Originals into the bucket first — photos are the ground truth; if
    // extraction hiccups the images are already safe and retryable.
    const pageKeys = await Promise.all(
      pages.map(async (p, i) => {
        const key = packetPageKey(packetId, i)
        await uploadPacketPageImage(key, p.bytes, p.contentType)
        return key
      }),
    )

    // 2. Photos → structured component (Gemini reads the stamp + CNC sheets).
    const extract = await extractPacket(
      pages.map((p) => ({
        mimeType: p.contentType,
        data: Buffer.from(p.bytes).toString('base64'),
      })),
    )

    // 3. Component + route + QR token + page index rows.
    const result = await createComponentFromPacket({
      extract,
      pageKeys,
      packetId,
      createdBy: user.name,
    })

    // 4. Register only the 2D drawing with the matcher. CNC program sheets
    // remain stored as packet source material, but must never identify a part
    // in the worker-facing photo matcher.
    await Promise.all(
      result.pageIds.map(async (pageId, i) => {
        const kind = extract.pages.find((pg) => pg.index === i)?.kind
        if (kind !== 'drawing') return
        const ok = await registerPage({
          pageId,
          partId: result.partId,
          kind,
          bytes: pages[i].bytes,
          contentType: pages[i].contentType,
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
      name: extract.name,
      partNo: extract.partNo,
      qty: extract.qty,
      opCount: extract.opCount,
      dueDate: extract.dueDate,
      attached: result.attached,
    })
  } catch (err) {
    console.error('[packet-ingest] failed:', err)
    return Response.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : (() => {
                try {
                  return JSON.stringify(err)
                } catch {
                  return String(err)
                }
              })() || '录入失败',
      },
      { status: 500 },
    )
  }
}
