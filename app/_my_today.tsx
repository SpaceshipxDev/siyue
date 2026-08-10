import { formatCny } from '@/lib/data'
import type { WorkerSelfStats } from '@/lib/pulse'

// 今日产出 — the personal headline a floor worker meets the instant they log
// in. The whole point of the floor's existence, said back to them in three
// numbers: how many components they finished today (the hero), the ¥ that
// flowed through their hands today, and how many they've finished this week.
//
// 现场/报工 answer "how is the floor doing"; this answers "how am *I* doing."
// It is the one place a worker sees money — their own throughput value, by the
// boss's call — so it sits above everything, before the work queue itself.
export function MyToday({
  name,
  stats,
  todayStr,
}: {
  name: string
  stats: WorkerSelfStats
  todayStr: string
}) {
  const nf = new Intl.NumberFormat('zh-CN')
  return (
    <section className="mb-8 overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center justify-between gap-4 px-6 md:px-8 pt-5 md:pt-6">
        <div className="flex items-baseline gap-2.5 min-w-0">
          <h2 className="text-[17px] font-semibold tracking-tight text-[var(--color-ink)] truncate">
            {name}
          </h2>
          <span className="label shrink-0 text-[var(--color-ink-3)]">今日产出</span>
        </div>
        <span className="label shrink-0 tabular-nums text-[var(--color-ink-3)]">
          {dayLabel(todayStr)}
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-x-12 md:gap-x-16 gap-y-6 px-6 md:px-8 pb-6 md:pb-7 pt-5">
        <Stat
          hero
          label="今日完成"
          value={nf.format(stats.todayFinishes)}
          aside={`${nf.format(stats.todayPieces)} 件`}
        />
        <Stat
          label="今日经手（按5%）"
          value={formatCny(stats.todayValueCny)}
          aside={stats.todayUnpriced > 0 ? `${stats.todayUnpriced} 未定价` : undefined}
          warnAside
        />
        <Stat
          label="本周完成"
          value={nf.format(stats.weekFinishes)}
          aside={`${nf.format(stats.weekPieces)} 件`}
        />
      </div>
    </section>
  )
}

function Stat({
  label,
  value,
  aside,
  hero = false,
  warnAside = false,
}: {
  label: string
  value: string
  aside?: string
  hero?: boolean
  warnAside?: boolean
}) {
  return (
    <div className="min-w-0">
      <p className="label mb-2 text-[var(--color-ink-3)]">{label}</p>
      <p className="flex items-baseline gap-2">
        <span
          className={`font-semibold tabular-nums tracking-tight leading-none text-[var(--color-ink)] ${
            hero ? 'text-[44px] md:text-[54px]' : 'text-[26px] md:text-[30px]'
          }`}
        >
          {value}
        </span>
        {aside && (
          <span
            className={`text-[12px] tabular-nums ${
              warnAside ? 'text-[var(--color-warning)]' : 'text-[var(--color-ink-3)]'
            }`}
          >
            {aside}
          </span>
        )}
      </p>
    </div>
  )
}

// "6月1日 周一" in factory-local terms. Server-rendered, so pin the timezone.
function dayLabel(ymd: string): string {
  const [, m, d] = ymd.split('-').map(Number)
  const wd = new Date(`${ymd}T12:00:00+08:00`).toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
  })
  return `${m}月${d}日 ${wd}`
}
