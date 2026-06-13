import { formatCny, formatMinutes } from '@/lib/data'

// A compact station-context strip, sitting just under the personal 今日产出
// card. Deliberately quiet — small inline label+value pairs, urgency shown by
// color rather than size — so it reads as the station's "needs attention" line
// beneath the hero, not as a second big-number band competing with it.
//
// In scan order:
//   在此    : jobs that are MINE at this station — strict definition that
//            matches the master sheet exactly: in_progress here, or pending
//            here AND every prior in-route stage already done. A job sitting
//            upstream waiting for 工程 to finish does NOT count as 在此 for
//            打磨 even if 打磨 is in its route.
//   今日    : of those, how many are due today
//   逾期    : of those, how many are already past due
//   平均    : avg flow time through this station. Computed server-side from
//            the rollup; pass null to render "—" while we wire that in.
//   在此金额 (opt-in via wipCny): boss-only ¥ value of WIP at this station.
//            Workers without money visibility get the original 4-up layout.
export function StationSummary({
  here,
  dueToday,
  overdue,
  avgMinutes,
  wipCny,
}: {
  here: number
  dueToday: number
  overdue: number
  avgMinutes?: number | null
  /** ¥ value of WIP at this station. Pass to render the 5th metric. */
  wipCny?: number
}) {
  const showWip = typeof wipCny === 'number'

  // A quiet, compact strip — not a hero band. The personal 今日产出 card now
  // owns the big-number role above; this is the station's context line beneath
  // it, so urgency is carried by COLOR (overdue red / due-today amber), not by
  // size. Reads label-then-value, matching the TopBar attention pills.
  return (
    <section className="mb-8 flex flex-wrap items-baseline gap-x-8 gap-y-2.5 border-b border-[var(--color-border)] pb-6">
      <Metric label="在此" value={here} />
      <Metric label="今日" value={dueToday} tone={dueToday > 0 ? 'warning' : 'mute'} />
      <Metric label="逾期" value={overdue} tone={overdue > 0 ? 'overdue' : 'mute'} />
      <Metric label="平均工段时长" value={formatMinutes(avgMinutes ?? null)} mono />
      {showWip && (
        <Metric
          label="在此金额"
          value={formatCny(wipCny)}
          tone={wipCny && wipCny > 0 ? 'ink' : 'mute'}
          mono
        />
      )}
    </section>
  )
}

function Metric({
  label,
  value,
  tone = 'ink',
  mono = false,
}: {
  label: string
  value: number | string
  tone?: 'ink' | 'warning' | 'overdue' | 'mute'
  mono?: boolean
}) {
  const color =
    tone === 'overdue'
      ? 'text-[var(--color-overdue)]'
      : tone === 'warning'
        ? 'text-[var(--color-warning)]'
        : tone === 'mute'
          ? 'text-[var(--color-ink-3)]'
          : 'text-[var(--color-ink)]'
  return (
    <span className="inline-flex items-baseline gap-2">
      <span className="label text-[var(--color-ink-3)]">{label}</span>
      <span
        className={`text-[20px] md:text-[22px] font-semibold tracking-tight tabular-nums leading-none ${color} ${mono ? 'mono' : ''}`}
      >
        {value}
      </span>
    </span>
  )
}
