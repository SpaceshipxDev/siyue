'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import type { ComponentBoardRow, BoardStageChip } from '@/lib/packets'
import type { SetPartRouteResult } from '@/lib/db'
import { mutate } from '@/lib/mutate'
import { CaretIcon, FilterMenuRow, FunnelIcon } from './_status_filter'
import { StickyHorizontalScrollbar } from './_sticky_hscroll'

// The PMC's board — every live component as one row, read left to right the
// way a part physically flows: OPs → 铣床 → 检验 → 出货. The 进度
// column answers her one question ("这个单子现在在哪、做了多少、谁在做")
// without walking the floor. 客户 and 交期 filter in-place from the column
// header (Excel's caret → funnel gesture, same as the master board); 交期
// takes a single day or a two-click range.

function mdCn(ymd?: string): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return ymd ?? '—'
  const [, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return `${m}/${d}`
}

function relTime(iso?: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000))
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins}分钟前`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}小时前`
  return `${Math.floor(hrs / 24)}天前`
}

function dueTone(ymd: string | undefined, shipped: boolean): string {
  if (shipped || !ymd) return 'text-[var(--color-ink-2)]'
  const today = new Date()
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  if (ymd < iso) return 'text-[var(--color-overdue)] font-semibold'
  if (ymd === iso) return 'text-[var(--color-warning)] font-semibold'
  return 'text-[var(--color-ink)]'
}

// ---- Calendar plumbing (Mon-first, matching _datepop) ----------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function ymdOf(y: number, monthZero: number, d: number): string {
  const dt = new Date(y, monthZero, d)
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`
}

function localToday(): string {
  const t = new Date()
  return ymdOf(t.getFullYear(), t.getMonth(), t.getDate())
}

function addDays(s: string, n: number): string {
  const [y, m, d] = s.split('-').map(Number)
  return ymdOf(y, m - 1, d + n)
}

function monthOf(s: string): { y: number; m: number } {
  const [y, m] = s.split('-').map(Number)
  return { y, m: m - 1 }
}

function shiftMonth(v: { y: number; m: number }, delta: number): { y: number; m: number } {
  return monthOf(ymdOf(v.y, v.m + delta, 1))
}

function monthGrid(y: number, monthZero: number): string[] {
  const lead = (new Date(y, monthZero, 1).getDay() + 6) % 7 // Mon-first
  return Array.from({ length: 42 }, (_, i) => ymdOf(y, monthZero, 1 - lead + i))
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

// 交期 filter — inclusive [start, end]; an open edge (已逾期 = everything
// before today) leaves that side undefined. start === end is the single-day
// case the floor asks most ("这天要出什么").
type DueFilter = { start?: string; end?: string } | null

function dueMatches(filter: DueFilter, dueDate?: string): boolean {
  if (!filter) return true
  if (!dueDate) return false
  const d = dueDate.slice(0, 10)
  if (filter.start && d < filter.start) return false
  if (filter.end && d > filter.end) return false
  return true
}

function dueFilterLabel(filter: NonNullable<DueFilter>): string {
  const { start, end } = filter
  if (start && end) return start === end ? mdCn(start) : `${mdCn(start)} – ${mdCn(end)}`
  if (end) return `已逾期 ≤${mdCn(end)}`
  if (start) return `≥ ${mdCn(start)}`
  return '全部'
}

// ---- Portal popover shell ---------------------------------------------------
// The table lives in an overflow-x-auto wrapper which would clip an absolute
// dropdown to a sliver, so the panel renders into document.body at fixed
// viewport coords and FOLLOWS the trigger on scroll (same treatment as
// DatePop's portal mode).

function HeaderPop({
  active,
  ariaLabel,
  panelWidth,
  children,
}: {
  /** Column currently filtered → filled funnel instead of the idle caret. */
  active: boolean
  ariaLabel: string
  panelWidth: number
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const place = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setPos({
      top: rect.bottom + 8,
      left: Math.max(8, Math.min(rect.left - 8, window.innerWidth - panelWidth - 12)),
    })
  }

  const close = () => {
    setOpen(false)
    setPos(null)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    let raf = 0
    const onMove = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        place()
      })
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
      if (raf) cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <span ref={triggerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => {
          if (open) {
            close()
          } else {
            place()
            setOpen(true)
          }
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={ariaLabel}
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
      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label={ariaLabel}
              style={{ top: pos.top, left: pos.left, width: panelWidth }}
              className="fixed z-[100] overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] text-left shadow-[0_10px_34px_-12px_rgba(20,19,15,0.28),0_0_0_0.5px_rgba(0,0,0,0.04)]"
            >
              {children(close)}
            </div>,
            document.body,
          )
        : null}
    </span>
  )
}

function CustomerHeaderFilter({
  value,
  onChange,
  options,
  allCount,
}: {
  value: string
  onChange: (next: string) => void
  options: { name: string; count: number }[]
  allCount: number
}) {
  return (
    <HeaderPop active={value !== ''} ariaLabel="按客户筛选" panelWidth={188}>
      {(close) => (
        <div className="max-h-[320px] overflow-y-auto py-1">
          <FilterMenuRow
            label="全部客户"
            count={allCount}
            active={value === ''}
            onClick={() => {
              onChange('')
              close()
            }}
          />
          <div className="my-1 h-px bg-[var(--color-border)]" />
          {options.map((c) => (
            <FilterMenuRow
              key={c.name}
              label={c.name}
              count={c.count}
              active={value === c.name}
              onClick={() => {
                onChange(c.name)
                close()
              }}
            />
          ))}
        </div>
      )}
    </HeaderPop>
  )
}

function DuePreset({
  label,
  count,
  onClick,
}: {
  label: string
  count?: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 whitespace-nowrap rounded-[2px] bg-[var(--color-bg)] px-1.5 py-1 text-[12px] text-[var(--color-ink-2)] transition-colors hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink)]"
    >
      {label}
      {count ? <span className="ml-1 tabular-nums text-[var(--color-ink-4)]">{count}</span> : null}
    </button>
  )
}

// 交期 column filter — presets on top, a month calendar under. One click
// filters that day; a second click (on another day) stretches it into a
// range. Days that actually carry due parts get a dot so the eye lands on
// load-bearing dates instead of hunting.
function DueHeaderFilter({
  value,
  onChange,
  dueCounts,
}: {
  value: DueFilter
  onChange: (next: DueFilter) => void
  dueCounts: Map<string, number>
}) {
  const today = localToday()
  const [view, setView] = useState(() => monthOf(value?.start ?? value?.end ?? today))
  // First click of a would-be range. Cleared whenever the popover closes.
  const [anchor, setAnchor] = useState<string | null>(null)

  const overdueCount = useMemo(() => {
    let n = 0
    for (const [d, c] of dueCounts) if (d < today) n += c
    return n
  }, [dueCounts, today])
  const todayCount = dueCounts.get(today) ?? 0
  const tomorrow = addDays(today, 1)
  const tomorrowCount = dueCounts.get(tomorrow) ?? 0
  const weekEnd = addDays(today, 6)
  const weekCount = useMemo(() => {
    let n = 0
    for (const [d, c] of dueCounts) if (d >= today && d <= weekEnd) n += c
    return n
  }, [dueCounts, today, weekEnd])

  const grid = monthGrid(view.y, view.m)

  return (
    <HeaderPop active={value !== null} ariaLabel="按交期筛选" panelWidth={272}>
      {(close) => {
        const commit = (next: DueFilter) => {
          onChange(next)
          setAnchor(null)
          close()
        }
        const clickDay = (d: string) => {
          if (anchor && anchor !== d) {
            const [start, end] = anchor < d ? [anchor, d] : [d, anchor]
            onChange({ start, end })
            setAnchor(null)
            close()
            return
          }
          // First click — filter this one day immediately, but stay open so a
          // second click can stretch it into a range.
          setAnchor(d)
          onChange({ start: d, end: d })
        }
        return (
          <div className="p-3">
            <div className="mb-3 flex items-center gap-1">
              <DuePreset
                label="已逾期"
                count={overdueCount}
                onClick={() => commit({ end: addDays(today, -1) })}
              />
              <DuePreset
                label="今天"
                count={todayCount}
                onClick={() => commit({ start: today, end: today })}
              />
              <DuePreset
                label="明天"
                count={tomorrowCount}
                onClick={() => commit({ start: tomorrow, end: tomorrow })}
              />
              <DuePreset
                label="7天内"
                count={weekCount}
                onClick={() => commit({ start: today, end: weekEnd })}
              />
            </div>

            <div className="mb-2 flex items-center justify-between px-1">
              <button
                type="button"
                onClick={() => setView(shiftMonth(view, -1))}
                aria-label="上个月"
                className="flex h-6 w-6 items-center justify-center rounded-[2px] text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-ink)]"
              >
                ‹
              </button>
              <span className="text-[13px] font-medium tabular-nums text-[var(--color-ink)]">
                {view.y}年{view.m + 1}月
              </span>
              <button
                type="button"
                onClick={() => setView(shiftMonth(view, 1))}
                aria-label="下个月"
                className="flex h-6 w-6 items-center justify-center rounded-[2px] text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-ink)]"
              >
                ›
              </button>
            </div>

            <div className="mb-1 grid grid-cols-7">
              {WEEKDAYS.map((w) => (
                <span key={w} className="py-1 text-center text-[11px] text-[var(--color-ink-4)]">
                  {w}
                </span>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-y-0.5">
              {grid.map((day) => {
                const inMonth = monthOf(day).m === view.m
                const isToday = day === today
                const start = value?.start
                const end = value?.end
                const isEdge = day === start || day === end
                const inRange = Boolean(start && end && day > start && day < end)
                const hasDue = (dueCounts.get(day) ?? 0) > 0
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => clickDay(day)}
                    title={hasDue ? `${mdCn(day)} · ${dueCounts.get(day)} 个零件到期` : undefined}
                    className={[
                      'relative flex h-8 items-center justify-center text-[13px] tabular-nums transition-colors',
                      isEdge
                        ? 'rounded-[2px] bg-[var(--color-ink)] font-medium text-[var(--color-bg)]'
                        : inRange
                          ? 'bg-[var(--color-active-bg)] text-[var(--color-ink)]'
                          : 'rounded-[2px] hover:bg-[var(--color-surface)] hover:shadow-[inset_0_0_0_1px_var(--color-border)]',
                      !isEdge && !inRange
                        ? inMonth
                          ? 'text-[var(--color-ink-2)]'
                          : 'text-[var(--color-ink-4)]'
                        : '',
                    ].join(' ')}
                  >
                    {parseInt(day.slice(8), 10)}
                    {hasDue ? (
                      <span
                        className={`absolute bottom-[3px] left-1/2 h-[3px] w-[3px] -translate-x-1/2 rounded-full ${
                          isEdge ? 'bg-[var(--color-bg)]' : 'bg-[var(--color-info)]'
                        }`}
                      />
                    ) : isToday ? (
                      <span className="absolute bottom-[3px] left-1/2 h-[3px] w-[3px] -translate-x-1/2 rounded-full bg-[var(--color-ink-3)]" />
                    ) : null}
                  </button>
                )
              })}
            </div>

            <div className="mt-2 flex items-center justify-between px-1">
              <span className="text-[11px] text-[var(--color-ink-4)]">
                {anchor ? '再点一天即成范围' : '点一天筛选 · 连点两天选范围'}
              </span>
              {value ? (
                <button
                  type="button"
                  onClick={() => commit(null)}
                  className="rounded-[2px] px-1.5 py-0.5 text-[12px] text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-ink)]"
                >
                  清除
                </button>
              ) : null}
            </div>
          </div>
        )
      }}
    </HeaderPop>
  )
}

// Active-filter chip in the toolbar — the always-visible receipt for a filter
// that was set from a column header, with one-tap clear.
function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex h-9 items-center gap-1.5 rounded-[3px] border border-[var(--color-info)] bg-[color-mix(in_srgb,var(--color-info)_8%,transparent)] pl-2.5 pr-1 text-[12px] font-medium text-[var(--color-info)]">
      {label}
      <button
        type="button"
        onClick={onClear}
        aria-label={`清除筛选 ${label}`}
        className="flex h-6 w-6 items-center justify-center rounded-[2px] text-[15px] leading-none transition-colors hover:bg-[color-mix(in_srgb,var(--color-info)_14%,transparent)]"
      >
        ×
      </button>
    </span>
  )
}

function Chip({ chip, qty }: { chip: BoardStageChip; qty: number }) {
  if (chip.status === 'done') {
    return (
      <span
        title={chip.by ? `${chip.label} · ${chip.by}` : chip.label}
        className="inline-flex h-6 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[3px] border border-[var(--color-success)] bg-[var(--color-success-soft)] px-2 text-[11px] font-medium leading-none text-[var(--color-success)]"
      >
        {chip.label} ✓
      </span>
    )
  }
  if (chip.status === 'in_progress') {
    return (
      <span
        title={chip.by ? `${chip.label} · ${chip.by}` : chip.label}
        className="inline-flex h-6 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[3px] border border-[var(--color-warning)] bg-[color-mix(in_srgb,var(--color-warning)_14%,transparent)] px-2 text-[11px] font-semibold leading-none text-[var(--color-warning)]"
      >
        {chip.label} {chip.doneQty}/{qty}
      </span>
    )
  }
  return (
    <span className="inline-flex h-6 shrink-0 items-center justify-center whitespace-nowrap rounded-[3px] border border-[var(--color-border)] px-2 text-[11px] leading-none text-[var(--color-ink-3)]">
      {chip.label}
    </span>
  )
}

type Seg = 'active' | 'shipped' | 'all'

export function ComponentSheet({
  rows,
  canDeleteJobs = false,
  canEditRoutes = false,
}: {
  rows: ComponentBoardRow[]
  canDeleteJobs?: boolean
  canEditRoutes?: boolean
}) {
  const [q, setQ] = useState('')
  const [seg, setSeg] = useState<Seg>('active')
  const [customer, setCustomer] = useState('')
  const [dueFilter, setDueFilter] = useState<DueFilter>(null)
  const [deletedJobIds, setDeletedJobIds] = useState<Set<string>>(new Set())
  const [deletingJobIds, setDeletingJobIds] = useState<Set<string>>(new Set())
  const [millingOverrides, setMillingOverrides] = useState<Map<string, boolean>>(
    () => new Map(),
  )
  const [routePendingIds, setRoutePendingIds] = useState<Set<string>>(
    () => new Set(),
  )

  // Everything except the two header filters — the candidate pool both
  // filters slice, so each one's counts reflect the other's selection.
  const base = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (deletedJobIds.has(r.jobId)) return false
      if (seg === 'active' && r.shipped) return false
      if (seg === 'shipped' && !r.shipped) return false
      if (!needle) return true
      return [r.partNo, r.drawingNo, r.name, r.customer, r.jobNo]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle))
    })
  }, [rows, q, seg, deletedJobIds])

  const customerOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of base) {
      if (!r.customer || !dueMatches(dueFilter, r.dueDate)) continue
      counts.set(r.customer, (counts.get(r.customer) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'zh'))
      .map(([name, count]) => ({ name, count }))
  }, [base, dueFilter])

  const dueCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of base) {
      if (customer && r.customer !== customer) continue
      if (!r.dueDate) continue
      const d = r.dueDate.slice(0, 10)
      counts.set(d, (counts.get(d) ?? 0) + 1)
    }
    return counts
  }, [base, customer])

  const filtered = useMemo(
    () =>
      base.filter(
        (r) =>
          (!customer || r.customer === customer) && dueMatches(dueFilter, r.dueDate),
      ),
    [base, customer, dueFilter],
  )

  async function removeJob(row: ComponentBoardRow) {
    const partCount = rows.filter((candidate) => candidate.jobId === row.jobId).length
    if (
      !confirm(
        `永久删除工单「${row.jobNo}」及其 ${partCount} 个零件？\n\n生产进度、报工记录和上传资料也会一并删除，此操作无法撤销。`,
      )
    ) {
      return
    }

    setDeletingJobIds((current) => new Set(current).add(row.jobId))
    setDeletedJobIds((current) => new Set(current).add(row.jobId))
    try {
      await mutate({ kind: 'deleteJob', jobId: row.jobId })
    } catch (error) {
      setDeletedJobIds((current) => {
        const next = new Set(current)
        next.delete(row.jobId)
        return next
      })
      alert(error instanceof Error ? `删除失败：${error.message}` : '删除失败')
    } finally {
      setDeletingJobIds((current) => {
        const next = new Set(current)
        next.delete(row.jobId)
        return next
      })
    }
  }

  async function setMilling(row: ComponentBoardRow, enabled: boolean) {
    setRoutePendingIds((current) => new Set(current).add(row.partId))
    try {
      const stages = [
        ...row.ops.map((stage) => stage.stage),
        ...(enabled ? (['丝印'] as const) : []),
        '检验' as const,
      ]
      let result = (
        await mutate<SetPartRouteResult>({
          kind: 'setPartRoute',
          jobId: row.jobId,
          componentId: row.componentId,
          stages,
          force: false,
        })
      ).data
      if (!result.ok && result.reason === 'needs_confirm') {
        const history = result.conflicts.map((item) => item.stage).join('、')
        if (!confirm(`铣床已有进度（${history}），仍要从此零件工序中移除吗？`)) return
        result = (
          await mutate<SetPartRouteResult>({
            kind: 'setPartRoute',
            jobId: row.jobId,
            componentId: row.componentId,
            stages,
            force: true,
          })
        ).data
      }
      if (!result.ok) {
        alert(
          result.reason === 'outsourced_locked'
            ? '铣床已外协，不能从工序中移除。'
            : '工序保存失败，请刷新后重试。',
        )
        return
      }
      setMillingOverrides((current) => {
        const next = new Map(current)
        next.set(row.partId, enabled)
        return next
      })
    } catch {
      alert('工序保存失败，请刷新后重试。')
    } finally {
      setRoutePendingIds((current) => {
        const next = new Set(current)
        next.delete(row.partId)
        return next
      })
    }
  }

  const headerTh =
    'px-3 py-2.5 text-[11px] font-semibold tracking-[0.08em] text-[var(--color-ink-3)] whitespace-nowrap'

  // Hundreds of rows tall — the native horizontal bar sits at the table's
  // bottom edge, unreachable until you scroll all the way down. The proxy bar
  // pinned to the viewport bottom keeps horizontal scroll reachable anywhere.
  const tableScrollRef = useRef<HTMLDivElement>(null)

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜 货号 / 图纸号 / 名称 / 客户"
          className="h-9 px-3 w-64 max-w-full text-[13px] border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] outline-none focus:border-[var(--color-ink)]"
        />
        <div className="flex border border-[var(--color-border-strong)] rounded-[3px] overflow-hidden">
          {(
            [
              ['active', '在产'],
              ['shipped', '已出货'],
              ['all', '全部'],
            ] as [Seg, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSeg(key)}
              className={`h-9 px-3 text-[12px] font-medium ${
                seg === key
                  ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
                  : 'bg-[var(--color-surface)] text-[var(--color-ink-2)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {customer ? (
          <FilterChip label={`客户 · ${customer}`} onClear={() => setCustomer('')} />
        ) : null}
        {dueFilter ? (
          <FilterChip
            label={`交期 · ${dueFilterLabel(dueFilter)}`}
            onClear={() => setDueFilter(null)}
          />
        ) : null}
        <span className="text-[12px] text-[var(--color-ink-3)] ml-auto">
          {filtered.length} 个零件
        </span>
      </div>

      <div
        ref={tableScrollRef}
        className="siyue-hscroll-hide-native overflow-x-auto border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)]"
      >
        <table className="w-max min-w-full border-collapse">
          <thead>
            <tr className="border-b border-[var(--color-border-strong)] text-left">
              <th className={headerTh}>
                <span className="inline-flex items-center gap-1">
                  客户
                  <CustomerHeaderFilter
                    value={customer}
                    onChange={setCustomer}
                    options={customerOptions}
                    allCount={customerOptions.reduce((n, c) => n + c.count, 0)}
                  />
                </span>
              </th>
              <th className={headerTh}>货号</th>
              <th className={headerTh}>描述</th>
              <th className={headerTh}>
                <span className="inline-flex items-center gap-1">
                  交期
                  <DueHeaderFilter
                    value={dueFilter}
                    onChange={setDueFilter}
                    dueCounts={dueCounts}
                  />
                </span>
              </th>
              <th className={headerTh}>图纸号</th>
              <th className={headerTh}>数量</th>
              <th className={headerTh}>工序</th>
              <th className={headerTh}>最近报工</th>
              {canDeleteJobs ? <th className={headerTh}>操作</th> : null}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const millingEnabled = millingOverrides.get(r.partId) ?? Boolean(r.post)
              const millingChip = r.post ?? {
                stage: '丝印' as const,
                label: '铣床',
                status: 'pending' as const,
                doneQty: 0,
              }
              const inspectionChip = r.inspection ?? {
                stage: '检验' as const,
                label: '检验',
                status: 'pending' as const,
                doneQty: 0,
              }
              return (
                <tr
                  key={r.partId}
                  className="border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-bg)]"
                >
                <td className="px-3 py-2.5 text-[12px] text-[var(--color-ink-2)] whitespace-nowrap">
                  {r.customer || '—'}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <Link
                    href={`/jobs/${r.jobId}`}
                    className="font-mono text-[12px] font-semibold text-[var(--color-ink)] underline-offset-2 hover:underline"
                  >
                    {r.partNo || r.jobNo}
                  </Link>
                </td>
                <td className="px-3 py-2.5 text-[13px] font-medium whitespace-nowrap">
                  <Link href={`/jobs/${r.jobId}`} className="hover:underline underline-offset-2">
                    {r.name}
                  </Link>
                </td>
                <td className={`px-3 py-2.5 text-[12px] font-mono whitespace-nowrap ${dueTone(r.dueDate, r.shipped)}`}>
                  {mdCn(r.dueDate)}
                </td>
                <td className="px-3 py-2.5 font-mono text-[11px] text-[var(--color-ink-2)] max-w-[220px] truncate">
                  {r.drawingNo || '—'}
                </td>
                <td className="px-3 py-2.5 text-[13px] font-semibold font-mono">{r.qty}</td>
                <td className="px-3 py-2.5">
                  {/* The whole route in one read: OPs → 铣床 → 检验 → 出货.
                      Exactly the stages this part carries, nothing else. */}
                  <div className="flex w-max flex-nowrap items-center gap-1.5 whitespace-nowrap">
                    {r.ops.map((c) => (
                      <Chip key={c.stage} chip={c} qty={r.qty} />
                    ))}
                    {canEditRoutes ? (
                      <button
                        type="button"
                        disabled={routePendingIds.has(r.partId)}
                        onClick={() => void setMilling(r, !millingEnabled)}
                        aria-pressed={millingEnabled}
                        title={millingEnabled ? '点击取消铣床' : '点击加入铣床'}
                        className="shrink-0 rounded-[3px] disabled:opacity-50"
                      >
                        {millingEnabled ? (
                          <Chip chip={millingChip} qty={r.qty} />
                        ) : (
                          <span className="inline-flex h-6 shrink-0 items-center justify-center whitespace-nowrap rounded-[3px] border border-dashed border-[var(--color-border-strong)] px-2 text-[11px] leading-none text-[var(--color-ink-3)]">
                            ＋ 铣床
                          </span>
                        )}
                      </button>
                    ) : millingEnabled ? (
                      <Chip chip={millingChip} qty={r.qty} />
                    ) : null}
                    <Chip chip={inspectionChip} qty={r.qty} />
                    {r.shipped ? (
                      <span className="inline-flex h-6 shrink-0 items-center justify-center whitespace-nowrap rounded-[3px] border border-[var(--color-success)] bg-[var(--color-success-soft)] px-2 text-[11px] font-medium leading-none text-[var(--color-success)]">
                        出货 ✓
                      </span>
                    ) : r.ship && r.ship.doneQty > 0 ? (
                      <span className="inline-flex h-6 shrink-0 items-center justify-center whitespace-nowrap rounded-[3px] border border-[var(--color-warning)] px-2 text-[11px] font-semibold leading-none text-[var(--color-warning)]">
                        出货 {r.ship.doneQty}/{r.qty}
                      </span>
                    ) : (
                      <span className="inline-flex h-6 shrink-0 items-center justify-center whitespace-nowrap rounded-[3px] border border-[var(--color-border)] px-2 text-[11px] leading-none text-[var(--color-ink-3)]">
                        出货
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-[11px] text-[var(--color-ink-2)] whitespace-nowrap">
                  {r.lastReport ? (
                    <>
                      <span className="font-medium text-[var(--color-ink)]">
                        {r.lastReport.actor}
                      </span>{' '}
                      {r.lastReport.stage} +{r.lastReport.qty} ·{' '}
                      {relTime(r.lastReport.at)}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                {canDeleteJobs ? (
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      disabled={deletingJobIds.has(r.jobId)}
                      onClick={() => void removeJob(r)}
                      title={`删除工单 ${r.jobNo}`}
                      aria-label={`删除工单 ${r.jobNo}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-[3px] text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-overdue-soft)] hover:text-[var(--color-overdue)] disabled:opacity-40"
                    >
                      <TrashIcon />
                    </button>
                  </td>
                ) : null}
                </tr>
              )
            })}
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={canDeleteJobs ? 9 : 8}
                  className="px-3 py-10 text-center text-[13px] text-[var(--color-ink-3)]"
                >
                  没有匹配的零件 — 拍照录入后会自动出现在这里
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <StickyHorizontalScrollbar containerRef={tableScrollRef} />
    </div>
  )
}

function TrashIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  )
}
