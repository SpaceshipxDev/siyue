'use client'

import { useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { shiftDate, windowDateBounds, type Granularity } from '@/lib/today'

// 报功 period control — one integrated bar, Apple-Calendar in spirit:
//
//   ┌ 日 周 月 ┐        ‹   5月26日 – 6月1日   ›        今天
//
//   • Left  — an iOS-style segmented control picking the granularity.
//   • Right — a period stepper. Its readout always spells out the exact span
//     the granularity selects (day → "5月31日 周五", week → "5月26日 – 6月1日",
//     month → "2026年5月"), so the two halves are visibly in sync. Tapping the
//     readout opens the calendar to pick any single day, which drops into…
//   • Range mode — "从 [date] → 到 [date] ✕", two freely-editable ends. Picking
//     a granularity (or ✕) returns to a preset window.
//
// All state lives in the URL (?g / ?d / ?from / ?to / ?w) so it stays
// refresh-stable and shareable, matching the rest of the page.

const GRANS: { key: Granularity; label: string }[] = [
  { key: 'day', label: '日' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
]

export function PeriodNav({
  gran,
  date,
  rangeMode,
  from,
  to,
  worker,
  stage,
  todayStr,
}: {
  gran: Granularity
  /** Anchor date for preset mode. */
  date: string
  /** Custom range active — segmented control is then unselected. */
  rangeMode: boolean
  /** Inclusive bounds of the active window (preset span or custom range). */
  from: string
  to: string
  worker?: string
  /** Active station filter (?stage=), preserved across date changes. */
  stage?: string
  /** Factory-local today, computed server-side to avoid client tz drift. */
  todayStr: string
}) {
  const router = useRouter()
  const startRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLInputElement>(null)

  // Build a /report href. Presence of from+to selects custom-range mode;
  // otherwise it's a granularity/anchor URL. `w` rides along so the worker
  // drill-down survives navigation.
  const buildHref = (next: {
    g?: Granularity
    d?: string
    from?: string
    to?: string
  }): string => {
    const q = new URLSearchParams()
    if (next.from && next.to) {
      q.set('from', next.from)
      q.set('to', next.to)
    } else {
      const g = next.g ?? 'day'
      const d = next.d ?? todayStr
      if (g !== 'day') q.set('g', g)
      if (d !== todayStr) q.set('d', d)
    }
    if (stage) q.set('stage', stage)
    if (worker) q.set('w', worker)
    const s = q.toString()
    return s ? `/report?${s}` : '/report'
  }

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

  // Preset stepping. Disable ▸ once the next window starts after today —
  // there's no output to report from a period that hasn't begun.
  const prevDate = shiftDate(date, gran, -1)
  const nextDate = shiftDate(date, gran, 1)
  const nextDisabled = windowDateBounds(nextDate, gran).from > todayStr
  const containsToday = from <= todayStr && todayStr <= to

  // Tapping the preset readout picks a single day → enters range mode (from===to).
  const onPresetPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    if (v) router.push(buildHref({ from: v, to: v }))
  }

  // Editing either end of an active range, with Apple-style forgiveness:
  // a start past the end collapses to that day; an end before the start swaps.
  const onStartChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    if (!v) return
    if (v > to) router.push(buildHref({ from: v, to: v }))
    else router.push(buildHref({ from: v, to }))
  }
  const onEndChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    if (!v) return
    if (v < from) router.push(buildHref({ from: v, to: from }))
    else router.push(buildHref({ from, to: v }))
  }

  const onClear = () => router.push(buildHref({ g: 'day', d: todayStr }))

  const readout = formatReadout(rangeMode ? 'range' : gran, from, to)

  return (
    <div className="mb-8 flex items-center justify-between gap-4 flex-wrap">
      {/* Granularity — iOS segmented control: a soft track with a raised
          selected thumb. Unselected entirely while a custom range is active. */}
      <nav
        aria-label="周期"
        className="inline-flex items-center rounded-[2px] bg-[var(--color-surface)] p-[3px]"
      >
        {GRANS.map((g) => {
          const active = !rangeMode && g.key === gran
          return (
            <Link
              key={g.key}
              // Leaving a range anchors on its start, so 日/周/月 reframes the
              // span you were looking at rather than jumping home.
              href={buildHref({ g: g.key, d: rangeMode ? from : date })}
              aria-current={active ? 'page' : undefined}
              className={`px-4 py-1 text-[13px] rounded-[2px] transition-all duration-150 ${
                active
                  ? 'bg-[var(--color-bg)] text-[var(--color-ink)] font-medium shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_0.5px_rgba(0,0,0,0.05)]'
                  : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
              }`}
            >
              {g.label}
            </Link>
          )
        })}
      </nav>

      {!rangeMode ? (
        <div className="flex items-center gap-1">
          <Stepper href={buildHref({ g: gran, d: prevDate })} dir="prev" />

          {/* Readout doubles as the calendar trigger; the native picker is an
              invisible overlay so it pops up right at the date text. */}
          <span className="relative inline-flex">
            <button
              type="button"
              onClick={() => openPicker(startRef)}
              aria-label="选择日期"
              className="group inline-flex items-center justify-center gap-1.5 min-w-[136px] px-2.5 py-1 rounded-[2px] text-[14px] font-medium tabular-nums text-[var(--color-ink)] transition-colors hover:bg-[var(--color-surface)]"
            >
              <span className="text-[var(--color-ink-4)] transition-colors group-hover:text-[var(--color-ink-2)]">
                <CalendarIcon />
              </span>
              {readout}
            </button>
            <input
              ref={startRef}
              type="date"
              value={from}
              onChange={onPresetPick}
              className="absolute inset-0 opacity-0 pointer-events-none"
              tabIndex={-1}
              aria-hidden="true"
            />
          </span>

          <Stepper href={buildHref({ g: gran, d: nextDate })} dir="next" disabled={nextDisabled} />

          {!containsToday && (
            <Link
              href={buildHref({ g: gran, d: todayStr })}
              className="ml-1.5 px-2.5 py-1 rounded-[2px] text-[12px] tracking-wide text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface)] transition-colors"
            >
              今天
            </Link>
          )}
        </div>
      ) : (
        <span className="inline-flex items-baseline gap-x-2.5 gap-y-1 flex-wrap text-[13px]">
          <span className="translate-y-[1px] text-[var(--color-ink-4)]" aria-hidden="true">
            <CalendarIcon />
          </span>
          <span className="text-[var(--color-ink-3)]">从</span>
          <DateLabel
            value={from}
            inputRef={startRef}
            max={to}
            onClick={() => openPicker(startRef)}
            onChange={onStartChange}
          />
          <span className="text-[var(--color-ink-3)]" aria-hidden="true">
            →
          </span>
          <span className="text-[var(--color-ink-3)]">到</span>
          <DateLabel
            value={to}
            inputRef={endRef}
            min={from}
            onClick={() => openPicker(endRef)}
            onChange={onEndChange}
          />
          <button
            type="button"
            onClick={onClear}
            aria-label="清除日期范围，回到今天"
            className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-[2px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
          >
            <ClearIcon />
          </button>
        </span>
      )}
    </div>
  )
}

// Adaptive period readout. day → "5月31日 周五", week/range-span → "M月D日 –
// M月D日", month → "Y年M月", single-day range → the day form.
function formatReadout(mode: Granularity | 'range', from: string, to: string): string {
  if (mode === 'month') {
    const [y, m] = from.split('-')
    return `${parseInt(y, 10)}年${parseInt(m, 10)}月`
  }
  if (mode === 'day') return dayLabel(from)
  if (mode === 'week') return `${monthDay(from)} – ${monthDay(to)}`
  // custom range
  return from === to ? dayLabel(from) : `${monthDay(from)} – ${monthDay(to)}`
}

function monthDay(ymd: string): string {
  const [, m, d] = ymd.split('-')
  return `${parseInt(m, 10)}月${parseInt(d, 10)}日`
}

function dayLabel(ymd: string): string {
  const [, m, d] = ymd.split('-')
  const wd = new Date(`${ymd}T12:00:00+08:00`).toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
  })
  return `${parseInt(m, 10)}月${parseInt(d, 10)}日 ${wd}`
}

// A clickable date label hiding a native <input type="date"> behind it, so the
// native picker pops up at the label's location. Same pattern as the jobs
// master filter — the visible text is the formatted M月D日.
function DateLabel({
  value,
  inputRef,
  min,
  max,
  onClick,
  onChange,
}: {
  value: string
  inputRef: React.RefObject<HTMLInputElement | null>
  min?: string
  max?: string
  onClick: () => void
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <span className="relative inline-flex items-baseline">
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-baseline gap-0.5 mono font-medium text-[var(--color-ink)] transition-colors hover:opacity-70"
      >
        <span>{monthDay(value)}</span>
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
        value={value}
        min={min}
        max={max}
        onChange={onChange}
        className="absolute inset-0 opacity-0 pointer-events-none"
        tabIndex={-1}
        aria-hidden="true"
      />
    </span>
  )
}

// Chevron stepper for prev/next period — a quiet, tappable icon button.
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

function ClearIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
