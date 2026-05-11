import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { currentUser } from '@/lib/auth'
import {
  deleteProcessCard,
  getProcessCard,
  saveProcessCard,
  updateProcessCardBody,
  type StoredProcessCardSource,
} from '@/lib/db'
import {
  generateProcessCard,
  normalizeCard,
  PROCESS_CARD_MODEL,
  type SourceFile,
} from '@/lib/gemini-card'
import { supabase, STORAGE_BUCKET } from '@/lib/supabase'
import { proxiedKeyUrl } from '@/lib/storage-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Generation can take 20-60s on a 4-page PDF + a few images at thinking=high.
export const maxDuration = 120

const MAX_FILES = 12
const MAX_FILE_BYTES = 12 * 1024 * 1024 // 12 MB per file
// Gemini's inlineData path caps near 20 MB total. Stay under that for v0 —
// larger inputs would need the Files API upload path, which we'll add later.
const MAX_TOTAL_BYTES = 18 * 1024 * 1024
const ALLOWED = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
])

function safeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
}

function extFor(mime: string, fallback: string): string {
  if (mime === 'application/pdf') return 'pdf'
  if (mime === 'image/png') return 'png'
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/webp') return 'webp'
  const m = fallback.match(/\.([a-zA-Z0-9]+)$/)
  return m ? m[1].toLowerCase() : 'bin'
}

export async function GET(request: NextRequest) {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const jobId = request.nextUrl.searchParams.get('jobId')
  if (!jobId) {
    return Response.json({ ok: false, error: 'missing jobId' }, { status: 400 })
  }
  const stored = await getProcessCard(jobId)
  if (!stored) return Response.json({ ok: true, card: null })
  return Response.json({
    ok: true,
    card: { ...stored, card: normalizeCard(stored.card) },
  })
}

export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const form = await request.formData()
  const jobId = form.get('jobId')
  if (typeof jobId !== 'string' || jobId.length === 0) {
    return Response.json({ ok: false, error: 'missing jobId' }, { status: 400 })
  }

  const fileEntries = form.getAll('files').filter((v): v is File => v instanceof File)
  if (fileEntries.length === 0) {
    return Response.json(
      { ok: false, error: '请上传至少一份图纸或图片' },
      { status: 400 },
    )
  }
  if (fileEntries.length > MAX_FILES) {
    return Response.json(
      { ok: false, error: `最多 ${MAX_FILES} 份附件` },
      { status: 413 },
    )
  }

  let totalBytes = 0
  for (const f of fileEntries) {
    if (!ALLOWED.has(f.type)) {
      return Response.json(
        { ok: false, error: `不支持的文件类型：${f.type || '未知'}` },
        { status: 415 },
      )
    }
    if (f.size > MAX_FILE_BYTES) {
      return Response.json(
        { ok: false, error: `${f.name} 超过 12MB` },
        { status: 413 },
      )
    }
    totalBytes += f.size
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    return Response.json(
      { ok: false, error: '总大小超过 18MB，请减少文件' },
      { status: 413 },
    )
  }

  // Read all files into memory once. Build the Gemini payload AND upload to
  // Supabase storage in parallel (storage upload is fire-and-forget for the
  // model call's correctness; we still await both before responding so the
  // client gets canonical URLs back).
  const buffers = await Promise.all(
    fileEntries.map(async (f) => ({
      file: f,
      bytes: Buffer.from(await f.arrayBuffer()),
    })),
  )

  const geminiInputs: SourceFile[] = buffers.map(({ file, bytes }) => ({
    mimeType: file.type,
    data: bytes.toString('base64'),
    name: file.name,
  }))

  // Storage upload (best-effort for tracking; not blocking the model call).
  const sourcesPromise: Promise<StoredProcessCardSource[]> = (async () => {
    const ts = Date.now()
    const out: StoredProcessCardSource[] = []
    for (let i = 0; i < buffers.length; i++) {
      const { file, bytes } = buffers[i]
      const ext = extFor(file.type, file.name)
      const key = `process-card/${safeName(jobId)}/${ts}-${i}-${safeName(
        file.name.replace(/\.[^.]+$/, ''),
      )}.${ext}`
      const up = await supabase.storage.from(STORAGE_BUCKET).upload(key, bytes, {
        contentType: file.type,
        upsert: true,
      })
      if (up.error) {
        // Log but don't fail the whole generation — the model already has the
        // bytes. The card just won't have a clickable source link for this file.
        console.error('process-card source upload failed:', up.error.message)
        continue
      }
      out.push({
        url: proxiedKeyUrl(key, ts.toString(36)),
        name: file.name,
        mimeType: file.type,
      })
    }
    return out
  })()

  let card
  try {
    card = await generateProcessCard(geminiInputs)
  } catch (err) {
    console.error('process-card generation failed:', err)
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : '生成失败',
      },
      { status: 502 },
    )
  }

  const sourceFiles = await sourcesPromise

  await saveProcessCard({
    jobId,
    card,
    sourceFiles,
    model: PROCESS_CARD_MODEL,
    generatedBy: user.name,
  })

  revalidatePath(`/jobs/${jobId}`)

  return Response.json({
    ok: true,
    card: {
      jobId,
      card,
      sourceFiles,
      model: PROCESS_CARD_MODEL,
      generatedAt: new Date().toISOString(),
      generatedBy: user.name,
    },
  })
}

// PATCH — manual edits to the card body. Body: { jobId, card: ProcessCard }.
export async function PATCH(request: NextRequest) {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid json' }, { status: 400 })
  }

  if (!body || typeof body !== 'object') {
    return Response.json({ ok: false, error: 'invalid body' }, { status: 400 })
  }
  const { jobId, card } = body as { jobId?: unknown; card?: unknown }
  if (typeof jobId !== 'string' || jobId.length === 0) {
    return Response.json({ ok: false, error: 'missing jobId' }, { status: 400 })
  }

  const existing = await getProcessCard(jobId)
  if (!existing) {
    return Response.json({ ok: false, error: 'card not found' }, { status: 404 })
  }

  const sanitized = normalizeCard(card)
  if (sanitized.components.length === 0) {
    return Response.json({ ok: false, error: 'invalid card shape' }, { status: 400 })
  }

  await updateProcessCardBody(jobId, sanitized)
  revalidatePath(`/jobs/${jobId}`)

  return Response.json({
    ok: true,
    card: {
      ...existing,
      card: sanitized,
    },
  })
}

// DELETE — drop the saved card. Query: ?jobId=...
export async function DELETE(request: NextRequest) {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const jobId = request.nextUrl.searchParams.get('jobId')
  if (!jobId) {
    return Response.json({ ok: false, error: 'missing jobId' }, { status: 400 })
  }
  await deleteProcessCard(jobId)
  revalidatePath(`/jobs/${jobId}`)
  return Response.json({ ok: true })
}

