import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { currentUser } from '@/lib/auth'
import { addChangePhoto } from '@/lib/changes'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 变更单上的图多半是新图纸的截图和手机拍的照，十几兆封顶足够 —— 再大就是有
// 人误传了一份模型进来，挡住比传上去好。
const MAX_BYTES = 16 * 1024 * 1024

const ALLOWED = /\.(png|jpe?g|webp|gif|bmp|heic|pdf)$/i

// 变更管理的配图 —— 跟那张表同一档权限：有账号就能传。
//
// 变更这件事是谁接到通知谁记的（商务接客户电话、工程收到新图），让他等一个
// 有权限的人来代传，就是让这张图不存在 —— 而车间下一道工序照着旧图就做下去
// 了。删和改已经填下去的东西才是另一档（见 /api/mutate 的 deleteChangePhoto）。
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const form = await request.formData()
  const file = form.get('file')
  const changeId = form.get('changeId')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: 'no file' }, { status: 400 })
  }
  if (typeof changeId !== 'string' || !changeId) {
    return Response.json({ ok: false, error: 'missing changeId' }, { status: 400 })
  }
  if (!ALLOWED.test(file.name) && !file.type.startsWith('image/')) {
    return Response.json({ ok: false, error: '只收图片 / PDF' }, { status: 415 })
  }
  if (file.size > MAX_BYTES) {
    return Response.json(
      { ok: false, error: '文件过大（上限 16MB）' },
      { status: 413 },
    )
  }

  try {
    const photo = await addChangePhoto({
      changeId,
      // Blob 直接转交 storage, 不在内存里再拷一份。
      body: file,
      fileName: file.name,
      contentType: file.type,
      uploadedBy: user.name,
      nowIso: new Date().toISOString(),
    })
    revalidatePath('/quality')
    return Response.json({ ok: true, photo })
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : '上传失败' },
      { status: 500 },
    )
  }
}
