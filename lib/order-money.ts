// 财务 / 订单资金 (per-order money) domain logic.
//
// One OrderMoneyRow == one 订单 (job). This is the boss's "money visibility"
// view: every order, read left-to-right through its MONEY pipeline exactly the
// way the master board reads a part left-to-right through its WORK pipeline.
//
//   合同 → 金额 → 外协 → 出货 → 开票 → 回款 → 应收
//
// Each money stage carries a hard ¥ amount AND a scannable state, so the boss
// finds where an order's money is stuck the same way he finds where a part is
// stuck on the production board — by eye, down a column.
//
// Pure functions only ⇒ safe to import from both server and client modules.
// The DB assembly lives in lib/db.ts#getOrderMoneyRows; the colors live in the
// client component. Everything that decides STATE or NUMBERS lives here so the
// page, the table, and the Excel export can never disagree.

import type { JobStatus } from './data'

// One row of the per-order money board. The system owns every field here —
// nothing on this view is hand-edited (edits happen in 应收 / 外协 / 录入). It's
// a read: the consolidated money position of one order.
export type OrderMoneyRow = {
  jobId: string
  jobNo: string
  customer: string
  product: string
  engineer?: string // 客户工程师 / 联系人
  salesperson?: string // 商务
  status: JobStatus
  createdAt?: string // 下单时间 (ISO)
  dueDate?: string // 交期 (YYYY-MM-DD)

  // 合同
  contractNo?: string // 合同号 — absent ⇒ 无合同 (the boss's money-leak flag)

  // 金额 — the order's contract value (jobs.amount_cny)
  amountCny?: number

  // 外协 — aggregated across every outsource block on the order's parts
  outsourceCount: number // how many blocks (单)
  outsourceOpenCount: number // still at a vendor
  outsourceSpendCny: number // Σ priced block amounts (外发金额)
  outsourceFirstSent?: string // earliest 派单日期 (YYYY-MM-DD)
  outsourceLastReturn?: string // latest 回件日期; undefined while any block open

  // 出货
  isShipped: boolean
  lastShipDate?: string // most recent 出货日期 (YYYY-MM-DD)

  // 开票 / 回款 — aggregated across the order's shipments (shipment_finance)
  shipmentCount: number
  invoicedCny: number // Σ 开票金额
  paidCny: number // Σ 回款金额
  outstandingCny: number // Σ outstanding (应收余额)
  hasInvoice: boolean // any shipment invoiced
  hasOverdue: boolean // any shipment past the aging window, still owed

  // 毛利 = 金额 − 外协支出
  marginCny?: number
}

// === Overall money status (the leading 状态 column) ===
//
// The single L→R answer to "where is this order's money in its life?". This is
// purely the production→cash lifecycle; 无合同 is its OWN column (and its own
// filter), because at this factory most orders carry no 合同号 — folding that
// into the status would paint every row the same and kill the scan. Priority is
// ordered by what costs money RIGHT NOW: overdue cash first.
export type OrderMoneyStatus =
  | 'overdue' // 逾期 — invoiced, past term, still owed
  | 'in_production' // 在产 — not shipped yet
  | 'uninvoiced' // 待开票 — shipped, not invoiced
  | 'unpaid' // 待回款 — invoiced, still owed (within term)
  | 'settled' // 已结清 — paid in full

export function orderMoneyStatus(row: OrderMoneyRow): OrderMoneyStatus {
  if (row.hasOverdue) return 'overdue'
  if (!row.isShipped) return 'in_production'
  if (!row.hasInvoice) return 'uninvoiced'
  if (row.outstandingCny > 0) return 'unpaid'
  return 'settled'
}

export const ORDER_STATUS_LABEL: Record<OrderMoneyStatus, string> = {
  overdue: '逾期',
  in_production: '在产',
  uninvoiced: '待开票',
  unpaid: '待回款',
  settled: '已结清',
}

// === 外协 duration ===
//
// "How long it took, in total, for the order" — the span from the order's
// first 派单 to its last 回件 (or to today while anything is still out). This is
// the number the boss asked for: total outsourcing turnaround per order.
export function outsourceDurationDays(
  row: OrderMoneyRow,
  todayYmd: string,
): number | undefined {
  if (!row.outsourceFirstSent) return undefined
  const end = row.outsourceLastReturn ?? todayYmd
  return daysBetween(row.outsourceFirstSent, end)
}

// Whole-day gap between two YYYY-MM-DD strings (b − a). Factory-local dates, so
// UTC-midnight math is exact (no tz drift). Mirrors lib/finance.ts.
function daysBetween(aYmd: string, bYmd: string): number {
  const a = Date.parse(`${aYmd}T00:00:00Z`)
  const b = Date.parse(`${bYmd}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

// === Filtering (shared by page + export so they never diverge) ===

export type OrderMoneyFilter =
  | 'all'
  | 'no_contract' // 无合同
  | 'outsourced' // 走过外协 (any block)
  | 'unpaid' // 应收余额 > 0
  | 'overdue' // 逾期

export const ORDER_FILTER_LABEL: Record<OrderMoneyFilter, string> = {
  all: '全部',
  no_contract: '无合同',
  outsourced: '外协',
  unpaid: '未回款',
  overdue: '逾期',
}

export function isOrderMoneyFilter(x: string): x is OrderMoneyFilter {
  return (
    x === 'all' ||
    x === 'no_contract' ||
    x === 'outsourced' ||
    x === 'unpaid' ||
    x === 'overdue'
  )
}

function matchesFilter(row: OrderMoneyRow, filter: OrderMoneyFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'no_contract':
      return !row.contractNo
    case 'outsourced':
      return row.outsourceCount > 0
    case 'unpaid':
      return row.outstandingCny > 0
    case 'overdue':
      return row.hasOverdue
  }
}

function matchesQuery(row: OrderMoneyRow, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  const hay = [
    row.customer,
    row.jobNo,
    row.product,
    row.contractNo,
    row.salesperson,
    row.engineer,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return hay.includes(needle)
}

export function applyOrderMoneyFilters(
  rows: OrderMoneyRow[],
  opts: { q?: string; filter?: OrderMoneyFilter },
): OrderMoneyRow[] {
  const filter = opts.filter ?? 'all'
  const q = opts.q ?? ''
  return rows.filter((r) => matchesFilter(r, filter) && matchesQuery(r, q))
}

// Per-filter tallies for the toggle row (mirrors the master board affordance).
// Independent of the search query, like the AR ledger.
export function orderMoneyCounts(
  rows: OrderMoneyRow[],
): Record<OrderMoneyFilter, number> {
  const counts: Record<OrderMoneyFilter, number> = {
    all: rows.length,
    no_contract: 0,
    outsourced: 0,
    unpaid: 0,
    overdue: 0,
  }
  for (const r of rows) {
    if (!r.contractNo) counts.no_contract += 1
    if (r.outsourceCount > 0) counts.outsourced += 1
    if (r.outstandingCny > 0) counts.unpaid += 1
    if (r.hasOverdue) counts.overdue += 1
  }
  return counts
}

// === Aggregates (KPI strip) ===

export type OrderMoneyTotals = {
  orderCount: number
  orderValueCny: number // Σ 金额 — the book of orders on hand
  noContractCount: number // 无合同 — the leak count
  outsourcedCount: number // orders that went through 外协
  outsourceSpendCny: number // Σ 外协支出
  outstandingCny: number // Σ 应收余额
  overdueCny: number // Σ owed on overdue orders
  overdueCount: number
}

export function orderMoneyTotals(rows: OrderMoneyRow[]): OrderMoneyTotals {
  const t: OrderMoneyTotals = {
    orderCount: rows.length,
    orderValueCny: 0,
    noContractCount: 0,
    outsourcedCount: 0,
    outsourceSpendCny: 0,
    outstandingCny: 0,
    overdueCny: 0,
    overdueCount: 0,
  }
  for (const r of rows) {
    t.orderValueCny += r.amountCny ?? 0
    if (!r.contractNo) t.noContractCount += 1
    if (r.outsourceCount > 0) t.outsourcedCount += 1
    t.outsourceSpendCny += r.outsourceSpendCny
    t.outstandingCny += r.outstandingCny
    if (r.hasOverdue) {
      t.overdueCny += r.outstandingCny
      t.overdueCount += 1
    }
  }
  return t
}

// === Excel export ===
//
// One row per order, money pipeline left-to-right. Numbers stay numeric so the
// boss can SUM any column natively in Excel — the whole point of "more
// intuitive than Excel": it IS Excel, already filled in.
export const ORDER_EXPORT_HEADERS = [
  '工号',
  '客户',
  '产品',
  '合同号',
  '金额',
  '外协单数',
  '外协金额',
  '外协天数',
  '已开票',
  '已回款',
  '应收余额',
  '毛利',
  '状态',
] as const

function numCell(n: number | undefined): number | string {
  return typeof n === 'number' && Number.isFinite(n) ? n : ''
}

export function buildOrderExportAoa(
  rows: OrderMoneyRow[],
  todayYmd: string,
): (string | number)[][] {
  const aoa: (string | number)[][] = [ORDER_EXPORT_HEADERS.slice() as string[]]
  for (const r of rows) {
    const days = outsourceDurationDays(r, todayYmd)
    aoa.push([
      r.jobNo ?? '',
      r.customer ?? '',
      r.product ?? '',
      r.contractNo ?? '无合同',
      numCell(r.amountCny),
      r.outsourceCount || '',
      numCell(r.outsourceSpendCny || undefined),
      r.outsourceCount > 0 && days != null ? days : '',
      numCell(r.invoicedCny || undefined),
      numCell(r.paidCny || undefined),
      numCell(r.outstandingCny || undefined),
      numCell(r.marginCny),
      ORDER_STATUS_LABEL[orderMoneyStatus(r)],
    ])
  }
  return aoa
}

export const ORDER_EXPORT_COL_WIDTHS = [
  14, 16, 14, 16, 12, 9, 12, 9, 12, 12, 12, 12, 10,
]
