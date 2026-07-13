import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { setComponentImage } from '@/lib/db'
import { currentUser } from '@/lib/auth'
import {
  uploadComponentImage,
  ALLOWED_IMAGE_MIMES,
  MAX_IMAGE_BYTES,
} from '@/lib/component-image'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user || user.role !== 'commerce') {
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

  const url = await uploadComponentImage({
    jobId,
    componentId,
    bytes: Buffer.from(await file.arrayBuffer()),
    mime: file.type,
    fallbackName: file.name,
  })
  await setComponentImage(jobId, componentId, url)

  revalidatePath(`/import/${jobId}`)
  revalidatePath(`/jobs/${jobId}`)

  return Response.json({ ok: true, url })
}
