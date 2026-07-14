import { revalidatePath } from 'next/cache'
import { canEditProductionFields, currentUser } from '@/lib/auth'
import { registerPage } from '@/lib/matcher'
import { deleteJobPhoto, markPageRegistered, rotateJobPhoto } from '@/lib/packets'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function message(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败'
}

async function authorize(): Promise<Response | null> {
  const user = await currentUser()
  if (!user || !canEditProductionFields(user)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  return null
}

function revalidate(jobId: string): void {
  revalidatePath('/')
  revalidatePath('/orders')
  revalidatePath(`/jobs/${jobId}`)
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ photoId: string }> },
): Promise<Response> {
  const denied = await authorize()
  if (denied) return denied

  const { photoId } = await params
  try {
    const result = await deleteJobPhoto(photoId)
    if (!result) {
      return Response.json({ ok: false, error: '照片不存在' }, { status: 404 })
    }
    revalidate(result.jobId)
    return Response.json({ ok: true })
  } catch (error) {
    console.error('[job-photos] delete failed:', error)
    return Response.json({ ok: false, error: message(error) }, { status: 500 })
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ photoId: string }> },
): Promise<Response> {
  const denied = await authorize()
  if (denied) return denied

  const { photoId } = await params
  const body = (await request.json().catch(() => ({}))) as {
    direction?: string
  }
  // ccw = counter-clockwise; anything else rotates clockwise a quarter turn.
  const quarterTurns = body.direction === 'ccw' ? -1 : 1

  try {
    const result = await rotateJobPhoto(photoId, quarterTurns)
    if (!result) {
      return Response.json({ ok: false, error: '照片不存在' }, { status: 404 })
    }
    // Best-effort re-enrollment so phone matches read the corrected orientation.
    // The rotate itself is already durably committed; a matcher miss self-heals
    // through sweepRegistrations, same as the initial upload.
    const registered = await registerPage({
      pageId: photoId,
      partId: result.partId,
      kind: 'other',
      bytes: result.bytes,
      contentType: result.contentType,
    })
    if (registered) await markPageRegistered(photoId, 'job_photo')

    revalidate(result.jobId)
    return Response.json({ ok: true })
  } catch (error) {
    console.error('[job-photos] rotate failed:', error)
    return Response.json({ ok: false, error: message(error) }, { status: 500 })
  }
}
