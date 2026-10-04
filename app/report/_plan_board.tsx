'use client'

import { Fragment, useState } from 'react'
import Link from 'next/link'
import { SHARED_PLAN_STAGES } from '@/lib/data'
import type { StagePlanRate } from '@/lib/plan-rate'

// 计划达成那一张表 —— 一道工序一行: 按时 · 延期完成 · 逾期未完 · 达成率。
// 点一行摊开没达成的那几张单 (还没做完的在前, 拖得最久的在上), 点单号进去。
//
// 打磨 · 喷漆 · 丝印 那三道共用一个时间节点, 左边一道竖线把它们圈在一起。

function pct(r: number | null): string {
  return r === null ? '—' : `${Math.round(r * 100)}%`
}

function tone(r: number | null): string {
  if (r === null) return 'text-[var(--color-ink-4)]'
  if (r >= 0.9) return 'text-[var(--color-success)]'
  if (r >= 0.7) return 'text-[var(--color-warning)]'
  return 'text-[var(--color-overdue)]'
}

function planLabel(plan: string): string {
  const [d, t] = plan.split('T')
  return `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日${t ? ` ${t}` : ''}`
}

const COLS = 'grid-cols-[88px_1fr_64px_72px_80px_72px] md:grid-cols-[104px_1fr_80px_88px_96px_88px]'

export function PlanRateBoard({ rates }: { rates: StagePlanRate[] }) {
  const [open, setOpen] = useState<string | null>(null)

  const total = rates.reduce(
    (acc, r) => ({
      onTime: acc.onTime + r.onTime,
      late: acc.late + r.late,
      overdue: acc.overdue + r.overdue,
      notDue: acc.notDue + r.notDue,
    }),
    { onTime: 0, late: 0, overdue: 0, notDue: 0 },
  )
  const counted = total.onTime + total.late + total.overdue
  const overall = counted > 0 ? total.onTime / counted : null
  const planned = counted + total.notDue

  if (planned === 0) {
    return (
      <p className="py-20 text-center text-[13px] leading-relaxed text-[var(--color-ink-3)]">
        这个月没有排过计划的工序 —— 工程在工单的「零件进度」上方那一行给每道工序排日子，
        排了才有达成率。
      </p>
    )
  }

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <p className={`text-[40px] font-semibold leading-none tracking-tight tabular-nums ${tone(overall)}`}>
            {pct(overall)}
          </p>
          <p className="label mt-2.5">总达成率</p>
        </div>
        <Stat n={total.onTime} label="按时" />
        <Stat n={total.late} label="延期完成" warn={total.late > 0} />
        <Stat n={total.overdue} label="逾期未完" bad={total.overdue > 0} />
        <Stat n={total.notDue} label="还没到期" muted />
      </div>

      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div
          className={`grid ${COLS} items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-4 py-2 md:px-5`}
        >
          <span className="label">工序</span>
          <span className="label">达成率</span>
          <span className="label text-right">按时</span>
          <span className="label text-right">延期完成</span>
          <span className="label text-right">逾期未完</span>
          <span className="label text-right">还没到期</span>
        </div>
        {rates.map((r) => {
          const any = r.onTime + r.late + r.overdue + r.notDue > 0
          const shared = SHARED_PLAN_STAGES.includes(r.stage)
          const canOpen = r.misses.length > 0
          return (
            <Fragment key={r.stage}>
              <button
                type="button"
                onClick={() => canOpen && setOpen(open === r.stage ? null : r.stage)}
                className={`relative grid w-full ${COLS} items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 text-left last:border-b-0 md:px-5 ${
                  canOpen ? 'cursor-pointer hover:bg-[#faf8f2]' : 'cursor-default'
                } ${open === r.stage ? 'bg-[#faf8f2]' : ''} ${any ? '' : 'opacity-45'}`}
              >
                {shared && (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-[3px] bg-[var(--color-border-strong)]"
                    title="打磨 · 喷漆 · 丝印 共用一个时间节点"
                  />
                )}
                <span className="text-[14px] font-medium text-[var(--color-ink)]">{r.stage}</span>
                <span className="flex items-center gap-3">
                  <span className={`mono w-[44px] text-[15px] font-semibold tabular-nums ${tone(r.rate)}`}>
                    {pct(r.rate)}
                  </span>
                  <span className="hidden h-[6px] flex-1 overflow-hidden rounded-full bg-[var(--color-active-bg)] md:block">
                    {r.rate !== null && (
                      <span
                        className="block h-full rounded-full bg-[var(--color-ink-3)]"
                        style={{ width: `${Math.round(r.rate * 100)}%` }}
                      />
                    )}
                  </span>
                </span>
                <Num n={r.onTime} />
                <Num n={r.late} cls={r.late > 0 ? 'text-[var(--color-warning)]' : undefined} />
                <Num n={r.overdue} cls={r.overdue > 0 ? 'text-[var(--color-overdue)] font-medium' : undefined} />
                <Num n={r.notDue} cls="text-[var(--color-ink-4)]" />
              </button>
              {open === r.stage && (
                <div className="border-b border-[var(--color-border)] bg-[#faf8f2] px-4 py-2 md:px-5">
                  {r.misses.map((m) => (
                    <Link
                      key={m.jobId}
                      href={`/jobs/${m.jobId}`}
                      className="flex items-baseline gap-4 border-b border-[var(--color-border)] py-2 last:border-b-0 hover:bg-[var(--color-active-bg)]"
                    >
                      <span className="mono w-[150px] shrink-0 truncate text-[12.5px] text-[var(--color-ink)]">
                        {m.jobNo}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-ink-2)]">
                        {m.product}
                        {m.customer && (
                          <span className="ml-2 text-[var(--color-ink-4)]">{m.customer}</span>
                        )}
                      </span>
                      <span className="shrink-0 text-[12px] text-[var(--color-ink-3)]">
                        计划 {planLabel(m.plan)}
                      </span>
                      <span
                        className={`w-[110px] shrink-0 text-right text-[12.5px] ${
                          m.outcome === 'overdue'
                            ? 'font-medium text-[var(--color-overdue)]'
                            : 'text-[var(--color-warning)]'
                        }`}
                      >
                        {m.outcome === 'overdue' ? `逾期 ${m.days} 天未完` : `晚 ${m.days} 天完成`}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </Fragment>
          )
        })}
      </div>

      <p className="mt-4 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
        计划日期落在这个月的才算这个月的账。到了计划那天（排了钟点就按钟点）这道工序的零件全部做完算按时；
        还没到期、也还没做完的不进达成率。操机、手工各自一个时间节点；左边带竖线的打磨、喷漆、丝印共用一个，各自对着那一天算。
      </p>
    </div>
  )
}

function Stat({
  n,
  label,
  warn,
  bad,
  muted,
}: {
  n: number
  label: string
  warn?: boolean
  bad?: boolean
  muted?: boolean
}) {
  return (
    <div>
      <p
        className={`text-[22px] font-semibold leading-none tracking-tight tabular-nums ${
          bad
            ? 'text-[var(--color-overdue)]'
            : warn
              ? 'text-[var(--color-warning)]'
              : muted
                ? 'text-[var(--color-ink-3)]'
                : 'text-[var(--color-ink)]'
        }`}
      >
        {n}
      </p>
      <p className="label mt-2.5">{label}</p>
    </div>
  )
}

function Num({ n, cls }: { n: number; cls?: string }) {
  return (
    <span className={`mono text-right text-[13.5px] tabular-nums ${cls ?? 'text-[var(--color-ink)]'}`}>
      {n > 0 ? n : '—'}
    </span>
  )
}
