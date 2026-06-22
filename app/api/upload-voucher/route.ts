import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { currentUser } from '@/lib/auth'
import { canSeeExpenses } from '@/lib/auth'
import { addExpenseVoucher, isAllowedVoucherName } from '@/lib/voucher-file'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 16 * 1024 * 1024

// 凭证上传 — the finance person attaches a receipt image (or PDF) to a 支出
// row. Gated to the 支出 surface (boss + designated finance users, same as the
// expense ledger itself), not all commerce. Stores the blob + a manifest row;
// the response carries the new row so the client appends it without a full RSC
// refresh (GFW posture — same as 合同上传).
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user || !canSeeExpenses(user)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const form = await request.formData()
  const file = form.get('file')
  const expenseId = form.get('expenseId')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: 'no file' }, { status: 400 })
  }
  if (typeof expenseId !== 'string' || !expenseId) {
    return Response.json(
      { ok: false, error: 'missing expenseId' },
      { status: 400 },
    )
  }
  if (!isAllowedVoucherName(file.name)) {
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
    row = await addExpenseVoucher({
      expenseId,
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

  revalidatePath('/finance')

  return Response.json({ ok: true, voucher: row })
}
