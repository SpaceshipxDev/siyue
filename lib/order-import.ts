import 'server-only'
import {
  createMoneyEvent,
  createPoLine,
  getFenqiData,
  getFinanceRows,
  getOrderLedgerRows,
} from './db'
import { setExtSettles } from './ext-settle'
import {
  addReceivablePayment,
  createReceivable,
  getReceivables,
  voidImportedReceivable,
} from './receivable'
import type { OrderLedgerRow } from './data'
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
 * 进应收 (于海伟 2026-11-04) —— 标了已对账 / 已回款的单落应收单。只认对账那一
 *           格: 导出的表上开票那一格本来就带着系统里开过的票, 拿它当条件, 没
 *           对过账的单也被扫进了应收 (于海伟: 这 9 单没对账, 却在 9 月应收里)。
 *           (财务 → 应收): 按客户 + 下单月份一张 —— 跟「财务 → 订单」分月
 *           一个口径, 导的是哪个月的表, 应收就落在哪个月 (于海伟: 8 月下单、
 *           9 月出货的单按出货月份落, 跑到了 9 月应收里, 对不上)。认的就是
 *           这几个单号。金额以导入表为准 —— 表上的订单额, 没填用系统
 *           里的订单额, 再没有用开票额 (于海伟: 表上 72 单对完是 458483.1,
 *           按出货金额现算只有 40 万, 对不上)。已回款的整张记一笔回款; 填了
 *           收款的按表上收款合计记一笔。
 *           对账页上审批过的单号不再进。导入落的应收单 (imported), 只要它
 *           认的单号在这张表上, 再导一次就作废重开 —— 表上不再算已对账的单
 *           就此退出应收, 应收跟着表走。
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
  /** 表上的订单额。 */
  orderCny?: number
}

export type OrderImportResult = {
  matched: number
  unmatched: string[]
  settles: number
  invoices: number
  payments: number
  /** 表上的数比系统里少, 没动的。 */
  lower: string[]
  /** 落了几张应收单, 合计多少。 */
  receivables: number
  receivableCny: number
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
    receivableCny: 0,
    notReceivable: [],
  }
  // 要进应收的单 —— 工号 → 表上那一行 + 系统里那一行。
  const toReceive = new Map<string, { it: OrderImportItem; row: OrderLedgerRow }>()
  // 这张表上有的单号 (不管对没对账) —— 导入落的应收单认的单在表上, 就按表重开。
  const inFile = new Set<string>()
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
    inFile.add(row.jobNo)
    out.matched++

    if (it.settle && !row.settle) {
      marks.push({ jobId: row.jobId, status: it.settle, no: it.settleNo })
      out.settles++
    }
    if (!row.free && it.settle) toReceive.set(row.jobNo, { it, row })

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
  await intoReceivables(toReceive, inFile, by, todayYmd, out)
  return out
}

/** 这一单进应收的金额 —— 表上订单额 > 系统订单额 > 表上开票额。 */
export function receivableAmountOf(
  it: Pick<OrderImportItem, 'orderCny' | 'invoiceCny'>,
  row: Pick<OrderLedgerRow, 'amountCny'>,
): number | undefined {
  const n = it.orderCny ?? row.amountCny ?? it.invoiceCny
  return typeof n === 'number' && n > 0 ? r2(n) : undefined
}

// 按客户 + 下单月份落应收单, 金额照导入表。
async function intoReceivables(
  want: Map<string, { it: OrderImportItem; row: OrderLedgerRow }>,
  inFile: Set<string>,
  by: string,
  todayYmd: string,
  out: OrderImportResult,
): Promise<void> {
  const [finance, receivables] = await Promise.all([getFinanceRows(), getReceivables()])
  const nowIso = new Date().toISOString()

  // 每单出了几件 —— 应收单上的件数。
  const shipQty = new Map<string, number>()
  for (const f of finance) {
    if (!want.has(f.jobNo)) continue
    shipQty.set(f.jobNo, (shipQty.get(f.jobNo) ?? 0) + f.qty)
  }
  // 应收单挂在下单那个月 —— 跟财务订单的月份一样。
  const periodOf = (no: string) => want.get(no)!.row.createdDate.slice(0, 7)
  const customerOf = (no: string) => want.get(no)!.row.customer.trim()

  // 导入落的 —— 打了 imported 的; 早先那一批没打 (同一个人、今天落的、回款都是
  // 导入记的、单号全在这张表里), 也算。
  const importMade = (r: (typeof receivables)[number]) =>
    r.imported ||
    (r.approvedBy === by &&
      shanghaiDay(r.approvedAt) === todayYmd &&
      !!r.jobNos?.length &&
      r.jobNos.every((n) => inFile.has(n)) &&
      r.payments.every((p) => (p.note ?? '').startsWith('导入')))

  const free = new Set(want.keys())
  for (const r of receivables) {
    if (r.voidedAt || r.manual) continue
    // 导入落的、认的单号在这张表上 —— 作废, 下面按表重开。
    if (importMade(r) && r.jobNos?.some((n) => inFile.has(n))) {
      if (await voidImportedReceivable(r.id, by, nowIso)) continue
    }
    const touched = r.jobNos
      ? r.jobNos.filter((n) => want.has(n))
      : [...want.keys()].filter((n) => customerOf(n) === r.customer && periodOf(n) === r.period)
    if (touched.length === 0) continue
    // 对账页上审批过的 (或者重开不了的) —— 不动, 这几单不再进。
    for (const n of touched) {
      if (!free.has(n)) continue
      free.delete(n)
      out.notReceivable.push(`${n} 已在应收单 ${r.no}`)
    }
  }

  const groups = new Map<string, { customer: string; period: string; nos: string[] }>()
  for (const no of free) {
    const { it, row } = want.get(no)!
    if (receivableAmountOf(it, row) === undefined) {
      out.notReceivable.push(`${no} 没有金额`)
      continue
    }
    const key = `${customerOf(no)}|${periodOf(no)}`
    if (!groups.has(key)) groups.set(key, { customer: customerOf(no), period: periodOf(no), nos: [] })
    groups.get(key)!.nos.push(no)
  }

  for (const g of groups.values()) {
    const items = g.nos.map((n) => want.get(n)!)
    const amount = r2(items.reduce((s, x) => s + receivableAmountOf(x.it, x.row)!, 0))
    let rec
    try {
      rec = await createReceivable({
        customer: g.customer,
        period: g.period,
        amountCny: amount,
        lineCount: g.nos.length,
        totalQty: g.nos.reduce((s, n) => s + (shipQty.get(n) ?? 0), 0),
        jobNos: g.nos,
        imported: true,
        approvedBy: by,
        nowIso,
        todayYmd,
      })
    } catch (e) {
      out.notReceivable.push(
        `${g.customer} ${Number(g.period.slice(5))}月 ${e instanceof Error ? e.message : '没落上'}`,
      )
      continue
    }
    out.receivables++
    out.receivableCny = r2(out.receivableCny + amount)
    // 回款: 已回款的那单按它的应收金额收完; 不然按表上的收款 (不超过它的应收)。
    const paid = r2(
      items.reduce((s, { it, row }) => {
        const own = receivableAmountOf(it, row)!
        return s + (it.settle === 'paid' ? own : Math.min(own, it.paymentCny ?? 0))
      }, 0),
    )
    if (paid > 0) {
      const dates = items.map((x) => x.it.paymentDate).filter((d): d is string => !!d).sort()
      await addReceivablePayment(
        rec.id,
        {
          date: dates[dates.length - 1] ?? todayYmd,
          amountCny: paid,
          note: items.every((x) => x.it.settle === 'paid') ? '导入 · 已回款' : '导入',
        },
        by,
        nowIso,
      )
    }
  }
}
