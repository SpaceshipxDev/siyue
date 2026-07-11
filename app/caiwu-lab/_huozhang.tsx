'use client'

// 活账单 (Huózhàng Dān) — the Living Sheet. ONE ROW PER ORDER, flat, like her
// Excel — minus the hand-mathing.
//
// This is her real spreadsheet, kept flat. One row per order; the columns she
// already knows (日期 / 客户 / 订单号 / 金额) sit on the left, and the money
// columns that USED to be a painful free-text cell — 已开票 / 待开票 / 已收 /
// 未收 — compute themselves. She never types a 剩余 again and never trusts one.
//
// The whole product is two motions, both Excel-native:
//   1. TYPE INTO A CELL. Click a row's 待开票 cell → it becomes an in-place
//      amount input + a month picker. Amount, Enter, done — store.addEvent
//      lands a 开票 installment and 已开票/待开票/未收 recompute live. Click 未收
//      → identical, kind 'payment'. An over-ceiling amount can NEVER commit
//      (the 剩余 promise): it shows red '超出', ✓ greys, Enter is ignored, the
//      field stays editable so she fixes it.
//   2. ADD A ROW. A persistent "+ 新增一行" at the bottom (Excel's blank last
//      row). Tab across 客户 / 订单号 / 金额 / 日期, Enter → store.addOrder.
//
// Multi-PO orders (the minority) expand into thin per-PO sub-rows so an
// installment lands on the right 订单号; the order row always shows the
// aggregate. Her old yellow installment cell is now automatic — click 已开票
// (or the row's chevron) to drop the month-by-month ledger beneath the row,
// with a quiet 撤销 on the last event.
//
// 238 orders render flat; the row list is WINDOWED with @tanstack/react-virtual
// (the master board's idiom — useWindowVirtualizer + measureElement + scrollMargin)
// so it stays smooth and scales to thousands. An expanded row (sub-rows or
// ledger) measures correctly. Nothing here stores or recomputes a 余额; every
// number derives from _derive over the shared store.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { formatCny } from '@/lib/data'
import { DatePop } from '@/app/_datepop'
import { useMockStore } from './_store'
import {
  buildOrders,
  sortByAnxiety,
  ledgerForLine,
  lineWaitInvoice,
  lineUnpaid,
  lineInvoiced,
  linePaid,
  matchesQuery,
  monthLabel,
  STATUS_TEXT,
  type OrderVM,
  type MoneyStatus,
} from './_derive'
import {
  TODAY,
  DATASET_STATS,
  type PoLine,
  type EventKind,
} from './_mock'

// Her two-Excels filter tabs. Default 待开票 (the leak she chases). 全部 last so
// the anxious slices lead. 收款中 includes 逾期 (an aging order still owes 收款).
type Lens = 'await_invoice' | 'collecting' | 'settled' | 'all'
const LENSES: { key: Lens; label: string }[] = [
  { key: 'await_invoice', label: '待开票' },
  { key: 'collecting', label: '收款中' },
  { key: 'settled', label: '已结清' },
  { key: 'all', label: '全部' },
]

// Status = colored TEXT, never a filled pill. 逾期 red, 已结清 fades to ink-3.
const STATUS_COLOR: Record<MoneyStatus, string> = {
  overdue: 'text-[var(--color-overdue)] font-medium',
  await_invoice: 'text-[var(--color-info)]',
  collecting: 'text-[var(--color-warning)]',
  settled: 'text-[var(--color-ink-3)]',
}

function passesLens(o: OrderVM, lens: Lens): boolean {
  switch (lens) {
    case 'all':
      return true
    case 'await_invoice':
      return o.status === 'await_invoice' || o.status === 'overdue'
    case 'collecting':
      return o.status === 'collecting' || o.status === 'overdue'
    case 'settled':
      return o.status === 'settled'
  }
}

// The shared inline-edit field vocabulary (verbatim from the spec / _fenqi).
// Transparent at rest; underline on focus — reads like every editable cell.
const baseInputClass =
  'block w-full bg-transparent border-0 outline-none rounded-[2px] px-1 -mx-1 py-0.5 transition-[background-color,box-shadow] duration-150 hover:bg-[var(--color-active-bg)] hover:shadow-[inset_0_-1px_0_var(--color-border-strong)] focus:bg-[var(--color-active-bg)] focus:shadow-[inset_0_-1px_0_var(--color-ink)]'

// Windowing keeps the DOM tiny; a soft cap is a second floor so the virtualizer
// can never be asked to lay out thousands of rows at once.
const SOFT_ROW_CAP = 600

// Compact order date — "1-30" from an ISO. Drops the year (her Excel does too).
function compactDate(iso: string): string {
  if (!iso || iso.length < 10) return iso
  return `${+iso.slice(5, 7)}-${+iso.slice(8, 10)}`
}

// A 0 余额 is NOISE — render a muted em-dash, never "¥0", so the eye only ever
// lands on live money. `live` is the class for a real (non-zero) amount.
function Money({
  value,
  live,
  size = 'text-[13px]',
}: {
  value: number
  live: string
  size?: string
}) {
  if (value === 0) {
    return (
      <span className={`mono tabular-nums ${size} text-[var(--color-ink-4)]`}>
        —
      </span>
    )
  }
  return (
    <span className={`mono tabular-nums ${size} ${live}`}>
      {formatCny(value)}
    </span>
  )
}

export default function HuozhangDesign() {
  const store = useMockStore()
  const [lens, setLens] = useState<Lens>('await_invoice')
  const [query, setQuery] = useState('')

  // Per-order UI state, keyed by job id. These survive sort/filter changes so a
  // row she's editing stays open even if its position shifts.
  // editing: which cell on which order is the live composer.
  const [editing, setEditing] = useState<{
    jobId: string
    lineId: string
    kind: EventKind
  } | null>(null)
  // historyOpen: orders whose month-by-month ledger strip is shown.
  const [historyOpen, setHistoryOpen] = useState<Record<string, boolean>>({})
  // poOpen: multi-PO orders expanded into per-PO sub-rows (entry routing).
  const [poOpen, setPoOpen] = useState<Record<string, boolean>>({})
  // The persistent "+ 新增一行" draft, when active.
  const [adding, setAdding] = useState(false)

  // One truth: derive every order from the store, sort by anxiety (逾期 →
  // 待开票 → 收款中 → 已结清, oldest ship first).
  const orders = useMemo(
    () => sortByAnxiety(buildOrders(store.jobs, store.lines, store.events)),
    [store.jobs, store.lines, store.events],
  )

  // Search first so the lens counts never lie about what tapping them shows.
  const searched = useMemo(
    () => orders.filter((o) => matchesQuery(o, query)),
    [orders, query],
  )

  const counts = useMemo(() => {
    const c: Record<Lens, number> = {
      await_invoice: 0,
      collecting: 0,
      settled: 0,
      all: 0,
    }
    for (const o of searched) {
      c.all += 1
      if (passesLens(o, 'await_invoice')) c.await_invoice += 1
      if (passesLens(o, 'collecting')) c.collecting += 1
      if (passesLens(o, 'settled')) c.settled += 1
    }
    return c
  }, [searched])

  const visible = useMemo(
    () => searched.filter((o) => passesLens(o, lens)),
    [searched, lens],
  )

  // Ambient Σ totals over the currently visible orders — two quiet numbers, not
  // a dashboard. 待开票 Σ and 未收 Σ, the two she scans the day for.
  const totals = useMemo(() => {
    let waitInvoice = 0
    let unpaid = 0
    for (const o of visible) {
      waitInvoice += o.rollup.waitInvoice
      unpaid += o.rollup.unpaid
    }
    return { waitInvoice, unpaid }
  }, [visible])

  // Soft cap — windowing already bounds the DOM; this guarantees the work.
  const cappedRows = useMemo(
    () => (visible.length > SOFT_ROW_CAP ? visible.slice(0, SOFT_ROW_CAP) : visible),
    [visible],
  )
  const hiddenRowCount = visible.length - cappedRows.length

  // --- WINDOWING — the row list is virtualized over the window scroll (the
  // master board's exact idiom). measureElement gives every <tr> its real
  // height, so a collapsed row (~36px) and an expanded one (sub-rows / ledger)
  // coexist without layout drift. ---
  const bodyRef = useRef<HTMLTableSectionElement>(null)
  const [listOffsetTop, setListOffsetTop] = useState(0)
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const update = () =>
      setListOffsetTop(el.getBoundingClientRect().top + window.scrollY)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [cappedRows.length])

  const rowVirtualizer = useWindowVirtualizer<HTMLTableRowElement>({
    count: cappedRows.length,
    estimateSize: () => 36, // dense spreadsheet row
    getItemKey: (index) => cappedRows[index]?.job.id ?? index,
    overscan: 12,
    scrollMargin: listOffsetTop,
  })
  const virtualItems = rowVirtualizer.getVirtualItems()
  const topSpacer =
    virtualItems.length > 0
      ? Math.max(0, virtualItems[0].start - listOffsetTop)
      : 0
  const bottomSpacer =
    virtualItems.length > 0
      ? Math.max(
          0,
          rowVirtualizer.getTotalSize() -
            (virtualItems[virtualItems.length - 1].end - listOffsetTop),
        )
      : 0

  // 9 money/data columns + caret. colSpan for the full-width spacer / footer.
  const COL_SPAN = 10

  const toggleHistory = (jobId: string) =>
    setHistoryOpen((p) => ({ ...p, [jobId]: !p[jobId] }))

  // Open a money cell for entry. Single-PO orders enter directly on their one
  // line; multi-PO orders EXPAND into per-PO sub-rows so the installment lands
  // on the right 订单号 (and clear any line-level composer).
  const openCell = (order: OrderVM, kind: EventKind) => {
    if (order.lines.length > 1) {
      setPoOpen((p) => ({ ...p, [order.job.id]: true }))
      setEditing(null)
      return
    }
    const line = order.lines[0]
    if (!line) return
    setEditing({ jobId: order.job.id, lineId: line.id, kind })
  }
  const openSubCell = (jobId: string, lineId: string, kind: EventKind) =>
    setEditing({ jobId, lineId, kind })
  const closeCell = () => setEditing(null)

  return (
    <div className="px-6 py-6">
      {/* LEAN TOP CHROME — one tight strip: her filter tabs (underline-active)
          with mono counts, a search box, and two ambient Σ totals. The sheet is
          the hero, so this stays one row, not a dashboard. */}
      <div className="mb-3 flex flex-wrap items-end gap-x-7 gap-y-3">
        <div role="tablist" aria-label="筛选" className="flex items-baseline gap-x-6">
          {LENSES.map((l) => {
            const active = l.key === lens
            return (
              <button
                key={l.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setLens(l.key)}
                className={`group inline-flex items-baseline gap-1.5 pb-1 border-b transition-colors ${
                  active
                    ? 'border-[var(--color-ink)]'
                    : 'border-transparent hover:border-[var(--color-border-strong)]'
                }`}
              >
                <span
                  className={`text-[14px] tracking-tight ${
                    active
                      ? 'font-semibold text-[var(--color-ink)]'
                      : 'font-medium text-[var(--color-ink-3)] group-hover:text-[var(--color-ink-2)]'
                  }`}
                >
                  {l.label}
                </span>
                <span className="mono text-[11px] tabular-nums text-[var(--color-ink-4)]">
                  {counts[l.key]}
                </span>
              </button>
            )
          })}
        </div>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索 · 客户 / 工号 / 订单号"
          className="w-[260px] bg-transparent border-0 border-b border-[var(--color-border)] outline-none rounded-none px-0.5 py-1 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] transition-colors focus:border-[var(--color-ink)]"
        />

        {/* Two ambient Σ totals — quiet, right-aligned, not a dashboard. */}
        <div className="ml-auto flex items-baseline gap-x-7">
          <SigmaTotal label="待开票 Σ" value={totals.waitInvoice} tone="info" />
          <SigmaTotal label="未收 Σ" value={totals.unpaid} tone="ink" />
        </div>
      </div>

      {/* SCALE LINE — minimal; the density IS the scale story. */}
      <div className="mb-2 flex flex-wrap items-center gap-x-2 text-[12px]">
        <span className="mono tabular-nums text-[var(--color-ink-3)]">
          {DATASET_STATS.orders} 单
        </span>
        <span className="text-[var(--color-ink-4)]">·</span>
        <span className="text-[var(--color-ink-3)]">待开票</span>
        <span className="mono tabular-nums text-[var(--color-ink-2)]">
          {counts.await_invoice} 单
        </span>
      </div>

      <div className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="sheet w-full text-left text-[13px]">
          {/* col order: 日期 · 客户 · 订单号 · 金额 · 已开票 · 待开票 · 已收 ·
              未收 · 状态 · caret. No whitespace/comments between <col> tags —
              React forbids text nodes inside <colgroup> (hydration error). */}
          <colgroup>
            <col style={{ width: 64 }} />
            <col style={{ width: 200 }} />
            <col style={{ width: 150 }} />
            <col style={{ width: 124 }} />
            <col style={{ width: 124 }} />
            <col style={{ width: 132 }} />
            <col style={{ width: 124 }} />
            <col style={{ width: 124 }} />
            <col style={{ width: 86 }} />
            <col style={{ width: 32 }} />
          </colgroup>
          {/* Sticky header — the th cells pin just under the lab's switcher bar
              (sticky top-0) so the columns stay labeled through the long scroll.
              .sheet thead th already paints an opaque #f5f3ed background. */}
          <thead>
            <tr className="text-[var(--color-ink-2)] [&>th]:sticky [&>th]:top-[49px] [&>th]:z-10">
              <th className="px-3 py-2 label whitespace-nowrap">日期</th>
              <th className="px-3 py-2 label whitespace-nowrap">客户</th>
              <th className="px-3 py-2 label whitespace-nowrap">订单号</th>
              <th className="px-3 py-2 text-right label whitespace-nowrap">金额</th>
              <th className="px-3 py-2 text-right label whitespace-nowrap">已开票</th>
              <th className="px-3 py-2 text-right label whitespace-nowrap">待开票</th>
              <th className="px-3 py-2 text-right label whitespace-nowrap">已收</th>
              <th className="px-3 py-2 text-right label whitespace-nowrap">未收</th>
              <th className="px-3 py-2 label whitespace-nowrap">状态</th>
              <th className="px-2 py-2" aria-hidden />
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {topSpacer > 0 && (
              <tr aria-hidden="true">
                <td colSpan={COL_SPAN} style={{ height: topSpacer, padding: 0, border: 0 }} />
              </tr>
            )}

            {virtualItems.map((vItem) => {
              const order = cappedRows[vItem.index]
              if (!order) return null
              return (
                <OrderRow
                  key={order.job.id}
                  order={order}
                  measureRef={rowVirtualizer.measureElement}
                  virtualIndex={vItem.index}
                  editing={
                    editing && editing.jobId === order.job.id ? editing : null
                  }
                  historyOpen={!!historyOpen[order.job.id]}
                  poOpen={!!poOpen[order.job.id]}
                  onOpenCell={(kind) => openCell(order, kind)}
                  onOpenSubCell={openSubCell}
                  onCloseCell={closeCell}
                  onToggleHistory={() => toggleHistory(order.job.id)}
                  onTogglePo={() =>
                    setPoOpen((p) => ({ ...p, [order.job.id]: !p[order.job.id] }))
                  }
                />
              )
            })}

            {bottomSpacer > 0 && (
              <tr aria-hidden="true">
                <td colSpan={COL_SPAN} style={{ height: bottomSpacer, padding: 0, border: 0 }} />
              </tr>
            )}

            {/* "+ 新增一行" — the blank last row. Click to type a brand-new order
                at the bottom of the sheet; her "I add rows" agency. */}
            <NewOrderRow
              active={adding}
              colSpan={COL_SPAN}
              onActivate={() => setAdding(true)}
              onClose={() => setAdding(false)}
            />

            {hiddenRowCount > 0 && (
              <tr>
                <td colSpan={COL_SPAN} className="px-3 py-3 text-[12px] text-[var(--color-ink-3)]">
                  + {hiddenRowCount} 更多 · 搜索跳转
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {visible.length === 0 && (
          <div className="py-16 text-center text-[13px] text-[var(--color-ink-3)]">
            {lens === 'await_invoice' ? '待开票已清空 · 按时开票' : '没有匹配的订单'}
          </div>
        )}
      </div>
    </div>
  )
}

// --- ambient Σ total (top strip) ---
function SigmaTotal({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'info' | 'ink'
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[11px] tracking-[0.12em] uppercase text-[var(--color-ink-4)]">
        {label}
      </span>
      <span
        className={`mono tabular-nums text-[15px] ${
          tone === 'info' ? 'text-[var(--color-info)]' : 'text-[var(--color-ink)]'
        }`}
      >
        {formatCny(value)}
      </span>
    </div>
  )
}

// --- ONE ORDER ROW (~36px) — flat, dense, the aggregate. Money cells are
// editable entry points; history + per-PO sub-rows drop beneath it. ---

interface EditState {
  jobId: string
  lineId: string
  kind: EventKind
}

function OrderRow({
  order,
  measureRef,
  virtualIndex,
  editing,
  historyOpen,
  poOpen,
  onOpenCell,
  onOpenSubCell,
  onCloseCell,
  onToggleHistory,
  onTogglePo,
}: {
  order: OrderVM
  measureRef: (node: HTMLTableRowElement | null) => void
  virtualIndex: number
  editing: EditState | null
  historyOpen: boolean
  poOpen: boolean
  onOpenCell: (kind: EventKind) => void
  onOpenSubCell: (jobId: string, lineId: string, kind: EventKind) => void
  onCloseCell: () => void
  onToggleHistory: () => void
  onTogglePo: () => void
}) {
  const store = useMockStore()
  const { job, lines, rollup, status, overdueDays } = order
  const multi = lines.length > 1
  const firstLine = lines[0]
  const firstPo = firstLine?.poNo ?? ''

  // The single-PO line whose money cell is the live composer (if any).
  const editingHere = !multi && editing && editing.lineId === firstLine?.id ? editing : null

  return (
    <>
      <tr
        ref={measureRef}
        data-index={virtualIndex}
        className="group/row align-middle"
      >
        {/* 日期 */}
        <td className="px-3 py-2 mono text-[12px] tabular-nums text-[var(--color-ink-3)] whitespace-nowrap">
          {compactDate(job.shipDate)}
        </td>

        {/* 客户 + 生产编号 (= 内部流水号, her bridge key) faint beneath */}
        <td className="px-3 py-1.5">
          <div className="text-[13px] text-[var(--color-ink)] truncate" title={job.customer}>
            {job.customer}
          </div>
          <div className="mono text-[11px] text-[var(--color-ink-3)] truncate" title={job.id}>
            {job.id}
          </div>
        </td>

        {/* 订单号 — single-PO shows the number; multi-PO shows first + "+N" and
            a caret to expand per-PO sub-rows. */}
        <td className="px-3 py-2">
          <div className="flex items-baseline gap-1.5">
            <span className="mono text-[12px] tabular-nums text-[var(--color-ink-2)] truncate" title={firstPo}>
              {firstPo}
            </span>
            {multi && (
              <button
                type="button"
                onClick={onTogglePo}
                className="inline-flex items-baseline gap-1 shrink-0"
                title={`${lines.length} 个订单号`}
              >
                <span className="mono text-[11px] tabular-nums text-[var(--color-ink-4)]">
                  +{lines.length - 1}
                </span>
                <span className="text-[10px] text-[var(--color-ink-4)]">
                  {poOpen ? '⌄' : '›'}
                </span>
              </button>
            )}
          </div>
        </td>

        {/* 金额 — order total */}
        <td className="px-3 py-2 text-right">
          <span className="mono tabular-nums text-[13px] text-[var(--color-ink)]">
            {formatCny(rollup.poAmount)}
          </span>
        </td>

        {/* 已开票 — click to drop the month-by-month history strip (secondary).
            ink-2; 0 → muted dash. */}
        <td
          className="px-3 py-2 text-right cursor-pointer hover:bg-[var(--color-active-bg)] transition-colors"
          onClick={onToggleHistory}
          title="查看开票/收款记录"
        >
          <Money value={rollup.invoiced} live="text-[var(--color-ink-2)]" />
        </td>

        {/* 待开票 — THE KEY billing number. Bold ink. EDITABLE entry cell. */}
        <td className="px-3 py-2 text-right">
          {editingHere && editingHere.kind === 'invoice' && firstLine ? (
            <CellComposer
              kind="invoice"
              ceiling={lineWaitInvoice(firstLine, store.events)}
              onCommit={(amount, dateIso) => {
                store.addEvent(firstLine.id, 'invoice', amount, dateIso)
                onCloseCell()
              }}
              onCancel={onCloseCell}
            />
          ) : (
            <EntryCell
              value={rollup.waitInvoice}
              live="text-[var(--color-ink)] font-medium"
              hint="开"
              onClick={() => onOpenCell('invoice')}
            />
          )}
        </td>

        {/* 已收 — ink-2; 0 → dash */}
        <td className="px-3 py-2 text-right">
          <Money value={rollup.paid} live="text-[var(--color-ink-2)]" />
        </td>

        {/* 未收 — EDITABLE entry cell. overdue-red when the order is aging. */}
        <td className="px-3 py-2 text-right">
          {editingHere && editingHere.kind === 'payment' && firstLine ? (
            <CellComposer
              kind="payment"
              ceiling={lineUnpaid(firstLine, store.events)}
              onCommit={(amount, dateIso) => {
                store.addEvent(firstLine.id, 'payment', amount, dateIso)
                onCloseCell()
              }}
              onCancel={onCloseCell}
            />
          ) : (
            <EntryCell
              value={rollup.unpaid}
              live={
                overdueDays > 0
                  ? 'text-[var(--color-overdue)] font-medium'
                  : 'text-[var(--color-ink)]'
              }
              hint="收"
              onClick={() => onOpenCell('payment')}
            />
          )}
        </td>

        {/* 状态 — colored TEXT, never a pill. 逾期 carries its day count. */}
        <td className="px-3 py-2 whitespace-nowrap">
          <span className={`text-[12px] ${STATUS_COLOR[status]}`}>
            {STATUS_TEXT[status]}
            {status === 'overdue' && overdueDays > 0 ? ` ${overdueDays}天` : ''}
          </span>
        </td>

        {/* caret — toggles the history strip (the row-level disclosure). */}
        <td className="px-2 py-2 text-center">
          <button
            type="button"
            onClick={onToggleHistory}
            aria-expanded={historyOpen}
            aria-label={historyOpen ? '收起记录' : '展开记录'}
            className="inline-flex h-5 w-5 items-center justify-center text-[12px] text-[var(--color-ink-4)] hover:text-[var(--color-ink)] transition-colors"
          >
            {historyOpen ? '⌄' : '›'}
          </button>
        </td>
      </tr>

      {/* MULTI-PO SUB-ROWS — thin per-PO rows, each its own entry cells, so the
          installment lands on the right 订单号. The order row above stays the
          aggregate. */}
      {multi && poOpen &&
        lines.map((line) => (
          <SubRow
            key={line.id}
            jobId={job.id}
            line={line}
            editing={editing && editing.lineId === line.id ? editing : null}
            onOpenSubCell={onOpenSubCell}
            onCloseCell={onCloseCell}
          />
        ))}

      {/* HISTORY STRIP — the month-by-month ledger her old yellow cell held.
          Automatic now: '6月 开票 ¥2,800 → 待开票 ¥232,936', 收款 lines, and a
          quiet 撤销 on the last event. Available, not required for daily entry. */}
      {historyOpen && (
        <tr>
          <td colSpan={10} className="bg-[var(--color-bg)] px-0 py-0">
            <HistoryStrip lines={lines} multi={multi} />
          </td>
        </tr>
      )}
    </>
  )
}

// One editable money cell at rest. Shows the derived 余额 (or "—" for 0) with a
// faint "+ 开" / "+ 收" hint on row hover so it's discoverable it's typeable.
function EntryCell({
  value,
  live,
  hint,
  onClick,
}: {
  value: number
  live: string
  hint: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex w-full items-baseline justify-end gap-1.5 rounded-[2px] px-1 -mx-1 py-0.5 text-right transition-colors hover:bg-[var(--color-active-bg)] hover:shadow-[inset_0_0_0_1px_var(--color-border)]"
      title={`点此录入 · ${hint}`}
    >
      <span className="text-[10px] text-[var(--color-ink-4)] opacity-0 group-hover/row:opacity-100 transition-opacity">
        + {hint}
      </span>
      <Money value={value} live={live} />
    </button>
  )
}

// --- multi-PO sub-row (~32px) — its own 订单号 · 金额 · 已开票 · 待开票 · 已收 ·
// 未收, each money entry cell clickable so the installment routes correctly. ---
function SubRow({
  jobId,
  line,
  editing,
  onOpenSubCell,
  onCloseCell,
}: {
  jobId: string
  line: PoLine
  editing: EditState | null
  onOpenSubCell: (jobId: string, lineId: string, kind: EventKind) => void
  onCloseCell: () => void
}) {
  const store = useMockStore()
  const invoiced = lineInvoiced(store.events, line.id)
  const paid = linePaid(store.events, line.id)
  const wait = lineWaitInvoice(line, store.events)
  const unpaid = lineUnpaid(line, store.events)

  return (
    <tr className="group/sub bg-[var(--color-bg)] align-middle">
      <td className="px-3 py-1.5" />
      <td className="px-3 py-1.5" />
      {/* 订单号 */}
      <td className="px-3 py-1.5 pl-6">
        <span className="mono text-[11px] tabular-nums text-[var(--color-ink-2)] truncate" title={line.poNo}>
          {line.poNo}
        </span>
      </td>
      {/* 金额 */}
      <td className="px-3 py-1.5 text-right">
        <span className="mono tabular-nums text-[12px] text-[var(--color-ink-2)]">
          {formatCny(line.poAmountCny)}
        </span>
      </td>
      {/* 已开票 */}
      <td className="px-3 py-1.5 text-right">
        <Money value={invoiced} live="text-[var(--color-ink-3)]" size="text-[12px]" />
      </td>
      {/* 待开票 — entry cell */}
      <td className="px-3 py-1.5 text-right">
        {editing && editing.kind === 'invoice' ? (
          <CellComposer
            kind="invoice"
            ceiling={wait}
            onCommit={(amount, dateIso) => {
              store.addEvent(line.id, 'invoice', amount, dateIso)
              onCloseCell()
            }}
            onCancel={onCloseCell}
          />
        ) : (
          <SubEntryCell
            value={wait}
            live="text-[var(--color-ink)] font-medium"
            hint="开"
            onClick={() => onOpenSubCell(jobId, line.id, 'invoice')}
          />
        )}
      </td>
      {/* 已收 */}
      <td className="px-3 py-1.5 text-right">
        <Money value={paid} live="text-[var(--color-ink-3)]" size="text-[12px]" />
      </td>
      {/* 未收 — entry cell */}
      <td className="px-3 py-1.5 text-right">
        {editing && editing.kind === 'payment' ? (
          <CellComposer
            kind="payment"
            ceiling={unpaid}
            onCommit={(amount, dateIso) => {
              store.addEvent(line.id, 'payment', amount, dateIso)
              onCloseCell()
            }}
            onCancel={onCloseCell}
          />
        ) : (
          <SubEntryCell
            value={unpaid}
            live="text-[var(--color-ink)]"
            hint="收"
            onClick={() => onOpenSubCell(jobId, line.id, 'payment')}
          />
        )}
      </td>
      <td className="px-3 py-1.5" />
      <td className="px-2 py-1.5" />
    </tr>
  )
}

// Sub-row entry cell — same affordance as EntryCell, keyed to row/sub hover.
function SubEntryCell({
  value,
  live,
  hint,
  onClick,
}: {
  value: number
  live: string
  hint: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex w-full items-baseline justify-end gap-1.5 rounded-[2px] px-1 -mx-1 py-0.5 text-right transition-colors hover:bg-[var(--color-active-bg)] hover:shadow-[inset_0_0_0_1px_var(--color-border)]"
      title={`点此录入 · ${hint}`}
    >
      <span className="text-[10px] text-[var(--color-ink-4)] opacity-0 group-hover/sub:opacity-100 transition-opacity">
        + {hint}
      </span>
      <Money value={value} live={live} size="text-[12px]" />
    </button>
  )
}

// --- THE IN-PLACE CELL COMPOSER — the whole product ---
//
// Replaces the money cell with an autofocused amount input + a DatePop (month
// label, default CURRENT month so amount+Enter commits in one stroke). Enter /
// ✓ → onCommit. Escape / ✕ → cancel, no write. An over-ceiling amount can NEVER
// commit: it shows red with a tiny '超出', ✓ greys, Enter is ignored, and the
// field stays editable so she fixes it. (A wrong 剩余 can never be written.)
function CellComposer({
  kind,
  ceiling,
  onCommit,
  onCancel,
}: {
  kind: EventKind
  ceiling: number
  onCommit: (amount: number, dateIso: string) => void
  onCancel: () => void
}) {
  const isInvoice = kind === 'invoice'
  const [raw, setRaw] = useState('')
  // Default to the CURRENT month so the trigger shows the real month ('6月'),
  // never an empty placeholder — she can commit in one stroke, re-pick in one
  // tap. 收款 still forbids future dates.
  const [date, setDate] = useState<string>(TODAY)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const amount = Number(raw)
  const valid = raw.trim() !== '' && Number.isFinite(amount) && amount > 0
  const over = valid && amount > ceiling
  const committable = valid && !over

  const commit = () => {
    if (!committable) return
    onCommit(amount, date || TODAY)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      {/* type word — full 开票 / 收款 as colored text, reads as 'the row being
          appended'. */}
      <span
        className={`text-[10px] shrink-0 ${
          isInvoice ? 'text-[var(--color-info)]' : 'text-[var(--color-success)]'
        }`}
      >
        {isInvoice ? '开' : '收'}
      </span>

      {/* amount — autofocused, mono, right-aligned. The 余额 ceiling shows
          faintly as placeholder but is NEVER pre-filled. Always editable; only
          the write is blocked when over. */}
      <div className="w-[88px] shrink-0">
        <input
          ref={inputRef}
          value={raw}
          inputMode="decimal"
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`余 ${formatCny(ceiling)}`}
          className={`${baseInputClass} mono tabular-nums text-right text-[12px] placeholder:text-[var(--color-ink-4)] ${
            over ? 'text-[var(--color-overdue)]' : ''
          }`}
        />
      </div>

      {/* date — DatePop, month label, default current month; 收款 forbids
          future. */}
      <DatePop
        value={date}
        onChange={setDate}
        allowFuture={isInvoice}
        formatLabel={monthLabel}
        placeholder="月份"
        hideIcon
      />

      {/* over-ceiling note — tiny red '超出'. */}
      {over && (
        <span className="text-[10px] text-[var(--color-overdue)] shrink-0">
          超出
        </span>
      )}

      {/* commit / discard */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={commit}
          disabled={!committable}
          aria-label="确认"
          className={`rounded-[2px] px-1 py-0.5 text-[12px] transition-colors ${
            committable
              ? 'text-[var(--color-success)] hover:bg-[var(--color-success-soft)]'
              : 'text-[var(--color-ink-4)] cursor-default'
          }`}
        >
          ✓
        </button>
        <button
          type="button"
          onClick={onCancel}
          aria-label="取消"
          className="rounded-[2px] px-1 py-0.5 text-[12px] text-[var(--color-ink-4)] hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink-2)] transition-colors"
        >
          ✕
        </button>
      </div>
    </div>
  )
}

// --- HISTORY STRIP — the month-by-month ledger beneath an order row. One
// strip per 订单号 (split when multi-PO), each: '6月 开票 ¥2,800 → 待开票
// ¥232,936' style rows, with a quiet 撤销 on the LAST event of each line. ---
function HistoryStrip({ lines, multi }: { lines: PoLine[]; multi: boolean }) {
  const store = useMockStore()
  const anyEvents = lines.some((l) => ledgerForLine(l, store.events).length > 0)
  return (
    <div className="px-6 py-3">
      {!anyEvents && (
        <div className="text-[11px] text-[var(--color-ink-4)]">
          暂无开票 / 收款记录 · 点 待开票 或 未收 单元格录入
        </div>
      )}
      {lines.map((line) => {
        const ledger = ledgerForLine(line, store.events)
        if (ledger.length === 0) return null
        return (
          <div key={line.id} className="mb-2 last:mb-0">
            {multi && (
              <div className="mb-1 mono text-[11px] tabular-nums text-[var(--color-ink-3)]">
                {line.poNo}
                <span className="ml-2 text-[var(--color-ink-4)]">
                  订单额 {formatCny(line.poAmountCny)}
                </span>
              </div>
            )}
            <div className="flex flex-col gap-0.5">
              {ledger.map((row) => {
                const isInvoice = row.event.kind === 'invoice'
                const done = row.running === 0
                return (
                  <div
                    key={row.event.id}
                    className="group/led flex items-center gap-2 text-[12px]"
                  >
                    <span className="mono tabular-nums text-[var(--color-ink-3)] w-9 shrink-0">
                      {monthLabel(row.event.date)}
                    </span>
                    <span
                      className={`shrink-0 w-8 ${
                        isInvoice
                          ? 'text-[var(--color-info)]'
                          : 'text-[var(--color-success)]'
                      }`}
                    >
                      {isInvoice ? '开票' : '收款'}
                    </span>
                    <span className="mono tabular-nums text-[var(--color-ink-2)] w-[96px] text-right">
                      {formatCny(row.event.amountCny)}
                    </span>
                    <span className="text-[var(--color-ink-4)] shrink-0">→</span>
                    <span className="text-[11px] text-[var(--color-ink-3)] shrink-0">
                      {isInvoice ? '待开票' : '未收'}
                    </span>
                    {done ? (
                      <span className="text-[var(--color-success)]">
                        {isInvoice ? '开完' : '收清'}
                      </span>
                    ) : (
                      <span className="mono tabular-nums text-[var(--color-ink-2)]">
                        {formatCny(row.running)}
                      </span>
                    )}
                    {/* quiet 撤销 on the last event only */}
                    {row.isLast && (
                      <button
                        type="button"
                        onClick={() => store.voidLastEvent(line.id)}
                        className="ml-2 text-[11px] text-[var(--color-ink-4)] opacity-0 group-hover/led:opacity-100 hover:text-[var(--color-overdue)] transition-opacity"
                        title="撤销最近一笔"
                      >
                        撤销
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// --- "+ 新增一行" — the persistent blank last row (Excel's bottom row). At rest
// it's a single quiet affordance; activated, it's an inline editable order row:
// 客户 (text) · 订单号 (text) · 金额 (number) · 日期 (DatePop, default today).
// Tab moves across the fields; Enter on 金额 (or ✓) → store.addOrder. Escape /
// ✕ cancels. ---
function NewOrderRow({
  active,
  colSpan,
  onActivate,
  onClose,
}: {
  active: boolean
  colSpan: number
  onActivate: () => void
  onClose: () => void
}) {
  const store = useMockStore()
  const [customer, setCustomer] = useState('')
  const [poNo, setPoNo] = useState('')
  const [amountRaw, setAmountRaw] = useState('')
  const [date, setDate] = useState<string>(TODAY)
  const customerRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (active) customerRef.current?.focus()
  }, [active])

  const amount = Number(amountRaw)
  const amountValid = amountRaw.trim() !== '' && Number.isFinite(amount) && amount > 0
  const valid = customer.trim() !== '' && poNo.trim() !== '' && amountValid

  const reset = () => {
    setCustomer('')
    setPoNo('')
    setAmountRaw('')
    setDate(TODAY)
  }

  const commit = () => {
    if (!valid) return
    store.addOrder({
      customer: customer.trim(),
      poNo: poNo.trim(),
      amountCny: amount,
      date: date || TODAY,
    })
    reset()
    onClose()
  }

  const cancel = () => {
    reset()
    onClose()
  }

  const onAmountKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }
  const onTextKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  if (!active) {
    return (
      <tr className="align-middle">
        <td colSpan={colSpan} className="px-3 py-0">
          <button
            type="button"
            onClick={onActivate}
            className="inline-flex w-full items-center gap-2 py-2 text-left text-[13px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
          >
            <span className="text-[15px] leading-none text-[var(--color-ink-4)]">+</span>
            新增一行
          </button>
        </td>
      </tr>
    )
  }

  return (
    <tr className="align-middle bg-[var(--color-active-bg)]/40">
      {/* 日期 */}
      <td className="px-2 py-1.5">
        <DatePop
          value={date}
          onChange={setDate}
          formatLabel={(iso) => compactDate(iso)}
          placeholder="日期"
          hideIcon
        />
      </td>
      {/* 客户 */}
      <td className="px-3 py-1.5">
        <input
          ref={customerRef}
          value={customer}
          onChange={(e) => setCustomer(e.target.value)}
          onKeyDown={onTextKeyDown}
          placeholder="客户"
          className={`${baseInputClass} text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)]`}
        />
      </td>
      {/* 订单号 */}
      <td className="px-3 py-1.5">
        <input
          value={poNo}
          onChange={(e) => setPoNo(e.target.value)}
          onKeyDown={onTextKeyDown}
          placeholder="订单号"
          className={`${baseInputClass} mono tabular-nums text-[12px] text-[var(--color-ink-2)] placeholder:text-[var(--color-ink-4)]`}
        />
      </td>
      {/* 金额 */}
      <td className="px-3 py-1.5 text-right">
        <input
          value={amountRaw}
          inputMode="decimal"
          onChange={(e) => setAmountRaw(e.target.value)}
          onKeyDown={onAmountKeyDown}
          placeholder="金额"
          className={`${baseInputClass} mono tabular-nums text-right text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)]`}
        />
      </td>
      {/* 已开票 / 待开票 / 已收 / 未收 — empty until events land. */}
      <td className="px-3 py-1.5 text-right">
        <span className="mono text-[12px] text-[var(--color-ink-4)]">—</span>
      </td>
      <td className="px-3 py-1.5 text-right">
        <span className="mono text-[12px] text-[var(--color-ink-4)]">—</span>
      </td>
      <td className="px-3 py-1.5 text-right">
        <span className="mono text-[12px] text-[var(--color-ink-4)]">—</span>
      </td>
      <td className="px-3 py-1.5 text-right">
        <span className="mono text-[12px] text-[var(--color-ink-4)]">—</span>
      </td>
      {/* commit / cancel in the 状态 + caret columns */}
      <td className="px-2 py-1.5" colSpan={2}>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={commit}
            disabled={!valid}
            aria-label="新增订单"
            className={`rounded-[2px] px-1.5 py-0.5 text-[13px] transition-colors ${
              valid
                ? 'text-[var(--color-success)] hover:bg-[var(--color-success-soft)]'
                : 'text-[var(--color-ink-4)] cursor-default'
            }`}
          >
            ✓
          </button>
          <button
            type="button"
            onClick={cancel}
            aria-label="取消"
            className="rounded-[2px] px-1.5 py-0.5 text-[13px] text-[var(--color-ink-4)] hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink-2)] transition-colors"
          >
            ✕
          </button>
        </div>
      </td>
    </tr>
  )
}
