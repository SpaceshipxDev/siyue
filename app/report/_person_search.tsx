'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

// 找人 — the 报工 person filter. A plain search field: clicking it drops the
// whole roster open (no typing required), typing narrows it, picking a name
// scopes the entire page — totals, the list, the drill and 导出 — to that one
// person. ✕ clears back to everybody.
//
// The roster is range-independent (accounts ∪ anyone who reported in the last
// year), so you can pick someone with no output today and then step the period
// back to find their work. Rows carry this window's 完成 count when there is
// one, so the dropdown itself already answers "did 张三 do anything today".

export type RosterPerson = {
  name: string
  subtitle: string
  active: boolean
  lastActiveTs?: string
}

export function PersonSearch({
  roster,
  loading,
  value,
  counts,
  onChange,
}: {
  roster: RosterPerson[]
  loading: boolean
  /** Selected 经手人, or null for everybody. */
  value: string | null
  /** name → 完成零件 in the current window (drives the trailing count). */
  counts: Map<string, number>
  onChange: (name: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const q = query.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      q
        ? roster.filter(
            (p) => p.name.toLowerCase().includes(q) || p.subtitle.toLowerCase().includes(q),
          )
        : roster,
    [roster, q],
  )

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const choose = (name: string | null) => {
    onChange(name)
    setQuery('')
    setOpen(false)
    inputRef.current?.blur()
  }

  return (
    <div ref={wrapRef} className="relative w-[220px]">
      <div
        className={`flex items-center gap-1.5 rounded-[2px] border bg-[var(--color-surface)] px-2 h-[30px] transition-colors ${
          open || value ? 'border-[var(--color-ink)]' : 'border-[var(--color-border-strong)]'
        }`}
      >
        <span className="shrink-0 text-[var(--color-ink-3)]">
          <SearchIcon />
        </span>
        <input
          ref={inputRef}
          type="text"
          value={open ? query : value ?? ''}
          onFocus={() => {
            setQuery('')
            setActive(0)
            setOpen(true)
          }}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
            if (!open) setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setOpen(true)
              setActive((i) => Math.min(i + 1, filtered.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const p = filtered[active]
              if (p) choose(p.name)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setOpen(false)
              inputRef.current?.blur()
            }
          }}
          placeholder={loading ? '载入人员…' : '找人'}
          autoComplete="off"
          spellCheck={false}
          aria-label="搜索人员"
          aria-expanded={open}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-3)] focus:outline-none"
        />
        {value && (
          <button
            type="button"
            onClick={() => choose(null)}
            aria-label="清除人员筛选"
            className="shrink-0 text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
          >
            <ClearIcon />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute left-0 z-40 mt-1 w-[268px] overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg">
          <div ref={listRef} role="listbox" className="max-h-[300px] overflow-auto py-1">
            {value && (
              <button
                type="button"
                onClick={() => choose(null)}
                className="w-full px-2.5 py-1.5 text-left text-[13px] text-[var(--color-ink-2)] hover:bg-black/5"
              >
                全部人员
              </button>
            )}
            {filtered.map((p, i) => {
              const n = counts.get(p.name) ?? 0
              return (
                <button
                  key={p.name}
                  type="button"
                  role="option"
                  aria-selected={p.name === value}
                  data-idx={i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(p.name)}
                  className={`flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left ${
                    i === active ? 'bg-black/5' : ''
                  }`}
                >
                  <span
                    className={`min-w-0 flex-1 truncate text-[13px] ${
                      p.active ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-3)]'
                    }`}
                  >
                    {p.name}
                    {p.name === value && <span className="ml-1.5 text-[var(--color-ink-3)]">✓</span>}
                  </span>
                  {p.subtitle && <span className="shrink-0 label text-[var(--color-ink-3)]">{p.subtitle}</span>}
                  <span className="w-[38px] shrink-0 text-right text-[11px] tabular-nums text-[var(--color-ink-4)]">
                    {fmtDay(p.lastActiveTs)}
                  </span>
                  <span className="w-[34px] shrink-0 text-right text-[11px] tabular-nums text-[var(--color-ink-2)]">
                    {n > 0 ? n : ''}
                  </span>
                </button>
              )
            })}
            {filtered.length === 0 && (
              <p className="px-2.5 py-2 text-[12px] text-[var(--color-ink-3)]">
                {loading ? '载入中…' : '无匹配'}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// 最后活动 as M-D in factory time (+08:00, no DST) — the row's honest "is this
// person still around" signal, in place of the unreliable 工段 pin.
function fmtDay(ts?: string): string {
  if (!ts) return ''
  const t = new Date(ts).getTime()
  if (Number.isNaN(t)) return ''
  const d = new Date(t + 8 * 60 * 60 * 1000)
  return `${d.getUTCMonth() + 1}-${d.getUTCDate()}`
}

function SearchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="5" cy="5" r="3.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7.6 7.6 L10.5 10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function ClearIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
