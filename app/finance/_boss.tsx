// 看钱 — the boss's read of the same book. Zero entry surface: four plain-
// speak numbers and a per-customer wall where bar length = money sitting out
// there and red = the phone call to make. Clicking a customer drops into the
// clerk's ledger filtered to them — boss and clerk look at the SAME data,
// two zoom levels. Server component: derived on the server, no client JS.

import Link from 'next/link'
import { formatCny } from '@/lib/data'
import {
  buildRows,
  customerWall,
  fenqiTotals,
  FENQI_AGING_DAYS,
  type FenqiData,
} from '@/lib/fenqi'

export function BossMoney({
  data,
  todayStr,
  month,
  monthLabel,
}: {
  data: FenqiData
  todayStr: string
  month: string
  monthLabel: string
}) {
  const rows = buildRows(data, todayStr)
  const totals = fenqiTotals(rows, data.events, month)
  const wall = customerWall(rows)
  const max = Math.max(1, ...wall.map((g) => g.totalCny))

  return (
    <div>
      {/* The four numbers, in his words. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-10 mb-14">
        <Hero
          label="货出了、票没开"
          value={formatCny(totals.waitCny)}
          sub="待开票总额"
          color="text-[var(--color-info)]"
        />
        <Hero
          label="票开了、钱没到"
          value={formatCny(totals.unpaidCny)}
          sub="应收未收总额"
          color="text-[var(--color-warning)]"
        />
        <Hero
          label="其中逾期"
          value={formatCny(totals.overdueCny)}
          sub={
            totals.overdueCount > 0
              ? `${totals.overdueCount} 单 · 开票超 ${FENQI_AGING_DAYS} 天没收清`
              : '无逾期'
          }
          color={
            totals.overdueCny > 0
              ? 'text-[var(--color-overdue)]'
              : 'text-[var(--color-ink)]'
          }
        />
        <Hero
          label={`${monthLabel}进账`}
          value={formatCny(totals.paidThisMonthCny)}
          sub={`${monthLabel}开票 ${formatCny(totals.invoicedThisMonthCny)}`}
          color="text-[var(--color-success)]"
        />
      </div>

      {/* 谁压着钱 — one bar per customer, overdue first. */}
      <div className="flex items-baseline gap-4 mb-4">
        <h2 className="text-[15px] font-semibold tracking-tight">谁压着钱</h2>
        <div className="ml-auto flex items-center gap-4 text-[11px] text-[var(--color-ink-3)]">
          <LegendSwatch className="bg-[var(--color-info)]" label="票没开" />
          <LegendSwatch className="bg-[var(--color-warning)]" label="钱没到" />
          <LegendSwatch className="bg-[var(--color-overdue)]" label="逾期" />
        </div>
      </div>

      <div className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        {wall.map((g) => (
          <Link
            key={g.customer}
            href={`/finance?q=${encodeURIComponent(g.customer)}`}
            title={`点开 ${g.customer} 的账本`}
            className="grid grid-cols-[minmax(96px,180px)_1fr_100px_100px_64px] items-center gap-x-4 px-4 py-3 border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-bg)] transition-colors"
          >
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-[var(--color-ink)] truncate">
                {g.customer}
              </span>
              {g.overdueDays > 0 && (
                <span className="block text-[11px] font-medium text-[var(--color-overdue)]">
                  逾期 {g.overdueDays} 天
                </span>
              )}
            </span>
            <span className="flex h-[14px] gap-[2px] items-stretch min-w-0">
              {g.waitCny > 0 && (
                <span
                  className="rounded-[2px] bg-[var(--color-info)] opacity-80"
                  style={{ width: `${Math.max(0.6, (g.waitCny / max) * 100)}%` }}
                />
              )}
              {g.unpaidCny > 0 && (
                <span
                  className={`rounded-[2px] ${
                    g.overdueCny > 0
                      ? 'bg-[var(--color-overdue)]'
                      : 'bg-[var(--color-warning)] opacity-90'
                  }`}
                  style={{ width: `${Math.max(0.6, (g.unpaidCny / max) * 100)}%` }}
                />
              )}
            </span>
            <span className="mono text-[12.5px] text-right whitespace-nowrap tabular-nums text-[var(--color-info)] max-lg:hidden">
              {g.waitCny > 0 ? formatCny(g.waitCny) : ''}
            </span>
            <span
              className={`mono text-[12.5px] text-right whitespace-nowrap tabular-nums ${
                g.overdueCny > 0
                  ? 'text-[var(--color-overdue)] font-medium'
                  : 'text-[var(--color-warning)]'
              }`}
            >
              {g.unpaidCny > 0 ? formatCny(g.unpaidCny) : ''}
            </span>
            <span className="mono text-[11px] text-right text-[var(--color-ink-3)] tabular-nums whitespace-nowrap">
              {g.jobCount} 单
            </span>
          </Link>
        ))}
        {wall.length === 0 && (
          <p className="py-20 text-center text-[13px] text-[var(--color-ink-3)]">
            没有在外的钱 — 出货后订单会自动进入记账页
          </p>
        )}
      </div>

      <p className="mt-4 text-[12px] text-[var(--color-ink-3)]">
        条越长压得越多，红的先打电话。点任何一家直接进它的账本 — 和财务看的是同一份数据；主板每单的收款灯也由它点亮。
      </p>
    </div>
  )
}

function Hero({
  label,
  value,
  sub,
  color,
}: {
  label: string
  value: string
  sub: string
  color: string
}) {
  return (
    <div>
      <p
        className={`text-[32px] md:text-[36px] font-semibold tracking-tight tabular-nums leading-none ${color}`}
      >
        {value}
      </p>
      <p className="label mt-3">{label}</p>
      <p className="text-[12px] text-[var(--color-ink-3)] mt-1 tabular-nums">{sub}</p>
    </div>
  )
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block w-[9px] h-[9px] rounded-[2px] ${className}`} />
      {label}
    </span>
  )
}
