'use client'

import { useEffect, useRef, useState } from 'react'

// Shared status-filter primitives — the spreadsheet-style funnel the master
// board uses to slice jobs by per-工段 status, factored out so the in-job
// part filter (app/_part_filter.tsx) is the LITERAL same control one level
// down. "I see what you see": the boss filters whole jobs on the board and
// the parts of one job inside it with the same caret → menu → funnel gesture.

export type StatusTone = 'pending' | 'warning' | 'success' | 'overdue' | 'info'

export const STATUS_TONE_VAR: Record<StatusTone, string> = {
  pending: 'var(--color-ink-3)',
  warning: 'var(--color-warning)',
  success: 'var(--color-success)',
  overdue: 'var(--color-overdue)',
  info: 'var(--color-info)',
}

// One row in a funnel menu: a tone dot, the label, and the live count pinned
// right. Active row goes ink + semibold with a check.
export function FilterMenuRow({
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
export function CaretIcon() {
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
export function FunnelIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <path d="M1.5 2 H10.5 L7 6.2 V9.5 L5 10.5 V6.2 Z" />
    </svg>
  )
}

export type FunnelRow = {
  key: string
  label: string
  tone: StatusTone
  count: number
}

// Generic funnel: a caret/funnel trigger that drops a menu of 全部 + N status
// rows with live counts, AND closes on outside-click / Esc. The board's
// HeaderFilter and the in-job part filter both describe their buckets as
// `rows` and let this shell own the open/close + trigger styling, so the two
// surfaces are pixel-identical and can never drift.
export function FilterFunnel({
  value,
  allLabel,
  allCount,
  rows,
  onChange,
  align = 'left',
  ariaLabel,
  title,
}: {
  /** Selected key — 'all' or one of rows[].key. */
  value: string
  allLabel: string
  allCount: number
  rows: FunnelRow[]
  onChange: (next: string) => void
  align?: 'left' | 'right'
  ariaLabel: string
  title: string
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

  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
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
          aria-label={ariaLabel}
          className={`absolute top-[calc(100%+8px)] z-40 min-w-[148px] overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] py-1 text-left shadow-[0_10px_34px_-12px_rgba(20,19,15,0.28)] ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          <FilterMenuRow
            label={allLabel}
            count={allCount}
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
              label={r.label}
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
