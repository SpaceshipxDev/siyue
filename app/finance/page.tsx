import Link from 'next/link'
import { redirect } from 'next/navigation'
import { canSeeExpenses, requireCommerce } from '@/lib/auth'
import { getExpenses, getFinanceRows } from '@/lib/db'
import { today } from '@/lib/today'
import { formatCny } from '@/lib/data'
import {
  applyFinanceFilters,
  financeCounts,
  financeTotals,
  isFinanceFilter,
  type FinanceFilter,
} from '@/lib/finance'
import {
  applyExpenseFilters,
  expenseCounts,
  expenseTotals,
  isExpenseFilter,
  payeesForCategory,
  prevMonth,
  rowsToCopy,
  EXPENSE_CATEGORIES,
  type ExpenseCategory,
  type ExpenseFilter,
} from '@/lib/expenses'
import { TopBar } from '../_ui'
import { FinanceLedger } from './_ledger'
import { ExpenseLedger } from './_expense_ledger'
import { MonthlyCashflow } from './_monthly'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 25

// 财务 — three reads of the same books, one route:
//   应收 (tab=ar, default)    money owed to us — the original AR ledger
//   支出 (tab=expense)        money out — the boss's 7 manual categories
//   月度 (tab=month)          回款收入 − 支出 = 净现金流, by month
// 应收 stays visible to every 商务 (unchanged). 支出/月度 carry per-person
// payroll, so they're gated to the boss + designated finance users
// (users.is_finance, migration 0051) — others don't even see the tabs.

type FinanceTab = 'ar' | 'expense' | 'month'

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string
    q?: string
    filter?: string
    cat?: string
    page?: string
    m?: string
  }>
}) {
  const user = await requireCommerce()
  const params = await searchParams
  const showExpenses = canSeeExpenses(user)

  const tab: FinanceTab =
    params.tab === 'expense' || params.tab === 'month'
      ? (params.tab as FinanceTab)
      : 'ar'
  // Deep link to a gated tab from a non-finance user → land on 应收.
  if (tab !== 'ar' && !showExpenses) redirect('/finance')

  const todayStr = today()
  const month = todayStr.slice(0, 7) // 'YYYY-MM'
  const monthLabel = `${parseInt(month.slice(5), 10)}月`

  const subtitle =
    tab === 'ar' ? '应收账款' : tab === 'expense' ? '支出台账' : '月度现金流'

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="财务"
        subtitle={subtitle}
        currentTab="财务"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
      />
      <main className="mx-auto w-full max-w-[1240px] px-5 md:px-10 py-10 md:py-14 flex-1">
        {showExpenses && <FinanceTabs tab={tab} />}
        {tab === 'ar' && (
          <ArTab params={params} todayStr={todayStr} month={month} monthLabel={monthLabel} />
        )}
        {tab === 'expense' && (
          <ExpenseTab params={params} month={month} monthLabel={monthLabel} userName={user.name} />
        )}
        {tab === 'month' && <MonthlyCashflow m={params.m} todayStr={todayStr} />}
      </main>
    </div>
  )
}

// Sub-tab row — same underline-active text-toggle idiom as the ledger filters.
// Server-rendered links so the gate stays on the server.
function FinanceTabs({ tab }: { tab: FinanceTab }) {
  const tabs: { key: FinanceTab; href: string; label: string }[] = [
    { key: 'ar', href: '/finance', label: '应收' },
    { key: 'expense', href: '/finance?tab=expense', label: '支出' },
    { key: 'month', href: '/finance?tab=month', label: '月度' },
  ]
  return (
    <div role="tablist" aria-label="财务视图" className="flex items-baseline gap-x-7 mb-12">
      {tabs.map((t) => {
        const active = t.key === tab
        return (
          <Link
            key={t.key}
            href={t.href}
            role="tab"
            aria-selected={active}
            className={`pb-1 border-b transition-colors text-[15px] tracking-tight ${
              active
                ? 'border-[var(--color-ink)] font-semibold text-[var(--color-ink)]'
                : 'border-transparent font-medium text-[var(--color-ink-3)] hover:text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)]'
            }`}
          >
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}

// === 应收 (the original page, content unchanged) ===

async function ArTab({
  params,
  todayStr,
  month,
  monthLabel,
}: {
  params: { q?: string; filter?: string; page?: string }
  todayStr: string
  month: string
  monthLabel: string
}) {
  const q = params.q ?? ''
  const filter: FinanceFilter =
    params.filter && isFinanceFilter(params.filter) ? params.filter : 'all'

  const allRows = await getFinanceRows()

  // KPIs aggregate over the FULL set (true AR position); the table is filtered
  // + paginated.
  const totals = financeTotals(allRows, todayStr, month)
  const counts = financeCounts(allRows, todayStr)
  const filtered = applyFinanceFilters(allRows, { q, filter, todayYmd: todayStr })

  const total = filtered.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const page = Math.min(
    Math.max(1, parseInt(params.page ?? '1', 10) || 1),
    totalPages,
  )
  const start = (page - 1) * PAGE_SIZE
  const display = filtered.slice(start, start + PAGE_SIZE)
  const rangeStart = total === 0 ? 0 : start + 1
  const rangeEnd = Math.min(start + PAGE_SIZE, total)

  const exportParams = new URLSearchParams()
  if (q.trim()) exportParams.set('q', q.trim())
  if (filter !== 'all') exportParams.set('filter', filter)
  const exportHref = exportParams.toString()
    ? `/finance/export?${exportParams.toString()}`
    : '/finance/export'

  return (
    <>
      {/* KPI strip — global AR position. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-10 mb-14">
        <Stat label="应收余额" value={formatCny(totals.outstandingCny)} sub="未回款总额" />
        <Stat
          label="逾期未回款"
          value={formatCny(totals.overdueCny)}
          sub={totals.overdueCount > 0 ? `${totals.overdueCount} 笔` : '无逾期'}
          tone={totals.overdueCny > 0 ? 'overdue' : undefined}
        />
        <Stat label={`${monthLabel}开票`} value={formatCny(totals.invoicedThisMonthCny)} sub="本月开票额" />
        <Stat
          label={`${monthLabel}回款`}
          value={formatCny(totals.collectedThisMonthCny)}
          sub="本月回款额"
          tone="success"
        />
      </div>

      <FinanceLedger
        rows={display}
        q={q}
        filter={filter}
        counts={counts}
        todayStr={todayStr}
        total={total}
        page={page}
        totalPages={totalPages}
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        exportHref={exportHref}
      />
    </>
  )
}

// === 支出 (expense ledger) ===

async function ExpenseTab({
  params,
  month,
  monthLabel,
  userName,
}: {
  params: { q?: string; cat?: string; page?: string }
  month: string
  monthLabel: string
  userName: string
}) {
  const q = params.q ?? ''
  const filter: ExpenseFilter =
    params.cat && isExpenseFilter(params.cat) ? params.cat : 'all'

  const allRows = await getExpenses()
  const totals = expenseTotals(allRows, month)
  const counts = expenseCounts(allRows)
  const filtered = applyExpenseFilters(allRows, { q, filter })

  const total = filtered.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const page = Math.min(
    Math.max(1, parseInt(params.page ?? '1', 10) || 1),
    totalPages,
  )
  const start = (page - 1) * PAGE_SIZE
  const display = filtered.slice(start, start + PAGE_SIZE)
  const rangeStart = total === 0 ? 0 : start + 1
  const rangeEnd = Math.min(start + PAGE_SIZE, total)

  // 对象 autocomplete per category + the 复制上月 prefill, both derived from
  // the full ledger so the form is smart without extra queries.
  const payees = {} as Record<ExpenseCategory, string[]>
  for (const c of EXPENSE_CATEGORIES) payees[c] = payeesForCategory(allRows, c)
  const lastMonth = prevMonth(month)
  const lastMonthPayroll = rowsToCopy(allRows, 'payroll', lastMonth).map((r) => ({
    payee: r.payee ?? '',
    amountCny: r.amountCny,
    note: r.note ?? '',
  }))

  const exportParams = new URLSearchParams()
  if (q.trim()) exportParams.set('q', q.trim())
  if (filter !== 'all') exportParams.set('cat', filter)
  const exportHref = exportParams.toString()
    ? `/finance/expenses/export?${exportParams.toString()}`
    : '/finance/expenses/export'

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-10 mb-14">
        <Stat
          label={`${monthLabel}支出`}
          value={formatCny(totals.monthTotalCny)}
          sub="本月手工台账"
        />
        <Stat label={`${monthLabel}工资`} value={formatCny(totals.monthPayrollCny)} sub="本月工资合计" />
        <Stat label="今年累计" value={formatCny(totals.yearTotalCny)} sub="年初至今支出" />
      </div>

      <ExpenseLedger
        rows={display}
        q={q}
        filter={filter}
        counts={counts}
        total={total}
        page={page}
        totalPages={totalPages}
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        exportHref={exportHref}
        payees={payees}
        lastMonthPayroll={lastMonthPayroll}
        lastMonthLabel={`${parseInt(lastMonth.slice(5), 10)}月`}
        userName={userName}
      />
    </>
  )
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub: string
  tone?: 'success' | 'overdue'
}) {
  const valueColor =
    tone === 'success'
      ? 'text-[var(--color-success)]'
      : tone === 'overdue'
        ? 'text-[var(--color-overdue)]'
        : 'text-[var(--color-ink)]'
  return (
    <div>
      <p className={`text-[32px] md:text-[36px] font-semibold tracking-tight tabular-nums leading-none ${valueColor}`}>
        {value}
      </p>
      <p className="label mt-3">{label}</p>
      <p className="text-[12px] text-[var(--color-ink-3)] mt-1 tabular-nums">{sub}</p>
    </div>
  )
}
