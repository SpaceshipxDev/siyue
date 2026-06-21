'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

// 报工 period control — one unified date-range picker, Apple-Calendar in spirit:
//
//   ‹   5月26日 – 6月1日   ›        今天        [📅 opens range calendar]
//
// Everything is a range. A single day is just from===to. "Week" / "month" are
// not special modes with their own UI — they're presets that fill in a from→to
// span, shown in the exact same readout as a hand-picked custom range.
//
//   • Readout button — opens a custom calendar popover. Navigating months there
//     NEVER selects a date (the old native <input type=date> overlay used to
//     auto-commit on month scroll — this fixes that). You pick a start day, then
//     an end day; only the second click commits.
//   • Presets (今天 / 本周 / 本月) inside the popover fill the range in one tap.
//   • ‹ › steppers shift the whole range by its own length (a week range steps
//     by a week, a day by a day).
//
// All state lives in the URL (?from / ?to / ?w / ?stage). A bare /report (or
// from===to===today) is the clean default-to-today view.

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] // Mon-first

export function PeriodNav({
  from,
  to,
  worker,
  stage,
  todayStr,
}: {
  /** Inclusive start of the active window (YYYY-MM-DD, Shanghai local). */
  from: string
  /** Inclusive end of the active window (YYYY-MM-DD, Shanghai local). */
  to: string
  worker?: string
  /** Active station filter (?stage=), preserved across date changes. */
  stage?: string
  /** Factory-local today, computed server-side to avoid client tz drift. */
  todayStr: string
}) {
  const router = useRouter()

  // Build a /report href for a from→to range. from===to===today collapses to
  // the bare /report default so the home view stays clean and shareable.
  const buildHref = (f: string, t: string): string => {
    const lo = f <= t ? f : t
    const hi = f <= t ? t : f
    const q = new URLSearchParams()
    if (!(lo === todayStr && hi === todayStr)) {
      q.set('from', lo)
      q.set('to', hi)
    }
    if (stage) q.set('stage', stage)
    if (worker) q.set('w', worker)
    const s = q.toString()
    return s ? `/report?${s}` : '/report'
  }

  const go = (f: string, t: string) => router.push(buildHref(f, t))

  // Range stepping — shift both ends by the range's own length. Disable ▸ once
  // the next window would start after today (no output from a period that
  // hasn't begun).
  const len = daysBetween(from, to) + 1
  const prevFrom = addDays(from, -len)
  const prevTo = addDays(to, -len)
  const nextFrom = addDays(from, len)
  const nextTo = addDays(to, len)
  const nextDisabled = nextFrom > todayStr
  const containsToday = from <= todayStr && todayStr <= to

  const readout = from === to ? dayLabel(from) : `${monthDay(from)} – ${monthDay(to)}`

  return (
    <div className="mb-8 flex items-center justify-start gap-1 flex-wrap">
      <Stepper href={buildHref(prevFrom, prevTo)} dir="prev" />

      <Calendar
        from={from}
        to={to}
        todayStr={todayStr}
        readout={readout}
        onPick={go}
      />

      <Stepper
        href={buildHref(nextFrom, nextTo)}
        dir="next"
        disabled={nextDisabled}
      />

      {!containsToday && (
        <Link
          href={buildHref(todayStr, todayStr)}
          className="ml-1.5 px-2.5 py-1 rounded-[2px] text-[12px] tracking-wide text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface)] transition-colors"
        >
          今天
        </Link>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Calendar — a readout button that opens a custom range-picker popover. The
// whole point of rolling our own (vs <input type=date>): navigating months
// must NOT commit a selection. Only clicking days does.
// ---------------------------------------------------------------------------
function Calendar({
  from,
  to,
  todayStr,
  readout,
  onPick,
}: {
  from: string
  to: string
  todayStr: string
  readout: string
  onPick: (from: string, to: string) => void
}) {
  const [open, setOpen] = useState(false)
  // View month (year + 0-based month) the grid is showing.
  const [view, setView] = useState(() => monthOf(to))
  // First click of a range lands here; the second click commits. null = idle.
  const [anchor, setAnchor] = useState<string | null>(null)
  // Hovered day, for live range preview while picking the second end.
  const [hover, setHover] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Open fresh: show the month of the current range end, clear any half-pick.
  const openCal = () => {
    setView(monthOf(to))
    setAnchor(null)
    setHover(null)
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    setAnchor(null)
    setHover(null)
  }

  // Dismiss on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const commit = (f: string, t: string) => {
    close()
    onPick(f, t)
  }

  const onDayClick = (day: string) => {
    if (day > todayStr) return // future — no output to report
    if (anchor === null) {
      setAnchor(day) // first end; wait for the second
    } else {
      commit(anchor, day) // second end → commit (buildHref orders them)
    }
  }

  // The span to highlight: mid-pick it's anchor↔hover (live preview); otherwise
  // the committed from→to range.
  const [selLo, selHi] =
    anchor !== null
      ? order(anchor, hover ?? anchor)
      : [from, to]

  const grid = monthGrid(view.y, view.m)
  // Don't let the view wander past the current month — there's no future
  // output, so the next-month arrow is dead once you're on today's month.
  const viewYM = `${view.y}-${pad(view.m + 1)}`
  const canNextMonth = viewYM < todayStr.slice(0, 7)

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => (open ? close() : openCal())}
        aria-label="选择日期范围"
        aria-expanded={open}
        className="group inline-flex items-center justify-center gap-1.5 min-w-[136px] px-2.5 py-1 rounded-[2px] text-[14px] font-medium tabular-nums text-[var(--color-ink)] transition-colors hover:bg-[var(--color-surface)]"
      >
        <span className="text-[var(--color-ink-4)] transition-colors group-hover:text-[var(--color-ink-2)]">
          <CalendarIcon />
        </span>
        {readout}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="日期范围选择"
          className="absolute left-0 top-[calc(100%+6px)] z-30 w-[280px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[0_8px_28px_rgba(0,0,0,0.12),0_0_0_0.5px_rgba(0,0,0,0.04)]"
        >
          {/* Presets — fill the range in one tap. */}
          <div className="mb-3 flex items-center gap-1">
            <Preset label="今天" onClick={() => commit(todayStr, todayStr)} />
            <Preset
              label="本周"
              onClick={() => {
                const [a, b] = weekOf(todayStr)
                commit(a, b)
              }}
            />
            <Preset
              label="本月"
              onClick={() => {
                const [a, b] = monthBounds(todayStr)
                commit(a, b)
              }}
            />
          </div>

          {/* Month header — these arrows ONLY change the view, never select. */}
          <div className="mb-2 flex items-center justify-between px-1">
            <MonthArrow
              dir="prev"
              onClick={() => setView(shiftMonth(view, -1))}
            />
            <span className="text-[13px] font-medium tabular-nums text-[var(--color-ink)]">
              {view.y}年{view.m + 1}月
            </span>
            <MonthArrow
              dir="next"
              onClick={() => setView(shiftMonth(view, 1))}
              disabled={!canNextMonth}
            />
          </div>

          {/* Weekday header */}
          <div className="grid grid-cols-7 mb-1">
            {WEEKDAYS.map((w) => (
              <span
                key={w}
                className="text-center text-[11px] text-[var(--color-ink-4)] py-1"
              >
                {w}
              </span>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-y-0.5" onMouseLeave={() => setHover(null)}>
            {grid.map((day) => {
              const inMonth = monthOf(day).m === view.m
              const isFuture = day > todayStr
              const isToday = day === todayStr
              const inSel = day >= selLo && day <= selHi
              const isLo = day === selLo
              const isHi = day === selHi
              const isEnd = isLo || isHi

              return (
                <button
                  key={day}
                  type="button"
                  disabled={isFuture}
                  onClick={() => onDayClick(day)}
                  onMouseEnter={() => anchor !== null && setHover(day)}
                  className={[
                    'relative h-8 text-[13px] tabular-nums transition-colors',
                    'flex items-center justify-center',
                    // range middle wash (square, edge-to-edge feel)
                    inSel && !isEnd ? 'bg-[var(--color-active-bg)]' : '',
                    inSel && isLo ? 'rounded-l-[2px]' : '',
                    inSel && isHi ? 'rounded-r-[2px]' : '',
                    isEnd ? 'rounded-[2px] bg-[var(--color-ink)] text-[var(--color-bg)] font-medium' : '',
                    !inSel && !isFuture ? 'rounded-[2px] hover:bg-[var(--color-surface)] hover:shadow-[inset_0_0_0_1px_var(--color-border)]' : '',
                    isFuture ? 'text-[var(--color-ink-4)] cursor-not-allowed' : '',
                    !inMonth && !inSel && !isFuture ? 'text-[var(--color-ink-4)]' : '',
                    inMonth && !inSel && !isFuture ? 'text-[var(--color-ink-2)]' : '',
                  ].join(' ')}
                >
                  {parseInt(day.slice(8), 10)}
                  {isToday && !isEnd && (
                    <span className="absolute bottom-[3px] left-1/2 -translate-x-1/2 h-[3px] w-[3px] rounded-full bg-[var(--color-ink-3)]" />
                  )}
                </button>
              )
            })}
          </div>

          {/* Hint line — tells the user where they are in the two-click pick. */}
          <p className="mt-2.5 px-1 text-[11px] text-[var(--color-ink-3)]">
            {anchor === null
              ? '选择开始日期'
              : `从 ${monthDay(selLo)} 起，选择结束日期`}
          </p>
        </div>
      )}
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

// ---------------------------------------------------------------------------
// Date helpers — all pure calendar math on 'YYYY-MM-DD' strings via Date.UTC,
// so there's no timezone drift (we never convert to/from local instants here).
// ---------------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function ymd(y: number, monthZeroBased: number, d: number): string {
  // Date.UTC normalizes over/underflow (d=0 → last day of prev month, etc.).
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

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = parseYMD(a)
  const [by, bm, bd] = parseYMD(b)
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000,
  )
}

function order(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a]
}

function monthOf(s: string): { y: number; m: number } {
  const [y, m] = parseYMD(s)
  return { y, m: m - 1 }
}

function shiftMonth(v: { y: number; m: number }, delta: number): { y: number; m: number } {
  const t = ymd(v.y, v.m + delta, 1)
  return monthOf(t)
}

// Mon..Sun ISO week containing `date`.
function weekOf(date: string): [string, string] {
  const [y, m, d] = parseYMD(date)
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=Sun..6=Sat
  const mondayOffset = (wd + 6) % 7
  return [addDays(date, -mondayOffset), addDays(date, 6 - mondayOffset)]
}

// 1st..last day of the calendar month containing `date`.
function monthBounds(date: string): [string, string] {
  const [y, m] = parseYMD(date)
  return [ymd(y, m - 1, 1), ymd(y, m, 0)]
}

// 42 day-cells (6 weeks, Mon-first) spanning the given month — the standard
// calendar grid with leading/trailing days from neighbouring months.
function monthGrid(y: number, monthZeroBased: number): string[] {
  const firstWd = new Date(Date.UTC(y, monthZeroBased, 1)).getUTCDay()
  const lead = (firstWd + 6) % 7 // days before the 1st to reach Monday
  const out: string[] = []
  for (let i = 0; i < 42; i++) {
    out.push(ymd(y, monthZeroBased, 1 - lead + i))
  }
  return out
}

function monthDay(ymdStr: string): string {
  const [, m, d] = ymdStr.split('-')
  return `${parseInt(m, 10)}月${parseInt(d, 10)}日`
}

function dayLabel(ymdStr: string): string {
  const [, m, d] = ymdStr.split('-')
  const wd = new Date(`${ymdStr}T12:00:00+08:00`).toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
  })
  return `${parseInt(m, 10)}月${parseInt(d, 10)}日 ${wd}`
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function Stepper({
  href,
  dir,
  disabled = false,
}: {
  href: string
  dir: 'prev' | 'next'
  disabled?: boolean
}) {
  const label = dir === 'prev' ? '上一周期' : '下一周期'
  if (disabled) {
    return (
      <span
        aria-disabled="true"
        className="inline-flex h-7 w-7 items-center justify-center rounded-[2px] text-[var(--color-ink-4)] cursor-not-allowed select-none"
      >
        <Chevron dir={dir} />
      </span>
    )
  }
  return (
    <Link
      href={href}
      aria-label={label}
      className="inline-flex h-7 w-7 items-center justify-center rounded-[2px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface)] transition-colors"
    >
      <Chevron dir={dir} />
    </Link>
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
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="11" height="10" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <line x1="1.5" y1="5.5" x2="12.5" y2="5.5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="4.5" y1="1" x2="4.5" y2="3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="9.5" y1="1" x2="9.5" y2="3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}
