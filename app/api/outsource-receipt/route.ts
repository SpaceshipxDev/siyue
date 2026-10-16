import { NextRequest } from 'next/server'
import { canManageOutsource, currentUser } from '@/lib/auth'
import {
  addOutsourceReceipt,
  deleteOutsourceReceipt,
  isAllowedReceiptName,
} from '@/lib/outsource-receipt'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 16 * 1024 * 1024

// 外协收货确认单 —— 传一张 / 删一张, 挂在订单上 (lib/outsource-receipt)。
// 跟外协台同一档人: 进得了外协台的就能传、能删。回包带着新的那一行, 页面
// 直接接上, 不整页刷新 (同 请购图)。
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  if (!canManageOutsource(user))
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 })
  const form = await request.formData()
  const file = form.get('file')
  const jobId = form.get('jobId')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: 'no file' }, { status: 400 })
  }
  if (typeof jobId !== 'string' || !jobId) {
    return Response.json({ ok: false, error: 'missing jobId' }, { status: 400 })
  }
  if (!isAllowedReceiptName(file.name)) {
    return Response.json({ ok: false, error: '只能传图片' }, { status: 415 })
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ ok: false, error: '图片太大（上限 16MB）' }, { status: 413 })
  }
  try {
    const photo = await addOutsourceReceipt({
      jobId,
      buf: await file.arrayBuffer(),
      fileName: file.name,
      contentType: file.type,
      uploadedBy: user.name,
    })
    return Response.json({ ok: true, photo })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const user = await currentUser()
  if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  if (!canManageOutsource(user))
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 })
  const jobId = request.nextUrl.searchParams.get('jobId')
  const id = request.nextUrl.searchParams.get('id')
  if (!jobId || !id) {
    return Response.json({ ok: false, error: 'missing id' }, { status: 400 })
  }
  await deleteOutsourceReceipt(jobId, id)
  return Response.json({ ok: true })
}
