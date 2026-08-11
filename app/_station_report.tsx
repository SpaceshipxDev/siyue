import 'server-only'

import Link from 'next/link'
import { getStationOutput } from '@/lib/pulse'
import type { Stage } from '@/lib/data'

// Boss-only. Today's 报工 scoreboard for a single station — one row per worker,
// ranked by 完成, counting only their work *at this stage*. Replaces the old
// raw 近期活动 event log: the boss standing on the 编程 tab now sees who
// produced here and how much, not just a chronological feed. The full ranged
// view (any date range, drill-downs) lives at /report?stage=<stage>; this is
// the same lens, defaulted to today and embedded in place. Async so the station
// shell paints first; wrapped in <Suspense> by the caller.

const NUM = new Intl.NumberFormat('zh-CN')

function fmtCny(n: number): string {
  return `¥${NUM.format(Math.round(n))}`
}

export async function StationReportAsync({
  stage,
  showMoney,
}: {
  stage: Stage
  showMoney: boolean
}) {
  const rows = await getStationOutput(stage)
  const reportHref = `/report?stage=${encodeURIComponent(stage)}`

  // 姓名 (flex) | 完成 | 开始 | 金额(money only)
  // 150px, not 120 — 经手金额（按5%）wraps at the narrower width.
  const cols = showMoney
    ? 'grid-cols-[1fr_132px_72px_150px]'
    : 'grid-cols-[1fr_132px_72px]'

  if (rows.length === 0) {
    return (
      <section className="mt-12 mb-6">
        <ReportHeader href={reportHref} />
        <p className="py-10 text-center text-[13px] text-[var(--color-ink-3)]">
          今日此工段暂无产出
        </p>
      </section>
    )
  }

  return (
    <section className="mt-12 mb-6">
      <ReportHeader href={reportHref} />
      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)]">
        <div
          className={`grid ${cols} gap-x-6 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2`}
        >
          <span className="label">姓名</span>
          <span className="label text-right">完成工序</span>
          <span className="label text-right">开始</span>
          {showMoney && (
            <span className="label text-right whitespace-nowrap">经手金额（按5%）</span>
          )}
        </div>
        <ul>
          {rows.map((r) => (
            <li
              key={r.actorName}
              className={`grid ${cols} gap-x-6 items-baseline border-b border-[var(--color-border)] px-3 py-3 last:border-0`}
            >
              <span className="flex items-baseline gap-2 min-w-0">
                <span className="truncate text-[14px] text-[var(--color-ink)]">
                  {r.actorName}
                </span>
                {r.unpriced > 0 && showMoney && (
                  <span className="shrink-0 text-[10px] tabular-nums tracking-wide text-[var(--color-warning)]">
                    {r.unpriced} 未定价
                  </span>
                )}
              </span>
              <span className="text-right tabular-nums">
                <span className="text-[16px] font-semibold text-[var(--color-ink)]">
                  {NUM.format(r.finishes)}
                </span>
                <span className="ml-1.5 text-[11px] text-[var(--color-ink-3)]">
                  · {NUM.format(r.pieces)} 件
                </span>
              </span>
              <span className="text-right text-[14px] tabular-nums text-[var(--color-ink-2)]">
                {NUM.format(r.starts)}
              </span>
              {showMoney && (
                <span className="text-right text-[14px] tabular-nums text-[var(--color-ink-2)]">
                  {fmtCny(r.valueCny)}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

export function StationReportFallback({ stage }: { stage: Stage }) {
  void stage
  return (
    <section className="mt-12 mb-6">
      <ReportHeader />
      <div className="py-10 text-center text-[13px] text-[var(--color-ink-3)]">
        加载中…
      </div>
    </section>
  )
}

function ReportHeader({ href }: { href?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
        本工段报工
        <span className="ml-2 label text-[var(--color-ink-3)]">今日</span>
      </h2>
      {href && (
        <Link
          href={href}
          className="text-[12px] tracking-wide text-[var(--color-ink-3)] transition-colors hover:text-[var(--color-ink)]"
        >
          查看全部 →
        </Link>
      )}
    </div>
  )
}
