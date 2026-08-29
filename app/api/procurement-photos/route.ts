import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { currentUser } from '@/lib/auth'
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

export async function DELETE(request: NextRequest) {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
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
