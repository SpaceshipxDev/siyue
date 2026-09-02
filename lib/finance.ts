// 财务 / 应收账款 (accounts-receivable) domain logic.
//
// One FinanceRow == one 出货单 (shipment). The system fills the left columns
// (date / customer / qty / 派单号 / 商务 / 外发金额 / auto 金额); 商务 fills
// the 开票 (invoice) + 回款 (collection) columns. Everything here is pure —
// no DB, no React — so the /finance page (server), the export route, and the
// client ledger component all share one source of truth.
//
// Pure functions only ⇒ safe to import from both server and client modules.

export type FinanceStatus =
  | 'uninvoiced' // 未开票 — shipped, no invoice issued yet
  | 'invoiced' // 已开票 — invoiced, nothing collected
  | 'partial' // 部分回款 — collected less than invoiced
  | 'paid' // 已回款 — collected in full
  | 'overdue' // 逾期 — invoiced + unpaid (or short) past the aging window

// One row of the AR ledger. The `computed*` / context fields come straight
// from the system (read-only on screen); the rest mirror the shipment_finance
// row and are edited inline.
export type FinanceRow = {
  shipmentId: string
  docNo?: string // 派单号 (YNMX-yy-m-d-NNN)
  shipDate: string // ISO timestamp the 出货单 was created (出货日期)
  jobId: string
  jobNo: string
  customer: string // 客户名称
  product: string
  salesperson?: string // 商务 — 建单人 (记账表沿用的那一列)
  // 越侬商务 — 这单归谁, 导入时必填。出货统计按它算业绩; 老单没填的退回
  // salesperson (建单人), 因为那是当时唯一留下的名字。
  yuenongBusiness?: string
  qty: number // 数量 — total units across the shipment's parts
  partNos: string // 物料号 — distinct part numbers in the shipment, joined
  // Auto 金额: Σ(shipped qty × part unit price) for this shipment, with a
  // single-shipment fall back to the whole job amount. undefined when nothing
  // could be priced — finance then types the number in.
  computedAmountCny?: number
  externalSpendCny: number // 外发金额 (job-level outsource spend)
  // --- shipment_finance (editable) ---
  saleAmountCny?: number // 金额 override; undefined ⇒ use computedAmountCny
  contact?: string // 名称 / 对接人
  pendingFlag?: string // 待确定
  invoiceNo?: string
  invoiceDate?: string // 开票日期 (YYYY-MM-DD)
  invoiceAmountCny?: number // 开票金额
  paymentDate?: string // 回款时间 (YYYY-MM-DD)
  paymentAmountCny?: number // 回款金额
}

// Days an invoice can sit unpaid before the row flags as 逾期. 30 days is the
// common 月结 term for the factory's larger customers; tune here if needed.
export const AR_AGING_DAYS = 30

// The 金额 that actually counts for this delivery: finance's override wins,
// else the system-computed value.
export function effectiveAmount(row: FinanceRow): number | undefined {
  return row.saleAmountCny ?? row.computedAmountCny
}

// Amount still owed on this delivery. Only meaningful once invoiced; the
// invoice amount is the basis (it's what the customer was actually billed),
// falling back to the delivery amount if finance left 开票金额 blank.
export function outstanding(row: FinanceRow): number {
  if (!row.invoiceDate) return 0
  const billed = row.invoiceAmountCny ?? effectiveAmount(row) ?? 0
  const paid = row.paymentAmountCny ?? 0
  return Math.max(0, billed - paid)
}

// Whole-day gap between two YYYY-MM-DD strings (b − a). Both are factory-local
// dates already, so plain UTC-midnight math is exact (no tz drift).
function daysBetween(aYmd: string, bYmd: string): number {
  const a = Date.parse(`${aYmd}T00:00:00Z`)
  const b = Date.parse(`${bYmd}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

// Days a delivery is past the aging window (0 if within term or uninvoiced).
// Drives the "逾期 N天" readout on the master board's 收款 light.
export function overdueDays(
  invoiceDate: string | undefined,
  todayYmd: string,
): number {
  if (!invoiceDate) return 0
  return Math.max(0, daysBetween(invoiceDate, todayYmd) - AR_AGING_DAYS)
}

export function financeStatus(row: FinanceRow, todayYmd: string): FinanceStatus {
  if (!row.invoiceDate) return 'uninvoiced'
  const billed = row.invoiceAmountCny ?? effectiveAmount(row) ?? 0
  const paid = row.paymentAmountCny ?? 0
  const settled = billed > 0 && paid >= billed
  if (settled) return 'paid'
  // Unpaid or short. Past the aging window ⇒ 逾期; otherwise show its
  // invoice/partial state.
  if (daysBetween(row.invoiceDate, todayYmd) > AR_AGING_DAYS) return 'overdue'
  return paid > 0 ? 'partial' : 'invoiced'
}

export const STATUS_LABEL: Record<FinanceStatus, string> = {
  uninvoiced: '未开票',
  invoiced: '已开票',
  partial: '部分回款',
  paid: '已回款',
  overdue: '逾期',
}

// Maps a status to the existing Pill tone vocabulary (see app/_ui.tsx).
export const STATUS_TONE: Record<
  FinanceStatus,
  'neutral' | 'info' | 'warning' | 'success' | 'overdue'
> = {
  uninvoiced: 'neutral',
  invoiced: 'info',
  partial: 'warning',
  paid: 'success',
  overdue: 'overdue',
}

// === Filtering (shared by page + export so they never diverge) ===

export type FinanceFilter = 'all' | 'uninvoiced' | 'unpaid' | 'overdue'

export const FILTER_LABEL: Record<FinanceFilter, string> = {
  all: '全部',
  uninvoiced: '未开票',
  unpaid: '未回款',
  overdue: '逾期',
}

export function isFinanceFilter(x: string): x is FinanceFilter {
  return x === 'all' || x === 'uninvoiced' || x === 'unpaid' || x === 'overdue'
}

export function matchesFilter(
  row: FinanceRow,
  filter: FinanceFilter,
  todayYmd: string,
): boolean {
  if (filter === 'all') return true
  const s = financeStatus(row, todayYmd)
  if (filter === 'uninvoiced') return s === 'uninvoiced'
  if (filter === 'overdue') return s === 'overdue'
  // 'unpaid' — invoiced but not settled (includes partial + overdue).
  return s === 'invoiced' || s === 'partial' || s === 'overdue'
}

// Free-text search over the columns finance actually scans by.
export function matchesQuery(row: FinanceRow, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  const hay = [
    row.customer,
    row.jobNo,
    row.docNo,
    row.salesperson,
    row.contact,
    row.product,
    row.partNos,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return hay.includes(needle)
}

export function applyFinanceFilters(
  rows: FinanceRow[],
  opts: { q?: string; filter?: FinanceFilter; todayYmd: string },
): FinanceRow[] {
  const filter = opts.filter ?? 'all'
  const q = opts.q ?? ''
  return rows.filter(
    (r) => matchesFilter(r, filter, opts.todayYmd) && matchesQuery(r, q),
  )
}

// Count per filter bucket — drives the small tallies on the filter toggles
// (matches the master board's 在产/已出货 count affordance). Independent of
// the search query, like the master toggles.
export function financeCounts(
  rows: FinanceRow[],
  todayYmd: string,
): Record<FinanceFilter, number> {
  const counts: Record<FinanceFilter, number> = {
    all: rows.length,
    uninvoiced: 0,
    unpaid: 0,
    overdue: 0,
  }
  for (const r of rows) {
    const s = financeStatus(r, todayYmd)
    if (s === 'uninvoiced') counts.uninvoiced += 1
    if (s === 'invoiced' || s === 'partial' || s === 'overdue') counts.unpaid += 1
    if (s === 'overdue') counts.overdue += 1
  }
  return counts
}

// === Aggregates (KPI strip) ===

export type FinanceTotals = {
  // Total still owed across every invoiced-but-unpaid delivery (cash you're
  // waiting on, regardless of month). This is the number the boss watches.
  outstandingCny: number
  // Of that, the slice that's gone past the aging window.
  overdueCny: number
  overdueCount: number
  // This-month flows.
  invoicedThisMonthCny: number
  collectedThisMonthCny: number
}

// `month` is a 'YYYY-MM' prefix (factory-local). Totals are computed over the
// FULL row set (not the filtered view) so the AR balance is a true position.
export function financeTotals(
  rows: FinanceRow[],
  todayYmd: string,
  month: string,
): FinanceTotals {
  let outstandingCny = 0
  let overdueCny = 0
  let overdueCount = 0
  let invoicedThisMonthCny = 0
  let collectedThisMonthCny = 0
  for (const r of rows) {
    const owed = outstanding(r)
    outstandingCny += owed
    if (owed > 0 && financeStatus(r, todayYmd) === 'overdue') {
      overdueCny += owed
      overdueCount += 1
    }
    if (r.invoiceDate?.startsWith(month)) {
      invoicedThisMonthCny += r.invoiceAmountCny ?? effectiveAmount(r) ?? 0
    }
    if (r.paymentDate?.startsWith(month)) {
      collectedThisMonthCny += r.paymentAmountCny ?? 0
    }
  }
  return {
    outstandingCny,
    overdueCny,
    overdueCount,
    invoicedThisMonthCny,
    collectedThisMonthCny,
  }
}

// === Excel export ===
//
// Column order is locked to 王雪梅's existing sheet so the export drops
// straight into her bank/tax reconciliation. `时间` columns are reserved for
// her manual precise timestamps; we fill the `日期`/`金额` columns the system
// actually owns. See the page header note.
export const EXPORT_HEADERS = [
  '日期',
  '客户名称',
  '待确定',
  '金额',
  '数量',
  '名称',
  '物料号',
  '外发金额',
  '派单号',
  '商务',
  '开票时间',
  '开票日期',
  '开票金额',
  '回款时间',
  '回款金额',
] as const

// '2026-05-05T...' (ISO) or '2026-05-05' → '5月5日' in factory-local time.
export function shipDateLabel(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    // Already a plain YYYY-MM-DD — format without a Date round-trip.
    const parts = iso.split('-')
    if (parts.length >= 3) return `${Number(parts[1])}月${Number(parts[2])}日`
    return iso
  }
  const ymd = d
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
    .split('-')
  return `${Number(ymd[1])}月${Number(ymd[2])}日`
}

function numCell(n: number | undefined): number | string {
  return typeof n === 'number' && Number.isFinite(n) ? n : ''
}

// Build the array-of-arrays for XLSX.utils.aoa_to_sheet. Numbers stay numeric
// (not pre-formatted strings) so Excel can SUM the 金额/开票金额/回款金额
// columns natively.
export function buildExportAoa(
  rows: FinanceRow[],
): (string | number)[][] {
  const aoa: (string | number)[][] = [EXPORT_HEADERS.slice() as string[]]
  for (const r of rows) {
    aoa.push([
      shipDateLabel(r.shipDate), // 日期
      r.customer ?? '', // 客户名称
      r.pendingFlag ?? '', // 待确定
      numCell(effectiveAmount(r)), // 金额
      numCell(r.qty), // 数量
      r.contact ?? '', // 名称 (对接人)
      r.partNos ?? '', // 物料号
      numCell(r.externalSpendCny || undefined), // 外发金额
      r.docNo ?? '', // 派单号
      r.salesperson ?? '', // 商务
      '', // 开票时间 (manual)
      r.invoiceDate ?? '', // 开票日期
      numCell(r.invoiceAmountCny), // 开票金额
      r.paymentDate ?? '', // 回款时间
      numCell(r.paymentAmountCny), // 回款金额
    ])
  }
  return aoa
}

// Column widths (in "characters") matching the header order — keeps the
// exported sheet readable without manual column dragging.
export const EXPORT_COL_WIDTHS = [
  10, 16, 10, 12, 8, 10, 14, 12, 18, 10, 12, 12, 12, 12, 12,
]

// === 出货统计 ===
//
// 这个月出了多少货, 哪天出的, 谁出的 — 三个问题, 一份数据。
//
// 出货 rows already carry everything it needs (出货日期, 金额, 越侬商务), so
// nothing here is entered a second time: 出一单货, 统计自己就变了。
//
// 金额 is effectiveAmount — 财务改过的数字优先, 没改过就按零件单价 × 出货数
// 算出来的。一单没有价可算的 (没填单价、也没人手工补) 记在 count 里但不进
// 金额, 因为把它当 0 元会让"这个月出了多少钱"这个数字变成假的; 页面把这种
// 单子的条数单独说出来。

export type ShipStat = {
  key: string // 日期 'YYYY-MM-DD' 或 商务姓名
  count: number // 单数
  amountCny: number // 金额合计
  unpriced: number // 其中没有金额的单数
}

export type ShipTotals = {
  count: number
  amountCny: number
  unpriced: number
}

/**
 * 出货 rows whose 出货日 (factory-local) starts with `period` — 'YYYY-MM' for a
 * month, 'YYYY' for the year to date.
 */
export function shipmentsInPeriod(
  rows: FinanceRow[],
  period: string,
  dayOf: (iso: string) => string,
): FinanceRow[] {
  return rows.filter((r) => dayOf(r.shipDate).startsWith(period))
}

export function shipTotals(rows: FinanceRow[]): ShipTotals {
  let amountCny = 0
  let unpriced = 0
  for (const r of rows) {
    const a = effectiveAmount(r)
    if (typeof a === 'number') amountCny += a
    else unpriced += 1
  }
  return { count: rows.length, amountCny, unpriced }
}

function groupShipments(
  rows: FinanceRow[],
  keyOf: (r: FinanceRow) => string,
): ShipStat[] {
  const by = new Map<string, ShipStat>()
  for (const r of rows) {
    const key = keyOf(r)
    const g = by.get(key) ?? { key, count: 0, amountCny: 0, unpriced: 0 }
    g.count += 1
    const a = effectiveAmount(r)
    if (typeof a === 'number') g.amountCny += a
    else g.unpriced += 1
    by.set(key, g)
  }
  return [...by.values()]
}

/** 按出货日期 — 早到晚, 一天一行。 */
export function shipStatsByDay(
  rows: FinanceRow[],
  dayOf: (iso: string) => string,
): ShipStat[] {
  return groupShipments(rows, (r) => dayOf(r.shipDate)).sort((a, b) =>
    a.key < b.key ? -1 : 1,
  )
}

// 这单归谁: 越侬商务 first — that's the name the order was confirmed under.
// Older orders predate the field and only ever carried 建单人, so they fall
// back to it rather than piling up under 未分配.
export function shipSalesperson(r: FinanceRow): string {
  return (r.yuenongBusiness ?? '').trim() || (r.salesperson ?? '').trim() || '未分配'
}

/** 按商务 — 金额高的在上, 那是这张表要回答的问题。 */
export function shipStatsBySalesperson(rows: FinanceRow[]): ShipStat[] {
  return groupShipments(rows, shipSalesperson).sort((a, b) =>
    a.amountCny !== b.amountCny
      ? b.amountCny - a.amountCny
      : a.key.localeCompare(b.key, 'zh'),
  )
}

// === 外协费用统计 ===
//
// 口径跟「月度」那一行完全一样, 一个字都没另算:
//   金额 — 单头的总价; 加急单没有单头价, 退回按件小计 (blockLineTotalsSum)
//   记账日 — 回件结算日 (blockClosedAt): 整单全部回厂那天。发出去还没回的
//     不算成本, 因为那笔钱还没结。
// 两页说的钱必须是同一个数, 否则月底对账时人会不知道信哪个。
//
// 还在外面没回的单子另算一块 (还没结的钱), 不混进当月成本 — 它回答的是另
// 一个问题: 现在有多少钱压在外协厂手里。

export type OutsourceStatRow = {
  /** 单头总价, 没有就按件小计; 两个都没有算 0 并计进 unpriced。 */
  amountCny: number
  /** 回件结算日 'YYYY-MM-DD' / 'MM-DD'; 未回厂为 undefined。 */
  closedAt?: string
  vendorName: string
  priced: boolean
}

export type VendorStat = {
  key: string // 供应商名
  count: number
  amountCny: number
  unpriced: number
}

export function outsourceStatsByVendor(rows: OutsourceStatRow[]): VendorStat[] {
  const by = new Map<string, VendorStat>()
  for (const r of rows) {
    const g = by.get(r.vendorName) ?? {
      key: r.vendorName,
      count: 0,
      amountCny: 0,
      unpriced: 0,
    }
    g.count += 1
    g.amountCny += r.amountCny
    if (!r.priced) g.unpriced += 1
    by.set(r.vendorName, g)
  }
  return [...by.values()].sort((a, b) =>
    a.amountCny !== b.amountCny
      ? b.amountCny - a.amountCny
      : a.key.localeCompare(b.key, 'zh'),
  )
}

export function outsourceTotals(rows: OutsourceStatRow[]): {
  count: number
  amountCny: number
  unpriced: number
} {
  let amountCny = 0
  let unpriced = 0
  for (const r of rows) {
    amountCny += r.amountCny
    if (!r.priced) unpriced += 1
  }
  return { count: rows.length, amountCny, unpriced }
}

// 结算日可能是 'YYYY-MM-DD' 也可能是工段完成时留下的 'MM-DD' —— 后者没有年,
// 所以按 MM 比, 跟「月度」页同一个将就法。
export function closedInMonth(closedAt: string, month: string): boolean {
  const parts = closedAt.split('-')
  const mm = parts.length === 3 ? parts[1] : parts.length === 2 ? parts[0] : ''
  return mm === month
}
