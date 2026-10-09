import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { currentUser } from '@/lib/auth'
import { addComplaintPhoto } from '@/lib/complaints'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 客户发来的照片多半是手机拍的, 十几兆封顶足够。
const MAX_BYTES = 16 * 1024 * 1024

const ALLOWED = /\.(png|jpe?g|webp|gif|bmp|heic)$/i

// 客诉的不良图片 —— 跟记客诉同一档: 有账号就能传 (谁接到客户电话谁记, 图也
// 是他手上那几张)。删图是改那一档, 见 /api/mutate 的 deleteComplaintPhoto。
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: '请先登录' }, { status: 401 })
  }
  const form = await request.formData()
  const file = form.get('file')
  const complaintId = form.get('complaintId')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: '没有收到图片' }, { status: 400 })
  }
  if (typeof complaintId !== 'string' || !complaintId) {
    return Response.json({ ok: false, error: '这条客诉找不到了' }, { status: 400 })
  }
  if (!ALLOWED.test(file.name) && !file.type.startsWith('image/')) {
    return Response.json({ ok: false, error: '只收图片' }, { status: 415 })
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ ok: false, error: '图片过大（上限 16MB）' }, { status: 413 })
  }

  try {
    const photo = await addComplaintPhoto({
      complaintId,
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
