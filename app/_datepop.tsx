'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Single-date popover picker — the project's replacement for native
// <input type=date>, which auto-commits while scrolling months (the exact
// failure the 报工 range calendar was built to fix; this is its single-date
// sibling). Month arrows ONLY change the view; clicking a day commits and
// closes. Unlike the report calendar, future dates are allowed by default —
// 预计回厂 / 交期-style fields point forward.

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] // Mon-first

export function DatePop({
  value,
  onChange,
  allowFuture = true,
  disabled = false,
  placeholder = '选择日期',
  className = '',
  formatLabel,
  hideIcon = false,
  withTime = false,
  clearable = false,
  tone,
  triggerClass,
  portal = false,
}: {
  /** Current value (YYYY-MM-DD, or YYYY-MM-DDTHH:mm when withTime) — '' / undefined for unset. */
  value?: string
  onChange: (next: string) => void
  /** false → days after today are unpickable (e.g. 收件日期). */
  allowFuture?: boolean
  disabled?: boolean
  placeholder?: string
  className?: string
  /** Optional human label for the trigger (e.g. '6月10日'); raw ISO otherwise. */
  formatLabel?: (iso: string) => string
  /** Drop the calendar glyph on the trigger (cleaner in dense rows). */
  hideIcon?: boolean
  /** Opt-in: let the user pin an optional hour. Commits YYYY-MM-DDTHH:mm when a
   *  time is set, plain YYYY-MM-DD otherwise. Off by default so every existing
   *  caller is untouched. */
  withTime?: boolean
  /** Opt-in: show a 清除 preset when a value is set, committing '' so the caller
   *  can delete the field. Off by default (most date fields are required). */
  clearable?: boolean
  /** Optional text-color class for the trigger label (e.g. red when a plan is
   *  slipping). Replaces the default ink; leave unset for standard styling. */
  tone?: string
  /** Optional size/weight classes for the trigger label — lets a caller make
   *  the value read bigger/bolder (e.g. the 排产 band). Defaults to text-[13px]. */
  triggerClass?: string
  /** Opt-in: render the panel into document.body (position:fixed) instead of
   *  absolutely inside the trigger. Required when the trigger lives inside an
   *  overflow-clipped container — e.g. the 排产 plan row inside the 零件进度
   *  table's horizontal-scroll wrapper, which clips an absolute panel to a
   *  sliver. Off by default so every existing caller keeps its geometry. */
  portal?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [openUp, setOpenUp] = useState(false)
  const [alignRight, setAlignRight] = useState(false)
  const [today, setToday] = useState(localToday)
  // A value may carry a time suffix (withTime); the calendar only ever reasons
  // about the date part, so split once up front.
  const datePart = value ? value.slice(0, 10) : ''
  const timePart = value && value.length >= 16 ? value.slice(11, 16) : ''
  const [view, setView] = useState(() => monthOf(datePart || localToday()))
  // The hour staged in the picker. Seeds from the value's time; a fresh time
  // typed before a day is chosen rides along when that day commits.
  const [pendingTime, setPendingTime] = useState(timePart)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Fixed-position anchor for portal mode, captured from the trigger rect at
  // open time. Null while closed (and always in non-portal mode).
  const [fixedPos, setFixedPos] = useState<{
    top?: number
    bottom?: number
    left?: number
    right?: number
  } | null>(null)

  // Commit a chosen date, carrying the staged hour when withTime + one is set.
  const commitDate = (d: string) => {
    close()
    onChange(withTime && pendingTime ? `${d}T${pendingTime}` : d)
  }

  const openCal = () => {
    const t = localToday()
    setToday(t)
    setPendingTime(timePart)
    setView(monthOf(datePart || t))
    const rect = rootRef.current?.getBoundingClientRect()
    // Flip ABOVE only when below can't fit the ~380px panel AND there's more
    // room up — never blindly, so it doesn't clip the top instead.
    const spaceBelow = rect ? window.innerHeight - rect.bottom : 0
    const up = !!rect && spaceBelow < 380 && rect.top > spaceBelow
    setOpenUp(up)
    // Anchor the panel's RIGHT edge to the trigger when it sits near the right
    // edge, so the 264px panel never spills off-screen (e.g. the rightmost
    // 工段 in the 排产 band).
    const right = !!rect && window.innerWidth - rect.left < 280
    setAlignRight(right)
    if (portal && rect) {
      setFixedPos({
        ...(up
          ? { bottom: window.innerHeight - rect.top + 6 }
          : { top: rect.bottom + 6 }),
        ...(right
          ? { right: window.innerWidth - rect.right }
          : { left: rect.left }),
      })
    }
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    setFixedPos(null)
  }

  // Dismiss on outside click / Escape. In portal mode the panel is NOT a DOM
  // descendant of the trigger, so "outside" must check both refs; and because
  // the panel is fixed to viewport coords, scrolling would detach it from its
  // trigger — so it FOLLOWS the trigger instead of closing (closing on scroll
  // eats the popover on trackpad-inertia scrolls right after opening). Capture
  // phase catches inner scroll containers like the 零件进度 table wrapper.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (rootRef.current?.contains(t)) return
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
        const rect = rootRef.current?.getBoundingClientRect()
        if (!rect) return
        const spaceBelow = window.innerHeight - rect.bottom
        const up = spaceBelow < 380 && rect.top > spaceBelow
        const right = window.innerWidth - rect.left < 280
        setFixedPos({
          ...(up
            ? { bottom: window.innerHeight - rect.top + 6 }
            : { top: rect.bottom + 6 }),
          ...(right
            ? { right: window.innerWidth - rect.right }
            : { left: rect.left }),
        })
      })
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    if (portal) {
      window.addEventListener('scroll', onMove, true)
      window.addEventListener('resize', onMove)
    }
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      if (portal) {
        window.removeEventListener('scroll', onMove, true)
        window.removeEventListener('resize', onMove)
        if (raf) cancelAnimationFrame(raf)
      }
    }
  }, [open, portal])

  const grid = monthGrid(view.y, view.m)

  const panel = open ? (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="选择日期"
      style={portal && fixedPos ? fixedPos : undefined}
      className={`${
        portal
          ? 'fixed z-50'
          : `absolute z-40 ${openUp ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]'} ${alignRight ? 'right-0' : 'left-0'}`
      } w-[264px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[0_8px_28px_rgba(0,0,0,0.12),0_0_0_0.5px_rgba(0,0,0,0.04)]`}
    >
      {/* Presets */}
      <div className="mb-3 flex items-center gap-1">
        <Preset label="今天" onClick={() => commitDate(today)} />
        {allowFuture && (
          <>
            <Preset label="明天" onClick={() => commitDate(addDays(today, 1))} />
            <Preset label="+1周" onClick={() => commitDate(addDays(today, 7))} />
          </>
        )}
        {!allowFuture && (
          <Preset label="昨天" onClick={() => commitDate(addDays(today, -1))} />
        )}
        {clearable && datePart && (
          <Preset
            label="清除"
            onClick={() => {
              close()
              onChange('')
            }}
          />
        )}
      </div>

      {/* Optional hour — 全天 by default; pin a time to say "由此工段完成的
          具体时刻". Setting it while a date already exists commits at once;
          set before a day is chosen, it rides along with that click. */}
      {withTime && (
        <TimeRow
          time={pendingTime}
          onSet={(t) => {
            // Commit live but keep the popover open so hour + minute can be
            // dialed in freely; the user closes by picking a day or clicking
            // away. When no day is chosen yet, just stage it for that click.
            setPendingTime(t)
            if (datePart) onChange(t ? `${datePart}T${t}` : datePart)
          }}
        />
      )}

      {/* Month header — arrows ONLY change the view, never select. */}
      <div className="mb-2 flex items-center justify-between px-1">
        <MonthArrow dir="prev" onClick={() => setView(shiftMonth(view, -1))} />
        <span className="text-[13px] font-medium tabular-nums text-[var(--color-ink)]">
          {view.y}年{view.m + 1}月
        </span>
        <MonthArrow
          dir="next"
          onClick={() => setView(shiftMonth(view, 1))}
          disabled={!allowFuture && `${view.y}-${pad(view.m + 1)}` >= today.slice(0, 7)}
        />
      </div>

      <div className="grid grid-cols-7 mb-1">
        {WEEKDAYS.map((w) => (
          <span key={w} className="text-center text-[11px] text-[var(--color-ink-4)] py-1">
            {w}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-0.5">
        {grid.map((day) => {
          const inMonth = monthOf(day).m === view.m
          const blocked = !allowFuture && day > today
          const isToday = day === today
          const isSel = day === datePart
          return (
            <button
              key={day}
              type="button"
              disabled={blocked}
              onClick={() => commitDate(day)}
              className={[
                'relative h-8 text-[13px] tabular-nums transition-colors flex items-center justify-center',
                isSel
                  ? 'rounded-[2px] bg-[var(--color-ink)] text-[var(--color-bg)] font-medium'
                  : '',
                !isSel && !blocked
                  ? 'rounded-[2px] hover:bg-[var(--color-surface)] hover:shadow-[inset_0_0_0_1px_var(--color-border)]'
                  : '',
                blocked ? 'text-[var(--color-ink-4)] cursor-not-allowed' : '',
                !inMonth && !isSel && !blocked ? 'text-[var(--color-ink-4)]' : '',
                inMonth && !isSel && !blocked ? 'text-[var(--color-ink-2)]' : '',
              ].join(' ')}
            >
              {parseInt(day.slice(8), 10)}
              {isToday && !isSel && (
                <span className="absolute bottom-[3px] left-1/2 -translate-x-1/2 h-[3px] w-[3px] rounded-full bg-[var(--color-ink-3)]" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  ) : null

  return (
    <div ref={rootRef} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => (open ? close() : openCal())}
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 rounded-[2px] px-1.5 py-0.5 mono tabular-nums transition-colors ${triggerClass ?? 'text-[13px]'} ${
          disabled
            ? 'cursor-default'
            : 'hover:bg-[var(--color-active-bg)] hover:shadow-[inset_0_-1px_0_var(--color-border-strong)]'
        } ${
          disabled
            ? 'text-[var(--color-ink-4)]'
            : (tone ?? (value ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-4)]'))
        }`}
      >
        {hideIcon ? null : (
          <span className="text-[var(--color-ink-4)]">
            <CalendarIcon />
          </span>
        )}
        {value ? (formatLabel ? formatLabel(value) : value) : placeholder}
      </button>

      {portal ? panel && createPortal(panel, document.body) : panel}
    </div>
  )
}

function Preset({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 px-2 py-1 rounded-[2px] text-[12px] text-[var(--color-ink-2)] bg-[var(--color-bg)] hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink)] transition-colors"
    >
      {label}
    </button>
  )
}

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
const MINUTES = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55']

// Optional-hour row. 全天 (all-day) until the user pins a time; then two square
// selects (时 / 分) with a quiet 全天 toggle to drop back. Kept dead simple —
// this is a refinement of the date, never a second required field.
function TimeRow({ time, onSet }: { time: string; onSet: (t: string) => void }) {
  const hasTime = time.length >= 4
  const hh = hasTime ? time.slice(0, 2) : '09'
  const mm = hasTime ? time.slice(3, 5) : '00'
  return (
    <div className="mb-3 flex items-center gap-2 px-1">
      <span className="w-8 text-[12px] text-[var(--color-ink-3)]">时间</span>
      {hasTime ? (
        <div className="flex items-center gap-1">
          <TimeSelect
            value={hh}
            options={HOURS}
            onChange={(v) => onSet(`${v}:${mm}`)}
          />
          <span className="text-[var(--color-ink-3)]">:</span>
          <TimeSelect
            value={mm}
            options={MINUTES}
            onChange={(v) => onSet(`${hh}:${v}`)}
          />
          <button
            type="button"
            onClick={() => onSet('')}
            className="ml-1 inline-flex h-6 items-center rounded-[2px] px-1.5 text-[12px] text-[var(--color-ink-4)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-ink-2)]"
          >
            全天
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onSet('09:00')}
          className="inline-flex h-6 items-center rounded-[2px] bg-[var(--color-bg)] px-2 text-[12px] text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink)]"
        >
          全天 · 指定时间
        </button>
      )}
    </div>
  )
}

function TimeSelect({
  value,
  options,
  onChange,
}: {
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="cursor-pointer rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-1 mono text-[13px] tabular-nums text-[var(--color-ink)] focus:border-[var(--color-border-strong)] focus:outline-none"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}

function MonthArrow({
  dir,
  onClick,
  disabled,
}: {
  dir: 'prev' | 'next'
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === 'prev' ? '上个月' : '下个月'}
      className="inline-flex h-7 w-7 items-center justify-center rounded-[2px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:bg-[var(--color-bg)] disabled:text-[var(--color-ink-4)] disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors"
    >
      <Chevron dir={dir} />
    </button>
  )
}

function Chevron({ dir }: { dir: 'prev' | 'next' }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className={dir === 'next' ? 'rotate-180' : ''}
    >
      <path
        d="M8.5 3.5 L5 7 L8.5 10.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CalendarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="11" height="10" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <line x1="1.5" y1="5.5" x2="12.5" y2="5.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="4.5" y1="1" x2="4.5" y2="3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="9.5" y1="1" x2="9.5" y2="3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

// --- pure calendar math on 'YYYY-MM-DD' strings (UTC; no tz drift) ---

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function ymd(y: number, monthZeroBased: number, d: number): string {
  return new Date(Date.UTC(y, monthZeroBased, d)).toISOString().slice(0, 10)
}

function parseYMD(s: string): [number, number, number] {
  const [y, m, d] = s.split('-').map(Number)
  return [y, m, d]
}

function addDays(s: string, n: number): string {
  const [y, m, d] = parseYMD(s)
  return ymd(y, m - 1, d + n)
}

function monthOf(s: string): { y: number; m: number } {
  const [y, m] = parseYMD(s)
  return { y, m: m - 1 }
}

function shiftMonth(v: { y: number; m: number }, delta: number): { y: number; m: number } {
  return monthOf(ymd(v.y, v.m + delta, 1))
}

function monthGrid(y: number, monthZeroBased: number): string[] {
  const firstWd = new Date(Date.UTC(y, monthZeroBased, 1)).getUTCDay()
  const lead = (firstWd + 6) % 7
  const out: string[] = []
  for (let i = 0; i < 42; i++) {
    out.push(ymd(y, monthZeroBased, 1 - lead + i))
  }
  return out
}

// Factory-local today — Asia/Shanghai regardless of the client's tz.
function localToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
}
