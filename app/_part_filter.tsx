'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { STAGES, type Stage } from '@/lib/data'
import {
  PART_STAGE_CODE,
  PART_STAGE_FILTER_LABEL,
  PART_STAGE_FILTER_ORDER,
  type PartStageFilterKind,
} from '@/lib/part-status'
import { FilterFunnel, type FunnelRow, type StatusTone } from './_status_filter'

// In-job part filter — the master board's per-工段 status funnel, one level
// down. The board slices whole jobs by a column's status; this slices the
// parts of ONE job the same way, AND-combined across stage columns. The table
// itself stays server-rendered: each part row carries a packed data-st string
// (see lib/part-status), and this client layer just toggles row visibility.

type FacetCounts = {
  pending: number
  in_progress: number
  outsourced: number
  done: number
  total: number
}

const TONE: Record<PartStageFilterKind, StatusTone> = {
  pending: 'pending',
  in_progress: 'warning',
  outsourced: 'info',
  done: 'success',
}

type PartFilterCtx = {
  statusByStage: Partial<Record<Stage, PartStageFilterKind>>
  setStageStatus: (stage: Stage, kind: PartStageFilterKind | null) => void
  clearAll: () => void
  countsFor: (stage: Stage) => FacetCounts
  activeStageCount: number
  visibleCount: number
  totalParts: number
}

const Ctx = createContext<PartFilterCtx | null>(null)

function usePartFilter(): PartFilterCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('part-filter components must be inside JobPartFilterProvider')
  return ctx
}

const STAGE_INDEX: Record<Stage, number> = STAGES.reduce(
  (m, s, i) => {
    m[s] = i
    return m
  },
  {} as Record<Stage, number>,
)

export function JobPartFilterProvider({
  codes,
  children,
}: {
  /** partId → packed per-stage status string (one char per stage, STAGES
   *  order). Built server-side; the values drive the counts, the DOM rows
   *  drive the hiding. */
  codes: Record<string, string>
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [statusByStage, setStatusByStage] = useState<
    Partial<Record<Stage, PartStageFilterKind>>
  >({})

  const setStageStatus = useCallback(
    (stage: Stage, kind: PartStageFilterKind | null) =>
      setStatusByStage((prev) => {
        const next = { ...prev }
        if (kind === null) delete next[stage]
        else next[stage] = kind
        return next
      }),
    [],
  )
  const clearAll = useCallback(() => setStatusByStage({}), [])

  const allCodes = useMemo(() => Object.values(codes), [codes])
  const totalParts = allCodes.length

  // Does a part pass every active filter EXCEPT the one on `except`? Passing
  // `null` checks against all of them. Excel-style faceting: a column's own
  // counts are computed ignoring its own filter, so the numbers read "how many
  // land here given everything else I've narrowed".
  const passes = useCallback(
    (code: string, except: Stage | null) => {
      for (const s of STAGES) {
        const v = statusByStage[s]
        if (!v || s === except) continue
        if (code[STAGE_INDEX[s]] !== PART_STAGE_CODE[v]) return false
      }
      return true
    },
    [statusByStage],
  )

  const countsFor = useCallback(
    (stage: Stage): FacetCounts => {
      const c: FacetCounts = {
        pending: 0,
        in_progress: 0,
        outsourced: 0,
        done: 0,
        total: 0,
      }
      const i = STAGE_INDEX[stage]
      for (const code of allCodes) {
        if (!passes(code, stage)) continue
        const ch = code[i]
        if (ch === 'p') c.pending++
        else if (ch === 'i') c.in_progress++
        else if (ch === 'o') c.outsourced++
        else if (ch === 'd') c.done++
        else continue // 'n' — part skips this stage, never a filter target
        c.total++
      }
      return c
    },
    [allCodes, passes],
  )

  const visibleCount = useMemo(
    () => allCodes.reduce((n, code) => (passes(code, null) ? n + 1 : n), 0),
    [allCodes, passes],
  )

  const activeStageCount = useMemo(
    () => STAGES.reduce((n, s) => (statusByStage[s] ? n + 1 : n), 0),
    [statusByStage],
  )

  // Toggle row visibility off the rendered rows (source of truth — already
  // narrowed if a 退货 scoped the sheet). Mirrors the JobTabs DOM-toggle.
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const rows = root.querySelectorAll<HTMLTableRowElement>('tr[data-part-id]')
    rows.forEach((tr) => {
      const code = tr.getAttribute('data-st') ?? ''
      tr.hidden = !passes(code, null)
    })
  }, [passes])

  const value: PartFilterCtx = {
    statusByStage,
    setStageStatus,
    clearAll,
    countsFor,
    activeStageCount,
    visibleCount,
    totalParts,
  }

  const showEmpty = activeStageCount > 0 && visibleCount === 0

  return (
    <Ctx.Provider value={value}>
      <div ref={ref}>
        {children}
        {showEmpty && (
          <div className="px-6 py-10 text-center">
            <p className="text-[13px] text-[var(--color-ink-2)]">
              没有符合筛选的零件
            </p>
            <button
              type="button"
              onClick={clearAll}
              className="label mt-3 text-[var(--color-ink)] hover:underline underline-offset-4 decoration-[var(--color-ink-3)]"
            >
              清除筛选 ↺
            </button>
          </div>
        )}
      </div>
    </Ctx.Provider>
  )
}

// The funnel for one 工段 column header — the literal same control the master
// board carries in its column headers, sliced to this job's parts. Idle = a
// caret; once a status is picked it becomes a filled funnel.
export function JobPartStageFunnel({ stage }: { stage: Stage }) {
  const { statusByStage, setStageStatus, countsFor } = usePartFilter()
  const counts = countsFor(stage)
  const value = statusByStage[stage] ?? 'all'
  const rows: FunnelRow[] = PART_STAGE_FILTER_ORDER.map((k) => ({
    key: k,
    label: PART_STAGE_FILTER_LABEL[k],
    tone: TONE[k],
    count: counts[k],
  }))
  // Last two columns open their menus rightward so they don't clip the table's
  // right edge — same rule the board uses.
  const i = STAGE_INDEX[stage]
  const align = i >= STAGES.length - 2 ? 'right' : 'left'
  return (
    <FilterFunnel
      value={value}
      allLabel="全部"
      allCount={counts.total}
      rows={rows}
      align={align}
      ariaLabel={`筛选 ${stage} 状态`}
      title={`按状态筛选 · ${stage}`}
      onChange={(next) =>
        setStageStatus(stage, next === 'all' ? null : (next as PartStageFilterKind))
      }
    />
  )
}

// Count + clear, shown in the 零件进度 heading only while a filter is live.
// Stays invisible on the default view so the page carries zero extra chrome.
export function JobPartFilterSummary() {
  const { activeStageCount, visibleCount, totalParts, clearAll } = usePartFilter()
  if (activeStageCount === 0) return null
  return (
    <span className="inline-flex items-baseline gap-3">
      <span className="label text-[var(--color-ink-3)]">
        <span className="mono mr-1 text-[12px] font-medium text-[var(--color-ink)]">
          {visibleCount}
        </span>
        / {totalParts}
      </span>
      <button
        type="button"
        onClick={clearAll}
        className="label text-[var(--color-ink)] hover:underline underline-offset-4 decoration-[var(--color-ink-3)]"
      >
        清除 ↺
      </button>
    </span>
  )
}
