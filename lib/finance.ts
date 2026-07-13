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
  salesperson?: string // 商务
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
