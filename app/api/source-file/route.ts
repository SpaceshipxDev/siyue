import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { currentUser } from '@/lib/auth'
import { updateJob } from '@/lib/db'
import { uploadSourceFile } from '@/lib/source-file'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 16 * 1024 * 1024

// Replace the source workbook attached to an existing job. We do NOT re-run
// Gemini extraction here — production may have already started working on
// this job, and re-parsing would wipe their stage history. Commerce can
// hand-correct any field after swapping the file; the stored copy is for
// download/reference, not a re-import trigger.
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user || user.role !== 'commerce') {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const form = await request.formData()
  const file = form.get('file')
  const jobId = form.get('jobId')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: 'no file' }, { status: 400 })
  }
  if (typeof jobId !== 'string' || !jobId) {
    return Response.json({ ok: false, error: 'missing jobId' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ ok: false, error: 'file too large' }, { status: 413 })
  }

  const buf = await file.arrayBuffer()
  let url: string
  try {
    url = await uploadSourceFile({
      jobId,
      buf,
      fileName: file.name,
      contentType: file.type,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }

  await updateJob(jobId, { sourceFile: file.name, sourceFileUrl: url })

  revalidatePath('/')
  revalidatePath(`/import/${jobId}`)
  revalidatePath(`/jobs/${jobId}`)

  return Response.json({ ok: true, url, fileName: file.name })
}
