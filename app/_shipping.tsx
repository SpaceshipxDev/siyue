'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { withBase } from '@/lib/base-path'
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
//
// 一行四个数, 成列摆开: 订单 (总共要交多少) · 已交 (以前交掉的) ·
// 未交 · 本次 (这一车拉走多少)。未交跟着本次实时减 —— 填 30, 未交立刻
// 显示出完还欠几件, 不用自己在脑子里减一遍, 也不用等打完单再回来看。
// 底下合计同理: 归零就是这个工单交清了。
//
// 打出来的出货单上只有「交货数量」, 也就是本次这一栏 —— 客户要的是
// 这一车拉了什么, 厂里的欠数是厂里的事。

type Pick = { selected: boolean; qty: number }

// 零件 · 订单 · 已交 · 未交 · 本次 — 表头和每一行共用, 所以列永远对得齐。
const COLS = 'grid-cols-[minmax(0,1fr)_34px_34px_40px_58px]'

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
  // Once every in-route part has been fully shipped there's nothing left to
  // compose, but the user still legitimately needs to reprint the last
  // 出货单 (customer lost it, mailroom asks for another copy, etc.). Skip the
  // picker in that state and open the print page directly — same artifact,
  // no new shipment row.
  const reprintOnly =
    shipments.length > 0 &&
    components
      .filter((c) => isStageInRoute(c, '出货'))
      .every((c) => componentShippedTotal(c.id, shipments) >= c.qty)
  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (reprintOnly) {
            window.open(withBase(`/jobs/${jobId}/print/shipping`), '_blank', 'noopener')
            return
          }
          setOpen(true)
        }}
        className="px-3 py-1.5 text-[12px] tracking-wider bg-[var(--color-ink)] text-[var(--color-surface)] rounded-[2px] hover:opacity-80"
      >
        {reprintOnly ? '重新打印出货单' : '制作出货单'}
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

  // 出完这一单还欠多少 — 订单 − 已交 − 本次。这是"未交"那一列的合计, 也是做
  // 这张单时唯一要盯的数: 它归零, 这个工单就交清了。
  const owedAfterTotal = inRoute.reduce((sum, c) => {
    const b = baseline.get(c.id)
    const p = picks[c.id]
    const take = p?.selected ? p.qty : 0
    return sum + Math.max(0, c.qty - (b?.shipped ?? 0) - take)
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
        window.open(withBase(`/jobs/${jobId}/print/shipping`), '_blank', 'noopener')
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
        className="w-full max-w-[560px] max-h-[88vh] flex flex-col bg-[var(--color-surface)] border border-[var(--color-ink)] rounded-[2px] shadow-xl"
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
            <>
            {/* 四个数各占一列, 而且有列头 — 以前它们藏在行下面一行小字里, 还
                是有条件才出现的 (发过货写"已发", 没发过写"共 N 件"), 同一个
                位置在不同行上说的是不同的事。 */}
            <div className={`sticky top-0 z-10 grid ${COLS} items-baseline gap-2 border-b border-[var(--color-border)] bg-[#f5f3ed] px-6 py-1.5`}>
              <span className="label">零件</span>
              <span className="label text-right">订单</span>
              <span className="label text-right">已交</span>
              <span className="label text-right">未交</span>
              <span className="label text-right">本次</span>
            </div>
            <ul className="divide-y divide-[var(--color-border)]">
              {inRoute.map((c) => {
                const b = baseline.get(c.id) ?? { shipped: 0, remaining: c.qty }
                const fullyShipped = b.remaining === 0
                const p = picks[c.id] ?? { selected: false, qty: b.remaining }
                const checked = !fullyShipped && p.selected
                const entries = componentShipmentEntries(c.id, shipments)
                const lastEntry = entries.at(-1)
                // 未交跟着「本次」实时减 — 填多少, 这里立刻显示出完还欠多少,
                // 不用自己在脑子里减一遍。
                const take = checked ? p.qty : 0
                const owedAfter = Math.max(0, c.qty - b.shipped - take)
                return (
                  <li
                    key={c.id}
                    className={`px-6 py-3 transition-colors ${
                      fullyShipped ? 'bg-[var(--color-success-soft)]' : ''
                    }`}
                  >
                    <div className={`grid ${COLS} items-center gap-2`}>
                      <label
                        className={`flex min-w-0 items-center gap-2.5 ${
                          fullyShipped ? 'cursor-default' : 'cursor-pointer'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(c)}
                          disabled={pending || fullyShipped}
                          aria-label={`选择 ${c.name}`}
                          className="h-4 w-4 shrink-0 accent-[var(--color-ink)] disabled:opacity-30"
                        />
                        <span
                          className={`truncate text-[13px] ${
                            fullyShipped
                              ? 'text-[var(--color-ink-3)] line-through decoration-[var(--color-ink-4)]'
                              : 'text-[var(--color-ink)]'
                          }`}
                        >
                          {c.name}
                        </span>
                      </label>
                      <span className="mono text-right text-[12.5px] tabular-nums text-[var(--color-ink-2)]">
                        {c.qty}
                      </span>
                      <span
                        className={`mono text-right text-[12.5px] tabular-nums ${
                          b.shipped > 0
                            ? 'text-[var(--color-ink-2)]'
                            : 'text-[var(--color-ink-4)]'
                        }`}
                      >
                        {b.shipped > 0 ? b.shipped : '·'}
                      </span>
                      <span
                        className={`mono text-right text-[12.5px] font-semibold tabular-nums ${
                          owedAfter === 0
                            ? 'text-[var(--color-success)]'
                            : 'text-[var(--color-ink)]'
                        }`}
                      >
                        {owedAfter}
                      </span>
                      {fullyShipped ? (
                        <span className="mono text-right text-[12.5px] text-[var(--color-success)]">
                          ✓
                        </span>
                      ) : (
                        <input
                          type="number"
                          min={0}
                          max={b.remaining}
                          step={1}
                          value={p.qty}
                          onChange={(e) => setQty(c, Number(e.target.value))}
                          onFocus={(e) => e.target.select()}
                          disabled={pending}
                          aria-label={`${c.name} 本次数量`}
                          className="mono w-full border-b border-[var(--color-border)] bg-transparent py-1 text-right text-[13px] tabular-nums focus:border-[var(--color-ink)] focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none disabled:opacity-30"
                        />
                      )}
                    </div>
                    {lastEntry ? (
                      <div className="mt-1 ml-7 text-[11px]">
                        <span className="mono truncate text-[var(--color-ink-4)]">
                          上次 {formatShipmentTimestamp(lastEntry.createdAt)} ×{lastEntry.qty}
                        </span>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
            </>
          )}
        </div>

        {error && (
          <p className="px-6 pt-2 text-[12px] text-[var(--color-overdue)]">
            {error}
          </p>
        )}

        <footer className="px-6 py-4 border-t border-[var(--color-border)] flex items-center justify-between gap-4">
          <span className="label mono text-[var(--color-ink-3)]">
            本次 {batchQty} 件 · {selectedCount} 种零件
            <span
              className={`ml-2 ${
                owedAfterTotal === 0
                  ? 'text-[var(--color-success)]'
                  : 'text-[var(--color-ink-2)]'
              }`}
            >
              · {owedAfterTotal === 0 ? '出完就交清了' : `出后仍欠 ${owedAfterTotal} 件`}
            </span>
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="px-3 py-1.5 text-[12px] tracking-wider border border-[var(--color-border)] text-[var(--color-ink-2)] hover:bg-[#f1eee4] rounded-[2px] disabled:opacity-60"
            >
              取消
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={pending || batchQty === 0}
              className="px-3 py-1.5 text-[12px] tracking-wider bg-[var(--color-ink)] text-[var(--color-surface)] rounded-[2px] hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {pending ? '生成中…' : '打印出货单'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
