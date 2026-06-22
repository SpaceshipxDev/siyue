'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react'
import { createPortal } from 'react-dom'
import { MoneyCell } from './_ui'
import { mutate } from '@/lib/mutate'
import { showToast } from './_toast'
import { formatCny } from '@/lib/data'
import { orderMoneyStatusFrom, type OrderMoneyStatus } from '@/lib/order-money'

// 收款 — click-to-fill, on BOTH surfaces the boss naturally reaches for:
//   • the board 收款 cell (the glance) — tap → popover, same one-tap controls;
//   • the job 财务 tab (where he goes to deal with one order's money).
// Tap 已开票 / 已回款 on a shipped order → the light goes 待开票 → 待回款 →
// 已结清 in place. The data that lights the light gets entered as a byproduct
// of looking at it. One source of truth (the same shipment_finance the 财务
// workspace reads), zero new columns, no migration.

export type Ship = {
  shipmentId: string
  docNo?: string
  shipDate: string
  invoiceDate?: string
  invoiceAmountCny?: number
  paymentDate?: string
  paymentAmountCny?: number
}

function todayYmd(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
}

// MM-DD from a YYYY-MM-DD (or ISO) string, for the compact "已开票 6-21" label.
function mdLabel(ymd: string): string {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return ymd
  return `${parseInt(m[2], 10)}-${parseInt(m[3], 10)}`
}

// ── Shared editor: the 开票 / 回款 one-tap rows for an order's shipments.
// Parent owns `ships` state; `onAfterChange` lets the board recompute its light.
function ShipmentFinanceEditor({
  amountCny,
  ships,
  setShips,
  onAfterChange,
}: {
  amountCny?: number
  ships: Ship[]
  setShips: (next: Ship[]) => void
  onAfterChange?: (next: Ship[]) => void
}) {
  const [pending, start] = useTransition()

  // Default 开票 amount: the whole order for a single delivery; split evenly as
  // a starting point when an order ships in parts (rare — 17 of 819). Editable.
  const defaultAmt = (): number | undefined => {
    if (typeof amountCny !== 'number' || !(amountCny > 0)) return undefined
    const n = ships.length || 1
    return n <= 1 ? amountCny : Math.round(amountCny / n)
  }

  const write = (
    shipmentId: string,
    patch: Record<string, unknown>,
    next: Ship[],
  ) => {
    const prev = ships
    setShips(next)
    onAfterChange?.(next)
    start(async () => {
      try {
        await mutate({ kind: 'updateShipmentFinance', shipmentId, patch })
      } catch (e) {
        showToast(`保存失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
        setShips(prev) // revert
        onAfterChange?.(prev)
      }
    })
  }

  const markInvoice = (s: Ship) => {
    const amt = s.invoiceAmountCny ?? defaultAmt()
    const today = todayYmd()
    const next = ships.map((x) =>
      x.shipmentId === s.shipmentId
        ? { ...x, invoiceDate: today, invoiceAmountCny: amt }
        : x,
    )
    write(s.shipmentId, { invoiceDate: today, invoiceAmountCny: amt ?? null }, next)
  }

  // 标记回款 also stamps 开票 if missing — "钱到了 ⇒ 结清" in one tap.
  const markPayment = (s: Ship) => {
    const today = todayYmd()
    const invAmt = s.invoiceAmountCny ?? defaultAmt()
    const patch: Record<string, unknown> = {
      paymentDate: today,
      paymentAmountCny: invAmt ?? null,
    }
    const upd: Ship = { ...s, paymentDate: today, paymentAmountCny: invAmt }
    if (!s.invoiceDate) {
      patch.invoiceDate = today
      patch.invoiceAmountCny = invAmt ?? null
      upd.invoiceDate = today
      upd.invoiceAmountCny = invAmt
    }
    const next = ships.map((x) => (x.shipmentId === s.shipmentId ? upd : x))
    write(s.shipmentId, patch, next)
  }

  const undoInvoice = (s: Ship) => {
    const next = ships.map((x) =>
      x.shipmentId === s.shipmentId
        ? { ...x, invoiceDate: undefined, invoiceAmountCny: undefined }
        : x,
    )
    write(s.shipmentId, { invoiceDate: null, invoiceAmountCny: null }, next)
  }

  const undoPayment = (s: Ship) => {
    const next = ships.map((x) =>
      x.shipmentId === s.shipmentId
        ? { ...x, paymentDate: undefined, paymentAmountCny: undefined }
        : x,
    )
    write(s.shipmentId, { paymentDate: null, paymentAmountCny: null }, next)
  }

  const setAmount = (
    s: Ship,
    field: 'invoiceAmountCny' | 'paymentAmountCny',
    value: number,
  ) => {
    const next = ships.map((x) =>
      x.shipmentId === s.shipmentId ? { ...x, [field]: value } : x,
    )
    write(s.shipmentId, { [field]: value }, next)
  }

  const multi = ships.length > 1

  return (
    <div className={`flex flex-col gap-3 ${pending ? 'opacity-70' : ''}`}>
      {ships.map((s) => (
        <div key={s.shipmentId} className="flex flex-col gap-1.5">
          {multi && s.docNo && (
            <span className="mono text-[10px] text-[var(--color-ink-4)]">{s.docNo}</span>
          )}
          <MoneyLine
            label="开票"
            done={!!s.invoiceDate}
            date={s.invoiceDate}
            amount={s.invoiceAmountCny}
            markLabel="标记开票"
            onMark={() => markInvoice(s)}
            onUndo={() => undoInvoice(s)}
            onSetAmount={(v) => setAmount(s, 'invoiceAmountCny', v)}
          />
          <MoneyLine
            label="回款"
            done={!!s.paymentDate}
            date={s.paymentDate}
            amount={s.paymentAmountCny}
            markLabel="标记回款"
            tone="success"
            onMark={() => markPayment(s)}
            onUndo={() => undoPayment(s)}
            onSetAmount={(v) => setAmount(s, 'paymentAmountCny', v)}
          />
        </div>
      ))}
    </div>
  )
}

// ── Board cell: the light, tappable, with the editor in a popover. The popover
// is PORTALED to <body> with fixed positioning — the board lives inside an
// overflow-x-auto scroll container (CSS forces overflow-y to auto too), which
// would otherwise clip an in-cell absolute popover: the click fires, the fetch
// runs, and you see nothing. The portal escapes the clip.
export function MoneyCellInteractive({
  jobId,
  jobNo,
  amountCny,
  status,
  outstandingCny,
  overdueDays,
}: {
  jobId: string
  jobNo: string
  amountCny?: number
  status?: OrderMoneyStatus
  outstandingCny?: number
  overdueDays?: number
}) {
  const [light, setLight] = useState({ status, outstandingCny, overdueDays })
  const [open, setOpen] = useState(false)
  const [ships, setShips] = useState<Ship[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const interactive = !!light.status && light.status !== 'in_production'

  const load = useCallback(async () => {
    setLoadErr(null)
    try {
      const r = await fetch(`/api/order-money?jobId=${encodeURIComponent(jobId)}`)
      const data = (await r.json()) as
        | { ok: true; shipments: Ship[] }
        | { ok: false; error: string }
      if (!data.ok) {
        setLoadErr(data.error)
        return
      }
      setShips(data.shipments)
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : '网络中断')
    }
  }, [jobId])

  const POP_W = 264
  const place = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let left = r.right - POP_W
    if (left < 8) left = 8
    const maxLeft = window.innerWidth - 8 - POP_W
    if (left > maxLeft) left = Math.max(8, maxLeft)
    setPos({ top: r.bottom + 4, left })
  }, [])

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    place()
    if (ships === null && loadErr === null) void load()
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (popRef.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    function dismiss() {
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    // capture:true catches scrolling of the inner overflow container too, so the
    // fixed popover never floats away from its cell.
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [open])

  // Recompute the light from live shipment state — mirrors the server's
  // orderMoneyStatusFrom so cell and board agree. (Aging is left to the next
  // real fetch; a just-invoiced order is never overdue.)
  const recompute = (next: Ship[]) => {
    const hasInvoice = next.some((s) => !!s.invoiceDate)
    const outstanding = next.reduce(
      (sum, s) =>
        sum +
        (s.invoiceDate ? (s.invoiceAmountCny ?? 0) - (s.paymentAmountCny ?? 0) : 0),
      0,
    )
    setLight({
      status: orderMoneyStatusFrom({
        hasOverdue: false,
        isShipped: true,
        hasInvoice,
        outstandingCny: outstanding,
      }),
      outstandingCny: outstanding,
      overdueDays: undefined,
    })
  }

  return (
    <div className="relative h-full w-full" onClick={(e) => e.stopPropagation()}>
      {interactive ? (
        <button
          ref={triggerRef}
          type="button"
          onClick={toggle}
          aria-label={`${jobNo} · 收款`}
          className="block h-full w-full cursor-pointer transition-colors hover:bg-[#f1eee4]"
        >
          <MoneyCell
            status={light.status}
            outstandingCny={light.outstandingCny}
            overdueDays={light.overdueDays}
          />
        </button>
      ) : (
        <div className="h-full w-full">
          <MoneyCell
            status={light.status}
            outstandingCny={light.outstandingCny}
            overdueDays={light.overdueDays}
          />
        </div>
      )}

      {open &&
        pos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popRef}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: POP_W }}
            className="z-[60] rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-xl text-left"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-baseline justify-between border-b border-[var(--color-border)] px-3 py-2">
              <span className="mono text-[12px] text-[var(--color-ink)]">{jobNo}</span>
              {typeof amountCny === 'number' && amountCny > 0 && (
                <span className="mono text-[12px] text-[var(--color-ink-2)]">
                  {formatCny(amountCny)}
                </span>
              )}
            </div>
            <div className="px-3 py-2.5">
              {loadErr ? (
                <button
                  type="button"
                  onClick={load}
                  className="w-full py-3 text-center text-[12px] text-[var(--color-overdue)] hover:underline"
                >
                  加载失败 · 点此重试
                </button>
              ) : ships === null ? (
                <p className="py-3 text-center text-[12px] text-[var(--color-ink-4)]">加载中…</p>
              ) : ships.length === 0 ? (
                <p className="py-3 text-center text-[12px] text-[var(--color-ink-4)]">
                  此单尚无出货单 · 请先在工单内开出货单
                </p>
              ) : (
                <ShipmentFinanceEditor
                  amountCny={amountCny}
                  ships={ships}
                  setShips={setShips}
                  onAfterChange={recompute}
                />
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}

// ── Job 财务 tab: the same one-tap controls, inline (no popover). Self-fetches
// the order's 出货单 + 开票/回款 state on mount, so it stays OFF the job page's
// server critical path (the page renders instantly; this streams into the
// hidden 财务 tab). This is where the boss deals with one order's money.
export function JobMoneyEditor({
  jobId,
  amountCny,
}: {
  jobId: string
  amountCny?: number
}) {
  const [ships, setShips] = useState<Ship[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`/api/order-money?jobId=${encodeURIComponent(jobId)}`)
      .then((r) => r.json())
      .then((d: { ok: true; shipments: Ship[] } | { ok: false; error: string }) => {
        if (!alive) return
        if (d.ok) setShips(d.shipments)
        else setErr(d.error)
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : '网络中断')
      })
    return () => {
      alive = false
    }
  }, [jobId])

  if (err) {
    return (
      <p className="text-[13px] text-[var(--color-overdue)]">开票 / 回款加载失败 · {err}</p>
    )
  }
  if (ships === null) {
    return <p className="text-[13px] text-[var(--color-ink-4)]">开票 / 回款 · 加载中…</p>
  }
  if (ships.length === 0) {
    return (
      <p className="text-[13px] text-[var(--color-ink-3)]">
        本单尚未出货 · 出货后可在此一键登记{' '}
        <span className="text-[var(--color-ink-2)]">开票 / 回款</span>。
      </p>
    )
  }
  return (
    <div className="max-w-[340px]">
      <ShipmentFinanceEditor amountCny={amountCny} ships={ships} setShips={setShips} />
    </div>
  )
}

function MoneyLine({
  label,
  done,
  date,
  amount,
  markLabel,
  tone,
  onMark,
  onUndo,
  onSetAmount,
}: {
  label: string
  done: boolean
  date?: string
  amount?: number
  markLabel: string
  tone?: 'success'
  onMark: () => void
  onUndo: () => void
  onSetAmount: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 shrink-0 text-[12px] text-[var(--color-ink-3)]">{label}</span>
      {done ? (
        <div className="flex flex-1 items-center gap-1.5">
          <span
            className={`text-[12px] font-medium ${
              tone === 'success'
                ? 'text-[var(--color-success)]'
                : 'text-[var(--color-ink)]'
            }`}
          >
            {date ? mdLabel(date) : ''}
          </span>
          <AmountEdit value={amount} onCommit={onSetAmount} />
          <button
            type="button"
            onClick={onUndo}
            title={`撤销${label}`}
            aria-label={`撤销${label}`}
            className="ml-auto shrink-0 text-[11px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
          >
            撤销
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onMark}
          className="flex-1 rounded-[2px] border border-[var(--color-border)] py-1 text-[12px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] transition-colors"
        >
          {markLabel}
        </button>
      )}
    </div>
  )
}

// Inline amount — plain text, becomes an input on click. Commits on blur/Enter.
function AmountEdit({
  value,
  onCommit,
}: {
  value?: number
  onCommit: (v: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value != null ? String(value) : '')

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value != null ? String(value) : '')
          setEditing(true)
        }}
        className="mono text-[12px] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:underline underline-offset-2"
        title="点击修改金额"
      >
        {value != null ? formatCny(value) : '¥—'}
      </button>
    )
  }
  const commit = () => {
    const n = Number(draft.trim())
    if (draft.trim() !== '' && Number.isFinite(n) && n >= 0 && n !== value) {
      onCommit(n)
    }
    setEditing(false)
  }
  return (
    <input
      autoFocus
      type="number"
      inputMode="decimal"
      min={0}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ;(e.target as HTMLInputElement).blur()
        } else if (e.key === 'Escape') {
          setEditing(false)
        }
      }}
      className="mono w-[72px] rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-1 py-0.5 text-[12px] text-[var(--color-ink)] outline-none"
    />
  )
}
