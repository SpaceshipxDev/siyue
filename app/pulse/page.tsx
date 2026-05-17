import { Suspense } from 'react'
import Link from 'next/link'
import { STAGES, formatCny, type Stage } from '@/lib/data'
import { canSeeMoney, requirePulseViewer } from '@/lib/auth'
import {
  formatEventTs,
  getStationEvents,
  getStationWip,
  type StationEvent,
  type StationWipRow,
} from '@/lib/pulse'
import { TopBar } from '../_ui'

export const dynamic = 'force-dynamic'

const FEED_LIMIT = 80

// /pulse — 现场. The boss's one-glance factory view.
//
// Two stacked panels: factory-wide station strip (¥ WIP per stage) on top,
// chronological activity feed below. Clicking a stage chip writes
// ?stage=<X> into the URL — re-renders both panels so the chip highlights
// AND the feed below filters. No JS state. Refresh-stable. Shareable URL.
//
// Streaming layout: the strip is one tiny view read (9 rows) and renders
// inline so the page-shell + KPI digits paint immediately. The activity
// feed is the wider query — it streams in behind <Suspense> below, with
// a shimmering skeleton in its place. On filter change (chip click) the
// strip swaps active state instantly; only the feed re-streams.
//
// Total fixed cost: O(1) round-trips for the shell; feed cost is
// O(FEED_LIMIT) thanks to the partial indexes in 0019. Scales unchanged
// from 10 jobs to 10k.
export default async function PulsePage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string }>
}) {
  const user = await requirePulseViewer()
  // Money visibility split: commerce sees ¥ figures everywhere; 工程 head
  // sees the same layout with the parts-count headline standing in. Single
  // boolean drives both the page-level KPI and per-tile renderings, so the
  // two surfaces stay consistent.
  const showMoney = canSeeMoney(user)
  const sp = await searchParams
  const rawStage = typeof sp?.stage === 'string' ? sp.stage : undefined
  const stageFilter: Stage | undefined =
    rawStage && (STAGES as readonly string[]).includes(rawStage)
      ? (rawStage as Stage)
      : undefined

  const wip = await getStationWip()
  const totalWip = wip.reduce((s, r) => s + r.wipCny, 0)
  const totalParts = wip.reduce((s, r) => s + r.partsHere, 0)
  const totalJobs = wip.reduce((s, r) => s + r.jobsHere, 0)

  const heading = stageFilter ? `${stageFilter} · 现场` : '现场'
  const subtitle = stageFilter
    ? `${stageFilter} 工段的实时动态`
    : '全厂实时动态'

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="现场"
        subtitle={showMoney ? '实时动态 · 在制金额' : '实时动态'}
        currentTab="现场"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
      />
      <main className="mx-auto w-full max-w-[1500px] px-4 md:px-10 py-8 md:py-12 flex-1">
        <header className="mb-8 md:mb-12 flex items-baseline justify-between gap-6">
          <div>
            <h1 className="text-[28px] md:text-[34px] font-semibold tracking-tight text-[var(--color-ink)]">
              {heading}
            </h1>
            <p className="text-[12px] md:text-[13px] text-[var(--color-ink-3)] mt-1">
              {subtitle}
            </p>
          </div>
          <div className="flex items-baseline gap-8">
            {showMoney && (
              <Headline label="在制金额" value={formatCny(totalWip)} />
            )}
            <Headline
              label="在制件数"
              value={new Intl.NumberFormat('zh-CN').format(totalParts)}
              mono
            />
            {!showMoney && (
              <Headline
                label="在制工单"
                value={new Intl.NumberFormat('zh-CN').format(totalJobs)}
                mono
              />
            )}
          </div>
        </header>

        <StationStrip wip={wip} active={stageFilter} showMoney={showMoney} />

        {/* Suspense key on stageFilter so chip changes re-trigger the
            fallback skeleton — feels instant even when the feed query
            takes a moment. */}
        <Suspense
          key={stageFilter ?? '_all'}
          fallback={<FeedFallback />}
        >
          <FeedAsync stage={stageFilter} />
        </Suspense>
      </main>
    </div>
  )
}

async function FeedAsync({ stage }: { stage: Stage | undefined }) {
  const events = await getStationEvents({ stage, limit: FEED_LIMIT })
  return (
    <ActivityFeed
      events={events}
      now={new Date()}
      filtered={!!stage}
    />
  )
}

// ---------------------------------------------------------------------------
// Top strip: 9 tiles, one per stage. The headline is the ¥ figure (commerce)
// or the parts count (工程 head, no money visibility). The sub-line carries
// jobs/parts (commerce) or just jobs (工程, since parts is now the headline).
// 未定价 is shown to both — 工程 can flag commerce when coverage is thin.
// Selected tile inverts (ink on surface). Clicking any tile rewrites
// ?stage=<X>; clicking the active tile clears it.
// ---------------------------------------------------------------------------
function StationStrip({
  wip,
  active,
  showMoney,
}: {
  wip: StationWipRow[]
  active: Stage | undefined
  showMoney: boolean
}) {
  return (
    <nav
      aria-label="工段筛选"
      className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-9 gap-px bg-[var(--color-border)] border border-[var(--color-border)] rounded-md overflow-hidden mb-12"
    >
      {wip.map((row) => {
        const isActive = active === row.stage
        const isEmpty = row.partsHere === 0
        const href = isActive
          ? '/pulse'
          : `/pulse?stage=${encodeURIComponent(row.stage)}`
        const headlineText = showMoney
          ? formatCny(row.wipCny)
          : isEmpty
            ? '—'
            : `${new Intl.NumberFormat('zh-CN').format(row.partsHere)} 件`
        const sublineText = isEmpty
          ? '—'
          : showMoney
            ? `${row.jobsHere} 单 · ${row.partsHere} 件`
            : `${row.jobsHere} 单`
        return (
          <Link
            key={row.stage}
            href={href}
            aria-current={isActive ? 'true' : undefined}
            className={`group flex flex-col gap-2 px-3 md:px-4 py-4 md:py-5 transition-colors ${
              isActive
                ? 'bg-[var(--color-ink)] text-[var(--color-bg)]'
                : 'bg-[var(--color-surface)] text-[var(--color-ink)] hover:bg-[var(--color-active-bg)]'
            }`}
          >
            <span
              className={`label tracking-[0.22em] ${
                isActive
                  ? 'text-[var(--color-bg)] opacity-70'
                  : 'text-[var(--color-ink-3)]'
              }`}
            >
              {row.stage}
            </span>
            <span
              className={`text-[18px] md:text-[22px] font-semibold tabular-nums tracking-tight ${
                isEmpty
                  ? isActive
                    ? 'opacity-50'
                    : 'text-[var(--color-ink-3)]'
                  : ''
              }`}
            >
              {headlineText}
            </span>
            <span
              className={`text-[11px] md:text-[12px] tabular-nums ${
                isActive
                  ? 'text-[var(--color-bg)] opacity-70'
                  : 'text-[var(--color-ink-3)]'
              }`}
            >
              {sublineText}
            </span>
            {/* 未定价 hint — only when there's coverage to flag.
                For commerce: a ¥0 column with all-unpriced parts reads as
                "we don't know" not "worthless." For 工程: same signal,
                useful as a nudge to commerce. Hidden when every part is
                priced so the strip stays calm. */}
            {row.partsUnpriced > 0 && (
              <span
                className={`text-[10px] tabular-nums tracking-wide ${
                  isActive
                    ? 'text-[var(--color-bg)] opacity-60'
                    : 'text-[var(--color-warning)]'
                }`}
              >
                {row.partsUnpriced} 未定价
              </span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}

// ---------------------------------------------------------------------------
// Activity feed. Single-column chronological list — newest at the top. Each
// row is one stage transition (开始 or 完成). Designed for floor-glance:
// time + stage + actor + job-no + part. Lots of whitespace; no row-borders
// inside the same minute cluster (just the time hairline).
// ---------------------------------------------------------------------------
function ActivityFeed({
  events,
  now,
  filtered,
}: {
  events: StationEvent[]
  now: Date
  filtered: boolean
}) {
  if (events.length === 0) {
    return (
      <section className="border-t border-[var(--color-border)] pt-12">
        <div className="text-center py-20">
          <p className="text-[13px] text-[var(--color-ink-3)]">
            {filtered ? '此工段暂无动态' : '暂无动态'}
          </p>
        </div>
      </section>
    )
  }

  return (
    <section className="border-t border-[var(--color-border)] pt-8">
      <div className="flex items-baseline justify-between mb-6">
        <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
          最新动态
        </h2>
        <p className="label tabular-nums">{events.length}</p>
      </div>
      <ul className="divide-y divide-[var(--color-border)]">
        {events.map((e, i) => (
          <EventRow key={`${e.partId}-${e.kind}-${e.ts}-${i}`} ev={e} now={now} />
        ))}
      </ul>
    </section>
  )
}

// Skeleton that matches the resolved feed layout — same header, same row
// grid, same row count target — so the swap is a content fade, not a
// jump. Eight rows is enough to fill above the fold on most screens.
function FeedFallback() {
  return (
    <section className="border-t border-[var(--color-border)] pt-8">
      <div className="flex items-baseline justify-between mb-6">
        <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
          最新动态
        </h2>
        <span className="siyue-shimmer h-3 w-6 rounded-sm inline-block" />
      </div>
      <ul className="divide-y divide-[var(--color-border)]" aria-busy="true">
        {Array.from({ length: 8 }).map((_, i) => (
          <li
            key={i}
            className="grid grid-cols-[88px_64px_92px_1fr] items-center gap-x-4 py-3"
          >
            <span className="siyue-shimmer h-3 w-14 rounded-sm" />
            <span className="siyue-shimmer h-4 w-12 rounded-sm" />
            <span className="siyue-shimmer h-3 w-16 rounded-sm" />
            <span className="siyue-shimmer h-3 w-3/4 rounded-sm" />
          </li>
        ))}
      </ul>
    </section>
  )
}

function EventRow({ ev, now }: { ev: StationEvent; now: Date }) {
  const isFinish = ev.kind === 'finished'
  // 4-col grid: time | stage chip | actor | description.
  // Each row stays a single height-line across the viewport so the eye can
  // scan the left edge for "what changed when" without scanning text.
  return (
    <li className="grid grid-cols-[88px_64px_92px_1fr] items-center gap-x-4 py-3 hover:bg-[var(--color-surface)] -mx-3 px-3 rounded-sm">
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
        {ev.stage}
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
        <span className="ml-2 text-[var(--color-ink-3)]">
          {isFinish ? '完成' : '开始'}
          {isFinish
            ? ` ${ev.partQty} 件`
            : ev.doneQty != null
              ? ` · 已 ${ev.doneQty}/${ev.partQty}`
              : ''}
        </span>
        <span className="mx-2 text-[var(--color-ink-4)]">·</span>
        <span className="text-[var(--color-ink-3)]">{ev.customer}</span>
      </Link>
    </li>
  )
}

function Headline({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="text-right">
      <p
        className={`text-[22px] md:text-[26px] font-semibold tabular-nums tracking-tight text-[var(--color-ink)] ${mono ? 'mono' : ''}`}
      >
        {value}
      </p>
      <p className="label mt-1">{label}</p>
    </div>
  )
}
