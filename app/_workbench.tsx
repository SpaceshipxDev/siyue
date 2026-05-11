'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  STAGES,
  daysFromToday,
  dueState,
  effectiveStageState,
  isStageInRoute,
  jobEffectiveDueDate,
  jobHasOpenOutsource,
  jobIntakeDate,
  jobIsMineAtStage,
  jobIsShipped,
  jobIsUpstreamOfStage,
  jobMostRecentFinishedAt,
  jobNoSortKey,
  jobStageCounts,
  jobTimerAtStage,
  type Job,
  type Stage,
} from '@/lib/data'
import { DueCell } from './_ui'
import { JobStageActionButton } from './_cell'
import { JobNotesInline } from './_editable'
import { ReturnChip } from './_returns'

// Production user's home view at /?stage=<theirs>. The 16-column master grid
// is the wrong shape for a worker who only acts on ONE column; at 50 jobs/
// station the other 15 columns are pure scan tax. This component collapses
// the row to a single fat action button — drilling into /jobs/[id] still
// surfaces the full per-stage detail when needed.
//
// Three tabs partition the active jobs into the buckets a worker reasons in:
//   在此  — jobs ready to act on (jobIsMineAtStage)
//   上游  — work hasn't reached me yet (jobIsUpstreamOfStage)
//   下游  — work has visibly moved past me (jobIsDownstreamOf — see below).
//          At 出货 specifically the third tab pivots to 已出货 (jobIsShipped),
//          since shipping has no further stage.
//
// Search + sort apply across all tabs. Tab badges show counts under the
// current filter, so the user always sees the impact of what they typed.

type Tab = 'mine' | 'upstream' | 'done'
type SortMode = 'due' | 'jobNo'
// Range filter on the active sort axis. start === end is the single-day case;
// start < end is a true range. See SortBar below for the two-tap UX.
type DateFilter =
  | { kind: 'all' }
  | { kind: 'range'; start: string; end: string }

const DONE_TAB_LIMIT = 100

// At 出货 there is no downstream, so the third tab pivots to "shipped".
// At every other stage, "downstream" = finished here but still in production.
// Shipped jobs are deliberately excluded — once a job leaves the factory it
// stops mattering to the floor head.
function downstreamLabel(stage: Stage): { label: string; sub: string } {
  return stage === '出货'
    ? { label: '已出货', sub: '本站已发货' }
    : { label: '下游', sub: '已离开本站' }
}

// "Downstream" reads from the worker's POV: has the work visibly moved past
// my station? In this codebase parts can be picked up at any point (permissive
// starts), so we don't require my own stage to be done — we just look for any
// part on the job that's currently active or finished at a stage AFTER mine.
// A 5-part job with 4 parts at 操机 and 1 still at 工程 counts as downstream
// of 编程 even though 编程 isn't strictly "done": the work has clearly crossed
// past me. Shipped jobs are excluded so the floor stops worrying about them
// once they leave the building. (Special-case 出货 itself: there's no further
// stage, so the third tab pivots to "已出货" = jobIsShipped.)
function jobIsDownstreamOf(job: Job, stage: Stage): boolean {
  if (stage === '出货') return jobIsShipped(job)
  if (jobIsShipped(job)) return false
  const stageIdx = STAGES.indexOf(stage)
  for (const c of job.components) {
    for (let i = stageIdx + 1; i < STAGES.length; i++) {
      const s = STAGES[i]
      if (!isStageInRoute(c, s)) continue
      const eff = effectiveStageState(c, s)
      if (
        eff.kind === 'in_progress' ||
        eff.kind === 'done' ||
        eff.kind === 'outsourced'
      ) {
        return true
      }
    }
  }
  return false
}

function jobMatchesDate(j: Job, f: DateFilter, mode: SortMode): boolean {
  if (f.kind === 'all') return true
  const d = mode === 'jobNo' ? jobIntakeDate(j) : jobEffectiveDueDate(j)
  // Jobs without an intake date drop out of a 生产日 range, same as under the
  // old equality filter.
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

// Stages where work is *actually happening* for this job, restricted to
// stages upstream of mine. "Pending" doesn't count — a pending stage isn't
// "正在" doing anything, just queued. We list only in_progress and
// outsourced (vendor is actively working it). Empty result is meaningful:
// the job is upstream-queued but nobody has picked it up yet, so there's
// nothing accurate to say in a "正在 · X" hint.
function upstreamActiveStages(job: Job, stage: Stage): Stage[] {
  const stageIdx = STAGES.indexOf(stage)
  const active = new Set<Stage>()
  for (const c of job.components) {
    for (let i = 0; i < stageIdx; i++) {
      const s = STAGES[i]
      if (!isStageInRoute(c, s)) continue
      const eff = effectiveStageState(c, s)
      if (eff.kind === 'in_progress' || eff.kind === 'outsourced') {
        active.add(s)
      }
    }
  }
  return STAGES.filter((s) => active.has(s))
}

function formatPickedDate(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${parseInt(m, 10)}月${parseInt(d, 10)}日`
}

type Role = 'commerce' | 'production'

// 出货 production users get full search affordances (jobNo / customer /
// product) — they own the customer-facing print flow. Other stations only
// search jobNo. Commerce always gets the full search.
function isJobNoOnlySearch(role: Role, defaultStage?: Stage): boolean {
  return role === 'production' && defaultStage !== '出货'
}

export function StationWorkbench({
  jobs,
  stage,
  role,
  defaultStage,
}: {
  jobs: Job[]
  stage: Stage
  role: Role
  defaultStage?: Stage
}) {
  const [tab, setTab] = useState<Tab>('mine')
  const [q, setQ] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('due')
  const [dateFilter, setDateFilter] = useState<DateFilter>({ kind: 'all' })

  const showCustomer = role === 'commerce'
  const jobNoOnly = isJobNoOnlySearch(role, defaultStage)

  // Pipeline: text → date → sort. Partition into the three tabs at the end
  // so each tab badge reflects the live filter.
  const matched = useMemo(() => {
    const query = q.trim().toLowerCase()
    let out = jobs
    if (query) {
      out = out.filter((j) => {
        const haystack = jobNoOnly
          ? j.jobNo
          : `${j.jobNo} ${j.customer} ${j.product}`
        return haystack.toLowerCase().includes(query)
      })
    }
    out = out.filter((j) => jobMatchesDate(j, dateFilter, sortMode))
    return sortJobs(out, sortMode)
  }, [jobs, q, jobNoOnly, dateFilter, sortMode])

  const { mineRows, upstreamRows, doneRows } = useMemo(() => {
    // 下游 is INCLUSIVE — a job appears here if any part has moved past this
    // stage and the job hasn't shipped, even if other parts of the same job
    // are still on my bench (在此). The worker's question "what of mine is
    // already past?" gets a complete answer regardless of split state.
    //
    // 在此 stays scoped to "parts on my bench right now." 上游 means "work
    // has not yet reached me at all" — exclude both 在此 (mine) and 下游
    // (work has moved past) so 上游 reads as a pure incoming queue.
    const mine: Job[] = []
    const downstream: Job[] = []
    const upstream: Job[] = []
    for (const j of matched) {
      const mineHere = jobIsMineAtStage(j, stage)
      const downstreamHere = jobIsDownstreamOf(j, stage)
      if (mineHere) mine.push(j)
      if (downstreamHere) downstream.push(j)
      if (!mineHere && !downstreamHere && jobIsUpstreamOfStage(j, stage)) {
        upstream.push(j)
      }
    }
    upstream.sort((a, b) =>
      jobEffectiveDueDate(a).localeCompare(jobEffectiveDueDate(b)),
    )
    downstream.sort((a, b) =>
      jobMostRecentFinishedAt(b, stage).localeCompare(
        jobMostRecentFinishedAt(a, stage),
      ),
    )
    return {
      mineRows: mine,
      upstreamRows: upstream,
      doneRows: downstream.slice(0, DONE_TAB_LIMIT),
    }
  }, [matched, stage])

  const isFiltered = q.length > 0 || dateFilter.kind !== 'all'

  const tabRows = tab === 'mine' ? mineRows : tab === 'upstream' ? upstreamRows : doneRows

  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-3">
        <SearchInput q={q} setQ={setQ} placeholder={searchPlaceholder(jobNoOnly)} />
        <SortBar
          sortMode={sortMode}
          setSortMode={setSortMode}
          dateFilter={dateFilter}
          setDateFilter={setDateFilter}
        />
        {isFiltered && (
          <button
            type="button"
            onClick={() => {
              setQ('')
              setDateFilter({ kind: 'all' })
            }}
            className="label text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:underline underline-offset-4 decoration-[var(--color-ink-3)]"
          >
            清除 ↺
          </button>
        )}
      </div>

      <TabBar
        active={tab}
        onChange={setTab}
        stage={stage}
        counts={{
          mine: mineRows.length,
          upstream: upstreamRows.length,
          done: doneRows.length,
        }}
        doneTruncated={doneRows.length === DONE_TAB_LIMIT}
      />

      {tabRows.length === 0 ? (
        <EmptyState tab={tab} stage={stage} isFiltered={isFiltered} q={q} />
      ) : (
        <ul className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)] overflow-hidden">
          {tabRows.map((job, i) => (
            <WorkbenchRow
              key={job.id}
              job={job}
              index={i}
              stage={stage}
              tab={tab}
              q={q}
              showCustomer={showCustomer}
            />
          ))}
        </ul>
      )}
    </>
  )
}

function TabBar({
  active,
  onChange,
  stage,
  counts,
  doneTruncated,
}: {
  active: Tab
  onChange: (t: Tab) => void
  stage: Stage
  counts: { mine: number; upstream: number; done: number }
  doneTruncated: boolean
}) {
  const downstream = downstreamLabel(stage)
  const tabs: { key: Tab; label: string; sub: string; count: number; suffix?: string }[] = [
    { key: 'mine', label: '在此', sub: '可以做的', count: counts.mine },
    { key: 'upstream', label: '上游', sub: '还在上游手里', count: counts.upstream },
    {
      key: 'done',
      label: downstream.label,
      sub: downstream.sub,
      count: counts.done,
      suffix: doneTruncated ? '+' : undefined,
    },
  ]
  return (
    <div className="mb-5 grid grid-cols-3 border border-[var(--color-border)] bg-[var(--color-surface)] rounded-sm overflow-hidden">
      {tabs.map((t) => {
        const isActive = t.key === active
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            aria-pressed={isActive}
            aria-current={isActive ? 'page' : undefined}
            className={`relative flex flex-col items-baseline gap-1 px-5 py-4 text-left transition-colors border-r last:border-r-0 border-[var(--color-border)] ${
              isActive
                ? 'bg-[var(--color-active-bg)]'
                : 'bg-transparent hover:bg-[#f5f3ed]'
            }`}
          >
            <span className="flex items-baseline gap-3">
              <span
                className={`text-[15px] font-semibold tracking-tight ${
                  isActive
                    ? 'text-[var(--color-ink)]'
                    : 'text-[var(--color-ink-2)]'
                }`}
              >
                {t.label}
              </span>
              <span
                className={`mono text-[14px] tabular-nums ${
                  isActive
                    ? 'text-[var(--color-ink)]'
                    : 'text-[var(--color-ink-3)]'
                }`}
              >
                {t.count}
                {t.suffix ?? ''}
              </span>
            </span>
            <span className="label text-[var(--color-ink-3)]">{t.sub}</span>
            {isActive && (
              <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[var(--color-ink)]" />
            )}
          </button>
        )
      })}
    </div>
  )
}

function WorkbenchRow({
  job,
  index,
  stage,
  tab,
  q,
  showCustomer,
}: {
  job: Job
  index: number
  stage: Stage
  tab: Tab
  q: string
  showCustomer: boolean
}) {
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

  return (
    <li
      className="flex items-stretch min-h-[80px]"
      style={{
        viewTransitionName: `row-${job.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        borderLeft: `3px solid ${stripeColor}`,
      }}
    >
      <div className="flex items-center pl-3 pr-2 mono text-[11px] text-[var(--color-ink-4)] w-[44px] shrink-0 tabular-nums">
        {String(index + 1).padStart(2, '0')}
      </div>

      <Link
        href={detailHref}
        className="flex flex-1 min-w-0 items-center gap-5 px-2 py-3 hover:bg-[#f7f5ee] transition-colors"
      >
        <div className="w-[150px] shrink-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="mono text-[14px] font-medium text-[var(--color-ink)]">
              <Highlight text={job.jobNo} q={q} />
            </span>
            {jobHasOpenOutsource(job) && (
              <span
                className="mono text-[10px] tracking-wider px-1.5 py-px rounded-sm border border-[var(--color-info)] text-[var(--color-info)] leading-tight"
                title="此工单有零件正在外协"
              >
                外协
              </span>
            )}
            {job.activeReturn && <ReturnChip ret={job.activeReturn} />}
          </div>
        </div>

        <div className="flex-1 min-w-0">
          {showCustomer && (
            <p className="text-[14px] font-medium text-[var(--color-ink)] truncate">
              <Highlight text={job.customer} q={q} />
            </p>
          )}
          <p
            className={
              showCustomer
                ? 'text-[12px] text-[var(--color-ink-3)] truncate mt-0.5'
                : 'text-[14px] text-[var(--color-ink)] truncate'
            }
          >
            <Highlight text={job.product} q={q} />
          </p>
          {tab === 'upstream' && (
            <UpstreamHint job={job} stage={stage} />
          )}
        </div>

        <div className="w-[110px] shrink-0">
          <DueCell date={effDue} state={ds} daysOff={days} />
        </div>
      </Link>

      <div className="w-[200px] shrink-0 border-l border-[var(--color-border)]">
        <ActionCell job={job} stage={stage} tab={tab} />
      </div>

      <div className="w-[200px] shrink-0 border-l border-[var(--color-border)] flex items-center px-3">
        <JobNotesInline
          jobId={job.id}
          value={job.notes}
          placeholder="备注…"
          className={`text-[12px] w-full ${
            job.notes && job.notes.includes('催')
              ? 'text-[var(--color-overdue)]'
              : 'text-[var(--color-ink-2)]'
          }`}
        />
      </div>
    </li>
  )
}

function ActionCell({ job, stage, tab }: { job: Job; stage: Stage; tab: Tab }) {
  if (tab === 'mine') {
    const cnts = jobStageCounts(job, stage)
    const total = cnts.inProgress + cnts.pending + cnts.done
    if (total === 0) {
      // No in-house work for this head at this stage (e.g. fully outsourced).
      // Defensive — jobIsMineAtStage shouldn't return true in that case, but
      // we render a calm placeholder rather than an empty cell.
      return (
        <Link
          href={`/jobs/${job.id}`}
          className="flex h-full w-full items-center justify-center text-[12px] text-[var(--color-ink-3)] hover:bg-[#f7f5ee]"
        >
          <span className="mono">查看 →</span>
        </Link>
      )
    }
    const timer = jobTimerAtStage(job, stage)
    return (
      <JobStageActionButton
        jobId={job.id}
        stage={stage}
        inProgress={cnts.inProgress}
        pending={cnts.pending}
        done={cnts.done}
        timer={timer}
      />
    )
  }

  if (tab === 'upstream') {
    return (
      <Link
        href={`/jobs/${job.id}`}
        className="flex h-full w-full items-center justify-center px-3 py-3 hover:bg-[#f7f5ee] transition-colors text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
        aria-label={`查看 ${job.jobNo}`}
      >
        <span className="text-[18px] leading-none">→</span>
      </Link>
    )
  }

  // done tab
  const finishedAt = jobMostRecentFinishedAt(job, stage)
  const finishedDate = finishedAt
    ? finishedAt.length === 5 // MM-DD legacy
      ? finishedAt
      : finishedAt.slice(5, 10) // YYYY-MM-DD → MM-DD
    : ''
  return (
    <Link
      href={`/jobs/${job.id}`}
      className="flex h-full w-full flex-col items-center justify-center gap-1 px-3 py-3 hover:bg-[#f7f5ee] transition-colors"
      aria-label={`查看已完成 ${job.jobNo}`}
    >
      <span className="text-[20px] leading-none font-semibold text-[var(--color-success)]">
        ✓
      </span>
      {finishedDate && (
        <span className="mono text-[11px] text-[var(--color-ink-3)]">
          {finishedDate}
        </span>
      )}
    </Link>
  )
}

function UpstreamHint({ job, stage }: { job: Job; stage: Stage }) {
  const active = upstreamActiveStages(job, stage)
  if (active.length === 0) return null
  return (
    <p className="label mt-1 text-[var(--color-ink-3)]">
      正在 · {active.join(' / ')}
    </p>
  )
}

function EmptyState({
  tab,
  stage,
  isFiltered,
  q,
}: {
  tab: Tab
  stage: Stage
  isFiltered: boolean
  q: string
}) {
  const downstream = downstreamLabel(stage)
  const lines: Record<Tab, { title: string; sub: string }> = {
    mine: {
      title: `${stage} 此刻没有任务`,
      sub: '上游送来后会出现在这里',
    },
    upstream: {
      title: '没有上游工单',
      sub: '上游手上目前没有要送到本站的工单',
    },
    done:
      stage === '出货'
        ? { title: '本站还没有出货记录', sub: '出货后会显示在这里' }
        : { title: `${downstream.label}还没有工单`, sub: '完成本站后会出现在这里' },
  }
  const { title, sub } = lines[tab]
  return (
    <div className="rounded-sm border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-16 text-center">
      <p className="text-[14px] text-[var(--color-ink-2)]">
        {isFiltered && q ? `未找到 “${q}”` : title}
      </p>
      <p className="label mt-2 text-[var(--color-ink-3)]">
        {isFiltered ? '清除筛选后再试' : sub}
      </p>
    </div>
  )
}

function searchPlaceholder(jobNoOnly: boolean): string {
  return jobNoOnly ? '搜索 工号' : '搜索 · 工号 / 客户 / 产品'
}

function SearchInput({
  q,
  setQ,
  placeholder,
}: {
  q: string
  setQ: (s: string) => void
  placeholder: string
}) {
  return (
    <div className="relative inline-block">
      <span className="absolute left-0 top-1/2 -translate-y-1/2 text-[var(--color-ink-3)] pointer-events-none">
        <SearchIcon />
      </span>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className="w-[220px] md:w-[300px] h-8 pl-6 pr-6 bg-transparent border-0 border-b border-[var(--color-border-strong)] placeholder:text-[var(--color-ink-3)] focus:outline-none focus:border-[var(--color-ink)] transition-colors"
        style={{ fontSize: '14px' }}
      />
      {q && (
        <button
          type="button"
          onClick={() => setQ('')}
          aria-label="清除搜索"
          className="absolute right-0 top-1/2 -translate-y-1/2 h-5 w-5 inline-flex items-center justify-center rounded-full text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
        >
          <ClearIcon />
        </button>
      )}
    </div>
  )
}

// Two-tap date chip. Idle → click opens start picker; after start, end picker
// auto-opens (dismiss = single-day). When a true range is active each bound is
// its own button that re-opens only its own picker. Mirrors the SortBar in
// _master_filter.tsx — kept duplicated to match the existing pattern.
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
  const autoChain = useRef(false)
  const isRange = dateFilter.kind === 'range'
  const isSingleDay = isRange && dateFilter.start === dateFilter.end

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

  const onStartClick = () => {
    if (!isRange || isSingleDay) {
      autoChain.current = true
    }
    openPicker(startRef)
  }

  const onEndClick = () => {
    openPicker(endRef)
  }

  const onStartChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    if (!v) return
    let newEnd: string
    if (autoChain.current || !isRange) {
      newEnd = v
    } else {
      newEnd = v > dateFilter.end ? v : dateFilter.end
    }
    setDateFilter({ kind: 'range', start: v, end: newEnd })
    if (autoChain.current) {
      autoChain.current = false
      setTimeout(() => openPicker(endRef), 0)
    }
  }

  const onEndChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    if (!v || !isRange) return
    const start = dateFilter.start
    if (v < start) {
      setDateFilter({ kind: 'range', start: v, end: start })
    } else {
      setDateFilter({ kind: 'range', start, end: v })
    }
  }

  const onClear = () => {
    autoChain.current = false
    setDateFilter({ kind: 'all' })
  }

  const inactiveLabel = sortMode === 'jobNo' ? '生产日' : '交期'

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

      <span className="relative inline-flex items-baseline gap-1.5">
        <button
          type="button"
          onClick={onStartClick}
          aria-label={isRange ? '修改起始日期' : '选择日期范围'}
          title={
            sortMode === 'jobNo' ? '按生产日筛选 (工号上的日期)' : '按交期筛选'
          }
          className={`inline-flex items-baseline gap-1.5 transition-colors ${
            isRange
              ? 'text-[var(--color-ink)] hover:opacity-70'
              : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
          }`}
        >
          <span className="translate-y-[1px]">
            <CalendarIcon />
          </span>
          <span className={isRange ? 'mono font-semibold' : ''}>
            {isRange ? formatPickedDate(dateFilter.start) : inactiveLabel}
          </span>
        </button>
        {isRange && !isSingleDay && (
          <>
            <span className="text-[var(--color-ink-3)]" aria-hidden="true">
              →
            </span>
            <button
              type="button"
              onClick={onEndClick}
              aria-label="修改结束日期"
              className="mono font-semibold text-[var(--color-ink)] hover:opacity-70 transition-opacity"
            >
              {formatPickedDate(dateFilter.end)}
            </button>
          </>
        )}
        {isRange && (
          <button
            type="button"
            onClick={onClear}
            aria-label="清除日期筛选"
            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
          >
            <ClearIcon />
          </button>
        )}
        <input
          ref={startRef}
          type="date"
          value={isRange ? dateFilter.start : ''}
          onChange={onStartChange}
          className="absolute inset-0 opacity-0 pointer-events-none"
          tabIndex={-1}
          aria-hidden="true"
        />
        <input
          ref={endRef}
          type="date"
          value={isRange ? dateFilter.end : ''}
          min={isRange ? dateFilter.start : undefined}
          onChange={onEndChange}
          className="absolute inset-0 opacity-0 pointer-events-none"
          tabIndex={-1}
          aria-hidden="true"
        />
      </span>
    </div>
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

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.4" />
      <line
        x1="10.5"
        y1="10.5"
        x2="14"
        y2="14"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function CalendarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect
        x="1.5"
        y="2.5"
        width="11"
        height="10"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <line x1="1.5" y1="5.5" x2="12.5" y2="5.5" stroke="currentColor" strokeWidth="1.2" />
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
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M3 3 L9 9 M9 3 L3 9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}
