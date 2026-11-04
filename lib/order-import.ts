import 'server-only'
import { createMoneyEvent, createPoLine, getFenqiData, getOrderLedgerRows } from './db'
import { setExtSettles } from './ext-settle'

/*
 * 订单账导入 (于海伟 2026-11-04) —— 财务把「财务 → 订单」导出去, 在系统外对
 * 完账、开完票、收完款, 在表上填好再导回来。按工号对上系统里的订单:
 *
 *   对账 —— 写「已对账 / 已回款」(或者填了应收单号) 的, 记一条系统外对账
 *           (lib/ext-settle)。系统里自己对过账的照系统的。
 *   开票 / 收款 —— 表上写的是这张单到现在的合计。比系统里多出来的那一截, 在
 *           记账里补一笔 (日期、发票号表上有就用, 没有按今天)。一样多的不动,
 *           比系统里少的不动 (要减得去记账里红冲, 不替人冲)。所以同一张表导两
 *           次, 第二次什么都不会多记。
 *
 * 记账的钱挂在订单号行 (po_lines) 上。这张单还没有订单号行的, 先开一行 (金额
 * = 订单额); 它原来的开票收款是记在出货单上的老数, 一开新行订单账就只认新行,
 * 所以新行上开票、收款都按表上的合计记全, 不是只记差额。免收的单不记钱。
 */

export type OrderImportItem = {
  jobNo: string
  settle?: 'reconciled' | 'paid'
  settleNo?: string
  invoiceCny?: number
  invoiceDate?: string
  invoiceNo?: string
  paymentCny?: number
  paymentDate?: string
}

export type OrderImportResult = {
  matched: number
  unmatched: string[]
  settles: number
  invoices: number
  payments: number
  /** 表上的数比系统里少, 没动的。 */
  lower: string[]
}

const r2 = (n: number) => Math.round(n * 100) / 100

export async function importOrderLedger(
  items: OrderImportItem[],
  by: string,
  todayYmd: string,
): Promise<OrderImportResult> {
  const [rows, fenqi] = await Promise.all([getOrderLedgerRows(), getFenqiData()])
  const byNo = new Map(rows.map((r) => [r.jobNo.trim().toLowerCase(), r]))
  const firstLine = new Map<string, string>()
  for (const l of [...fenqi.lines].sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    if (!firstLine.has(l.jobId)) firstLine.set(l.jobId, l.id)

  const out: OrderImportResult = { matched: 0, unmatched: [], settles: 0, invoices: 0, payments: 0, lower: [] }
  const marks: { jobId: string; status: 'reconciled' | 'paid'; no?: string }[] = []
  const seen = new Set<string>()

  for (const it of items) {
    const row = byNo.get(it.jobNo.trim().toLowerCase())
    if (!row) {
      out.unmatched.push(it.jobNo)
      continue
    }
    // 一张表里同一个工号写了两行 —— 只认第一行。
    if (seen.has(row.jobId)) continue
    seen.add(row.jobId)
    out.matched++

    if (it.settle && !row.settle) {
      marks.push({ jobId: row.jobId, status: it.settle, no: it.settleNo })
      out.settles++
    }

    if (row.free) continue
    const wantInv = it.invoiceCny
    const wantPay = it.paymentCny
    const invUp = wantInv !== undefined && r2(wantInv - row.invoicedCny) > 0
    const payUp = wantPay !== undefined && r2(wantPay - row.paidCny) > 0
    if (wantInv !== undefined && r2(wantInv - row.invoicedCny) < 0) out.lower.push(`${row.jobNo} 开票`)
    if (wantPay !== undefined && r2(wantPay - row.paidCny) < 0) out.lower.push(`${row.jobNo} 收款`)
    if (!invUp && !payUp) continue

    let lineId = firstLine.get(row.jobId)
    // 新开的行: 原来的老数不再算, 开票、收款都按合计记全。
    const fresh = !lineId
    if (!lineId) {
      lineId = await createPoLine(row.jobId, by, { amountCny: row.amountCny ?? 0 })
      firstLine.set(row.jobId, lineId)
    }
    const invAmt = fresh ? r2(invUp ? wantInv! : row.invoicedCny) : invUp ? r2(wantInv! - row.invoicedCny) : 0
    const payAmt = fresh ? r2(payUp ? wantPay! : row.paidCny) : payUp ? r2(wantPay! - row.paidCny) : 0
    if (invAmt > 0) {
      await createMoneyEvent(
        {
          poLineId: lineId,
          kind: 'invoice',
          amountCny: invAmt,
          eventDate: it.invoiceDate ?? todayYmd,
          invoiceNo: it.invoiceNo,
          note: '导入',
        },
        by,
      )
      out.invoices++
    }
    if (payAmt > 0) {
      await createMoneyEvent(
        {
          poLineId: lineId,
          kind: 'payment',
          amountCny: payAmt,
          eventDate: it.paymentDate ?? todayYmd,
          note: '导入',
        },
        by,
      )
      out.payments++
    }
  }

  await setExtSettles(marks, by, new Date().toISOString())
  return out
}
