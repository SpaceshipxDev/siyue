import Link from 'next/link'
import { formatCny } from '@/lib/data'
import { canSeeMoney, requirePulseViewer } from '@/lib/auth'
import {
  today,
  shanghaiWindow,
  shiftDate,
  type Granularity,
} from '@/lib/today'
import {
  formatEventTs,
  getWorkerOutput,
  getWorkerTimeline,
  type WorkerOutputRow,
  type WorkerStageEvent,
} from '@/lib/pulse'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { TopBar } from '../_ui'

export const dynamic = 'force-dynamic'

// /report — 报功. The person-axis read of the floor.
//
// 现场 (/pulse) answers "what's happening, by stage, right now." 报功 rotates
// the same finish-event data 90°: "how much did each worker push through,
// per day / week / month." Two numbers per worker — 完成零件 (components that
// flowed through their hands) and ¥经手 (the value of that throughput). It
// only tracks 生产 (floor) output; 商务 don't tick stages here.
//
// Everything is a read off worker_output()/worker_finish_events (migration
// 0025) — no new instrumentation, no extra clicks. The numbers come from the
// ✓ the floor has been clicking since day one.
//
// State is all in the URL — refresh-stable, shareable, no client JS:
//   ?g=day|week|month   reporting granularity (default day)
//   ?d=YYYY-MM-DD        anchor date in factory-local time (default today)
//   ?w=<name>            drill into one worker's timeline

const GRANS: { key: Granularity; label: string }[] = [
  { key: 'day', label: '日' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
]

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{ g?: string; d?: string; w?: string }>
}) {
  const user = await requirePulseViewer()
  // ¥经手 follows the same money split as everywhere else: 商务 see it, the
  // 工程 head (production) sees the same scoreboard with the count headline
  // standing in. One boolean drives both the column and the totals.
  const showMoney = canSeeMoney(user)

  const sp = await searchParams
  const gran: Granularity =
    sp?.g === 'week' || sp?.g === 'month' ? sp.g : 'day'
  const date = typeof sp?.d === 'string' && ISO_DATE.test(sp.d) ? sp.d : today()
  const worker = typeof sp?.w === 'string' && sp.w.length > 0 ? sp.w : undefined

  const window = shanghaiWindow(date, gran)
  const rows = await getWorkerOutput(window)

  const totalFinishes = rows.reduce((s, r) => s + r.finishes, 0)
  const totalStarts = rows.reduce((s, r) => s + r.starts, 0)
  const totalValue = rows.reduce((s, r) => s + r.valueCny, 0)

  const timeline = worker
    ? await getWorkerTimeline({
        actorName: worker,
        ...window,
        kind: 'finished',
        limit: 200,
      })
    : null

  // Build a same-page href preserving the params we aren't changing.
  const hrefWith = (next: { g?: Granularity; d?: string; w?: string | null }) => {
    const q = new URLSearchParams()
    const g = next.g ?? gran
    const d = next.d ?? date
    const w = next.w === null ? undefined : next.w ?? worker
    if (g !== 'day') q.set('g', g)
    if (d !== today()) q.set('d', d)
    if (w) q.set('w', w)
    const s = q.toString()
    return s ? `/report?${s}` : '/report'
  }

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="报功"
        subtitle={showMoney ? '当日产出 · 经手金额' : '当日产出'}
        currentTab="报功"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
      />
      <main className="mx-auto w-full max-w-[1100px] px-4 md:px-10 py-8 md:py-12 flex-1">
        <header className="mb-8 md:mb-10 flex flex-col gap-6 md:flex-row md:items-baseline md:justify-between">
          <div>
            <h1 className="text-[28px] md:text-[34px] font-semibold tracking-tight text-[var(--color-ink)]">
              {periodLabel(date, gran)}
            </h1>
            <p className="text-[12px] md:text-[13px] text-[var(--color-ink-3)] mt-1">
              生产工段 · 完成零件经手
            </p>
          </div>
          <div className="flex items-baseline gap-8">
            {showMoney && (
              <Headline label="经手金额" value={formatCny(totalValue)} />
            )}
            <Headline
              label="完成零件"
              value={new Intl.NumberFormat('zh-CN').format(totalFinishes)}
              mono
            />
            <Headline
              label="开始"
              value={new Intl.NumberFormat('zh-CN').format(totalStarts)}
              mono
            />
          </div>
        </header>

        {/* Granularity toggle + period stepper. Plain links — refresh-stable,
            no client state needed for a boss report that's read, not poked. */}
        <div className="mb-8 flex items-center justify-between gap-4">
          <nav
            aria-label="周期"
            className="inline-flex rounded-md border border-[var(--color-border)] overflow-hidden"
          >
            {GRANS.map((g) => {
              const active = g.key === gran
              return (
                <Link
                  key={g.key}
                  href={hrefWith({ g: g.key })}
                  aria-current={active ? 'true' : undefined}
                  className={`px-4 py-1.5 text-[13px] tracking-wider transition-colors ${
                    active
                      ? 'bg-[var(--color-ink)] text-[var(--color-bg)]'
                      : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface)]'
                  }`}
                >
                  {g.label}
                </Link>
              )
            })}
          </nav>
          <div className="flex items-center gap-1">
            <Stepper href={hrefWith({ d: shiftDate(date, gran, -1) })} dir="prev" />
            {date !== today() && (
              <Link
                href={hrefWith({ d: today() })}
                className="label px-3 py-1.5 text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                今天
              </Link>
            )}
            <Stepper
              href={hrefWith({ d: shiftDate(date, gran, 1) })}
              dir="next"
              disabled={shiftDate(date, gran, 1) > today() && gran === 'day'}
            />
          </div>
        </div>

        <Scoreboard
          rows={rows}
          showMoney={showMoney}
          activeWorker={worker}
          timeline={timeline}
          clearHref={hrefWith({ w: null })}
          now={new Date()}
          hrefForWorker={(name) =>
            hrefWith({ w: name === worker ? null : name })
          }
        />
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scoreboard — one row per worker, sorted by output (server-side). Columns:
// 姓名 | 完成零件 (with 件 muted) | 开始 | 最后活动 | 经手金额. Click a row to
// expand that worker's timeline inline, directly beneath the row.
// ---------------------------------------------------------------------------
function Scoreboard({
  rows,
  showMoney,
  activeWorker,
  timeline,
  clearHref,
  now,
  hrefForWorker,
}: {
  rows: WorkerOutputRow[]
  showMoney: boolean
  activeWorker?: string
  timeline: WorkerStageEvent[] | null
  clearHref: string
  now: Date
  hrefForWorker: (name: string) => string
}) {
  // 姓名 (flex) | 完成 | 开始 | 最后活动 | 金额(money only)
  const cols = showMoney
    ? 'grid-cols-[1fr_132px_72px_104px_132px]'
    : 'grid-cols-[1fr_132px_72px_104px]'

  if (rows.length === 0) {
    return (
      <section className="border-t border-[var(--color-border)] pt-12">
        <p className="text-center py-16 text-[13px] text-[var(--color-ink-3)]">
          此周期暂无产出
        </p>
      </section>
    )
  }

  return (
    <section className="border-t border-[var(--color-border)]">
      <div
        className={`grid ${cols} gap-x-6 px-3 py-3 border-b border-[var(--color-border)]`}
      >
        <span className="label">姓名</span>
        <span className="label text-right">完成零件</span>
        <span className="label text-right">开始</span>
        <span className="label text-right">最后活动</span>
        {showMoney && <span className="label text-right">经手金额</span>}
      </div>
      <ul>
        {rows.map((r) => {
          const active = r.actorName === activeWorker
          return (
            <li key={r.actorName}>
              <Link
                href={hrefForWorker(r.actorName)}
                aria-current={active ? 'true' : undefined}
                className={`grid ${cols} gap-x-6 items-baseline px-3 py-3.5 border-b border-[var(--color-border)] transition-colors ${
                  active
                    ? 'bg-[var(--color-active-bg)]'
                    : 'hover:bg-[var(--color-surface)]'
                }`}
              >
                <span className="flex items-baseline gap-2 min-w-0">
                  <span className="text-[15px] text-[var(--color-ink)] truncate">
                    {r.actorName}
                  </span>
                  {r.unpriced > 0 && showMoney && (
                    <span className="text-[10px] tabular-nums tracking-wide text-[var(--color-warning)] shrink-0">
                      {r.unpriced} 未定价
                    </span>
                  )}
                </span>
                <span className="text-right tabular-nums">
                  <span className="text-[17px] font-semibold text-[var(--color-ink)]">
                    {new Intl.NumberFormat('zh-CN').format(r.finishes)}
                  </span>
                  <span className="ml-1.5 text-[11px] text-[var(--color-ink-3)]">
                    · {new Intl.NumberFormat('zh-CN').format(r.pieces)} 件
                  </span>
                </span>
                <span className="text-right text-[15px] tabular-nums text-[var(--color-ink-2)]">
                  {new Intl.NumberFormat('zh-CN').format(r.starts)}
                </span>
                <span className="text-right label tabular-nums text-[var(--color-ink-3)]">
                  {r.lastActiveTs ? formatEventTs(r.lastActiveTs, now) : '—'}
                </span>
                {showMoney && (
                  <span className="text-right text-[15px] tabular-nums text-[var(--color-ink-2)]">
                    {formatCny(r.valueCny)}
                  </span>
                )}
              </Link>
              {active && (
                <WorkerTimeline
                  worker={r.actorName}
                  events={timeline ?? []}
                  showMoney={showMoney}
                  clearHref={clearHref}
                  now={now}
                />
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------------------
// WorkerTimeline — the drill-down, rendered inline right under the clicked
// worker's row. The boss wanted this to read like the Excel/components sheet:
// each completed component is one row with its photo + real specs (料号 / 材料 /
// 表面处理), the same shape as the job-detail components table — not a text feed.
// ---------------------------------------------------------------------------
function WorkerTimeline({
  worker,
  events,
  showMoney,
  clearHref,
  now,
}: {
  worker: string
  events: WorkerStageEvent[]
  showMoney: boolean
  clearHref: string
  now: Date
}) {
  return (
    <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 md:px-6 py-6">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="text-[13px] font-medium tracking-tight text-[var(--color-ink-2)]">
          {worker} · 完成零件
          <span className="ml-2 label tabular-nums text-[var(--color-ink-3)]">
            {events.length}
          </span>
        </h3>
        <Link
          href={clearHref}
          className="text-[11px] tracking-wider text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
        >
          收起 ↑
        </Link>
      </div>
      {events.length === 0 ? (
        <p className="text-[13px] text-[var(--color-ink-3)] py-6 text-center">
          此周期暂无完成零件
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-[var(--color-border)]">
                <th className="px-3 py-2.5 label whitespace-nowrap">图</th>
                <th className="px-3 py-2.5 label whitespace-nowrap">零件</th>
                <th className="px-3 py-2.5 label whitespace-nowrap">料号</th>
                <th className="px-3 py-2.5 text-right label whitespace-nowrap">数量</th>
                <th className="px-3 py-2.5 label whitespace-nowrap">材料</th>
                <th className="px-3 py-2.5 label whitespace-nowrap">表面处理</th>
                <th className="px-3 py-2.5 label whitespace-nowrap">工段</th>
                <th className="px-3 py-2.5 label whitespace-nowrap">完成</th>
                <th className="px-3 py-2.5 label whitespace-nowrap">工单 · 客户</th>
                {showMoney && (
                  <th className="px-3 py-2.5 text-right label whitespace-nowrap">
                    经手金额
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => {
                const src = proxiedStorageUrl(e.imageUrl)
                return (
                  <tr
                    key={`${e.partName}-${e.ts}-${i}`}
                    className="border-b border-[var(--color-border)] last:border-0 align-middle hover:bg-[var(--color-surface)]"
                  >
                    <td className="px-3 py-2">
                      <div className="h-11 w-11 overflow-hidden rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)]">
                        {src ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={src}
                            alt="零件图"
                            loading="lazy"
                            decoding="async"
                            className="h-full w-full object-contain"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[10px] text-[var(--color-ink-4)]">
                            —
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-[13px] font-medium text-[var(--color-ink)] whitespace-nowrap">
                      {e.partName || '部件'}
                    </td>
                    <td className="px-3 py-2 mono text-[12px] text-[var(--color-ink-2)] whitespace-nowrap">
                      {e.partNo ?? ''}
                    </td>
                    <td className="px-3 py-2 text-right mono text-[13px] text-[var(--color-ink)]">
                      {e.partQty}
                    </td>
                    <td className="px-3 py-2 text-[12px] text-[var(--color-ink-2)] whitespace-nowrap">
                      {e.material ?? ''}
                    </td>
                    <td className="px-3 py-2 text-[12px] text-[var(--color-ink-2)] whitespace-nowrap">
                      {e.surfaceTreatment ?? ''}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="inline-flex text-[11px] tracking-wider px-2 py-0.5 rounded-sm bg-[var(--color-success-soft)] text-[var(--color-success)]">
                        {e.stage}
                      </span>
                    </td>
                    <td className="px-3 py-2 label tabular-nums text-[var(--color-ink-3)] whitespace-nowrap">
                      {formatEventTs(e.ts, now)}
                    </td>
                    <td className="px-3 py-2 text-[12px] whitespace-nowrap">
                      <Link
                        href={`/jobs/${e.jobId}`}
                        className="text-[var(--color-ink)] hover:underline"
                      >
                        <span className="tabular-nums text-[var(--color-ink-2)]">
                          {e.jobNo || '—'}
                        </span>
                        <span className="mx-1.5 text-[var(--color-ink-4)]">·</span>
                        <span className="text-[var(--color-ink-3)]">{e.customer}</span>
                      </Link>
                    </td>
                    {showMoney && (
                      <td className="px-3 py-2 text-right tabular-nums text-[13px] text-[var(--color-ink-2)] whitespace-nowrap">
                        {e.unpriced ? (
                          <span className="text-[var(--color-warning)]">未定价</span>
                        ) : (
                          formatCny(e.valueCny)
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Stepper({
  href,
  dir,
  disabled = false,
}: {
  href: string
  dir: 'prev' | 'next'
  disabled?: boolean
}) {
  const glyph = dir === 'prev' ? '◂' : '▸'
  const label = dir === 'prev' ? '上一周期' : '下一周期'
  if (disabled) {
    return (
      <span
        aria-disabled="true"
        className="px-3 py-1.5 text-[15px] text-[var(--color-ink-4)] cursor-not-allowed select-none"
      >
        {glyph}
      </span>
    )
  }
  return (
    <Link
      href={href}
      aria-label={label}
      className="px-3 py-1.5 text-[15px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface)] rounded-sm transition-colors"
    >
      {glyph}
    </Link>
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

// Period heading, e.g. "5月30日 周五" / "5月26日 – 6月1日" / "2026年5月".
function periodLabel(date: string, gran: Granularity): string {
  const [y, m, d] = date.split('-').map(Number)
  if (gran === 'month') return `${y}年${m}月`
  if (gran === 'day') {
    const wd = new Date(`${date}T12:00:00+08:00`).toLocaleDateString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      weekday: 'short',
    })
    return `${m}月${d}日 ${wd}`
  }
  // week — label the Mon–Sun span from the computed window.
  const win = shanghaiWindow(date, 'week')
  const start = localYMD(win.from)
  // window.to is the exclusive next-Monday midnight; back off one day for Sun.
  const end = localYMD(new Date(new Date(win.to).getTime() - 86_400_000).toISOString())
  return `${fmtMD(start)} – ${fmtMD(end)}`
}

function localYMD(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
}

function fmtMD(ymd: string): string {
  const [, m, d] = ymd.split('-').map(Number)
  return `${m}月${d}日`
}
