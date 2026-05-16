import { dueState, formatMinutes, type Stage } from '@/lib/data'
import { rowIsMineAtStage, type MasterRow } from '@/lib/master'

// One band of four numbers. No card, no border, no chrome — just the digits
// and a small label below. Sits at the top of the station view so the head's
// eye lands on the totals before the table.
//
// The four numbers, in scan order:
//   在此    : jobs that are MINE at this station — strict definition that
//            matches the master sheet exactly: in_progress here, or pending
//            here AND every prior in-route stage already done. A job sitting
//            upstream waiting for 工程 to finish does NOT count as 在此 for
//            打磨 even if 打磨 is in its route.
//   今日    : of those, how many are due today
//   逾期    : of those, how many are already past due
//   平均    : avg flow time through this station. Computed server-side from
//            the rollup; pass null to render "—" while we wire that in.
export function StationSummary({
  rows,
  stage,
  avgMinutes,
}: {
  rows: MasterRow[]
  stage: Stage
  avgMinutes?: number | null
}) {
  let here = 0
  let dueToday = 0
  let overdue = 0
  for (const r of rows) {
    if (!rowIsMineAtStage(r, stage)) continue
    here++
    const ds = dueState(r.dueDate)
    if (ds === 'overdue') overdue++
    else if (ds === 'today') dueToday++
  }

  return (
    <section className="mb-12 mt-2 grid grid-cols-2 sm:grid-cols-4 gap-y-8 gap-x-6 border-b border-[var(--color-border)] pb-10">
      <Metric label="在此" value={here} />
      <Metric label="今日" value={dueToday} tone={dueToday > 0 ? 'warning' : 'mute'} />
      <Metric label="逾期" value={overdue} tone={overdue > 0 ? 'overdue' : 'mute'} />
      <Metric label="平均工段时长" value={formatMinutes(avgMinutes ?? null)} mono />
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
    <div className="flex flex-col gap-2 leading-none">
      <span
        className={`text-[44px] md:text-[56px] font-semibold tracking-tight tabular-nums ${color} ${mono ? 'mono' : ''}`}
      >
        {value}
      </span>
      <span className="label text-[var(--color-ink-3)]">{label}</span>
    </div>
  )
}
