'use client'

import { useEffect, useRef, useState } from 'react'
import { colFilterParams, matchCols, type ColFilters, type ColSpec } from '@/lib/quality-filter'

// 质量模块表头筛选的那一格和它的状态 (于海伟 2026-11-02) —— 列名旁边一个小
// 箭头, 点开列出这一列这个月出现过的值 (后面带条数, 按别的列已经筛过的那一
// 批数, 跟 Excel 一样), 点一个筛, 点「全部」不筛。选了的列名变黑、箭头变蓝点、
// 下面一道蓝线。菜单用 fixed 摆, 不被表格裁掉。

export function ColHead({
  label,
  value,
  options,
  onPick,
  right,
}: {
  label: string
  value?: string
  options: [string, number][]
  onPick: (v: string) => void
  right?: boolean
}) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!at) return
    const close = (e: Event) => {
      if (e.type === 'mousedown' && box.current?.contains(e.target as Node)) return
      if (e.type === 'mousedown' && btn.current?.contains(e.target as Node)) return
      setAt(null)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setAt(null)
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [at])
  const active = !!value
  return (
    <span className={`relative flex items-center gap-1 ${right ? 'justify-end' : ''}`}>
      <span className={`label ${active ? 'text-[var(--color-ink)]' : ''}`}>{label}</span>
      <button
        ref={btn}
        type="button"
        onClick={() => {
          if (at) return setAt(null)
          const r = btn.current?.getBoundingClientRect()
          if (r) setAt({ left: Math.min(r.left, window.innerWidth - 240), top: r.bottom + 6 })
        }}
        aria-label={`按${label}筛选`}
        className={`inline-flex h-4 w-4 items-center justify-center rounded-[2px] text-[10px] ${
          active ? 'text-[var(--color-info)]' : 'text-[var(--color-ink-4)] hover:text-[var(--color-ink-2)]'
        }`}
      >
        {active ? '●' : '▾'}
      </button>
      {active && (
        <span className="pointer-events-none absolute -bottom-[7px] left-0 right-0 h-[2px] rounded-[2px] bg-[var(--color-info)]" />
      )}
      {at && (
        <div
          ref={box}
          style={{ left: at.left, top: at.top }}
          className="fixed z-50 max-h-[320px] w-[230px] overflow-y-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] py-1 text-left shadow-[0_10px_34px_-12px_rgba(20,19,15,0.28)]"
        >
          {[['', options.reduce((n, [, c]) => n + c, 0)] as [string, number], ...options].map(([v, n]) => (
            <button
              key={v || '__all'}
              type="button"
              onClick={() => {
                onPick(v)
                setAt(null)
              }}
              className={`flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left text-[12.5px] hover:bg-[#f5f3ed] ${
                (value ?? '') === v ? 'font-semibold text-[var(--color-ink)]' : 'text-[var(--color-ink-2)]'
              }`}
            >
              <span className="min-w-0 truncate">{v || '全部'}</span>
              <span className="mono shrink-0 text-[11.5px] text-[var(--color-ink-4)]">{n}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

/**
 * 一张表的表头筛选状态。rows = 这个月的 (还没按表头筛过的) 那一批。
 * head(key) 画那一格; match 用来筛行; params 拼到导出链接上。
 */
export function useColFilters<T>(rows: T[], specs: ColSpec<T>[]) {
  const [filters, setFilters] = useState<ColFilters>({})
  const optionsOf = (key: string): [string, number][] => {
    const spec = specs.find((s) => s.key === key)
    if (!spec) return []
    const m = new Map<string, number>()
    for (const r of rows) {
      if (!matchCols(r, specs, filters, key)) continue
      const v = spec.get(r)
      m.set(v, (m.get(v) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) =>
      key === 'date' ? b[0].localeCompare(a[0]) : b[1] - a[1] || a[0].localeCompare(b[0], 'zh'),
    )
  }
  const set = (key: string, v: string) =>
    setFilters((cur) => {
      const next = { ...cur }
      if (v) next[key] = v
      else delete next[key]
      return next
    })
  return {
    filters,
    active: Object.values(filters).some(Boolean),
    match: (r: T) => matchCols(r, specs, filters),
    clear: () => setFilters({}),
    params: colFilterParams(filters),
    head: (key: string, opts?: { right?: boolean }) => {
      const spec = specs.find((s) => s.key === key)!
      return (
        <ColHead
          label={spec.label}
          value={filters[key]}
          options={optionsOf(key)}
          onPick={(v) => set(key, v)}
          right={opts?.right}
        />
      )
    },
  }
}
