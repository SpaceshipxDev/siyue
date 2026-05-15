'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  componentShipmentEntries,
  componentShippedTotal,
  formatShipmentTimestamp,
  isStageInRoute,
  type Component,
  type Shipment,
} from '@/lib/data'
import { mutate } from '@/lib/mutate'

// 制作出货单 — pick how many of each part ship in this batch and emit one
// new 出货单. The dialog reads existing shipment history per part, locks
// fully-shipped rows, and defaults the qty input to whatever's still owed.

type Pick = { selected: boolean; qty: number }

export function ShippingComposerButton({
  jobId,
  components,
  shipments,
}: {
  jobId: string
  components: Component[]
  shipments: Shipment[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-[12px] tracking-wider bg-[var(--color-ink)] text-[var(--color-surface)] rounded-sm hover:opacity-80"
      >
        制作出货单
      </button>
      {open && (
        <ShippingComposer
          jobId={jobId}
          components={components}
          shipments={shipments}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function defaultPicks(
  components: Component[],
  shipments: Shipment[],
): Record<string, Pick> {
  // Sensible default: every part with remaining qty is checked at exactly the
  // remaining amount. Fully-shipped parts come in unchecked at 0 so the row
  // renders as "已完成" rather than "select me again".
  const picks: Record<string, Pick> = {}
  for (const c of components) {
    if (!isStageInRoute(c, '出货')) continue
    const shipped = componentShippedTotal(c.id, shipments)
    const remaining = Math.max(0, c.qty - shipped)
    picks[c.id] = {
      selected: remaining > 0,
      qty: remaining,
    }
  }
  return picks
}

export function ShippingComposer({
  jobId,
  components,
  shipments,
  onClose,
}: {
  jobId: string
  components: Component[]
  shipments: Shipment[]
  onClose: () => void
}) {
  const inRoute = useMemo(
    () => components.filter((c) => isStageInRoute(c, '出货')),
    [components],
  )
  // Per-part shipped-so-far + remaining headroom. Frozen on dialog open — the
  // picker is the only path that can change these, and it closes after one
  // submit, so we don't need to recompute on every render.
  const baseline = useMemo(() => {
    const m = new Map<string, { shipped: number; remaining: number }>()
    for (const c of inRoute) {
      const shipped = componentShippedTotal(c.id, shipments)
      m.set(c.id, {
        shipped,
        remaining: Math.max(0, c.qty - shipped),
      })
    }
    return m
  }, [inRoute, shipments])

  const [picks, setPicks] = useState<Record<string, Pick>>(() =>
    defaultPicks(components, shipments),
  )
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const router = useRouter()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, pending])

  const shippableRows = inRoute.filter(
    (c) => (baseline.get(c.id)?.remaining ?? 0) > 0,
  )
  const allShippableSelected =
    shippableRows.length > 0 &&
    shippableRows.every((c) => picks[c.id]?.selected && (picks[c.id]?.qty ?? 0) > 0)
  const selectedCount = shippableRows.filter(
    (c) => picks[c.id]?.selected && (picks[c.id]?.qty ?? 0) > 0,
  ).length
  const batchQty = shippableRows.reduce((sum, c) => {
    const p = picks[c.id]
    return sum + (p?.selected ? p.qty : 0)
  }, 0)

  const toggle = (c: Component) => {
    const remaining = baseline.get(c.id)?.remaining ?? 0
    if (remaining === 0) return
    setPicks((prev) => {
      const cur = prev[c.id]
      return {
        ...prev,
        [c.id]: {
          selected: !cur?.selected,
          qty: cur?.qty && cur.qty > 0 ? Math.min(cur.qty, remaining) : remaining,
        },
      }
    })
  }

  const setQty = (c: Component, raw: number) => {
    const remaining = baseline.get(c.id)?.remaining ?? 0
    if (remaining === 0) return
    setPicks((prev) => {
      const clamped = Math.max(0, Math.min(remaining, Math.floor(raw || 0)))
      return {
        ...prev,
        [c.id]: {
          selected: clamped > 0,
          qty: clamped,
        },
      }
    })
  }

  const toggleAll = () => {
    setPicks((prev) => {
      const next: Record<string, Pick> = { ...prev }
      for (const c of shippableRows) {
        const remaining = baseline.get(c.id)?.remaining ?? 0
        if (allShippableSelected) {
          next[c.id] = { selected: false, qty: prev[c.id]?.qty ?? 0 }
        } else {
          const cur = prev[c.id]
          const qty = cur?.qty && cur.qty > 0 ? Math.min(cur.qty, remaining) : remaining
          next[c.id] = { selected: true, qty }
        }
      }
      return next
    })
  }

  const submit = () => {
    setError(null)
    const selections = shippableRows
      .map((c) => {
        const p = picks[c.id]
        if (!p || !p.selected || p.qty <= 0) return null
        return { componentId: c.id, qty: p.qty }
      })
      .filter((x): x is { componentId: string; qty: number } => x !== null)
    if (selections.length === 0) {
      setError('请至少选择一个零件')
      return
    }
    start(async () => {
      try {
        await mutate<{ shipmentId: string; docNo: string }>({
          kind: 'prepareShipping',
          jobId,
          selections,
        })
        window.open(`/jobs/${jobId}/print/shipping`, '_blank', 'noopener')
        // /jobs/[id] is force-dynamic; one router.refresh after a once-per-
        // batch action is acceptable. Inline edits already bypass refresh.
        router.refresh()
        onClose()
      } catch (e) {
        setError(e instanceof Error ? e.message : '提交失败')
      }
    })
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="制作出货单"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => {
        if (!pending) onClose()
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[560px] max-h-[88vh] flex flex-col bg-[var(--color-surface)] border border-[var(--color-ink)] rounded-sm shadow-xl"
      >
        <header className="px-6 py-5 border-b border-[var(--color-border)] flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <p className="label text-[var(--color-ink-3)] mb-1">出货</p>
            <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-ink)]">
              制作出货单
            </h2>
          </div>
          {shippableRows.length > 0 && (
            <button
              type="button"
              onClick={toggleAll}
              disabled={pending}
              className="label text-[var(--color-ink-3)] hover:text-[var(--color-ink)] tracking-wider whitespace-nowrap disabled:opacity-40"
            >
              {allShippableSelected ? '取消全选' : '全选剩余'}
            </button>
          )}
        </header>

        <div className="flex-1 overflow-y-auto">
          {inRoute.length === 0 ? (
            <p className="px-6 py-10 text-center text-[13px] text-[var(--color-ink-3)]">
              该工单没有出货环节
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {inRoute.map((c) => {
                const b = baseline.get(c.id) ?? { shipped: 0, remaining: c.qty }
                const fullyShipped = b.remaining === 0
                const p = picks[c.id] ?? { selected: false, qty: b.remaining }
                const checked = !fullyShipped && p.selected
                const entries = componentShipmentEntries(c.id, shipments)
                const lastEntry = entries.at(-1)
                return (
                  <li
                    key={c.id}
                    className={`px-6 py-3 transition-colors ${
                      fullyShipped ? 'bg-[var(--color-success-soft)]' : ''
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <label
                        className={`flex items-center gap-3 flex-1 min-w-0 ${
                          fullyShipped ? 'cursor-default' : 'cursor-pointer'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(c)}
                          disabled={pending || fullyShipped}
                          aria-label={`选择 ${c.name}`}
                          className="h-4 w-4 accent-[var(--color-ink)] disabled:opacity-30"
                        />
                        <span
                          className={`text-[13px] truncate ${
                            fullyShipped
                              ? 'text-[var(--color-ink-3)] line-through decoration-[var(--color-ink-4)]'
                              : 'text-[var(--color-ink)]'
                          }`}
                        >
                          {c.name}
                        </span>
                      </label>
                      <div className="flex items-baseline gap-1.5 shrink-0">
                        <input
                          type="number"
                          min={0}
                          max={b.remaining}
                          step={1}
                          value={fullyShipped ? 0 : p.qty}
                          onChange={(e) => setQty(c, Number(e.target.value))}
                          onFocus={(e) => e.target.select()}
                          disabled={pending || fullyShipped}
                          aria-label={`${c.name} 本次数量`}
                          className="w-14 mono text-[13px] text-right border-b border-[var(--color-border)] bg-transparent py-1 focus:outline-none focus:border-[var(--color-ink)] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none disabled:opacity-30"
                        />
                        <span className="label text-[var(--color-ink-3)] mono">
                          / {b.remaining}
                        </span>
                      </div>
                    </div>
                    <div className="mt-1 ml-7 flex items-baseline gap-3 text-[11px]">
                      {fullyShipped ? (
                        <span className="mono text-[var(--color-success)]">
                          ✓ 已全部出货 {c.qty}/{c.qty}
                        </span>
                      ) : b.shipped > 0 ? (
                        <span className="mono text-[var(--color-warning)]">
                          已发 {b.shipped}
                        </span>
                      ) : (
                        <span className="mono text-[var(--color-ink-3)]">
                          共 {c.qty} 件
                        </span>
                      )}
                      {lastEntry ? (
                        <span className="mono text-[var(--color-ink-4)] truncate">
                          上次 {formatShipmentTimestamp(lastEntry.createdAt)} ×{lastEntry.qty}
                        </span>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {error && (
          <p className="px-6 pt-2 text-[12px] text-[var(--color-overdue)]">
            {error}
          </p>
        )}

        <footer className="px-6 py-4 border-t border-[var(--color-border)] flex items-center justify-between gap-4">
          <span className="label text-[var(--color-ink-3)] mono">
            本次 {batchQty} 件 · {selectedCount} 种零件
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="px-3 py-1.5 text-[12px] tracking-wider border border-[var(--color-border)] text-[var(--color-ink-2)] hover:bg-[#f1eee4] rounded-sm disabled:opacity-60"
            >
              取消
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={pending || batchQty === 0}
              className="px-3 py-1.5 text-[12px] tracking-wider bg-[var(--color-ink)] text-[var(--color-surface)] rounded-sm hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {pending ? '生成中…' : '打印出货单'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
