import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { canDeleteProcurement, currentUser } from '@/lib/auth'
import {
  deleteProcurementPhoto,
  getProcurementPhotos,
} from '@/lib/procurement-photo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The pictures on one 采购, read on demand when its panel opens. Per-row and
// not part of the board's server render on purpose: the board holds every
// open purchase at once, and a manifest read each would be hundreds of
// storage round-trips for pictures nobody has looked at.
export async function GET(request: NextRequest) {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const id = request.nextUrl.searchParams.get('id')
  if (!id) {
    return Response.json({ ok: false, error: 'missing id' }, { status: 400 })
  }
  return Response.json({ ok: true, photos: await getProcurementPhotos(id) })
}

// 删一张请购图 —— 跟删采购同一档 (老板 + 商务于海伟)。传图对全厂开着: 买东
// 西的人当场拍一张是这一页好用的原因, 删掉别人拍的那张不是。
export async function DELETE(request: NextRequest) {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  if (!canDeleteProcurement(user)) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 })
  }
  const id = request.nextUrl.searchParams.get('id')
  const photoId = request.nextUrl.searchParams.get('photoId')
  if (!id || !photoId) {
    return Response.json({ ok: false, error: 'missing id' }, { status: 400 })
  }
  await deleteProcurementPhoto(id, photoId)
  revalidatePath('/procurement')
  return Response.json({ ok: true })
}
