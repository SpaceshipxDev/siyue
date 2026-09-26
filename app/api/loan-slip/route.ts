import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { canApplyLoan, canSeeLoans, currentUser } from '@/lib/auth'
import { addLoanSlip, getLoan, isAllowedSlipName } from '@/lib/loan'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 16 * 1024 * 1024

// 借支单上传 —— 员工签了字的那张纸, 拍一张挂到借款上。
//
// 人事填申请的时候顺手传 (人事这头, canApplyLoan); 财务放款前发现少了一张也能
// 补 (财务那头, canSeeLoans)。删走 /api/mutate 的 deleteLoanSlip。
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user || !(canApplyLoan(user) || canSeeLoans(user))) {
    return Response.json({ ok: false, error: '传支单要找人事或财务' }, { status: 401 })
  }
  const form = await request.formData()
  const file = form.get('file')
  const loanId = form.get('loanId')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: '没有文件' }, { status: 400 })
  }
  if (typeof loanId !== 'string' || !loanId) {
    return Response.json({ ok: false, error: 'bad loanId' }, { status: 400 })
  }
  if (!isAllowedSlipName(file.name)) {
    return Response.json({ ok: false, error: '仅支持图片或 PDF' }, { status: 415 })
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ ok: false, error: '文件过大（上限 16MB）' }, { status: 413 })
  }
  if (!(await getLoan(loanId))) {
    return Response.json({ ok: false, error: '找不到这笔借款' }, { status: 404 })
  }

  let slip
  try {
    slip = await addLoanSlip({
      loanId,
      buf: await file.arrayBuffer(),
      fileName: file.name,
      contentType: file.type,
      uploadedBy: user.name,
      nowIso: new Date().toISOString(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
  revalidatePath('/hr')
  revalidatePath('/finance')
  return Response.json({ ok: true, slip })
}
