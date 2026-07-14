import { revalidatePath } from 'next/cache'
import { canEditProductionFields, currentUser } from '@/lib/auth'
import { registerPage } from '@/lib/matcher'
import { createJobPhoto, markPageRegistered } from '@/lib/packets'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_FILES = 8
const MAX_BYTES = 8 * 1024 * 1024

function message(error: unknown): string {
  return error instanceof Error ? error.message : '照片添加失败'
}

export async function POST(request: Request): Promise<Response> {
  const user = await currentUser()
  if (!user || !canEditProductionFields(user)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  try {
    const form = await request.formData()
    const jobId = String(form.get('jobId') ?? '').trim()
    const partId = String(form.get('partId') ?? '').trim()
    const files = form
      .getAll('images')
      .filter((value): value is File => value instanceof File && value.size > 0)

    if (!jobId || !partId) {
      return Response.json({ ok: false, error: '缺少工单信息' }, { status: 400 })
    }
    if (files.length === 0) {
      return Response.json({ ok: false, error: '请选择照片' }, { status: 400 })
    }
    if (files.length > MAX_FILES) {
      return Response.json(
        { ok: false, error: `一次最多添加 ${MAX_FILES} 张照片` },
        { status: 400 },
      )
    }
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        return Response.json({ ok: false, error: '只支持图片文件' }, { status: 400 })
      }
      if (file.size > MAX_BYTES) {
        return Response.json({ ok: false, error: '单张照片不能超过 8MB' }, { status: 400 })
      }
    }

    const prepared = await Promise.all(
      files.map(async (file) => ({
        bytes: new Uint8Array(await file.arrayBuffer()),
        contentType: file.type || 'image/jpeg',
      })),
    )
    const photos = await Promise.all(
      prepared.map((image) =>
        createJobPhoto({
          jobId,
          partId,
          bytes: image.bytes,
          contentType: image.contentType,
          uploadedBy: user.name,
        }),
      ),
    )

    // Storage + DB are the durable commit. Matcher enrollment is best-effort
    // and self-heals through sweepRegistrations when the service is offline.
    const registrationResults = await Promise.all(
      photos.map(async (photo, index) => {
        const registered = await registerPage({
          pageId: photo.id,
          partId: photo.partId,
          kind: 'other',
          bytes: prepared[index].bytes,
          contentType: prepared[index].contentType,
        })
        if (registered) await markPageRegistered(photo.id, 'job_photo')
        return registered
      }),
    )

    revalidatePath('/')
    revalidatePath('/orders')
    revalidatePath(`/jobs/${jobId}`)
    return Response.json({
      ok: true,
      count: photos.length,
      registered: registrationResults.filter(Boolean).length,
    })
  } catch (error) {
    console.error('[job-photos] failed:', error)
    return Response.json({ ok: false, error: message(error) }, { status: 500 })
  }
}
