import Link from 'next/link'
import {
  formatEventTs,
  getStationEvents,
  type StationEvent,
} from '@/lib/pulse'
import type { Stage } from '@/lib/data'

const FEED_LIMIT = 20

// Compact recent-activity strip rendered below the workbench on a per-station
// page. Boss-only — workers see their queue, not the audit log. Same shape
// as the /pulse feed but pre-filtered to one stage and capped short.
//
// Self-fetching server component so the caller can drop it inside <Suspense>
// without plumbing data through. The page's main render path doesn't block
// on the event read — the workbench/sheet flushes first, this streams in.

export async function StationActivityAsync({ stage }: { stage: Stage }) {
  const events = await getStationEvents({ stage, limit: FEED_LIMIT })
  return <StationActivity events={events} stage={stage} now={new Date()} />
}

export function StationActivityFallback({ stage }: { stage: Stage }) {
  // Same layout box as the resolved view so there's no shift when the
  // events stream in — header line + 5 placeholder rows on a fixed grid.
  return (
    <section className="mt-12 border-t border-[var(--color-border)] pt-8">
      <Header stage={stage} />
      <ul className="divide-y divide-[var(--color-border)]" aria-busy="true">
        {Array.from({ length: 5 }).map((_, i) => (
          <li
            key={i}
            className="grid grid-cols-[88px_60px_92px_1fr] items-center gap-x-4 py-2.5"
          >
            <Shimmer className="h-3 w-12" />
            <Shimmer className="h-4 w-12" />
            <Shimmer className="h-3 w-16" />
            <Shimmer className="h-3 w-2/3" />
          </li>
        ))}
      </ul>
    </section>
  )
}

function StationActivity({
  events,
  stage,
  now,
}: {
  events: StationEvent[]
  stage: Stage
  now: Date
}) {
  return (
    <section className="mt-12 border-t border-[var(--color-border)] pt-8">
      <Header stage={stage} count={events.length} />
      {events.length === 0 ? (
        <p className="text-[13px] text-[var(--color-ink-3)] py-8 text-center">
          暂无动态
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {events.map((e, i) => (
            <Row key={`${e.partId}-${e.kind}-${e.ts}-${i}`} ev={e} now={now} />
          ))}
        </ul>
      )}
    </section>
  )
}

function Header({ stage, count }: { stage: Stage; count?: number }) {
  return (
    <div className="flex items-baseline justify-between mb-5">
      <div className="flex items-baseline gap-3">
        <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
          {stage} 最新动态
        </h2>
        <Link
          href={`/pulse?stage=${encodeURIComponent(stage)}`}
          className="text-[11px] tracking-wider text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
        >
          查看全部 →
        </Link>
      </div>
      {typeof count === 'number' && (
        <p className="label tabular-nums">{count}</p>
      )}
    </div>
  )
}

function Row({ ev, now }: { ev: StationEvent; now: Date }) {
  const isFinish = ev.kind === 'finished'
  return (
    <li className="grid grid-cols-[88px_60px_92px_1fr] items-center gap-x-4 py-2.5 hover:bg-[var(--color-surface)] -mx-3 px-3 rounded-sm">
      <span className="label tabular-nums text-[var(--color-ink-3)]">
        {formatEventTs(ev.ts, now)}
      </span>
      <span
        className={`inline-flex justify-center text-[11px] tracking-wider px-2 py-0.5 rounded-sm ${
          isFinish
            ? 'bg-[var(--color-success-soft)] text-[var(--color-success)]'
            : 'bg-[var(--color-info-soft)] text-[var(--color-info)]'
        }`}
      >
        {isFinish ? '完成' : '开始'}
      </span>
      <span className="text-[13px] text-[var(--color-ink-2)] truncate">
        {ev.actorName ?? '—'}
      </span>
      <Link
        href={`/jobs/${ev.jobId}`}
        className="text-[13px] text-[var(--color-ink)] hover:underline truncate"
      >
        <span className="tabular-nums text-[var(--color-ink-2)]">
          {ev.jobNo || '—'}
        </span>
        <span className="mx-2 text-[var(--color-ink-4)]">·</span>
        <span>{ev.partName || '部件'}</span>
        {isFinish ? (
          <span className="ml-2 text-[var(--color-ink-3)]">{ev.partQty} 件</span>
        ) : ev.doneQty != null ? (
          <span className="ml-2 text-[var(--color-ink-3)]">
            已 {ev.doneQty}/{ev.partQty}
          </span>
        ) : null}
        <span className="mx-2 text-[var(--color-ink-4)]">·</span>
        <span className="text-[var(--color-ink-3)]">{ev.customer}</span>
      </Link>
    </li>
  )
}

function Shimmer({ className = '' }: { className?: string }) {
  // CSS-only shimmer that piggybacks on globals.css's siyue-shimmer
  // keyframes (added in the same patch as this component). Single class,
  // no JS, no layout impact — just a moving highlight on a muted base.
  return <span className={`siyue-shimmer block rounded-sm ${className}`} />
}
