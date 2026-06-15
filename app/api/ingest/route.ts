import { NextRequest, after } from 'next/server'
import {
  createParsingJob,
  markJobFailed,
  updateJob,
} from '@/lib/db'
import { canEditProductionFields, currentUser } from '@/lib/auth'
import { revalidatePath } from 'next/cache'
import { uploadSourceFile } from '@/lib/source-file'
import { runExtraction } from '@/lib/extract'
import { errMessage } from '@/lib/err'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const t0 = Date.now()
  const user = await currentUser()
  // Commerce + 工程 head both run imports (工程 head uploads PDFs from the
  // shop floor and confirms them straight into the master grid).
  if (!user || !canEditProductionFields(user)) {
    console.warn('[ingest] unauthorized', { role: user?.role ?? null })
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch (err) {
    console.error('[ingest] formData() failed', err)
    const message = errMessage(err)
    return Response.json({ ok: false, error: `formData: ${message}` }, { status: 500 })
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    console.warn('[ingest] no file in form', {
      keys: Array.from(form.keys()),
    })
    return Response.json({ ok: false, error: 'no file' }, { status: 400 })
  }

  const fileName = file.name
  console.log('[ingest] received', {
    fileName,
    size: file.size,
    type: file.type,
    user: user.name,
  })

  let buf: ArrayBuffer
  try {
    buf = await file.arrayBuffer()
  } catch (err) {
    console.error('[ingest] arrayBuffer() failed', { fileName }, err)
    const message = errMessage(err)
    return Response.json({ ok: false, error: `arrayBuffer: ${message}` }, { status: 500 })
  }

  let job
  try {
    job = await createParsingJob({ sourceFile: fileName })
  } catch (err) {
    console.error('[ingest] createParsingJob failed', { fileName }, err)
    const message = errMessage(err)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
  console.log('[ingest] job created', { jobId: job.id, jobNo: job.jobNo, fileName, ms: Date.now() - t0 })

  // Persist the original bytes to storage so 商务 can re-download or replace
  // the source long after the parse finishes. We do this before the Gemini
  // call so the file is recoverable even if extraction fails. Failure to
  // upload is non-fatal — log and continue; the parse is still useful.
  try {
    const url = await uploadSourceFile({
      jobId: job.id,
      buf,
      fileName,
      contentType: file.type,
    })
    await updateJob(job.id, { sourceFileUrl: url })
  } catch (err) {
    console.error('source-file upload failed', err)
  }

  // The import page polls and re-renders when status flips. We hand the
  // Gemini call to `after()` so Vercel keeps the serverless invocation alive
  // until the parse settles (up to `maxDuration`). A bare fire-and-forget
  // would be killed the moment the response is flushed on Vercel.
  after(async () => {
    try {
      await runExtraction({ jobId: job.id, fileName, buf, t0 })
    } catch (err) {
      const message = errMessage(err)
      console.error('[ingest] parse failed', {
        jobId: job.id,
        fileName,
        message,
        stack: err instanceof Error ? err.stack : undefined,
      })
      await markJobFailed(job.id, message)
    } finally {
      revalidatePath('/')
      revalidatePath(`/import/${job.id}`)
    }
  })

  revalidatePath('/')
  return Response.json({
    ok: true,
    job: {
      id: job.id,
      jobNo: job.jobNo,
      customer: job.customer,
      status: job.status,
      components: job.components,
    },
  })
}
