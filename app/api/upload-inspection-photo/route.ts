import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { addPartPhoto } from '@/lib/db'
import { currentUser } from '@/lib/auth'
import { ALLOWED_IMAGE_MIMES, MAX_IMAGE_BYTES } from '@/lib/component-image'
import { uploadInspectionPhoto } from '@/lib/inspection-photo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 检验照片 upload. Same auth shape as the mutate route's requireOwnStage('检验'):
// commerce, 工程 head, and 检验-station workers may upload; other production
// stations may not.
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (
    !user ||
    (user.role === 'production' &&
      user.defaultStage !== '工程' &&
      user.defaultStage !== '检验')
  ) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const form = await request.formData()
  const file = form.get('file')
  const jobId = form.get('jobId')
  const componentId = form.get('componentId')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: 'no file' }, { status: 400 })
  }
  if (typeof jobId !== 'string' || typeof componentId !== 'string') {
    return Response.json({ ok: false, error: 'missing jobId/componentId' }, { status: 400 })
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return Response.json({ ok: false, error: 'file too large' }, { status: 413 })
  }
  if (!ALLOWED_IMAGE_MIMES.has(file.type)) {
    return Response.json({ ok: false, error: 'unsupported image type' }, { status: 415 })
  }

  const url = await uploadInspectionPhoto({
    jobId,
    componentId,
    bytes: Buffer.from(await file.arrayBuffer()),
    mime: file.type,
    fallbackName: file.name,
  })
  const photo = await addPartPhoto(jobId, componentId, url, user.name)
  if (!photo) {
    return Response.json({ ok: false, error: 'component not found' }, { status: 404 })
  }

  revalidatePath(`/jobs/${jobId}`)

  return Response.json({ ok: true, ...photo })
}
