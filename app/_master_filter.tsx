'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  STAGES,
  daysFromToday,
  dueState,
  formatCny,
  jobIntakeDate,
  jobNoSortKey,
  type Stage,
} from '@/lib/data'
import {
  rowIsDoneAtStage,
  rowIsMineAtStage,
  rowIsShipped,
  rowIsUpstreamOfStage,
  rowMostRecentFinishedAt,
  rowRollupStage,
  rowStageCounts,
  rowTimerAtStage,
  type MasterRow,
} from '@/lib/master'
import { DueCell, RollupCell } from './_ui'
import { JobStageActionButton } from './_cell'
import { JobNotesInline } from './_editable'
import { ReturnChip } from './_returns'
import { TypeChip, useOptimisticJobType } from './_type_chip'
import { SearchInput } from './_search'
import { ExportExcelButton } from './_export_excel'
import { usePersistentState } from './_persist'
import { StickyHorizontalScrollbar } from './_sticky_hscroll'
import type { JobType } from '@/lib/data'

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

// Per-column status filter (商务 / 工程 overview only). The viewer focuses ONE
// 工段 column and narrows the rows to that station's rollup state:
//   pending — 未开始 (no part started here)
//   partial — 进行中 (some parts moving, not all done)
//   done    — 已完成 (every routed part finished here)
// 'all' keeps the column focused (header lit, live counts shown) without
// narrowing — the natural "I picked a column, show me everything" rest state.
// Mirrors lib/master#RowRollupKind minus 'na' (jobs that skip the stage are
// never status-filterable and drop out of every non-'all' bucket).
type StatusFilter = 'all' | 'pending' | 'partial' | 'done'

// 工段 floor vocabulary. Order is the lifecycle order a job moves through, so
// the segmented control reads left→right like the work actually flows.
const STATUS_LABEL: Record<StatusFilter, string> = {
  all: '全部',
  pending: '未开始',
  partial: '进行中',
  done: '已完成',
}

function rowMatchesDate(r: MasterRow, f: DateFilter, mode: SortMode): boolean {
  if (f.kind === 'all') return true
  const d = mode === 'jobNo' ? jobIntakeDate(r) : r.effectiveDueDate
  // Rows without an intake date (legacy / hand-entered 工号) drop out of a
  // 生产日 range, same as they did under the old equality filter.
  if (!d) return false
  return d >= f.start && d <= f.end
}

function sortRows(rows: MasterRow[], mode: SortMode): MasterRow[] {
  const arr = [...rows]
  if (mode === 'jobNo') {
    arr.sort((a, b) => jobNoSortKey(a).localeCompare(jobNoSortKey(b)))
  } else {
    arr.sort((a, b) => a.effectiveDueDate.localeCompare(b.effectiveDueDate))
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
  rows,
  role,
  defaultStage,
  stageFilter,
  actionableHighlight = false,
}: {
  rows: MasterRow[]
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
  // Scope persisted filter state per view context so the commerce overview,
  // /?stage=工程, and any station-filtered overview each remember their own
  // filter independently.
  const persistKey = `mes:filter:v1:master:${stageFilter ?? 'overview'}`
  const [q, setQ] = usePersistentState<string>(`${persistKey}:q`, '')
  const [sortMode, setSortMode] = usePersistentState<SortMode>(
    `${persistKey}:sort`,
    'due',
  )
  const [dateFilter, setDateFilter] = usePersistentState<DateFilter>(
    `${persistKey}:date`,
    { kind: 'all' },
  )
  const [shipFilter, setShipFilter] = usePersistentState<ShipFilter>(
    `${persistKey}:ship`,
    'live',
  )
  const [showAll, setShowAll] = usePersistentState<boolean>(
    `${persistKey}:showAll`,
    false,
  )
  // 待外协 facet — 商务's "what's waiting on me to arrange outsourcing" view.
  // Transient (not persisted): it's a momentary focus, not a saved preference,
  // so a refresh returns to the full board. Overview only.
  const [onlyPendingOutsource, setOnlyPendingOutsource] = useState(false)
  // 图纸变更 facet — the live drawing-change alarms. Same transient semantics
  // as 待外协; the chip itself only renders while ≥1 alarm is open, so the
  // board carries zero extra chrome on normal days.
  const [onlyDrawingChange, setOnlyDrawingChange] = useState(false)
  // Per-column status filters (overview only) — Excel-style: each 工段 column
  // carries its own independent filter, applied with AND across columns
  // ("未开始 at 编程 AND 已完成 at 工程"). Persisted per view context. A column
  // is "filtered" when its entry exists and isn't 'all'.
  const [statusByStage, setStatusByStage] = usePersistentState<
    Partial<Record<Stage, StatusFilter>>
  >(`${persistKey}:statusByStage`, {})
  const setStageStatus = (stage: Stage, next: StatusFilter) =>
    setStatusByStage((prev) => {
      const out = { ...prev }
      if (next === 'all') delete out[stage]
      else out[stage] = next
      return out
    })
  const clearStageStatuses = () => setStatusByStage({})
  // The columns with a live (non-'all') filter, in board order.
  const activeFilterStages = useMemo(
    () => STAGES.filter((s) => statusByStage[s] && statusByStage[s] !== 'all'),
    [statusByStage],
  )

  const isProduction = role === 'production'
  const showMoney = role === 'commerce'
  const jobNoOnly = isJobNoOnlySearch(role, defaultStage)
  // Job-type edit auth: commerce + 工程 head. Workers see the stripe + chip
  // read-only. Server enforces the same rule in /api/mutate#setJobType.
  const canEditType = role === 'commerce' || defaultStage === '工程'

  // Optimistic overlay for jobType edits — chip + stripe + sort all update
  // in the same React tick as the click. See useOptimisticJobType.
  const { effectiveType, effectiveIsProduct, setType, setIsProduct } =
    useOptimisticJobType(rows)

  // Ref handed to <StickyHorizontalScrollbar>: the grid is hundreds of rows
  // tall, so the native horizontal bar at the table's bottom is invisible
  // until you scroll to the end of the list. The proxy bar pinned to the
  // viewport bottom keeps the horizontal control reachable at every scroll
  // position.
  const tableScrollRef = useRef<HTMLDivElement>(null)

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

  // Counts on the segmented control: total rows in each scope BEFORE search /
  // sort / date narrowing. Apple-style segmented controls show stable counts;
  // the down-stream count chip already reflects the live filter.
  const liveCount = useMemo(
    () => rows.reduce((n, r) => (rowIsShipped(r) ? n : n + 1), 0),
    [rows],
  )
  const shippedCount = rows.length - liveCount

  const scopedRows = useMemo(() => {
    if (!showShipTabs) return rows
    return shipFilter === 'live'
      ? rows.filter((r) => !rowIsShipped(r))
      : rows.filter((r) => rowIsShipped(r))
  }, [rows, showShipTabs, shipFilter])
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
  // For non-出货 production users we restrict the searchable text to jobNo
  // only — customer + product are PII for them. The view-built haystack already
  // includes everything; for the jobNoOnly path we substring-match against
  // jobNo alone instead.
  const matchedByText = useMemo(() => {
    const query = q.trim().toLowerCase()
    if (!query) return scopedRows
    if (jobNoOnly) {
      return scopedRows.filter((r) => r.jobNo.toLowerCase().includes(query))
    }
    return scopedRows.filter((r) => r.searchHaystack.includes(query))
  }, [scopedRows, q, jobNoOnly])

  const sortedByMode = useMemo(
    () => sortRows(matchedByText, sortMode),
    [matchedByText, sortMode],
  )

  // Date narrowing is shared by the partition below AND the status-facet
  // counts, so it's hoisted out of the partition memo. The status filter sits
  // logically AFTER the date filter (you scope to "this week", then ask "what's
  // not started this week"), so counts are computed over this set.
  const dateFiltered = useMemo(
    () => sortedByMode.filter((r) => rowMatchesDate(r, dateFilter, sortMode)),
    [sortedByMode, dateFilter, sortMode],
  )

  // Faceted per-status counts for every 工段's header menu. Each column's
  // counts are computed over the set that passes the date scope AND every
  // OTHER column's active filter (but not its own) — so the numbers always
  // read "how many land here given everything else I've already narrowed",
  // exactly like Excel's filter dropdown. 'na' rows (job skips the stage) fall
  // out of every bucket. Only built on the overview, where the menus live.
  const statusCountsByStage = useMemo(() => {
    if (!treatAsOverview) return null
    const out = {} as Record<
      Stage,
      { pending: number; partial: number; done: number; total: number }
    >
    for (const s of STAGES) {
      const others = activeFilterStages.filter((o) => o !== s)
      let pending = 0
      let partial = 0
      let done = 0
      for (const r of dateFiltered) {
        if (!others.every((o) => rowRollupStage(r, o).kind === statusByStage[o]))
          continue
        const k = rowRollupStage(r, s).kind
        if (k === 'pending') pending++
        else if (k === 'partial') partial++
        else if (k === 'done') done++
      }
      out[s] = { pending, partial, done, total: pending + partial + done }
    }
    return out
  }, [treatAsOverview, dateFiltered, activeFilterStages, statusByStage])

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
    // Float 加急 rows to the very top — the single global priority signal.
    // Uses the OPTIMISTIC type so the row jumps the moment the user picks
    // 加急 from the chip popover. Within the rush bucket, most recently
    // flagged is first (pinned_at desc, set by setJobType when promoting
    // to rush). Stable input order keeps the just-clicked row at the top
    // until the server echoes back.
    const floatRush = (arr: MasterRow[]) => {
      const rush: MasterRow[] = []
      const rest: MasterRow[] = []
      for (const r of arr) {
        if (effectiveType(r) === 'rush') rush.push(r)
        else rest.push(r)
      }
      rush.sort((a, b) => {
        const ta = a.pinnedAt ?? ''
        const tb = b.pinnedAt ?? ''
        return tb.localeCompare(ta)
      })
      return [...rush, ...rest]
    }
    if (!isStationView || !stageFilter) {
      // Overview (商务 / 工程): a single flat list, narrowed by each filtered
      // 工段 column with AND across columns. No active column → untouched.
      const statusScoped =
        activeFilterStages.length === 0
          ? dateFiltered
          : dateFiltered.filter((r) =>
              activeFilterStages.every(
                (s) => rowRollupStage(r, s).kind === statusByStage[s],
              ),
            )
      const facetScoped = onlyPendingOutsource
        ? statusScoped.filter((r) => r.needsOutsource && !r.hasOpenOutsource)
        : statusScoped
      const alarmScoped = onlyDrawingChange
        ? facetScoped.filter((r) => r.drawingChangeOpen)
        : facetScoped
      return {
        topRows: floatRush(alarmScoped),
        upstreamRows: [] as MasterRow[],
        doneRows: [] as MasterRow[],
      }
    }
    if (q.trim().length > 0) {
      return {
        topRows: floatRush(dateFiltered),
        upstreamRows: [] as MasterRow[],
        doneRows: [] as MasterRow[],
      }
    }
    const top = dateFiltered.filter((r) => rowIsMineAtStage(r, stageFilter))
    const upstream = dateFiltered
      .filter(
        (r) =>
          !rowIsMineAtStage(r, stageFilter) &&
          !rowIsDoneAtStage(r, stageFilter) &&
          rowIsUpstreamOfStage(r, stageFilter),
      )
      .sort((a, b) => a.effectiveDueDate.localeCompare(b.effectiveDueDate))
      .slice(0, 20)
    const done = dateFiltered
      .filter((r) => rowIsDoneAtStage(r, stageFilter))
      .sort((a, b) =>
        rowMostRecentFinishedAt(b, stageFilter).localeCompare(
          rowMostRecentFinishedAt(a, stageFilter),
        ),
      )
      .slice(0, 20)
    return {
      topRows: floatRush(top),
      upstreamRows: floatRush(upstream),
      doneRows: done,
    }
  }, [dateFiltered, isStationView, stageFilter, q, effectiveType, activeFilterStages, statusByStage, onlyPendingOutsource, onlyDrawingChange])

  // 待外协 count over the current date scope — drives the facet chip label and
  // hides the chip entirely when nothing is waiting (clean board, no chrome).
  const pendingOutsourceCount = useMemo(
    () =>
      dateFiltered.reduce(
        (n, r) => (r.needsOutsource && !r.hasOpenOutsource ? n + 1 : n),
        0,
      ),
    [dateFiltered],
  )

  // 图纸变更 count — live drawing-change alarms. Same hide-at-zero contract
  // as 待外协: the chip is the boss's alarm list, and on normal days the
  // board shows no trace of the feature at all.
  const drawingChangeCount = useMemo(
    () => dateFiltered.reduce((n, r) => (r.drawingChangeOpen ? n + 1 : n), 0),
    [dateFiltered],
  )

  // Any column filter narrows the list — treat it like search/date so
  // pagination lifts and the count chip + 清除 affordance show.
  const statusActive = activeFilterStages.length > 0
  const filteredCount = topRows.length + upstreamRows.length + doneRows.length
  const isFiltered =
    q.length > 0 ||
    dateFilter.kind !== 'all' ||
    statusActive ||
    onlyPendingOutsource ||
    onlyDrawingChange

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
        {treatAsOverview && (pendingOutsourceCount > 0 || onlyPendingOutsource) && (
          <button
            type="button"
            onClick={() => setOnlyPendingOutsource((v) => !v)}
            aria-pressed={onlyPendingOutsource}
            className={`inline-flex items-baseline gap-1.5 rounded-[2px] border px-2.5 py-[3px] text-[10px] tracking-[0.14em] uppercase transition-colors ${
              onlyPendingOutsource
                ? 'border-[var(--color-warning)]/40 bg-[var(--color-warning-soft)] text-[var(--color-warning)]'
                : 'border-[var(--color-border)] text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)]'
            }`}
            title="只看工程已标记需外协、商务尚未安排的工单"
          >
            <span>待外协</span>
            <span className="mono text-[12px] tracking-normal font-medium">
              {pendingOutsourceCount}
            </span>
          </button>
        )}
        {/* 图纸变更 alarm facet — exists only while ≥1 alarm is live, so the
            board carries zero chrome on normal days. Overdue tone: this is
            the one true alarm, a notch louder than the 待外协 todo. */}
        {treatAsOverview && (drawingChangeCount > 0 || onlyDrawingChange) && (
          <button
            type="button"
            onClick={() => setOnlyDrawingChange((v) => !v)}
            aria-pressed={onlyDrawingChange}
            className={`inline-flex items-baseline gap-1.5 rounded-[2px] border px-2.5 py-[3px] text-[10px] tracking-[0.14em] uppercase transition-colors ${
              onlyDrawingChange
                ? 'border-[var(--color-overdue)]/40 bg-[var(--color-overdue-soft)] text-[var(--color-overdue)]'
                : 'border-[var(--color-border)] text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)]'
            }`}
            title="只看客户已修改图纸、报警未解除的工单"
          >
            <span>图纸变更</span>
            <span className="mono text-[12px] tracking-normal font-medium">
              {drawingChangeCount}
            </span>
          </button>
        )}
        <span className="ml-auto inline-flex items-baseline gap-4">
          <span className="label text-[var(--color-ink-3)]">
            <span
              className={`mono mr-1 text-[12px] ${
                isFiltered
                  ? 'text-[var(--color-ink)] font-medium'
                  : 'text-[var(--color-ink-2)]'
              }`}
            >
              {filteredCount}
            </span>
            {isFiltered ? `/ ${scopedRows.length}` : ''}
          </span>
          {/* 导出 — downloads exactly the rows the table is showing (search +
              date + 在产/已出货 + column status filters all applied). Sits
              beside the count so "导出 N 个" reads as one unit. */}
          <ExportExcelButton
            rows={[...topRows, ...upstreamRows, ...doneRows]}
            showMoney={showMoney}
            showCustomer={!isProduction}
          />
        </span>
      </div>

      <div
        ref={tableScrollRef}
        className="siyue-hscroll-hide-native overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]"
      >
        <table className="sheet w-full text-left text-[13px]">
          <colgroup>
            <col style={{ width: 56 }} />
            <col style={{ width: 230 }} />
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
              // Cool wash on a column with a live filter — deliberately
              // distinct from the warm warning wash of the home/action column
              // so the two signals never read as the same thing. Yields to the
              // warning wash when both land on one column.
              const isFilteredCol =
                treatAsOverview && Boolean(statusByStage[s])
              const colBg =
                isHighlighted && !highlightIsActionable
                  ? 'var(--color-warning-soft)'
                  : isFilteredCol
                    ? 'var(--color-info-soft)'
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
                {isProduction ? '产品' : '客户 / 工程师'}
              </th>
              {showMoney && (
                <th className="px-4 py-3 text-right label whitespace-nowrap">
                  金额
                </th>
              )}
              <th className="px-4 py-3 label whitespace-nowrap">交期</th>
              {STAGES.map((s, si) => {
                const isHighlighted = s === highlightStage
                const colStatus = statusByStage[s]
                const isFilteredCol = treatAsOverview && Boolean(colStatus)
                // The stage name is a plain label — the column header doesn't
                // navigate anywhere (the per-stage drill-down wasn't useful from
                // the dashboard). All interaction lives in the filter funnel
                // beside it.
                return (
                  <th
                    key={s}
                    // Override .sheet th { overflow:hidden } so the dropdown
                    // isn't clipped. Header text never overflows, so visible is
                    // safe here.
                    style={{ overflow: 'visible' }}
                    className="relative px-2 py-3 text-center whitespace-nowrap"
                  >
                    <span className="inline-flex items-center justify-center gap-1 text-[12px] font-medium tracking-wider text-[var(--color-ink)]">
                      <span
                        className={
                          isHighlighted || isFilteredCol
                            ? 'font-semibold text-[var(--color-ink)]'
                            : undefined
                        }
                      >
                        {s}
                      </span>
                      {treatAsOverview && (
                        <HeaderFilter
                          stage={s}
                          value={colStatus ?? 'all'}
                          counts={
                            statusCountsByStage?.[s] ?? {
                              pending: 0,
                              partial: 0,
                              done: 0,
                              total: 0,
                            }
                          }
                          align={si >= STAGES.length - 2 ? 'right' : 'left'}
                          onChange={(next) => setStageStatus(s, next)}
                        />
                      )}
                    </span>
                    {/* Accent bar marks a column with a live filter. */}
                    {isFilteredCol && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-2 bottom-[6px] h-[2px] rounded-[2px] bg-[var(--color-info)]"
                      />
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
            {visibleTopRows.map((row, i) => (
              <JobRow
                key={row.id}
                row={row}
                index={i}
                q={q}
                isProduction={isProduction}
                showMoney={showMoney}
                highlightStage={highlightStage}
                highlightIsActionable={highlightIsActionable}
                tier="mine"
                canEditType={canEditType}
                jobType={effectiveType(row)}
                isProduct={effectiveIsProduct(row)}
                onTypeChange={(next) => setType(row, next)}
                onProductChange={(next) => setIsProduct(row, next)}
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
                {upstreamRows.map((row, i) => (
                  <JobRow
                    key={row.id}
                    row={row}
                    index={topRows.length + i}
                    q={q}
                    isProduction={isProduction}
                    showMoney={showMoney}
                    highlightStage={highlightStage}
                    highlightIsActionable={highlightIsActionable}
                    tier="upstream"
                    canEditType={canEditType}
                    jobType={effectiveType(row)}
                    isProduct={effectiveIsProduct(row)}
                    onTypeChange={(next) => setType(row, next)}
                    onProductChange={(next) => setIsProduct(row, next)}
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
                {doneRows.map((row, i) => (
                  <JobRow
                    key={row.id}
                    row={row}
                    index={topRows.length + upstreamRows.length + i}
                    q={q}
                    isProduction={isProduction}
                    showMoney={showMoney}
                    highlightStage={highlightStage}
                    highlightIsActionable={highlightIsActionable}
                    tier="done"
                    canEditType={canEditType}
                    jobType={effectiveType(row)}
                    isProduct={effectiveIsProduct(row)}
                    onTypeChange={(next) => setType(row, next)}
                    onProductChange={(next) => setIsProduct(row, next)}
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
              {q
                ? `未找到 “${q}”`
                : statusActive
                  ? `${activeFilterStages
                      .map((s) => `${s} · ${STATUS_LABEL[statusByStage[s]!]}`)
                      .join(' / ')} 暂无工单`
                  : '该范围暂无工单'}
            </p>
            {isFiltered && (
              <button
                type="button"
                onClick={() => {
                  setQ('')
                  setDateFilter({ kind: 'all' })
                  clearStageStatuses()
                }}
                className="label mt-4 text-[var(--color-ink)] hover:underline underline-offset-4 decoration-[var(--color-ink-3)]"
              >
                清除筛选 ↺
              </button>
            )}
          </div>
        )}
      </div>
      <StickyHorizontalScrollbar containerRef={tableScrollRef} />
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

// Excel-style per-column status filter. A small triangle sits beside each
// 工段 header name; clicking it drops a menu to slice that column's rows by
// state (全部 / 未开始 / 进行中 / 已完成) with live counts. Once a state is
// picked the trigger becomes a filled funnel and the column lights up (accent
// bar + cool wash). The header itself doesn't navigate — the funnel is the only
// interactive target. Closes on outside-click / Esc.
function HeaderFilter({
  stage,
  value,
  counts,
  align,
  onChange,
}: {
  stage: Stage
  value: StatusFilter
  counts: { pending: number; partial: number; done: number; total: number }
  align: 'left' | 'right'
  onChange: (next: StatusFilter) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const active = value !== 'all'

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const rows: { key: StatusFilter; tone: StatusTone; count: number }[] = [
    { key: 'pending', tone: 'pending', count: counts.pending },
    { key: 'partial', tone: 'warning', count: counts.partial },
    { key: 'done', tone: 'success', count: counts.done },
  ]

  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`筛选 ${stage} 状态`}
        title={`按状态筛选 · ${stage}`}
        className={`inline-flex h-4 w-4 items-center justify-center rounded-[2px] transition-colors ${
          active
            ? 'text-[var(--color-info)]'
            : open
              ? 'text-[var(--color-ink)] bg-black/[0.06]'
              : 'text-[var(--color-ink-4)] hover:text-[var(--color-ink-2)] hover:bg-black/[0.04]'
        }`}
      >
        {active ? <FunnelIcon /> : <CaretIcon />}
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={`${stage} 状态`}
          className={`absolute top-[calc(100%+8px)] z-40 min-w-[148px] overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] py-1 text-left shadow-[0_10px_34px_-12px_rgba(20,19,15,0.28)] ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          <FilterMenuRow
            label="全部"
            count={counts.total}
            active={value === 'all'}
            onClick={() => {
              onChange('all')
              setOpen(false)
            }}
          />
          <div className="my-1 h-px bg-[var(--color-border)]" />
          {rows.map((r) => (
            <FilterMenuRow
              key={r.key}
              label={STATUS_LABEL[r.key]}
              count={r.count}
              tone={r.tone}
              active={value === r.key}
              onClick={() => {
                onChange(r.key)
                setOpen(false)
              }}
            />
          ))}
        </div>
      )}
    </span>
  )
}

type StatusTone = 'pending' | 'warning' | 'success'

const STATUS_TONE_VAR: Record<StatusTone, string> = {
  pending: 'var(--color-ink-3)',
  warning: 'var(--color-warning)',
  success: 'var(--color-success)',
}

// One row in a column's filter menu: a tone dot, the label, and the live count
// pinned right. Active row goes ink + semibold with a check.
function FilterMenuRow({
  label,
  count,
  tone,
  active,
  onClick,
}: {
  label: string
  count: number
  tone?: StatusTone
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] normal-case tracking-normal transition-colors hover:bg-[var(--color-bg)] ${
        active
          ? 'font-semibold text-[var(--color-ink)]'
          : 'text-[var(--color-ink-2)]'
      }`}
    >
      <span
        aria-hidden="true"
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-[2px]"
        style={{ background: tone ? STATUS_TONE_VAR[tone] : 'var(--color-ink-4)' }}
      />
      <span className="flex-1 text-left">{label}</span>
      <span
        className={`mono text-[11px] tabular-nums ${
          active ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-4)]'
        }`}
      >
        {count}
      </span>
      <span
        className={`w-2 text-[10px] ${active ? 'text-[var(--color-ink)]' : 'text-transparent'}`}
        aria-hidden="true"
      >
        ✓
      </span>
    </button>
  )
}

// Idle trigger — a quiet downward caret, the universal "open a filter here".
function CaretIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path
        d="M2 3.5 L5 6.5 L8 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Active trigger — a filled funnel, the spreadsheet "this column is filtered".
function FunnelIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <path d="M1.5 2 H10.5 L7 6.2 V9.5 L5 10.5 V6.2 Z" />
    </svg>
  )
}

function JobRow({
  row,
  index,
  q,
  isProduction,
  showMoney,
  highlightStage,
  highlightIsActionable,
  tier,
  canEditType,
  jobType,
  isProduct,
  onTypeChange,
  onProductChange,
}: {
  row: MasterRow
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
  /** Commerce/工程 can edit the job's classification (短期/中期/长期/加急).
   *  Other roles see the chip + stripe read-only. */
  canEditType: boolean
  /** Effective job type after the optimistic overlay. Drives stripe color
   *  + chip label + rush-first sort (sort is done by parent). */
  jobType?: JobType
  isProduct: boolean
  onTypeChange: (next: JobType | null) => void
  onProductChange: (next: boolean) => void
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
      ? rowIsMineAtStage(row, highlightStage)
      : false
  const timer =
    isMineHere && highlightStage ? rowTimerAtStage(row, highlightStage) : null
  // Returns override the master-grid color/sort while open — effective due
  // date is precomputed on the row. Original ship date stays on the
  // job-detail header.
  const effDue = row.effectiveDueDate
  const ds = dueState(effDue)
  const days = daysFromToday(effDue)
  const stripeColor =
    ds === 'overdue'
      ? 'var(--color-overdue)'
      : ds === 'today'
        ? 'var(--color-warning)'
        : 'transparent'
  const detailHref = `/jobs/${row.id}`
  const rowOpacity =
    tier === 'mine' ? '' : tier === 'upstream' ? 'opacity-50' : 'opacity-40'
  return (
    <tr
      style={{
        viewTransitionName: `row-${row.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      }}
      className={`group/row align-middle ${rowOpacity}`}
    >
      <td className="px-3 py-3 text-center mono text-[var(--color-ink-3)] text-[12px]">
        {String(index + 1).padStart(2, '0')}
      </td>
      <td className="px-4 py-3">
        {/* Type chip BEFORE 工号 — square-ish tonal block, carries the
            color signal that the old left stripe used to. The full 工号
            never wraps (`whitespace-nowrap` + reserved column width);
            secondary badges (外协 / 退货) flow to a second row below
            via `flex-wrap` if the row gets too dense. */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-nowrap">
            <TypeChip
              jobType={jobType}
              isProduct={isProduct}
              jobNo={row.jobNo}
              canEdit={canEditType}
              onChange={onTypeChange}
              onProductChange={onProductChange}
            />
            <Link
              href={detailHref}
              className="mono text-[13px] font-medium text-[var(--color-ink)] hover:underline underline-offset-4 decoration-[var(--color-ink-3)] whitespace-nowrap"
            >
              <Highlight text={row.jobNo} q={q} />
            </Link>
          </div>
          {row.hasOpenOutsource && (
            <span
              className="row-badge"
              data-tone="info"
              title="此工单有零件正在外协"
              aria-label="此工单有外协"
            >
              外协
            </span>
          )}
          {/* 待外协 — 工程 flagged this job for outsourcing; 商务 hasn't made
              the vendor block yet. Mutually exclusive with the 外协 chip above
              (the flag is cleared when the block is created). */}
          {!row.hasOpenOutsource && row.needsOutsource && (
            <span
              className="row-badge"
              data-tone="warning"
              title={
                row.outsourceNote
                  ? `待外协 · ${row.outsourceNote}`
                  : '工程已标记需外协，待商务安排'
              }
              aria-label="待外协"
            >
              待外协
            </span>
          )}
          {row.hasOpenInspectionVerdict && (
            <span
              className="row-badge"
              data-tone="overdue"
              title="此工单有零件检验未过 (重做/返修/外修)"
              aria-label="检验异常"
            >
              检验异常
            </span>
          )}
          {/* 图纸变更 — live drawing-change alarm; the headline lives on the
              job-detail banner, this is the row-level pointer to it. */}
          {row.drawingChangeOpen && (
            <span
              className="row-badge"
              data-tone="overdue"
              title={
                row.drawingChangeNote
                  ? `图纸变更 · ${row.drawingChangeNote}`
                  : '客户已修改图纸,请核对最新图纸后再加工'
              }
              aria-label="图纸变更"
            >
              图纸变更
            </span>
          )}
          {row.activeReturn && <ReturnChip ret={row.activeReturn} />}
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-col leading-tight">
          {!isProduction && (
            <span className="text-[13px] font-medium text-[var(--color-ink)]">
              <Highlight text={row.customer} q={q} />
            </span>
          )}
          {/* Production sees 产品 (the part they actually make); commerce/boss
              see 工程师 as the customer-side identifier under the customer name. */}
          <span
            className={
              isProduction
                ? 'text-[13px] font-medium text-[var(--color-ink)]'
                : 'label mt-0.5 normal-case tracking-normal text-[11px] text-[var(--color-ink-3)]'
            }
          >
            <Highlight text={isProduction ? row.product : row.engineer || '—'} q={q} />
          </span>
          {/* MatchedComponentsStrip dropped on the lite shape — components
              are not loaded on the master read. Job-detail still shows them. */}
        </div>
      </td>
      {showMoney && (
        <td className="px-4 py-3 text-right">
          <div className="flex flex-col items-end leading-tight">
            <span
              className={
                typeof row.amountCny === 'number'
                  ? 'mono text-[13px] font-medium text-[var(--color-ink)]'
                  : 'mono text-[13px] text-[var(--color-ink-4)]'
              }
            >
              {formatCny(row.amountCny)}
            </span>
            {row.externalSpendCny !== 0 && (
              <span className="mono text-[10px] text-[var(--color-ink-3)] mt-0.5">
                外 {formatCny(row.externalSpendCny)}
                {typeof row.marginCny === 'number'
                  ? ` · 利 ${formatCny(row.marginCny)}`
                  : ''}
              </span>
            )}
          </div>
        </td>
      )}
      <td className="px-4 py-3">
        <DueCell
          date={effDue}
          state={ds}
          daysOff={days}
          secondaryDate={row.secondaryDueDate}
        />
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
          const rollup = rowRollupStage(row, stage)
          const cnts = rowStageCounts(row, stage)
          const totalCounted = cnts.inProgress + cnts.pending + cnts.done
          if (totalCounted === 0) {
            return (
              <td key={stage} className="p-0 h-[78px]" style={cellBgStyle}>
                <RollupCell rollup={rollup} />
              </td>
            )
          }
          return (
            <td key={stage} className="p-0 h-[78px]" style={cellBgStyle}>
              <JobStageActionButton
                jobId={row.id}
                stage={stage}
                inProgress={cnts.inProgress}
                pending={cnts.pending}
                done={cnts.done}
                latestBy={rollup.latestBy}
                latestDate={rollup.latestDate}
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
              aria-label={`${row.jobNo} · ${stage}`}
            >
              <RollupCell rollup={rowRollupStage(row, stage)} />
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
          jobId={row.id}
          value={row.notes}
          placeholder="备注…"
          className={`text-[12px] ${
            row.notes && row.notes.includes('催')
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
            className="inline-flex h-4 w-4 items-center justify-center rounded-[2px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
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
