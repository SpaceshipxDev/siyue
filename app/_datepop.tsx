'use client'

import { useEffect, useRef, useState } from 'react'

// Single-date popover picker — the project's replacement for native
// <input type=date>, which auto-commits while scrolling months (the exact
// failure the 报功 range calendar was built to fix; this is its single-date
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
}: {
  /** Current value (YYYY-MM-DD) or '' / undefined for unset. */
  value?: string
  onChange: (next: string) => void
  /** false → days after today are unpickable (e.g. 收件日期). */
  allowFuture?: boolean
  disabled?: boolean
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [today, setToday] = useState(localToday)
  const [view, setView] = useState(() => monthOf(value || localToday()))
  const rootRef = useRef<HTMLDivElement>(null)

  const openCal = () => {
    const t = localToday()
    setToday(t)
    setView(monthOf(value || t))
    setOpen(true)
  }
  const close = () => setOpen(false)

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

  const grid = monthGrid(view.y, view.m)

  return (
    <div ref={rootRef} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => (open ? close() : openCal())}
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 rounded-[2px] px-1.5 py-0.5 mono text-[13px] tabular-nums transition-colors ${
          disabled
            ? 'text-[var(--color-ink-4)] cursor-default'
            : 'text-[var(--color-ink)] hover:bg-[var(--color-active-bg)] hover:shadow-[inset_0_-1px_0_var(--color-border-strong)]'
        } ${value ? '' : 'text-[var(--color-ink-4)]'}`}
      >
        <span className="text-[var(--color-ink-4)]">
          <CalendarIcon />
        </span>
        {value || placeholder}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="选择日期"
          className="absolute left-0 top-[calc(100%+6px)] z-30 w-[264px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[0_8px_28px_rgba(0,0,0,0.12),0_0_0_0.5px_rgba(0,0,0,0.04)]"
        >
          {/* Presets */}
          <div className="mb-3 flex items-center gap-1">
            <Preset
              label="今天"
              onClick={() => {
                close()
                onChange(today)
              }}
            />
            {allowFuture && (
              <>
                <Preset
                  label="明天"
                  onClick={() => {
                    close()
                    onChange(addDays(today, 1))
                  }}
                />
                <Preset
                  label="+1周"
                  onClick={() => {
                    close()
                    onChange(addDays(today, 7))
                  }}
                />
              </>
            )}
            {!allowFuture && (
              <Preset
                label="昨天"
                onClick={() => {
                  close()
                  onChange(addDays(today, -1))
                }}
              />
            )}
          </div>

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
              const isSel = day === value
              return (
                <button
                  key={day}
                  type="button"
                  disabled={blocked}
                  onClick={() => {
                    close()
                    onChange(day)
                  }}
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
