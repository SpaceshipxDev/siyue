import { NextRequest, after } from 'next/server'
import { revalidatePath } from 'next/cache'
import {
  getJob,
  markJobAsParsing,
  markJobFailed,
} from '@/lib/db'
import { currentUser } from '@/lib/auth'
import { runExtraction } from '@/lib/extract'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Re-runs the AI extraction against an existing job's stored source file.
// The original /api/ingest path creates a new job from a fresh upload; this
// path is for the recovery case where extraction stalled or failed and the
// user wants another shot without re-uploading.
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user || user.role !== 'commerce') {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as
    | { jobId?: string }
    | null
  const jobId = body?.jobId
  if (!jobId) {
    return Response.json({ ok: false, error: 'missing jobId' }, { status: 400 })
  }

  const job = await getJob(jobId)
  if (!job) {
    return Response.json({ ok: false, error: 'job not found' }, { status: 404 })
  }
  if (!job.sourceFileUrl) {
    return Response.json(
      { ok: false, error: '没有源文件可重试，请改用手动填写' },
      { status: 400 },
    )
  }

  // Flip back to 'parsing' immediately so the import page resumes its poller
  // while the heavy work runs in the background. Without this the failed-state
  // UI stays visible and confuses the user about whether the retry took.
  await markJobAsParsing(jobId)
  revalidatePath(`/import/${jobId}`)

  const sourceFileUrl = job.sourceFileUrl
  const fileName = job.sourceFile ?? 'unknown.xlsx'

  // Background work — same `after()` pattern as /api/ingest so Vercel keeps
  // the invocation alive past response flush.
  after(async () => {
    try {
      const r = await fetch(sourceFileUrl)
      if (!r.ok) throw new Error(`下载源文件失败 (${r.status})`)
      const buf = await r.arrayBuffer()
      await runExtraction({ jobId, fileName, buf })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[retry-parse] failed', { jobId, fileName, message })
      await markJobFailed(jobId, message)
    } finally {
      revalidatePath('/')
      revalidatePath(`/import/${jobId}`)
    }
  })

  return Response.json({ ok: true })
}
