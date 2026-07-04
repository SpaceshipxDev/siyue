'use client'

import { useEffect, useId, useRef, useState } from 'react'

// Searchable single-pick — the same square ledger field everywhere a list has
// outgrown a native <select> (外协厂商, 做什么). Button trigger → popover with
// a type-to-filter input, ↑/↓/↵/Esc keyboard nav, click-outside closes. With
// `onCreate` set, a query that matches nothing exactly grows a final
// "+ 新增…「query」" row so creating never needs a separate mode switch.

function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path
        d="M2 3.5 L5 6.5 L8 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function SearchSelect({
  options,
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  createLabel,
  onCreate,
  disabled,
  triggerClass = '',
  triggerLabel,
}: {
  options: { id: string; label: string }[]
  value: string
  onChange: (id: string) => void
  placeholder: string
  searchPlaceholder: string
  /** Label for the create row, e.g. '新增厂商'. Requires onCreate. */
  createLabel?: string
  onCreate?: (name: string) => void
  disabled?: boolean
  triggerClass?: string
  /** Overrides the trigger text (e.g. a just-typed new vendor name). */
  triggerLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const selected = options.find((o) => o.id === value)
  const q = query.trim().toLowerCase()
  const filtered = q
    ? options.filter((o) => o.label.toLowerCase().includes(q))
    : options
  // The create row exists only for a non-empty query with no exact match —
  // "喷砂" in a list that already has 喷砂 offers nothing.
  const canCreate =
    !!createLabel &&
    !!onCreate &&
    q.length > 0 &&
    !options.some((o) => o.label.toLowerCase() === q)
  const rowCount = filtered.length + (canCreate ? 1 : 0)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const openPicker = () => {
    setQuery('')
    const idx = options.findIndex((o) => o.id === value)
    setActiveIndex(idx < 0 ? 0 : idx)
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const t = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  const choose = (id: string) => {
    onChange(id)
    setOpen(false)
  }
  const create = () => {
    onCreate?.(query.trim())
    setOpen(false)
  }
  const pick = (idx: number) => {
    if (canCreate && idx === filtered.length) create()
    else if (filtered[idx]) choose(filtered[idx].id)
  }

  const shown = triggerLabel ?? selected?.label

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPicker())}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex min-h-[34px] items-center justify-between gap-2 rounded-[2px] border bg-[var(--color-surface)] px-2 text-left text-[13px] disabled:opacity-50 ${
          open
            ? 'border-[var(--color-ink)]'
            : 'border-[var(--color-border-strong)]'
        } ${triggerClass}`}
      >
        <span
          className={`min-w-0 flex-1 truncate ${shown ? '' : 'text-[var(--color-ink-3)]'}`}
        >
          {shown || placeholder}
        </span>
        <span
          className={`shrink-0 text-[var(--color-ink-3)] transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        >
          <Chevron />
        </span>
      </button>

      {open ? (
        <div className="absolute left-0 z-30 mt-1 w-[240px] overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActiveIndex((i) => Math.min(i + 1, rowCount - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActiveIndex((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                pick(activeIndex)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setOpen(false)
              }
            }}
            placeholder={searchPlaceholder}
            autoComplete="off"
            spellCheck={false}
            className="w-full border-b border-[var(--color-border)] bg-transparent px-2.5 py-2 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-3)] focus:outline-none"
          />
          <div
            ref={listRef}
            role="listbox"
            id={listId}
            className="max-h-[220px] overflow-auto py-1"
          >
            {filtered.map((o, i) => {
              const isActive = i === activeIndex
              const isSelected = o.id === value
              return (
                <button
                  key={o.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-idx={i}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => choose(o.id)}
                  className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[13px] text-[var(--color-ink)] ${
                    isActive ? 'bg-black/5' : ''
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {isSelected ? <span aria-hidden>✓</span> : null}
                </button>
              )
            })}
            {canCreate ? (
              <button
                type="button"
                role="option"
                aria-selected={false}
                data-idx={filtered.length}
                onMouseEnter={() => setActiveIndex(filtered.length)}
                onClick={create}
                className={`w-full px-2.5 py-1.5 text-left text-[13px] font-medium text-[var(--color-ink)] ${
                  activeIndex === filtered.length ? 'bg-black/5' : ''
                }`}
              >
                + {createLabel}「{query.trim()}」
              </button>
            ) : null}
            {filtered.length === 0 && !canCreate ? (
              <p className="px-2.5 py-2 text-[12px] text-[var(--color-ink-3)]">
                无匹配
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
