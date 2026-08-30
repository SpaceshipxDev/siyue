import Link from 'next/link'
import { redirect } from 'next/navigation'
import {
  canSeeExpenses,
  canSeeOrderLedger,
  canSeeReport,
  requireOrderLedgerViewer,
} from '@/lib/auth'
import {
  getActiveUsers,
  getExpenses,
  getFenqiData,
  getOrderLedgerRows,
} from '@/lib/db'
import { getVouchersForExpenses } from '@/lib/voucher-file'
import { getHrMonth, getHrMonths, getHrRoster } from '@/lib/hr'
import {
  buildPayslips,
  isPayrollMonth,
  summarizeAttendance,
} from '@/lib/payroll'
import {
  getPayrollBase,
  getPayrollMonths,
  getPayrollRules,
  getPayrollSheet,
} from '@/lib/payroll-store'
import { today } from '@/lib/today'
import { formatCny } from '@/lib/data'
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
import { FenqiLedger } from './_fenqi'
import { BossMoney } from './_boss'
import { ExpenseLedger } from './_expense_ledger'
import { MonthlyCashflow } from './_monthly'
import { OrderLedger } from './_orders'
import { PayrollBoard } from './_payroll'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 25

// 财务 — one route, five reads of the same money:
//   订单 (tab=orders, default) every confirmed order with its full cost story —
//                            订单额 − 外协 − 采购 = 毛利, month-scoped, with the
//                            receipts one click down and a 3-sheet 导出.
//   记账 (tab=ar)             the clerk's 分期账 — her Excel, columns and all,
//                            where 开票/收款 installments are appended and every
//                            剩余 derives itself (lib/fenqi). Rows are born from
//                            出货 automatically.
//   看钱 (tab=money)         the boss's read — 4 plain-speak totals + the
//                            per-customer 谁压着钱 wall. Same derived rows.
//   支出 (tab=expense)       money out — the boss's 7 manual categories
//   工资 (tab=payroll)       一人一行的月度工资表 — 考勤读自人事, 月休4天的
//                            制度写在页头, 发放一键记进支出台账
//   月度 (tab=month)         回款收入 − 支出 = 净现金流, by month
// 订单 opens to every 商务 plus the canSeeOrderLedger allowlist (于海伟's
// production account). 记账 + 看钱 stay commerce-wide. 支出/月度 carry
// per-person payroll, so they're gated to the boss + designated finance users
// (users.is_finance).

type FinanceTab = 'orders' | 'ar' | 'money' | 'expense' | 'payroll' | 'month'

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
    pm?: string
  }>
}) {
  const user = await requireOrderLedgerViewer()
  const params = await searchParams
  const isCommerce = user.role === 'commerce'
  const showExpenses = canSeeExpenses(user)

  const tab: FinanceTab =
    params.tab === 'ar' ||
    params.tab === 'expense' ||
    params.tab === 'payroll' ||
    params.tab === 'month' ||
    params.tab === 'money'
      ? (params.tab as FinanceTab)
      : 'orders'
  // Deep link to a tab beyond the user's grant → land on 订单. A production
  // grantee (于海伟) holds ONLY the order ledger; 记账/看钱 stay commerce-wide.
  if (tab !== 'orders' && !isCommerce) redirect('/finance')
  if (
    (tab === 'expense' || tab === 'payroll' || tab === 'month') &&
    !showExpenses
  )
    redirect('/finance')

  const todayStr = today()
  const month = todayStr.slice(0, 7) // 'YYYY-MM'
  const monthLabel = `${parseInt(month.slice(5), 10)}月`

  const subtitle =
    tab === 'orders'
      ? '订单'
      : tab === 'ar'
        ? '分期账'
        : tab === 'money'
          ? '看钱'
          : tab === 'expense'
            ? '支出台账'
            : tab === 'payroll'
              ? '工资'
              : '月度现金流'

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="财务"
        subtitle={subtitle}
        currentTab="财务"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="mx-auto w-full max-w-[1240px] px-5 md:px-10 py-10 md:py-14 flex-1">
        <FinanceTabs tab={tab} isCommerce={isCommerce} showExpenses={showExpenses} />
        {tab === 'orders' && <OrdersTab todayStr={todayStr} />}
        {tab === 'ar' && (
          <FenqiTab
            q={params.q ?? ''}
            todayStr={todayStr}
            month={month}
            monthLabel={monthLabel}
          />
        )}
        {tab === 'money' && (
          <MoneyTab todayStr={todayStr} month={month} monthLabel={monthLabel} />
        )}
        {tab === 'expense' && (
          <ExpenseTab params={params} month={month} monthLabel={monthLabel} userName={user.name} />
        )}
        {tab === 'payroll' && <PayrollTab pm={params.pm} thisMonth={month} />}
        {tab === 'month' && <MonthlyCashflow m={params.m} todayStr={todayStr} />}
      </main>
    </div>
  )
}

// Sub-tab row — same underline-active text-toggle idiom as the ledger filters.
// Server-rendered links so the gate stays on the server. A production grantee
// (于海伟) sees only 订单; the rest of the book stays commerce-wide.
function FinanceTabs({
  tab,
  isCommerce,
  showExpenses,
}: {
  tab: FinanceTab
  isCommerce: boolean
  showExpenses: boolean
}) {
  const tabs: { key: FinanceTab; href: string; label: string }[] = [
    { key: 'orders', href: '/finance', label: '订单' },
    ...(isCommerce
      ? ([
          { key: 'ar', href: '/finance?tab=ar', label: '记账' },
          { key: 'money', href: '/finance?tab=money', label: '看钱' },
        ] as { key: FinanceTab; href: string; label: string }[])
      : []),
    ...(showExpenses
      ? ([
          { key: 'expense', href: '/finance?tab=expense', label: '支出' },
          { key: 'payroll', href: '/finance?tab=payroll', label: '工资' },
          { key: 'month', href: '/finance?tab=month', label: '月度' },
        ] as { key: FinanceTab; href: string; label: string }[])
      : []),
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

// === 订单 — every order's money story (one payload, client-driven) ===

async function OrdersTab({ todayStr }: { todayStr: string }) {
  const rows = await getOrderLedgerRows()
  return <OrderLedger rows={rows} todayStr={todayStr} />
}

// === 记账 — the 分期账 ledger (her surface; one payload, client-driven) ===

async function FenqiTab({
  q,
  todayStr,
  month,
  monthLabel,
}: {
  q: string
  todayStr: string
  month: string
  monthLabel: string
}) {
  const data = await getFenqiData()
  return (
    <FenqiLedger
      data={data}
      todayStr={todayStr}
      month={month}
      monthLabel={monthLabel}
      initialQ={q}
    />
  )
}

// === 看钱 — the boss's read of the same book ===

async function MoneyTab({
  todayStr,
  month,
  monthLabel,
}: {
  todayStr: string
  month: string
  monthLabel: string
}) {
  const data = await getFenqiData()
  return (
    <BossMoney data={data} todayStr={todayStr} month={month} monthLabel={monthLabel} />
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

  // 凭证 (receipts) for just this page's rows — bounded (~25 parallel reads),
  // like the contract widget does one per job. Table-free, so a stale DB or an
  // empty bucket simply yields no vouchers.
  const vouchers = await getVouchersForExpenses(display.map((r) => r.id))

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
        vouchers={vouchers}
      />
    </>
  )
}

// === 工资 — 一人一行的月度工资表 ===
//
// Nothing here is typed twice: 月薪 is a standing number, the 考勤 columns are
// the 人事 log for that month read back through lib/payroll, and 加班/奖罚 are
// the only two cells a person fills. A month that's been 发放'd renders its
// frozen 工资条 instead of a live recomputation — what was paid out is history.
//
// The 名册 is 人事's: system accounts plus every name 人事 was told to
// remember, which is the only list this shop has of people who don't have a
// login. Somebody without a 月薪 sits under 未定月薪 until one is typed.
async function PayrollTab({
  pm,
  thisMonth,
}: {
  pm?: string
  thisMonth: string
}) {
  const month = isPayrollMonth(pm ?? '') ? (pm as string) : thisMonth

  const [rules, base, sheet, hrRecords, payrollMonths, hrMonths, users, extra] =
    await Promise.all([
      getPayrollRules(),
      getPayrollBase(),
      getPayrollSheet(month),
      getHrMonth(month),
      getPayrollMonths(),
      getHrMonths(),
      getActiveUsers(),
      getHrRoster(),
    ])

  const slips = sheet.paid
    ? sheet.paid.slips
    : buildPayslips(
        base,
        summarizeAttendance(hrRecords),
        sheet.lines,
        rules,
        month,
      )

  const onPayroll = new Set(slips.map((s) => s.name))
  const offRoster = [...new Set([...users.map((u) => u.name), ...extra])]
    .filter((n) => !onPayroll.has(n))
    .sort((a, b) => a.localeCompare(b, 'zh'))

  return (
    <PayrollBoard
      month={month}
      months={[...new Set([...payrollMonths, ...hrMonths, thisMonth])]}
      rules={rules}
      slips={slips}
      offRoster={offRoster}
      paid={
        sheet.paid
          ? {
              at: sheet.paid.at,
              by: sheet.paid.by,
              total: sheet.paid.total,
              count: sheet.paid.slips.length,
            }
          : null
      }
    />
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
