import { requireCommerce } from '@/lib/auth'
import { getFinanceRows } from '@/lib/db'
import { today } from '@/lib/today'
import { formatCny } from '@/lib/data'
import {
  applyFinanceFilters,
  financeCounts,
  financeTotals,
  isFinanceFilter,
  type FinanceFilter,
} from '@/lib/finance'
import { TopBar } from '../_ui'
import { FinanceLedger } from './_ledger'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 25

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; filter?: string; page?: string }>
}) {
  const user = await requireCommerce()
  const params = await searchParams
  const q = params.q ?? ''
  const filter: FinanceFilter =
    params.filter && isFinanceFilter(params.filter) ? params.filter : 'all'

  const todayStr = today()
  const month = todayStr.slice(0, 7) // 'YYYY-MM'
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

  const monthLabel = `${parseInt(month.slice(5), 10)}月`

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="财务"
        subtitle="应收账款"
        currentTab="财务"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
      />
      <main className="mx-auto w-full max-w-[1240px] px-5 md:px-10 py-10 md:py-14 flex-1">
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
      </main>
    </div>
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
