'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  STAGES,
  daysFromToday,
  dueState,
  formatCny,
  jobEffectiveDueDate,
  jobExternalSpend,
  jobHasOpenOutsource,
  jobIntakeDate,
  jobIsDoneAtStage,
  jobIsMineAtStage,
  jobIsShipped,
  jobIsUpstreamOfStage,
  jobMargin,
  jobMostRecentFinishedAt,
  jobNoSortKey,
  jobStageCounts,
  jobTimerAtStage,
  rollupStage,
  type Job,
  type Stage,
} from '@/lib/data'
import { DueCell, RollupCell, StageHeader } from './_ui'
import { JobStageActionButton } from './_cell'
import { JobNotesInline } from './_editable'
import { ReturnChip } from './_returns'
import {
  MatchedComponentsStrip,
  SearchInput,
  matchedComponents,
  searchHaystack,
} from './_search'

// Role mirrored locally so this client component doesn't import lib/auth
// (which is server-only).
type Role = 'commerce' | 'production'

// 出货 production users get the same search affordances as commerce — they
// own the customer-facing print flow, so jobNo-only would block them from
// looking work up by customer name.
function isJobNoOnlySearch(role: Role, defaultStage?: Stage): boolean {
  return role === 'production' && defaultStage !== '出货'
}

// Default page size on the commerce overview. The full list (1000+ at scale)
// belongs in search/filter, not as a default scroll. The cap only applies on
// the unfiltered overview — search, date filter, and station views all bypass
// it because narrowing implies "show me everything that matches."
const DEFAULT_PAGE_SIZE = 25

// Two ordering axes the floor reasons in:
//   'due'   — by 交期 ascending. Production's "what's burning" — the historic
//             default. Calendar in this mode picks 交期 = X.
//   'jobNo' — by 工号 (newest 收单 first). Mirrors the share-drive day-folder
//             order commerce uses to reconcile against STEP files. Calendar
//             in this mode picks 生产日 = X (the YY-M-D embedded in the 工号).
type SortMode = 'due' | 'jobNo'

// Range filter on the active sort axis. start === end is the single-day case
// (the floor's "今天的活" question) and renders as a single chip; start < end
// is a true range ("这周的活"). 'all' is the unfiltered default.
type DateFilter =
  | { kind: 'all' }
  | { kind: 'range'; start: string; end: string }

// Top-level scope filter on the master sheet. 在产 hides shipped jobs (the
// daily-attention set); 已出货 surfaces them for finance / archive lookups.
type ShipFilter = 'live' | 'shipped'

function jobMatchesDate(j: Job, f: DateFilter, mode: SortMode): boolean {
  if (f.kind === 'all') return true
  const d = mode === 'jobNo' ? jobIntakeDate(j) : jobEffectiveDueDate(j)
  // Jobs without an intake date (legacy / hand-entered 工号) drop out of a
  // 生产日 range, same as they did under the old equality filter.
  if (!d) return false
  return d >= f.start && d <= f.end
}

function sortJobs(jobs: Job[], mode: SortMode): Job[] {
  const arr = [...jobs]
  if (mode === 'jobNo') {
    arr.sort((a, b) => jobNoSortKey(a).localeCompare(jobNoSortKey(b)))
  } else {
    arr.sort((a, b) =>
      jobEffectiveDueDate(a).localeCompare(jobEffectiveDueDate(b)),
    )
  }
  return arr
}

function formatPickedDate(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${parseInt(m, 10)}月${parseInt(d, 10)}日`
}

// Date-range presets exposed in the SortBar. Order matches reading flow
// (narrowest → widest). 本周 uses a Monday-start week — the factory's natural
// boundary; payroll, day-folders, and 排产 cycles all anchor on Monday.
const PRESETS = [
  { key: 'today', label: '今天' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
] as const
type PresetKey = (typeof PRESETS)[number]['key']

// Local-time ISO. Important: toISOString() would UTC-shift dates by ±1 day
// depending on timezone, which silently corrupts the filter near midnight.
function isoLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function presetRange(key: PresetKey): { start: string; end: string } {
  const now = new Date()
  if (key === 'today') {
    const s = isoLocal(now)
    return { start: s, end: s }
  }
  if (key === 'week') {
    // Monday = 1, Sunday = 0 in JS; pull forward to Monday of the current week.
    const day = now.getDay()
    const offsetToMonday = day === 0 ? -6 : 1 - day
    const monday = new Date(now)
    monday.setDate(now.getDate() + offsetToMonday)
    const sunday = new Date(monday)
    sunday.setDate(monday.getDate() + 6)
    return { start: isoLocal(monday), end: isoLocal(sunday) }
  }
  // 'month': first → last day of the current month.
  const first = new Date(now.getFullYear(), now.getMonth(), 1)
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  return { start: isoLocal(first), end: isoLocal(last) }
}

// If the current filter exactly matches a preset's range, return its key so
// the SortBar can bold that preset label — the user gets a free "I'm on 本周"
// readout without parsing the dates.
function matchingPreset(f: DateFilter): PresetKey | null {
  if (f.kind !== 'range') return null
  for (const p of PRESETS) {
    const r = presetRange(p.key)
    if (r.start === f.start && r.end === f.end) return p.key
  }
  return null
}

export function MasterSheet({
  jobs,
  role,
  defaultStage,
  stageFilter,
  actionableHighlight = false,
}: {
  jobs: Job[]
  role: Role
  /** The user's home station (undefined for commerce). */
  defaultStage?: Stage
  /** URL ?stage filter — narrows the view to one station. */
  stageFilter?: Stage
  /** When true, the highlighted column renders the start/pause action button
   * for each job, even though the page itself isn't a station-filtered view.
   * 工程 head's holistic master view sets this so they can drive their stage
   * cells from the same flat grid commerce sees, without losing the actions. */
  actionableHighlight?: boolean
}) {
  const [q, setQ] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('due')
  const [dateFilter, setDateFilter] = useState<DateFilter>({ kind: 'all' })
  const [shipFilter, setShipFilter] = useState<ShipFilter>('live')
  const [showAll, setShowAll] = useState(false)

  const isProduction = role === 'production'
  const showMoney = role === 'commerce'
  const jobNoOnly = isJobNoOnlySearch(role, defaultStage)
  // 工程 is the one stage that intentionally uses the flat master grid even
  // when it's the URL filter — page.tsx already skips StationWorkbench for it,
  // and we mirror that here so the mine/upstream/done partition + pagination
  // cap match the 商务 overview. Highlight + per-cell action button still fire
  // off `highlightStage` / `actionableHighlight`, which are decoupled.
  const treatAsOverview = !stageFilter || stageFilter === '工程'
  // Tabs + pagination + flat-list rendering all key off the overview shape.
  // Renamed from the old `!stageFilter` so adding 工程 didn't require touching
  // every downstream call site.
  const showShipTabs = treatAsOverview

  // Counts on the segmented control: total jobs in each scope BEFORE search /
  // sort / date narrowing. Apple-style segmented controls show stable counts;
  // the down-stream count chip already reflects the live filter.
  const liveCount = useMemo(
    () => jobs.reduce((n, j) => (jobIsShipped(j) ? n : n + 1), 0),
    [jobs],
  )
  const shippedCount = jobs.length - liveCount

  const scopedJobs = useMemo(() => {
    if (!showShipTabs) return jobs
    return shipFilter === 'live'
      ? jobs.filter((j) => !jobIsShipped(j))
      : jobs.filter((j) => jobIsShipped(j))
  }, [jobs, showShipTabs, shipFilter])
  // Highlight the user's home station for production; otherwise highlight the
  // URL stage (so commerce navigating to a station sees the same emphasis).
  const highlightStage: Stage | undefined = defaultStage ?? stageFilter
  // Station view = anyone (commerce or production) viewing a specific stage
  // OTHER THAN 工程 — the floor-style mine/upstream/done partition. 工程 routes
  // through the flat master grid even when it's the URL filter (see
  // `treatAsOverview` above).
  const isStationView = !treatAsOverview
  // Render start/pause buttons in the highlighted column even outside a
  // formal station view — used by the 工程 head on the holistic master grid
  // so they keep their stage controls without falling into the station-style
  // mine/upstream/done partition.
  const highlightIsActionable = isStationView || actionableHighlight

  // Pipeline: text → sort by mode → date filter → partition. The parent
  // pre-sorts by due date but we re-sort here so the toggle is purely local.
  // For non-出货 production users we restrict customer + product text from the
  // haystack (their privacy line); 零件名 / 材料 stay searchable for everyone
  // — production workers search their own parts. searchHaystack centralizes
  // this rule with the popover.
  const matchedByText = useMemo(() => {
    const query = q.trim().toLowerCase()
    if (!query) return scopedJobs
    return scopedJobs.filter((j) => searchHaystack(j, jobNoOnly).includes(query))
  }, [scopedJobs, q, jobNoOnly])

  const sortedByMode = useMemo(
    () => sortJobs(matchedByText, sortMode),
    [matchedByText, sortMode],
  )

  // Three-section split for the production station view:
  //   topRows      — jobs that are MINE: in_progress here, or pending here
  //                  with all prior in-route stages already done. These are
  //                  the only rows the click-to-advance affordance applies to.
  //   upstreamRows — up to 20 jobs heading toward me but not yet here. Faded,
  //                  pushed below, no timer, no action — they're a preview
  //                  of incoming flow, not part of today's queue.
  //   doneRows     — up to 20 most-recently-handled jobs at this stage,
  //                  including vendor-owned work (外协) that no longer needs
  //                  this station's in-house attention. Faded further, pushed
  //                  to the bottom — the head can glance back at what just
  //                  left the station without losing the scan-for-now
  //                  affordance up top.
  //   (excluded)   — jobs that don't visit this stage at all, plus completed
  //                  jobs older than the recent-20 cutoff (reachable by search).
  //
  // Search bypasses the partition so the head can find any job by jobNo at
  // any moment. Commerce / no-stage view collapses to a single list (legacy).
  // Upstream/done tiers keep their dedicated sort axes (next-due / most-recent
  // -finished) — those tiers are about flow signals, not the user's chosen
  // ordering, so the toggle only affects the actionable top tier.
  const { topRows, upstreamRows, doneRows } = useMemo(() => {
    const dateFiltered = sortedByMode.filter((j) =>
      jobMatchesDate(j, dateFilter, sortMode),
    )
    if (!isStationView || !stageFilter) {
      return {
        topRows: dateFiltered,
        upstreamRows: [] as Job[],
        doneRows: [] as Job[],
      }
    }
    if (q.trim().length > 0) {
      return {
        topRows: dateFiltered,
        upstreamRows: [] as Job[],
        doneRows: [] as Job[],
      }
    }
    const top = dateFiltered.filter((j) => jobIsMineAtStage(j, stageFilter))
    const upstream = dateFiltered
      .filter(
        (j) =>
          !jobIsMineAtStage(j, stageFilter) &&
          !jobIsDoneAtStage(j, stageFilter) &&
          jobIsUpstreamOfStage(j, stageFilter),
      )
      .sort((a, b) =>
        jobEffectiveDueDate(a).localeCompare(jobEffectiveDueDate(b)),
      )
      .slice(0, 20)
    const done = dateFiltered
      .filter((j) => jobIsDoneAtStage(j, stageFilter))
      .sort((a, b) =>
        jobMostRecentFinishedAt(b, stageFilter).localeCompare(
          jobMostRecentFinishedAt(a, stageFilter),
        ),
      )
      .slice(0, 20)
    return { topRows: top, upstreamRows: upstream, doneRows: done }
  }, [sortedByMode, dateFilter, sortMode, isStationView, stageFilter, q])

  const filteredCount = topRows.length + upstreamRows.length + doneRows.length
  const isFiltered = q.length > 0 || dateFilter.kind !== 'all'

  // Pagination applies only on the commerce overview. Station views already
  // self-limit (mine + upstream≤20 + done≤20), and any active filter implies
  // "show me everything that matches" — capping there would feel broken.
  const shouldPaginate = !isStationView && !isFiltered
  const visibleTopRows =
    shouldPaginate && !showAll
      ? topRows.slice(0, DEFAULT_PAGE_SIZE)
      : topRows
  const hiddenTopCount =
    shouldPaginate && !showAll ? topRows.length - visibleTopRows.length : 0

  return (
    <>
      {showShipTabs && (
        <ShipFilterToggle
          active={shipFilter}
          onChange={setShipFilter}
          liveCount={liveCount}
          shippedCount={shippedCount}
        />
      )}

      <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-3">
        <SearchInput
          q={q}
          setQ={setQ}
          placeholder={searchPlaceholder(jobNoOnly)}
        />
        <SortBar
          sortMode={sortMode}
          setSortMode={setSortMode}
          dateFilter={dateFilter}
          setDateFilter={setDateFilter}
        />
        <span className="ml-auto label text-[var(--color-ink-3)]">
          <span
            className={`mono mr-1 text-[12px] ${
              isFiltered
                ? 'text-[var(--color-ink)] font-medium'
                : 'text-[var(--color-ink-2)]'
            }`}
          >
            {filteredCount}
          </span>
          {isFiltered ? `/ ${scopedJobs.length}` : ''}
        </span>
      </div>

      <div className="overflow-x-auto rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="sheet w-full text-left text-[13px]">
          <colgroup>
            <col style={{ width: 56 }} />
            <col style={{ width: 130 }} />
            <col style={{ width: 220 }} />
            {showMoney && <col style={{ width: 120 }} />}
            <col style={{ width: 140 }} />
            {STAGES.map((s) => {
              const isHighlighted = s === highlightStage
              // Highlighted column gets extra width for the action button +
              // timer chip stack on the station view. On commerce / overview
              // we still tint via the col background — no per-cell action
              // there, so the wash is what signals "this column matters."
              const width = isHighlighted ? 168 : 88
              // Static yellow wash signals "this column matters" only when
              // there's no per-cell action button — once cells become actionable
              // (station view OR 工程 holistic), the buttons paint their own
              // state and the wash would just mute them.
              const colBg =
                isHighlighted && !highlightIsActionable
                  ? 'var(--color-warning-soft)'
                  : undefined
              return (
                <col
                  key={s}
                  style={{ width, background: colBg }}
                />
              )
            })}
            <col style={{ minWidth: 200 }} />
          </colgroup>
          <thead>
            <tr className="text-[var(--color-ink-2)]">
              <th className="px-3 py-3 text-center label whitespace-nowrap">#</th>
              <th className="px-4 py-3 label whitespace-nowrap">工号</th>
              <th className="px-4 py-3 label whitespace-nowrap">
                {isProduction ? '产品' : '客户 / 产品'}
              </th>
              {showMoney && (
                <th className="px-4 py-3 text-right label whitespace-nowrap">
                  金额
                </th>
              )}
              <th className="px-4 py-3 label whitespace-nowrap">交期</th>
              {STAGES.map((s) => {
                const isHighlighted = s === highlightStage
                const cell = (
                  <span
                    className={
                      isHighlighted
                        ? 'block font-semibold text-[var(--color-ink)]'
                        : 'block hover:opacity-60'
                    }
                  >
                    <StageHeader name={s} />
                  </span>
                )
                return (
                  <th key={s} className="px-2 py-3 text-center whitespace-nowrap">
                    {isProduction ? (
                      cell
                    ) : (
                      <Link href={`/station/${encodeURIComponent(s)}`}>
                        {cell}
                      </Link>
                    )}
                  </th>
                )
              })}
              <th
                className="px-4 py-3 label whitespace-nowrap"
                style={{ borderRight: '6px solid transparent' }}
              >
                备注
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleTopRows.map((job, i) => (
              <JobRow
                key={job.id}
                job={job}
                index={i}
                q={q}
                isProduction={isProduction}
                showMoney={showMoney}
                highlightStage={highlightStage}
                highlightIsActionable={highlightIsActionable}
                tier="mine"
              />
            ))}
            {shouldPaginate && (showAll || hiddenTopCount > 0) && topRows.length > DEFAULT_PAGE_SIZE && (
              <tr>
                <td
                  colSpan={5 + STAGES.length + (showMoney ? 1 : 0)}
                  className="px-4 py-3 text-center border-t border-[var(--color-border)]"
                >
                  <button
                    type="button"
                    onClick={() => setShowAll((s) => !s)}
                    className="label text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
                    aria-expanded={showAll}
                  >
                    {showAll ? (
                      <>收起 ↑</>
                    ) : (
                      <>
                        显示其余{' '}
                        <span className="mono tabular-nums">{hiddenTopCount}</span>{' '}
                        个 ↓
                      </>
                    )}
                  </button>
                </td>
              </tr>
            )}
            {upstreamRows.length > 0 && (
              <>
                <tr aria-hidden="true">
                  <td
                    colSpan={5 + STAGES.length + (showMoney ? 1 : 0)}
                    className="px-4 pt-8 pb-2"
                  >
                    <div className="flex items-baseline gap-3 border-t border-[var(--color-border)] pt-4">
                      <span className="label text-[var(--color-ink-3)]">
                        即将到达
                      </span>
                      <span className="mono text-[11px] text-[var(--color-ink-4)]">
                        上游 · {upstreamRows.length}
                      </span>
                    </div>
                  </td>
                </tr>
                {upstreamRows.map((job, i) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    index={topRows.length + i}
                    q={q}
                    isProduction={isProduction}
                    showMoney={showMoney}
                    highlightStage={highlightStage}
                    highlightIsActionable={highlightIsActionable}
                    tier="upstream"
                  />
                ))}
              </>
            )}
            {doneRows.length > 0 && (
              <>
                <tr aria-hidden="true">
                  <td
                    colSpan={5 + STAGES.length + (showMoney ? 1 : 0)}
                    className="px-4 pt-8 pb-2"
                  >
                    <div className="flex items-baseline gap-3 border-t border-[var(--color-border)] pt-4">
                      <span className="label text-[var(--color-ink-3)]">
                        已处理
                      </span>
                      <span className="mono text-[11px] text-[var(--color-ink-4)]">
                        完成 / 外协 · {doneRows.length}
                      </span>
                    </div>
                  </td>
                </tr>
                {doneRows.map((job, i) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    index={topRows.length + upstreamRows.length + i}
                    q={q}
                    isProduction={isProduction}
                    showMoney={showMoney}
                    highlightStage={highlightStage}
                    highlightIsActionable={highlightIsActionable}
                    tier="done"
                  />
                ))}
              </>
            )}
          </tbody>
        </table>
        {filteredCount === 0 && (
          <div className="px-6 py-12 text-center">
            <p className="text-[13px] text-[var(--color-ink-2)]">
              {isStationView
                ? '此刻没有任务 · 上游也没有正在进行的工单'
                : stageFilter
                  ? `${stageFilter} 工段当前无待处理工单`
                  : '无匹配工单'}
            </p>
            <p className="label mt-2 text-[var(--color-ink-3)]">
              {q ? `未找到 “${q}”` : '该范围暂无工单'}
            </p>
            {isFiltered && (
              <button
                type="button"
                onClick={() => {
                  setQ('')
                  setDateFilter({ kind: 'all' })
                }}
                className="label mt-4 text-[var(--color-ink)] hover:underline underline-offset-4 decoration-[var(--color-ink-3)]"
              >
                清除筛选 ↺
              </button>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function searchPlaceholder(jobNoOnly: boolean): string {
  return jobNoOnly ? '搜索 · 工号 / 零件' : '搜索 · 工号 / 客户 / 产品 / 零件'
}

// Two text buttons, no container, no fill — just typography. Active label
// goes ink + semibold with a hairline rule beneath; inactive sits in ink-3.
// The count rides to the right in tiny mono ink-4 so it never competes with
// the label. This matches the 按交期/按工号 sort toggle's restraint, dialed
// up half a notch (tighter underline) because the scope choice is the
// view's top-level pivot, not just an ordering preference.
function ShipFilterToggle({
  active,
  onChange,
  liveCount,
  shippedCount,
}: {
  active: ShipFilter
  onChange: (s: ShipFilter) => void
  liveCount: number
  shippedCount: number
}) {
  const segments: { key: ShipFilter; label: string; count: number }[] = [
    { key: 'live', label: '在产', count: liveCount },
    { key: 'shipped', label: '已出货', count: shippedCount },
  ]
  return (
    <div role="tablist" aria-label="工单范围" className="mb-6 flex items-baseline gap-x-7">
      {segments.map((s) => {
        const isActive = s.key === active
        return (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(s.key)}
            className={`group inline-flex items-baseline gap-1.5 pb-1 transition-colors border-b ${
              isActive
                ? 'border-[var(--color-ink)]'
                : 'border-transparent hover:border-[var(--color-border-strong)]'
            }`}
          >
            <span
              className={`text-[15px] tracking-tight ${
                isActive
                  ? 'font-semibold text-[var(--color-ink)]'
                  : 'font-medium text-[var(--color-ink-3)] group-hover:text-[var(--color-ink-2)]'
              }`}
            >
              {s.label}
            </span>
            <span className="mono text-[11px] text-[var(--color-ink-4)] tabular-nums">
              {s.count}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function JobRow({
  job,
  index,
  q,
  isProduction,
  showMoney,
  highlightStage,
  highlightIsActionable,
  tier,
}: {
  job: Job
  index: number
  q: string
  isProduction: boolean
  showMoney: boolean
  highlightStage?: Stage
  /** True when the highlighted column should render its action button — set
   * for both the per-station workbench and the 工程 head's holistic master
   * grid. Drives the start/pause cell vs static rollup decision. */
  highlightIsActionable: boolean
  /** Visual tier on the station view:
   *   'mine'     — full color, actionable
   *   'upstream' — opacity-50, "incoming"
   *   'done'     — opacity-40, "recently finished, no longer demanding" */
  tier: 'mine' | 'upstream' | 'done'
}) {
  // The head's own column is NEVER a navigation Link — clicks here are
  // stage-action gestures. Three flavors:
  //   • something to act on  → JobStageActionButton (advance / undo). Timer
  //                            chip beneath only when this row is "mine"
  //                            (in_progress here, or pending+canStart with
  //                            all priors done).
  //   • nothing to act on    → plain RollupCell (n/a or all-outsourced —
  //                            no in-house counts at this stage).
  //
  // Other stages on the row keep the existing Link → /jobs/[id] behavior so
  // the row stays drillable from any non-head column.
  const isMineHere =
    highlightIsActionable && highlightStage
      ? jobIsMineAtStage(job, highlightStage)
      : false
  const timer =
    isMineHere && highlightStage ? jobTimerAtStage(job, highlightStage) : null
  // Returns override the master-grid color/sort while open — see
  // jobEffectiveDueDate. Original ship date stays on the job-detail header.
  const effDue = jobEffectiveDueDate(job)
  const ds = dueState(effDue)
  const days = daysFromToday(effDue)
  const stripeColor =
    ds === 'overdue'
      ? 'var(--color-overdue)'
      : ds === 'today'
        ? 'var(--color-warning)'
        : 'transparent'
  const detailHref = `/jobs/${job.id}`
  const rowOpacity =
    tier === 'mine' ? '' : tier === 'upstream' ? 'opacity-50' : 'opacity-40'
  return (
    <tr
      style={{
        viewTransitionName: `row-${job.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      }}
      className={`align-middle ${rowOpacity}`}
    >
      <td className="px-3 py-3 text-center mono text-[var(--color-ink-3)] text-[12px]">
        {String(index + 1).padStart(2, '0')}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Link
            href={detailHref}
            className="mono text-[13px] font-medium text-[var(--color-ink)] hover:underline underline-offset-4 decoration-[var(--color-ink-3)]"
          >
            <Highlight text={job.jobNo} q={q} />
          </Link>
          {jobHasOpenOutsource(job) && (
            <span
              className="mono text-[10px] tracking-wider px-1.5 py-px rounded-sm border border-[var(--color-info)] text-[var(--color-info)] leading-tight"
              title="此工单有零件正在外协"
              aria-label="此工单有外协"
            >
              外协
            </span>
          )}
          {job.activeReturn && <ReturnChip ret={job.activeReturn} />}
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-col leading-tight">
          {!isProduction && (
            <span className="text-[13px] font-medium text-[var(--color-ink)]">
              <Highlight text={job.customer} q={q} />
            </span>
          )}
          <span
            className={
              isProduction
                ? 'text-[13px] font-medium text-[var(--color-ink)]'
                : 'label mt-0.5 normal-case tracking-normal text-[11px] text-[var(--color-ink-3)]'
            }
          >
            <Highlight text={job.product} q={q} />
          </span>
          <MatchedComponentsStrip
            job={job}
            components={matchedComponents(job, q)}
            q={q}
            viewerStage={highlightStage}
          />
        </div>
      </td>
      {showMoney && (
        <td className="px-4 py-3 text-right">
          <div className="flex flex-col items-end leading-tight">
            <span
              className={
                typeof job.amountCny === 'number'
                  ? 'mono text-[13px] font-medium text-[var(--color-ink)]'
                  : 'mono text-[13px] text-[var(--color-ink-4)]'
              }
            >
              {formatCny(job.amountCny)}
            </span>
            {(() => {
              const ext = jobExternalSpend(job)
              if (ext === 0) return null
              const margin = jobMargin(job)
              return (
                <span className="mono text-[10px] text-[var(--color-ink-3)] mt-0.5">
                  外 {formatCny(ext)}
                  {typeof margin === 'number'
                    ? ` · 利 ${formatCny(margin)}`
                    : ''}
                </span>
              )
            })()}
          </div>
        </td>
      )}
      <td className="px-4 py-3">
        <DueCell date={effDue} state={ds} daysOff={days} />
      </td>
      {STAGES.map((stage) => {
        const isHighlighted = stage === highlightStage
        // Highlighted column when actionable: never changes color on hover
        // (the button paints its own state). Other columns keep the brown
        // hover so the row is clickable to job detail.
        const hoverCls =
          isHighlighted && highlightIsActionable
            ? ''
            : isHighlighted
              ? 'hover:bg-black/5'
              : 'hover:bg-[#f1eee4]'
        // Highlighted col tint on actionable view: full warning-soft for "mine"
        // rows (the action button paints it), but a much fainter wash on the
        // non-mine tiers (upstream + done) so the column stays visible without
        // competing with the actionable tier. Row-level opacity does the rest
        // of the work to push those tiers back.
        const cellBgStyle: React.CSSProperties | undefined =
          isHighlighted && highlightIsActionable && !isMineHere
            ? { backgroundColor: '#fdf7e7' }
            : undefined
        // Head's own column when actionable: render the action button
        // (or a plain RollupCell when there's nothing to act on). Crucially,
        // this branch NEVER wraps the cell in a <Link> — without that guard,
        // a click on a "done ✓" or "upstream-blocked" cell silently flashed
        // brown and navigated to /jobs/[id] instead of giving the head a way
        // to interact with the stage. The head's column owns stage actions.
        if (isHighlighted && highlightIsActionable) {
          const rollup = rollupStage(job, stage)
          const cnts = jobStageCounts(job, stage)
          const totalCounted = cnts.inProgress + cnts.pending + cnts.done
          if (totalCounted === 0) {
            // No in-house work for this head at this stage — n/a or every
            // part is currently at a vendor. Static cell, no Link, no button.
            return (
              <td key={stage} className="p-0 h-[78px]" style={cellBgStyle}>
                <RollupCell rollup={rollup} />
              </td>
            )
          }
          return (
            <td key={stage} className="p-0 h-[78px]" style={cellBgStyle}>
              <JobStageActionButton
                jobId={job.id}
                stage={stage}
                inProgress={cnts.inProgress}
                pending={cnts.pending}
                done={cnts.done}
                timer={timer}
                subdued
              />
            </td>
          )
        }
        return (
          <td key={stage} className="p-0 h-[78px]" style={cellBgStyle}>
            <Link
              href={detailHref}
              className={`block h-full w-full ${hoverCls} transition-colors`}
              aria-label={`${job.jobNo} · ${stage}`}
            >
              <RollupCell rollup={rollupStage(job, stage)} />
            </Link>
          </td>
        )
      })}
      <td
        className="px-3 py-2 align-middle"
        style={{ borderRight: `6px solid ${stripeColor}` }}
        // Click bubbles up from the input — stop the row's hover/link feel.
        onClick={(e) => e.stopPropagation()}
      >
        <JobNotesInline
          jobId={job.id}
          value={job.notes}
          placeholder="备注…"
          className={`text-[12px] ${
            job.notes && job.notes.includes('催')
              ? 'text-[var(--color-overdue)]'
              : 'text-[var(--color-ink-2)]'
          }`}
        />
      </td>
    </tr>
  )
}

// 排序 toggle + an inline range filter.
//   • Idle — single chip "📅 交期 / 生产日". Click expands the filter inline.
//   • Expanded — preset row [今天 · 本周 · 本月] then "从 [date] → 到 [date] ✕".
//     Presets fill both bounds in one click. Each date label opens its own
//     native picker. ✕ both clears the filter AND collapses back to the chip.
// The active preset (if the range matches one) bolds itself so the user gets a
// free "I'm on 本周" readout without parsing the ISO dates.
function SortBar({
  sortMode,
  setSortMode,
  dateFilter,
  setDateFilter,
}: {
  sortMode: SortMode
  setSortMode: (m: SortMode) => void
  dateFilter: DateFilter
  setDateFilter: (f: DateFilter) => void
}) {
  const startRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLInputElement>(null)
  // UI flag for "user clicked the chip but hasn't picked anything yet". An
  // active filter forces expanded regardless. If the filter is cleared
  // externally (e.g. the overview's 清除筛选 button) the chip stays expanded
  // with empty date labels until the user clicks ✕ — they can also just pick
  // a new range from the open form.
  const [uiExpanded, setUiExpanded] = useState(false)
  const isRange = dateFilter.kind === 'range'
  const expanded = uiExpanded || isRange
  const currentPreset = matchingPreset(dateFilter)
  const inactiveLabel = sortMode === 'jobNo' ? '生产日' : '交期'

  const openPicker = (ref: React.RefObject<HTMLInputElement | null>) => {
    const el = ref.current
    if (!el) return
    if (typeof el.showPicker === 'function') {
      try {
        el.showPicker()
      } catch {
        el.focus()
        el.click()
      }
    } else {
      el.focus()
      el.click()
    }
  }

  const applyPreset = (key: PresetKey) => {
    setDateFilter({ kind: 'range', ...presetRange(key) })
  }

  const onStartChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    if (!v) return
    if (isRange) {
      // Editing start of an active range: clamp so end never falls behind.
      const end = v > dateFilter.end ? v : dateFilter.end
      setDateFilter({ kind: 'range', start: v, end })
    } else {
      // First pick from expanded-but-empty: collapse to single-day. The user
      // can extend via the end label or a preset.
      setDateFilter({ kind: 'range', start: v, end: v })
    }
  }

  const onEndChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    if (!v) return
    if (isRange) {
      // End before start → swap rather than reject (Apple-style forgiveness).
      if (v < dateFilter.start) {
        setDateFilter({ kind: 'range', start: v, end: dateFilter.start })
      } else {
        setDateFilter({ kind: 'range', start: dateFilter.start, end: v })
      }
    } else {
      setDateFilter({ kind: 'range', start: v, end: v })
    }
  }

  const onCollapse = () => {
    setUiExpanded(false)
    setDateFilter({ kind: 'all' })
  }

  return (
    <div className="flex items-baseline gap-x-5 gap-y-2 flex-wrap text-[13px]">
      <SortToggle
        label="按交期"
        active={sortMode === 'due'}
        onClick={() => setSortMode('due')}
      />
      <SortToggle
        label="按工号"
        active={sortMode === 'jobNo'}
        onClick={() => setSortMode('jobNo')}
      />

      {!expanded ? (
        <button
          type="button"
          onClick={() => setUiExpanded(true)}
          aria-label="选择日期范围"
          title={
            sortMode === 'jobNo'
              ? '按生产日筛选 (工号上的日期)'
              : '按交期筛选'
          }
          className="inline-flex items-baseline gap-1.5 text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
        >
          <span className="translate-y-[1px]">
            <CalendarIcon />
          </span>
          <span>{inactiveLabel}</span>
        </button>
      ) : (
        <span className="inline-flex items-baseline gap-x-3 gap-y-1 flex-wrap">
          <span
            className="translate-y-[1px] text-[var(--color-ink-2)]"
            aria-hidden="true"
          >
            <CalendarIcon />
          </span>
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => applyPreset(p.key)}
              aria-pressed={currentPreset === p.key}
              className={`transition-colors ${
                currentPreset === p.key
                  ? 'text-[var(--color-ink)] font-semibold'
                  : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
              }`}
            >
              {p.label}
            </button>
          ))}
          <span className="text-[var(--color-ink-4)]" aria-hidden="true">
            ·
          </span>
          <span className="text-[var(--color-ink-3)]">从</span>
          <DateLabel
            value={isRange ? dateFilter.start : undefined}
            inputRef={startRef}
            onClick={() => openPicker(startRef)}
            onChange={onStartChange}
          />
          <span className="text-[var(--color-ink-3)]" aria-hidden="true">
            →
          </span>
          <span className="text-[var(--color-ink-3)]">到</span>
          <DateLabel
            value={isRange ? dateFilter.end : undefined}
            inputRef={endRef}
            min={isRange ? dateFilter.start : undefined}
            onClick={() => openPicker(endRef)}
            onChange={onEndChange}
          />
          <button
            type="button"
            onClick={onCollapse}
            aria-label="清除并收起日期筛选"
            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
          >
            <ClearIcon />
          </button>
        </span>
      )}
    </div>
  )
}

// A clickable date label that hides a native <input type="date"> directly
// behind itself. The hidden input is positioned absolutely over the button so
// the native picker pops up at the button's location (not floating elsewhere
// in the bar). showPicker() drives the open; the visible text is the
// formatted M月D日 (or "选择" placeholder).
function DateLabel({
  value,
  inputRef,
  min,
  onClick,
  onChange,
}: {
  value?: string
  inputRef: React.RefObject<HTMLInputElement | null>
  min?: string
  onClick: () => void
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <span className="relative inline-flex items-baseline">
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-baseline gap-0.5 transition-colors ${
          value
            ? 'mono font-medium text-[var(--color-ink)] hover:opacity-70'
            : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
        }`}
      >
        <span>{value ? formatPickedDate(value) : '选择'}</span>
        <span
          className="text-[var(--color-ink-4)] text-[9px] translate-y-[-2px]"
          aria-hidden="true"
        >
          ▼
        </span>
      </button>
      <input
        ref={inputRef}
        type="date"
        value={value ?? ''}
        min={min}
        onChange={onChange}
        className="absolute inset-0 opacity-0 pointer-events-none"
        tabIndex={-1}
        aria-hidden="true"
      />
    </span>
  )
}

function SortToggle({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-baseline gap-1 transition-colors ${
        active
          ? 'text-[var(--color-ink)] font-semibold'
          : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
      }`}
    >
      <span>{label}</span>
    </button>
  )
}

function Highlight({ text, q }: { text: string; q: string }) {
  const query = q.trim()
  if (!query) return <>{text}</>
  const lowerText = text.toLowerCase()
  const lowerQ = query.toLowerCase()
  const idx = lowerText.indexOf(lowerQ)
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-[var(--color-warning-soft)] text-[var(--color-ink)] px-0.5 rounded-[2px]">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  )
}

function CalendarIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="1.5"
        y="2.5"
        width="11"
        height="10"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <line
        x1="1.5"
        y1="5.5"
        x2="12.5"
        y2="5.5"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <line
        x1="4.5"
        y1="1"
        x2="4.5"
        y2="3.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <line
        x1="9.5"
        y1="1"
        x2="9.5"
        y2="3.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function ClearIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 3 L9 9 M9 3 L3 9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}
