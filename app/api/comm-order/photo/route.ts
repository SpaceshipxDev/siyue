import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { canWriteCommSheet, currentUser } from '@/lib/auth'
import {
  addCommOrderImage,
  isCommOrderImageField,
  uploadCommImage,
} from '@/lib/comm-order'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 沟通确认单上的图 —— 截图和手机拍的照, 十几兆封顶足够。
const MAX_BYTES = 16 * 1024 * 1024
const ALLOWED = /\.(png|jpe?g|webp|gif|bmp)$/i

export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user || !canWriteCommSheet(user)) {
    return Response.json({ ok: false, error: '沟通确认单由工程或商务填' }, { status: 401 })
  }
  const form = await request.formData()
  const file = form.get('file')
  const jobNo = form.get('jobNo')
  const rowId = form.get('rowId')
  const field = form.get('field')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: '没有收到图片' }, { status: 400 })
  }
  if (typeof jobNo !== 'string' || !jobNo || typeof rowId !== 'string' || !isCommOrderImageField(field)) {
    return Response.json({ ok: false, error: 'bad args' }, { status: 400 })
  }
  if (!ALLOWED.test(file.name) && !file.type.startsWith('image/')) {
    return Response.json({ ok: false, error: '只收图片' }, { status: 415 })
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ ok: false, error: '图片过大（上限 16MB）' }, { status: 413 })
  }
  try {
    const image = await uploadCommImage(jobNo, file, file.name, file.type)
    const sheet = await addCommOrderImage(jobNo, rowId, field, image, user.name)
    revalidatePath('/comm')
    return Response.json({ ok: true, sheet })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
