import 'server-only'
import {
  createMoneyEvent,
  createPoLine,
  getCustomerStatementLines,
  getFenqiData,
  getFinanceRows,
  getOrderLedgerRows,
} from './db'
import { setExtSettles } from './ext-settle'
import { addReceivablePayment, createReceivable, getReceivables } from './receivable'
import { customerSettledFrom } from './settle-shared'
import { getNoReconcile, LINE_MARK } from './no-reconcile'
import { buildCustomerDuizhang, keepCustomerLines, monthBounds, pickCustomerLines } from './duizhang'
import { shanghaiDay } from './today'

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
 * 进应收 (于海伟 2026-11-04) —— 标了已对账 / 已回款、或者填了开票的单, 跟对账页上
 *           点「审批通过」一样落应收单 (财务 → 应收): 按客户 + 出货月份一张,
 *           认的就是这几个单号, 金额照对账单现算 (出货金额)。已回款的整张记一
 *           笔回款; 填了收款的按表上收款合计记一笔。已经进过应收单的单号不再
 *           进; 没出货、没定价的进不了, 只打已对账的标记。
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
  /** 落了几张应收单。 */
  receivables: number
  /** 想进应收、没进去的 (没出货 / 没定价 / 已经审过)。 */
  notReceivable: string[]
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

  const out: OrderImportResult = {
    matched: 0,
    unmatched: [],
    settles: 0,
    invoices: 0,
    payments: 0,
    lower: [],
    receivables: 0,
    notReceivable: [],
  }
  // 要进应收的单 —— 工号 → 表上那一行。
  const toReceive = new Map<string, OrderImportItem>()
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
    if (!row.settle && !row.free && (it.settle || (it.invoiceCny ?? 0) > 0))
      toReceive.set(row.jobNo, it)

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
  if (toReceive.size > 0) await intoReceivables(toReceive, by, todayYmd, out)
  return out
}

// 按客户 + 出货月份落应收单 —— 跟 /api/mutate approveDuizhang 同一个算法。
async function intoReceivables(
  want: Map<string, OrderImportItem>,
  by: string,
  todayYmd: string,
  out: OrderImportResult,
): Promise<void> {
  const [rows, receivables, marks] = await Promise.all([
    getFinanceRows(),
    getReceivables(),
    getNoReconcile().catch(() => ({}) as Record<string, unknown>),
  ])
  const groups = new Map<string, { customer: string; period: string; jobNos: Set<string> }>()
  const shipped = new Set<string>()
  for (const r of rows) {
    if (!want.has(r.jobNo) || r.jobNo in marks) continue
    shipped.add(r.jobNo)
    const customer = (r.customer ?? '').trim()
    const period = shanghaiDay(r.shipDate).slice(0, 7)
    const key = `${customer}|${period}`
    if (!groups.has(key)) groups.set(key, { customer, period, jobNos: new Set() })
    groups.get(key)!.jobNos.add(r.jobNo)
  }
  for (const no of want.keys()) if (!shipped.has(no)) out.notReceivable.push(`${no} 没出货`)
  // 一张单分几个月出的货 —— 表上的收款只算进第一张应收单, 不重复记。
  const paidUsed = new Set<string>()

  for (const g of groups.values()) {
    const settled = customerSettledFrom(receivables, g.customer, g.period)
    if (settled.whole) continue
    const nos = [...g.jobNos].filter((n) => !settled.jobNos.has(n))
    if (nos.length === 0) continue
    const { from, to } = monthBounds(g.period)
    const detail = await getCustomerStatementLines(g.customer, from, to, shanghaiDay)
    const keep = new Set(nos)
    const sheet = pickCustomerLines(
      keepCustomerLines(
        buildCustomerDuizhang(rows, g.customer, from, to, shanghaiDay, detail),
        (l) => !(`${LINE_MARK}${l.key}` in marks),
      ),
      (no) => keep.has(no),
    )
    const label = `${g.customer} ${Number(g.period.slice(5))}月`
    if (sheet.lines.length === 0) continue
    if (sheet.unpricedCount > 0) {
      out.notReceivable.push(`${label} 有 ${sheet.unpricedCount} 行没定价`)
      continue
    }
    const onSheet = [...new Set(sheet.lines.map((l) => l.docNo))]
    let rec
    try {
      rec = await createReceivable({
        customer: g.customer,
        period: g.period,
        amountCny: sheet.totalAmountCny,
        lineCount: sheet.lines.length,
        totalQty: sheet.totalQty,
        jobNos: onSheet,
        approvedBy: by,
        nowIso: new Date().toISOString(),
        todayYmd,
      })
    } catch (e) {
      out.notReceivable.push(`${label} ${e instanceof Error ? e.message : '没落上'}`)
      continue
    }
    out.receivables++
    // 回款: 已回款 → 整张收完; 不然按表上这几单的收款合计 (不超过应收)。
    const items = onSheet.map((n) => want.get(n)!).filter(Boolean)
    const allPaid = items.length > 0 && items.every((i) => i.settle === 'paid')
    const paid = Math.min(
      rec.amountCny,
      allPaid
        ? rec.amountCny
        : items.reduce((s, i) => s + (paidUsed.has(i.jobNo) ? 0 : (i.paymentCny ?? 0)), 0),
    )
    for (const i of items) paidUsed.add(i.jobNo)
    if (paid > 0) {
      const dates = items.map((i) => i.paymentDate).filter((d): d is string => !!d).sort()
      await addReceivablePayment(
        rec.id,
        {
          date: dates[dates.length - 1] ?? todayYmd,
          amountCny: Math.round(paid * 100) / 100,
          note: allPaid ? '导入 · 已回款' : '导入',
        },
        by,
        new Date().toISOString(),
      )
    }
  }
}
