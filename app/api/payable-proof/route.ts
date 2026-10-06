import { NextRequest } from 'next/server'
import { canSettleAccounts, currentUser } from '@/lib/auth'
import { extractPaymentProof, type ExtractedPaymentProof } from '@/lib/gemini'
import { getPayable, isAllowedProofName, storePaymentProof } from '@/lib/payable'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_BYTES = 16 * 1024 * 1024

// 付款凭证 —— 传一张回单上来, 存好, 再让机器读一遍日期、金额、收款方。
//
// 这一步不记付款: 读出来的数交回浏览器填进表单, 人看过、点了「记付款」才落
// 账 (/api/mutate addPayablePayment, 带上这里返回的凭证地址)。机器读错了、读
// 不出来都不要紧 —— 凭证照样存好, 空着的格子人自己填。
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user || !canSettleAccounts(user)) {
    return Response.json({ ok: false, error: '记付款要找于海伟或财务' }, { status: 401 })
  }
  const form = await request.formData()
  const file = form.get('file')
  const payableId = form.get('payableId')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: '没有文件' }, { status: 400 })
  }
  if (typeof payableId !== 'string' || !payableId) {
    return Response.json({ ok: false, error: 'bad payableId' }, { status: 400 })
  }
  if (!isAllowedProofName(file.name)) {
    return Response.json({ ok: false, error: '仅支持图片或 PDF' }, { status: 415 })
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ ok: false, error: '文件过大（上限 16MB）' }, { status: 413 })
  }
  // 'manual' —— 补录老账时挂的凭证 (应收、应付都走这里), 那时还没有单子。
  if (payableId !== 'manual' && !(await getPayable(payableId))) {
    return Response.json({ ok: false, error: '找不到这张应付单' }, { status: 404 })
  }

  const buf = await file.arrayBuffer()
  const contentType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg')

  let proof
  try {
    proof = await storePaymentProof({
      payableId,
      buf,
      fileName: file.name,
      contentType,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: `存不上 · ${message}` }, { status: 500 })
  }

  // 读不出来不算失败 —— 凭证已经存好了, 人自己填就是。
  let extracted: ExtractedPaymentProof | null = null
  try {
    extracted = await extractPaymentProof({
      base64: Buffer.from(buf).toString('base64'),
      mimeType: contentType,
    })
  } catch {
    extracted = null
  }

  return Response.json({ ok: true, proof, extracted })
}
