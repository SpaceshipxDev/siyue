// 财务 / 支出台账 (cash-out ledger) domain logic.
//
// One Expense == one cash event (a salary payment, a rent transfer, a 报销).
// The categories are exactly the boss's list, annotated on the 财务 page:
// 工资（人员名单）、房租、水电、耗材、税费、原材料、日常开支（员工报销）.
//
// Pure functions only — no DB, no React — mirroring lib/finance.ts so the
// /finance page (server), the export route, and the client ledger component
// all share one source of truth.

export type ExpenseCategory =
  | 'payroll' // 工资
  | 'rent' // 房租
  | 'utilities' // 水电
  | 'consumables' // 耗材
  | 'tax' // 税费
  | 'materials' // 原材料
  | 'daily' // 日常开支（员工报销）
  | 'other' // 其他

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  'payroll',
  'rent',
  'utilities',
  'consumables',
  'tax',
  'materials',
  'daily',
  'other',
]

export const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  payroll: '工资',
  rent: '房租',
  utilities: '水电',
  consumables: '耗材',
  tax: '税费',
  materials: '原材料',
  daily: '日常开支',
  other: '其他',
}

export function isExpenseCategory(x: unknown): x is ExpenseCategory {
  return (
    typeof x === 'string' &&
    (EXPENSE_CATEGORIES as string[]).includes(x)
  )
}

export type Expense = {
  id: string
  expenseDate: string // YYYY-MM-DD
  category: ExpenseCategory
  amountCny: number
  payee?: string // 对象 — 工资/报销 = 人名; 房租/水电 = 收款方
  note?: string
  createdBy?: string
  createdAt: string // ISO
}

// === Filtering (shared by page + export so they never diverge) ===

export type ExpenseFilter = 'all' | ExpenseCategory

export function isExpenseFilter(x: string): x is ExpenseFilter {
  return x === 'all' || isExpenseCategory(x)
}

export function matchesExpenseQuery(row: Expense, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  const hay = [row.payee, row.note, CATEGORY_LABEL[row.category], row.createdBy]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return hay.includes(needle)
}

export function applyExpenseFilters(
  rows: Expense[],
  opts: { q?: string; filter?: ExpenseFilter; month?: string },
): Expense[] {
  const filter = opts.filter ?? 'all'
  const q = opts.q ?? ''
  return rows.filter(
    (r) =>
      (filter === 'all' || r.category === filter) &&
      (!opts.month || r.expenseDate.startsWith(opts.month)) &&
      matchesExpenseQuery(r, q),
  )
}

// Count per category — drives the filter-toggle tallies. Independent of the
// search query, like the master board toggles.
export function expenseCounts(rows: Expense[]): Record<ExpenseFilter, number> {
  const counts = { all: rows.length } as Record<ExpenseFilter, number>
  for (const c of EXPENSE_CATEGORIES) counts[c] = 0
  for (const r of rows) counts[r.category] += 1
  return counts
}

// === Aggregates (KPI strip) ===

export type ExpenseTotals = {
  monthTotalCny: number // 本月支出 (manual ledger only)
  monthPayrollCny: number // 本月工资
  yearTotalCny: number // 今年累计支出
}

// `month` is 'YYYY-MM'; year is derived from it. Totals run over the FULL row
// set (not the filtered view) so the position is true.
export function expenseTotals(rows: Expense[], month: string): ExpenseTotals {
  const year = month.slice(0, 4)
  let monthTotalCny = 0
  let monthPayrollCny = 0
  let yearTotalCny = 0
  for (const r of rows) {
    if (r.expenseDate.startsWith(month)) {
      monthTotalCny += r.amountCny
      if (r.category === 'payroll') monthPayrollCny += r.amountCny
    }
    if (r.expenseDate.startsWith(year)) yearTotalCny += r.amountCny
  }
  return { monthTotalCny, monthPayrollCny, yearTotalCny }
}

// Per-category sums for one month — the 月度 breakdown table.
export function categoryTotalsForMonth(
  rows: Expense[],
  month: string,
): Record<ExpenseCategory, number> {
  const out = {} as Record<ExpenseCategory, number>
  for (const c of EXPENSE_CATEGORIES) out[c] = 0
  for (const r of rows) {
    if (r.expenseDate.startsWith(month)) out[r.category] += r.amountCny
  }
  return out
}

// 'YYYY-MM' of the month before `month`. Powers 复制上月.
export function prevMonth(month: string): string {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return m === 1
    ? `${y - 1}-12`
    : `${y}-${String(m - 1).padStart(2, '0')}`
}

// The rows 复制上月 would copy: one entry per payee for the given category in
// the given month. If a payee appears twice (e.g. salary + bonus rows), both
// copy — the ledger is the truth, not a roster.
export function rowsToCopy(
  rows: Expense[],
  category: ExpenseCategory,
  month: string,
): Expense[] {
  return rows
    .filter((r) => r.category === category && r.expenseDate.startsWith(month))
    .sort((a, b) => (a.payee ?? '').localeCompare(b.payee ?? ''))
}

// Distinct payees for a category, most recent first — feeds the 对象 datalist
// so 工资/报销 names autocomplete instead of being retyped.
export function payeesForCategory(
  rows: Expense[],
  category: ExpenseCategory,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows) {
    if (r.category !== category) continue
    const p = r.payee?.trim()
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

// === Excel export ===

export const EXPENSE_EXPORT_HEADERS = [
  '日期',
  '类别',
  '对象',
  '金额',
  '备注',
  '记录人',
] as const

export function buildExpenseExportAoa(
  rows: Expense[],
): (string | number)[][] {
  const aoa: (string | number)[][] = [EXPENSE_EXPORT_HEADERS.slice() as string[]]
  for (const r of rows) {
    aoa.push([
      r.expenseDate,
      CATEGORY_LABEL[r.category],
      r.payee ?? '',
      r.amountCny,
      r.note ?? '',
      r.createdBy ?? '',
    ])
  }
  return aoa
}

export const EXPENSE_EXPORT_COL_WIDTHS = [12, 10, 14, 12, 24, 10]
