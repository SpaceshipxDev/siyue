import Link from 'next/link'
import { formatCny, blockClosedAt, procurementTotalCny } from '@/lib/data'
import {
  getExpenses,
  getFinanceRows,
  getOutsourceBlockRows,
  getProcurements,
} from '@/lib/db'
import {
  categoryTotalsForMonth,
  CATEGORY_LABEL,
  EXPENSE_CATEGORIES,
} from '@/lib/expenses'

// 月度 — the cashflow answer the boss actually wants from 财务:
// 这个月收了多少钱，花了多少钱，剩多少。
//
// 收入 = 回款 (cash that actually arrived — NOT 开票, NOT order amounts).
// 支出 = 手工台账 (the 7 categories) + two read-time joins rendered as 自动:
//   外协 — closed outsource blocks, keyed by 回件结算日 (same read as /month)
//   采购 — purchases keyed by 下单日
// The joins are accrual dates, not bank dates — labeled honestly on screen.
// Nothing here is stored twice; edit the source and this page follows.

const MONTHS = [
  '01', '02', '03', '04', '05', '06',
  '07', '08', '09', '10', '11', '12',
]

// 'YYYY-MM-DD' or 'MM-DD' → 'MM'. Outsource closure dates can arrive in the
// short stage-completion form, so month matching is by MM within the current
// year — the same convention /month uses.
function monthOf(dateStr?: string): string | undefined {
  if (!dateStr) return undefined
  const parts = dateStr.split('-')
  if (parts.length === 3) return parts[1]
  if (parts.length === 2) return parts[0]
  return undefined
}

export async function MonthlyCashflow({
  m,
  todayStr,
}: {
  m?: string
  todayStr: string
}) {
  const year = todayStr.slice(0, 4)
  const currentMonth = todayStr.slice(5, 7)
  const month = m && MONTHS.includes(m) ? m : currentMonth
  const monthIdx = MONTHS.indexOf(month)
  const prevM = MONTHS[(monthIdx + 11) % 12]
  const nextM = MONTHS[(monthIdx + 1) % 12]
  const isCurrent = month === currentMonth
  const ym = `${year}-${month}` // 'YYYY-MM'

  const [financeRows, expenses, blockRows, procurements] = await Promise.all([
    getFinanceRows(),
    getExpenses(),
    getOutsourceBlockRows(),
    getProcurements(),
  ])

  // 收入 — 回款 landing in the picked month.
  let collectedCny = 0
  let collectedCount = 0
  for (const r of financeRows) {
    if (r.paymentDate?.startsWith(ym)) {
      collectedCny += r.paymentAmountCny ?? 0
      collectedCount += 1
    }
  }

  // 手工支出 by category.
  const byCategory = categoryTotalsForMonth(expenses, ym)
  const manualTotal = EXPENSE_CATEGORIES.reduce((s, c) => s + byCategory[c], 0)

  // 外协 — blocks fully returned in the picked month (accrual on closure).
  let outsourceCny = 0
  let outsourceCount = 0
  for (const r of blockRows) {
    const closedAt = blockClosedAt(r.block)
    if (!closedAt || monthOf(closedAt) !== month) continue
    outsourceCny += r.block.amountCny ?? 0
    outsourceCount += 1
  }

  // 采购 — purchases ordered in the picked month.
  let procurementCny = 0
  let procurementCount = 0
  for (const p of procurements) {
    if (!p.orderDate.startsWith(ym)) continue
    const t = procurementTotalCny(p)
    if (typeof t === 'number') procurementCny += t
    procurementCount += 1
  }

  const totalOut = manualTotal + outsourceCny + procurementCny
  const net = collectedCny - totalOut
  const monthLabel = `${year}年 ${parseInt(month, 10)}月`
  const pct = (n: number) => (totalOut > 0 ? `${Math.round((n / totalOut) * 100)}%` : '—')

  return (
    <div>
      {/* Month navigator — same affordance as /month. */}
      <div className="flex items-center justify-center gap-10 mb-16">
        <Link
          href={`/finance?tab=month&m=${prevM}`}
          aria-label="上月"
          className="text-[20px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] px-3 py-1"
        >
          ‹
        </Link>
        <h1 className="text-[36px] font-semibold tracking-tight text-[var(--color-ink)] tabular-nums">
          {monthLabel}
          {!isCurrent && (
            <span className="ml-3 align-middle text-[12px] tracking-[0.22em] text-[var(--color-ink-3)] uppercase">
              历史
            </span>
          )}
        </h1>
        <Link
          href={`/finance?tab=month&m=${nextM}`}
          aria-label="下月"
          className="text-[20px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] px-3 py-1"
        >
          ›
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-12 mb-16 text-center">
        <Stat
          label="回款收入"
          value={formatCny(collectedCny)}
          sub={collectedCount > 0 ? `${collectedCount} 笔回款` : '本月暂无回款'}
          tone="success"
        />
        <Stat
          label="总支出"
          value={formatCny(totalOut)}
          sub="台账 + 外协 + 采购"
        />
        <Stat
          label="净现金流"
          value={formatCny(net)}
          sub="回款 − 支出"
          tone={net >= 0 ? 'success' : 'overdue'}
        />
      </div>

      {/* Breakdown — one row per category, system joins marked 自动. */}
      <div className="max-w-[640px] mx-auto">
        <table className="w-full border-collapse">
          <tbody>
            {EXPENSE_CATEGORIES.map((c) =>
              byCategory[c] > 0 ? (
                <tr key={c} className="border-b border-[var(--color-border)]">
                  <td className="py-2.5 text-[14px] text-[var(--color-ink)]">
                    {CATEGORY_LABEL[c]}
                  </td>
                  <td className="py-2.5 text-right mono text-[14px] text-[var(--color-ink)] tabular-nums">
                    {formatCny(byCategory[c])}
                  </td>
                  <td className="py-2.5 pl-6 text-right label tabular-nums w-[64px]">
                    {pct(byCategory[c])}
                  </td>
                </tr>
              ) : null,
            )}
            <tr className="border-b border-[var(--color-border)]">
              <td className="py-2.5 text-[14px] text-[var(--color-ink)]">
                <Link href="/month" className="hover:underline underline-offset-2 decoration-[var(--color-border-strong)]">
                  外协
                </Link>
                <span className="ml-2 label text-[var(--color-ink-4)]">
                  自动 · 本月已结 {outsourceCount} 单
                </span>
              </td>
              <td className="py-2.5 text-right mono text-[14px] text-[var(--color-ink)] tabular-nums">
                {formatCny(outsourceCny)}
              </td>
              <td className="py-2.5 pl-6 text-right label tabular-nums">{pct(outsourceCny)}</td>
            </tr>
            <tr className="border-b border-[var(--color-border)]">
              <td className="py-2.5 text-[14px] text-[var(--color-ink)]">
                <Link href="/procurement" className="hover:underline underline-offset-2 decoration-[var(--color-border-strong)]">
                  采购
                </Link>
                <span className="ml-2 label text-[var(--color-ink-4)]">
                  自动 · 本月下单 {procurementCount} 笔
                </span>
              </td>
              <td className="py-2.5 text-right mono text-[14px] text-[var(--color-ink)] tabular-nums">
                {formatCny(procurementCny)}
              </td>
              <td className="py-2.5 pl-6 text-right label tabular-nums">{pct(procurementCny)}</td>
            </tr>
            <tr className="border-b border-[var(--color-border-strong)]">
              <td className="py-3 text-[14px] font-semibold text-[var(--color-ink)]">支出合计</td>
              <td className="py-3 text-right mono text-[14px] font-semibold text-[var(--color-ink)] tabular-nums">
                {formatCny(totalOut)}
              </td>
              <td />
            </tr>
            <tr>
              <td className="py-3 text-[14px] font-semibold text-[var(--color-ink)]">
                净额 <span className="label font-normal text-[var(--color-ink-4)]">收入 − 支出</span>
              </td>
              <td
                className={`py-3 text-right mono text-[15px] font-semibold tabular-nums ${
                  net >= 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-overdue)]'
                }`}
              >
                {formatCny(net)}
              </td>
              <td />
            </tr>
          </tbody>
        </table>

        <p className="mt-6 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
          回款 ≠ 开票 — 此页只算实际到账。外协按回件结算日、采购按下单日计入，
          非银行付款日；台账类别在「支出」页逐笔记录。
        </p>
      </div>
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
      <p className={`text-[30px] md:text-[34px] font-semibold tracking-tight tabular-nums leading-none ${valueColor}`}>
        {value}
      </p>
      <p className="label mt-3">{label}</p>
      <p className="text-[12px] text-[var(--color-ink-3)] mt-1 tabular-nums">{sub}</p>
    </div>
  )
}
