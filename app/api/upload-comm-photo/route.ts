import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { canWriteCommSheet, currentUser } from '@/lib/auth'
import { addCommPhoto } from '@/lib/comm-sheet-store'
import { isCommTopic } from '@/lib/comm-sheet'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 沟通单上的图多半是截图和手机拍的照, 十几兆封顶足够 —— 再大就是有人误传了
// 一份模型进来, 挡住比传上去好。
const MAX_BYTES = 16 * 1024 * 1024

const ALLOWED = /\.(png|jpe?g|webp|gif|bmp|heic|pdf)$/i

// 沟通确认单的配图 —— 工程/商务传, 全厂可看 (车间照着图做的就是它)。
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user || !canWriteCommSheet(user)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const form = await request.formData()
  const file = form.get('file')
  const jobId = form.get('jobId')
  const topic = form.get('topic')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: 'no file' }, { status: 400 })
  }
  if (typeof jobId !== 'string' || !jobId) {
    return Response.json({ ok: false, error: 'missing jobId' }, { status: 400 })
  }
  if (!isCommTopic(topic)) {
    return Response.json({ ok: false, error: 'bad topic' }, { status: 400 })
  }
  if (!ALLOWED.test(file.name) && !file.type.startsWith('image/')) {
    return Response.json(
      { ok: false, error: '只收图片 / PDF' },
      { status: 415 },
    )
  }
  if (file.size > MAX_BYTES) {
    return Response.json(
      { ok: false, error: '文件过大（上限 16MB）' },
      { status: 413 },
    )
  }

  try {
    const { photo } = await addCommPhoto({
      jobId,
      topic,
      // Blob 直接转交 storage, 不在内存里再拷一份。
      body: file,
      fileName: file.name,
      contentType: file.type,
      uploadedBy: user.name,
      nowIso: new Date().toISOString(),
    })
    revalidatePath(`/jobs/${jobId}`)
    return Response.json({ ok: true, photo })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
