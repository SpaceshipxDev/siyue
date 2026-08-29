import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { currentUser } from '@/lib/auth'
import {
  addProcurementPhoto,
  isAllowedProcurementPhotoName,
} from '@/lib/procurement-photo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 16 * 1024 * 1024

// 请购图片上传 — a picture pinned to one 采购 row. Open to anyone signed in,
// same as the 采购 board itself: the floor requests, so the floor attaches the
// photo of what broke. Stores the blob + a manifest row; the response carries
// the new row so the client appends it without a full RSC refresh (GFW
// posture — same as 合同 / 凭证上传).
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const form = await request.formData()
  const file = form.get('file')
  const procurementId = form.get('procurementId')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: 'no file' }, { status: 400 })
  }
  if (typeof procurementId !== 'string' || !procurementId) {
    return Response.json(
      { ok: false, error: 'missing procurementId' },
      { status: 400 },
    )
  }
  if (!isAllowedProcurementPhotoName(file.name)) {
    return Response.json(
      { ok: false, error: '仅支持图片或 PDF' },
      { status: 415 },
    )
  }
  if (file.size > MAX_BYTES) {
    return Response.json(
      { ok: false, error: '文件过大（上限 16MB）' },
      { status: 413 },
    )
  }

  const buf = await file.arrayBuffer()
  let row
  try {
    row = await addProcurementPhoto({
      procurementId,
      buf,
      fileName: file.name,
      contentType: file.type,
      uploadedBy: user.name,
      nowIso: new Date().toISOString(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }

  revalidatePath('/procurement')

  return Response.json({ ok: true, photo: row })
}
