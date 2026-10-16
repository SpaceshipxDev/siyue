import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import {
  canSeePayRequest,
  currentUser,
  type AuthUser,
} from '@/lib/auth'
import {
  addPayRequestFile,
  deletePayRequestFile,
  getPayRequest,
  isAllowedPayFileName,
} from '@/lib/pay-request'
import type { PayFileKind, PayRequest } from '@/lib/pay-request-shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 16 * 1024 * 1024

// 付款申请的附件 —— 付款凭证 / 发票, 一张一张挂在申请上 (lib/pay-request)。
// 看得到这张申请的人 (填的人、老板、财务、于海伟、审核人) 就能传、能删 (批
// 下来以后不能删)。回包带着新的那一行,
// 页面直接接上。

function canTouch(u: AuthUser, r: PayRequest): boolean {
  return canSeePayRequest(u, r)
}

function kindOf(v: unknown): PayFileKind | null {
  return v === 'voucher' || v === 'invoice' ? v : null
}

export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const form = await request.formData()
  const file = form.get('file')
  const id = form.get('id')
  const kind = kindOf(form.get('kind'))
  if (!(file instanceof File) || typeof id !== 'string' || !id || !kind) {
    return Response.json({ ok: false, error: 'bad request' }, { status: 400 })
  }
  const r = await getPayRequest(id)
  if (!r) return Response.json({ ok: false, error: '找不到这张付款申请' }, { status: 404 })
  if (!canTouch(user, r))
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 })
  if (!isAllowedPayFileName(file.name)) {
    return Response.json({ ok: false, error: '只能传图片或 PDF' }, { status: 415 })
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ ok: false, error: '文件太大（上限 16MB）' }, { status: 413 })
  }
  try {
    const row = await addPayRequestFile({
      id,
      kind,
      buf: await file.arrayBuffer(),
      fileName: file.name,
      contentType: file.type,
      by: user.name,
    })
    revalidatePath('/pay')
    revalidatePath('/hr')
    return Response.json({ ok: true, file: row })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const user = await currentUser()
  if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const sp = request.nextUrl.searchParams
  const id = sp.get('id')
  const fileId = sp.get('fileId')
  const kind = kindOf(sp.get('kind'))
  if (!id || !fileId || !kind) {
    return Response.json({ ok: false, error: 'bad request' }, { status: 400 })
  }
  const r = await getPayRequest(id)
  if (!r) return Response.json({ ok: true })
  if (!canTouch(user, r))
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 })
  try {
    await deletePayRequestFile(id, kind, fileId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: message }, { status: 400 })
  }
  revalidatePath('/pay')
  revalidatePath('/hr')
  return Response.json({ ok: true })
}
