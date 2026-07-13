'use client'

import { useEffect, useRef, useState } from 'react'
import type { Stage } from '@/lib/data'

// Quiet partial-completion editor. Centered modal (matches the route-conflict
// dialog in _stagechips.tsx) — one number, plus/minus, save. The default cell
// click already finishes the row in one shot; this is only for "I did 3 of 5."
// Saving qty === total flips the row through the same finish path as the
// pause-button click.
export function QtyEditor({
  stage,
  componentName,
  totalQty,
  currentDone,
  onCancel,
  onSubmit,
  pending = false,
}: {
  stage: Stage
  componentName: string
  totalQty: number
  currentDone: number
  onCancel: () => void
  onSubmit: (qty: number) => void
  pending?: boolean
}) {
  const initial = clamp(currentDone, 0, totalQty)
  const [value, setValue] = useState<number>(initial)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.select()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const dec = () => setValue((v) => clamp(v - 1, 0, totalQty))
  const inc = () => setValue((v) => clamp(v + 1, 0, totalQty))
  const save = () => {
    if (pending) return
    onSubmit(clamp(value, 0, totalQty))
  }

  const willFinish = value >= totalQty && totalQty > 0
  const unchanged = value === initial

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${stage} · 完成数量`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[320px] max-w-[92vw] bg-[var(--color-surface)] border border-[var(--color-ink)] rounded-[2px] p-6 shadow-xl"
      >
        <p className="label text-[var(--color-ink-3)] mb-1">{stage} · 完成数量</p>
        <h3 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)] mb-6 truncate">
          {componentName}
        </h3>

        <div className="flex items-center justify-center gap-4 mb-2">
          <button
            type="button"
            onClick={dec}
            disabled={pending || value <= 0}
            aria-label="减一"
            className="h-9 w-9 flex items-center justify-center rounded-[2px] border border-[var(--color-border-strong)] text-[18px] text-[var(--color-ink-2)] hover:bg-[#f1eee4] disabled:opacity-30 disabled:cursor-not-allowed"
          >
            −
          </button>
          <input
            ref={inputRef}
            type="number"
            inputMode="numeric"
            min={0}
            max={totalQty}
            step={1}
            value={value}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (!Number.isFinite(n)) return
              setValue(clamp(Math.floor(n), 0, totalQty))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
            disabled={pending}
            className="w-20 text-center mono text-[28px] font-medium tracking-tight text-[var(--color-ink)] bg-transparent border-b border-[var(--color-ink)] py-1 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <button
            type="button"
            onClick={inc}
            disabled={pending || value >= totalQty}
            aria-label="加一"
            className="h-9 w-9 flex items-center justify-center rounded-[2px] border border-[var(--color-border-strong)] text-[18px] text-[var(--color-ink-2)] hover:bg-[#f1eee4] disabled:opacity-30 disabled:cursor-not-allowed"
          >
            +
          </button>
        </div>
        <p className="text-center label text-[var(--color-ink-3)] mb-6">
          共 {totalQty} 件
        </p>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="px-3 py-1.5 text-[12px] tracking-wider border border-[var(--color-border)] text-[var(--color-ink-2)] hover:bg-[#f1eee4] rounded-[2px] disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            onClick={save}
            disabled={pending || unchanged}
            className={`px-3 py-1.5 text-[12px] tracking-wider rounded-[2px] disabled:opacity-40 disabled:cursor-not-allowed ${
              willFinish
                ? 'bg-[var(--color-ink)] text-[var(--color-surface)] hover:opacity-80'
                : 'bg-[var(--color-warning-soft)] text-[var(--color-warning)] hover:brightness-95'
            }`}
          >
            {willFinish ? '全部完成' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.round(n)))
}
