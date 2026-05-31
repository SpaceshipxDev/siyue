import Link from 'next/link'
import { STAGES, type Stage } from '@/lib/data'

// 报功 station axis — a segmented chip row that re-cuts the whole scoreboard to
// one station (全部 = the original all-stages view). The chips mirror the
// dashboard's station tabs one-for-one, so the boss can land on the same
// station here that he was just looking at on the floor. State lives in the URL
// (?stage=) like the date range; the parent owns href construction (hrefFor) so
// the date window is preserved and the drilled worker is dropped on switch.
// Server-rendered — pure navigation, no client JS.

export function StationFilter({
  current,
  hrefFor,
}: {
  /** Active station, or undefined for 全部 (all stages). */
  current?: Stage
  /** Build a /report href for a station (null = 全部), preserving the date window. */
  hrefFor: (stage: Stage | null) => string
}) {
  const chips: { label: string; stage: Stage | null }[] = [
    { label: '全部', stage: null },
    ...STAGES.map((s) => ({ label: s, stage: s })),
  ]

  return (
    <div className="mb-8 flex flex-wrap items-center gap-1">
      {chips.map(({ label, stage }) => {
        const active = stage === null ? !current : current === stage
        return (
          <Link
            key={label}
            href={hrefFor(stage)}
            aria-current={active ? 'true' : undefined}
            className={`whitespace-nowrap rounded-[2px] px-3 py-1.5 text-[13px] transition-colors ${
              active
                ? 'bg-[var(--color-active-bg)] font-medium text-[var(--color-ink)]'
                : 'text-[var(--color-ink-3)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]'
            }`}
          >
            {label}
          </Link>
        )
      })}
    </div>
  )
}
