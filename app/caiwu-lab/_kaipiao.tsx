'use client'

// 开票本 (Kāipiào Běn) — The Per-Customer Statement Book (对账-first).
//
// Pick a customer from a left rail sorted by who-owes-an-invoice; their
// orders → PO lines → 开票/收款 installments stack into ONE warm-paper 对账单
// she reads top-to-bottom. She appends a single number anywhere (amount +
// month, never a 剩余), and every derived figure — the line's running 剩余,
// the order rollup, the statement's four headline numbers, and the left-rail
// meta — cascades from the shared store the next render. The instant 思看
// calls she types '思看', the statement auto-selects, and the four numbers
// are already on screen to read aloud.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMockStore } from './_store'
import {
  buildCustomers,
  buildOrders,
  ledgerForLine,
  lineInvoiced,
  linePaid,
  lineStatus,
  lineUnpaid,
  lineWaitInvoice,
  matchesQuery,
  monthLabel,
  sortByAnxiety,
  STATUS_TEXT,
  type CustomerVM,
  type MoneyStatus,
  type OrderVM,
} from './_derive'
import { DATASET_STATS, TODAY, type EventKind, type MoneyEvent, type PoLine } from './_mock'
import { DatePop } from '@/app/_datepop'
import { showToast } from '@/app/_toast'
import { formatCny } from '@/lib/data'

// Shared inline-edit field — verbatim from _editable / the AR ledger, so an
// active composer field reads like every other edit in the product. Adapted
// per call-site with `mono text-right`.
const baseInputClass =
  'block w-full bg-transparent border-0 outline-none rounded-[2px] px-1 -mx-1 py-0.5 transition-[background-color,box-shadow] duration-150 hover:bg-[var(--color-active-bg)] hover:shadow-[inset_0_-1px_0_var(--color-border-strong)] focus:bg-[var(--color-active-bg)] focus:shadow-[inset_0_-1px_0_var(--color-ink)]'

// State as colored text (the app idiom — never a pill).
const STATUS_COLOR: Record<MoneyStatus, string> = {
  overdue: 'text-[var(--color-overdue)]',
  await_invoice: 'text-[var(--color-ink-3)]',
  collecting: 'text-[var(--color-info)]',
  settled: 'text-[var(--color-ink-4)]',
}

// Compact 万 formatter for the dense left-rail meta. Headline numbers use
// formatCny; this only ever appears in the 11px mono backlog line.
function wan(n: number): string {
  if (n <= 0) return '¥0'
  const w = n / 10000
  if (w >= 10) return `¥${Math.round(w)}万`
  return `¥${(Math.round(w * 10) / 10).toFixed(1)}万`
}

// The day she reads aloud — '对账截至 6月24日'.
function todayLabel(): string {
  return `${+TODAY.slice(5, 7)}月${+TODAY.slice(8, 10)}日`
}

export default function KaipiaoDesign() {
  const store = useMockStore()
  const { jobs, lines, events } = store

  // Everything derives from the store; appends cascade on the next render.
  const orders = useMemo(() => buildOrders(jobs, lines, events), [jobs, lines, events])
  const customers = useMemo(() => buildCustomers(orders), [orders]) // already owing-first

  const [query, setQuery] = useState('')
  const [activeCustomer, setActiveCustomer] = useState<string | null>(null)

  // Filter the rail by name / 生产编号 / 订单号. A customer survives if ANY of
  // its orders match the haystack (or its name does).
  const filtered = useMemo<CustomerVM[]>(() => {
    const q = query.trim().toLowerCase()
    if (!q) return customers
    return customers.filter(
      (c) =>
        c.customer.toLowerCase().includes(q) ||
        c.orders.some((o) => matchesQuery(o, q)),
    )
  }, [customers, query])

  // 对账 escape hatch: when the typed query resolves to exactly one customer,
  // auto-select it — she types '思看', the statement opens, numbers ready.
  useEffect(() => {
    if (!query.trim()) return
    if (filtered.length === 1 && filtered[0].customer !== activeCustomer) {
      setActiveCustomer(filtered[0].customer)
    }
  }, [query, filtered, activeCustomer])

  const active = useMemo(
    () => customers.find((c) => c.customer === activeCustomer) ?? null,
    [customers, activeCustomer],
  )

  // 待开票 backlog: the customer owning the OLDEST owing PO line across ALL
  // customers (oldest = earliest ship date among orders that still owe an
  // invoice). One tap selects that customer and opens its oldest owing order.
  const backlog = useMemo(() => {
    let best: { customer: string; jobId: string; shipDate: string } | null = null
    for (const c of customers) {
      for (const o of c.orders) {
        if (o.rollup.waitInvoice <= 0) continue
        if (!best || o.job.shipDate < best.shipDate) {
          best = { customer: c.customer, jobId: o.job.id, shipDate: o.job.shipDate }
        }
      }
    }
    return best
  }, [customers])

  const awaitInvoiceCount = useMemo(
    () => customers.reduce((s, c) => s + c.awaitInvoiceLineCount, 0),
    [customers],
  )

  // Scale ledger for the rail — makes "hundreds of orders" legible. At rest it
  // reads the full dataset (DATASET_STATS) + the compact 待开票 sum across all
  // customers; with a search active it shows the filtered subset so narrowing
  // is visible. One faint mono line, no chrome.
  const scale = useMemo(() => {
    const searching = query.trim().length > 0
    if (searching) {
      const orderCount = filtered.reduce((s, c) => s + c.orders.length, 0)
      const wait = filtered.reduce((s, c) => s + c.rollup.waitInvoice, 0)
      return { orders: orderCount, customers: filtered.length, wait }
    }
    const wait = customers.reduce((s, c) => s + c.rollup.waitInvoice, 0)
    return { orders: DATASET_STATS.orders, customers: DATASET_STATS.customers, wait }
  }, [query, filtered, customers])

  // When the backlog chip is tapped we want the target order force-expanded;
  // a bump counter lets the statement re-run its "open the most anxious one"
  // logic but pointed at a specific order.
  const [forceOpen, setForceOpen] = useState<{ jobId: string; bump: number } | null>(null)

  const jumpToBacklog = () => {
    if (!backlog) return
    setQuery('')
    setActiveCustomer(backlog.customer)
    setForceOpen({ jobId: backlog.jobId, bump: Date.now() })
  }

  const selectCustomer = (name: string) => {
    setActiveCustomer(name)
    setForceOpen(null)
  }

  return (
    <div className="mx-auto max-w-[1240px] px-6 py-8">
      <div className="flex gap-6">
        {/* ── LEFT RAIL — the backlog Excel ──────────────────────────── */}
        <aside className="w-[300px] shrink-0">
          <div className="sticky top-[64px]">
            {/* Search */}
            <div className="relative mb-3">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索客户 / 生产编号 / 订单号"
                className="block w-full rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] outline-none transition-colors focus:border-[var(--color-border-strong)] focus:bg-[var(--color-surface)]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="清除"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-[2px] px-1 text-[14px] leading-none text-[var(--color-ink-4)] hover:text-[var(--color-ink-2)] transition-colors"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Scale ledger — full dataset at rest, filtered subset while
                searching. One faint mono line, no chrome. */}
            <div className="mono mb-3 px-1 text-[11px] tabular-nums text-[var(--color-ink-4)]">
              {scale.orders} 单
              <span className="px-1">·</span>
              {scale.customers} 客户
              <span className="px-1">·</span>
              待开票 {wan(scale.wait)}
            </div>

            {/* 待开票 N jump chip — the daily backlog escape hatch. */}
            {backlog && (
              <button
                type="button"
                onClick={jumpToBacklog}
                className="mb-3 flex w-full items-center justify-between rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left transition-colors hover:bg-[#faf8f2]"
              >
                <span className="text-[13px] text-[var(--color-ink-2)]">待开票</span>
                <span className="mono text-[13px] tabular-nums text-[var(--color-overdue)] font-medium">
                  {awaitInvoiceCount}
                  <span className="ml-1 text-[11px] text-[var(--color-ink-4)]">↳ 最早一笔</span>
                </span>
              </button>
            )}

            {/* Customer list — owing first, settled sinks in ink-4. */}
            <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
              {filtered.length === 0 ? (
                <div className="px-3 py-10 text-center text-[12px] text-[var(--color-ink-4)]">
                  没有匹配的客户
                </div>
              ) : (
                filtered.map((c) => (
                  <CustomerRow
                    key={c.customer}
                    vm={c}
                    active={c.customer === activeCustomer}
                    onSelect={() => selectCustomer(c.customer)}
                  />
                ))
              )}
            </div>
          </div>
        </aside>

        {/* ── RIGHT PANEL — the statement ───────────────────────────── */}
        <main className="min-w-0 flex-1">
          {active ? (
            <Statement key={active.customer} customer={active} forceOpen={forceOpen} />
          ) : (
            <div className="flex min-h-[60vh] items-center justify-center rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
              <p className="text-[14px] text-[var(--color-ink-4)]">选择左侧客户查看对账单</p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

// ── LEFT RAIL ROW ─────────────────────────────────────────────────────
function CustomerRow({
  vm,
  active,
  onSelect,
}: {
  vm: CustomerVM
  active: boolean
  onSelect: () => void
}) {
  const settled = vm.status === 'settled'
  const overdue = vm.status === 'overdue'
  // 未收 carries the second anxiety: overdue-red if this customer has an
  // overdue order, info-blue otherwise.
  const unpaidColor = overdue ? 'text-[var(--color-overdue)]' : 'text-[var(--color-info)]'

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative flex h-[56px] w-full flex-col justify-center gap-0.5 border-b border-[var(--color-border)] px-3 text-left transition-colors last:border-b-0 ${
        active ? 'bg-[var(--color-active-bg)]' : 'hover:bg-[#faf8f2]'
      }`}
    >
      {active && (
        <span className="absolute inset-y-0 left-0 w-[2px] bg-[var(--color-ink)]" aria-hidden />
      )}
      <span className="flex items-center gap-2">
        <span
          className={`truncate text-[15px] ${
            settled ? 'text-[var(--color-ink-4)]' : 'text-[var(--color-ink)]'
          }`}
        >
          {vm.customer}
        </span>
        {/* Shipped-uninvoiced flag — overdue-colored count, floats this row up. */}
        {vm.awaitInvoiceLineCount > 0 && (
          <span className="mono shrink-0 text-[10px] tabular-nums text-[var(--color-overdue)]">
            待开票 {vm.awaitInvoiceLineCount}
          </span>
        )}
      </span>
      <span className="mono truncate text-[11px] tabular-nums">
        {settled ? (
          <span className="text-[var(--color-ink-4)]">已结清</span>
        ) : (
          <>
            <span className="text-[var(--color-ink-3)]">待开票 {wan(vm.rollup.waitInvoice)}</span>
            <span className="text-[var(--color-ink-4)]"> · </span>
            <span className={unpaidColor}>未收 {wan(vm.rollup.unpaid)}</span>
          </>
        )}
      </span>
    </button>
  )
}

// ── STATEMENT (right panel) ───────────────────────────────────────────
function Statement({
  customer,
  forceOpen,
}: {
  customer: CustomerVM
  forceOpen: { jobId: string; bump: number } | null
}) {
  const store = useMockStore()
  const { events } = store
  const sorted = useMemo(() => sortByAnxiety(customer.orders), [customer.orders])

  // 展开全部 — when on, every order card AND every PO-line ledger opens so the
  // full installment narrative reads top-to-bottom in one scroll for the phone
  // 对账. It seeds initial open state; manual toggles take over thereafter.
  const [allExpanded, setAllExpanded] = useState(false)

  // ONLY the single most-attention-needing order auto-expands on select; the
  // rest stay collapsed. A backlog jump force-opens a specific order instead.
  const [openOrder, setOpenOrder] = useState<string | null>(null)
  // The order whose owing PO line should auto-expand (the auto-opened / forced
  // one). Bumped per (re)selection so OrderCard re-seeds its line open state.
  const [seedBump, setSeedBump] = useState(0)
  const autoOrderId = forceOpen ? forceOpen.jobId : sorted.length ? sorted[0].job.id : null

  useEffect(() => {
    setAllExpanded(false)
    setOpenOrder(autoOrderId)
    setSeedBump((b) => b + 1)
    // Re-run when the customer changes or a backlog jump bumps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer.customer, forceOpen?.bump])

  const toggleAll = () => {
    setAllExpanded((on) => {
      const next = !on
      // When turning OFF, fall back to only the most-anxious order open.
      if (!next) setOpenOrder(autoOrderId)
      setSeedBump((b) => b + 1)
      return next
    })
  }

  const r = customer.rollup
  const overdue = customer.status === 'overdue'

  // 复制余额 — the read-aloud surface as plain text for WeChat/phone 对账:
  // header + four rollup numbers, then one line per owing order. Mirrors the
  // _fenqi copyBalance pattern (same four labels), extended with the orders.
  const copyBalance = () => {
    const owing = sorted.filter((o) => o.rollup.waitInvoice > 0 || o.rollup.unpaid > 0)
    const summary = [
      `${customer.customer} 对账`,
      `对账截至 ${todayLabel()}`,
      `已开票 ${formatCny(r.invoiced)}`,
      `已收款 ${formatCny(r.paid)}`,
      `待开票余额 ${formatCny(r.waitInvoice)}`,
      `未收余额 ${formatCny(r.unpaid)}`,
      ...owing.map(
        (o) => `${o.job.id} · 待开票 ${formatCny(o.rollup.waitInvoice)} · 未收 ${formatCny(o.rollup.unpaid)}`,
      ),
    ].join('\n')
    void navigator.clipboard?.writeText(summary)
    showToast('已复制', 'success')
  }

  return (
    <div className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-7 py-6">
      {/* HEADER — the thing she reads aloud. */}
      <header className="border-b border-[var(--color-border)] pb-5">
        <h2 className="text-[28px] font-semibold leading-tight text-[var(--color-ink)]">
          {customer.customer}
        </h2>

        {/* Four-mono-number rollup strip. */}
        <div className="mt-4 grid grid-cols-4 gap-px overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-border)]">
          <RollupCell label="已开票" value={r.invoiced} tone="ink-2" />
          <RollupCell label="已收款" value={r.paid} tone="ink-2" />
          <RollupCell label="待开票余额" value={r.waitInvoice} tone="ink" />
          <RollupCell
            label="未收余额"
            value={r.unpaid}
            tone={overdue ? 'overdue' : 'info'}
          />
        </div>

        <p className="mt-3 flex items-center gap-2 text-[12px] text-[var(--color-ink-3)]">
          <span>对账截至 {todayLabel()}</span>
          <span className="text-[var(--color-ink-4)]">·</span>
          <button
            type="button"
            onClick={toggleAll}
            aria-pressed={allExpanded}
            className="inline-flex items-center gap-1 rounded-[2px] px-1 -mx-1 text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink)]"
          >
            {allExpanded ? '收起全部' : '展开全部'}
          </button>
          <span className="text-[var(--color-ink-4)]">·</span>
          <button
            type="button"
            onClick={copyBalance}
            className="inline-flex items-center gap-1 rounded-[2px] px-1 -mx-1 text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink)]"
          >
            复制余额 <span aria-hidden>⧉</span>
          </button>
        </p>
      </header>

      {/* ORDER SECTION CARDS — most-owing first. */}
      {sorted.length === 0 ? (
        <p className="py-16 text-center text-[13px] text-[var(--color-ink-4)]">该客户暂无订单</p>
      ) : (
        <div className="divide-y divide-[var(--color-border)]">
          {sorted.map((o) => (
            <OrderCard
              key={o.job.id}
              order={o}
              open={allExpanded || openOrder === o.job.id}
              onToggle={() => {
                setAllExpanded(false)
                setOpenOrder((prev) => (prev === o.job.id ? null : o.job.id))
              }}
              // Auto-expand the owing PO line when this is the auto/forced order,
              // OR expand every line when 展开全部 is on.
              autoExpandLines={allExpanded || o.job.id === autoOrderId}
              expandAllLines={allExpanded}
              owingLineId={owingLineId(o, events)}
              seedBump={seedBump}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// The PO line to auto-expand for an owing order: single-line → that line;
// multi-line → the oldest owing line (earliest ship/po among lines that still
// owe an invoice or are invoiced-but-unpaid). Returns null when nothing owes.
function owingLineId(order: OrderVM, events: MoneyEvent[]): string | null {
  const { lines } = order
  if (lines.length === 1) return lines[0].id
  let best: PoLine | null = null
  for (const line of lines) {
    const owes = lineWaitInvoice(line, events) > 0 || lineUnpaid(line, events) > 0
    if (!owes) continue
    if (!best || line.poNo < best.poNo) best = line
  }
  return best ? best.id : null
}

function RollupCell({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'ink' | 'ink-2' | 'info' | 'overdue'
}) {
  const color =
    tone === 'ink'
      ? 'text-[var(--color-ink)]'
      : tone === 'info'
        ? 'text-[var(--color-info)]'
        : tone === 'overdue'
          ? 'text-[var(--color-overdue)]'
          : 'text-[var(--color-ink-2)]'
  return (
    <div className="bg-[var(--color-surface)] px-3 py-2.5">
      <div className="label">{label}</div>
      <div className={`mono mt-1 text-[18px] tabular-nums ${color}`}>{formatCny(value)}</div>
    </div>
  )
}

// ── ORDER CARD ────────────────────────────────────────────────────────
function OrderCard({
  order,
  open,
  onToggle,
  autoExpandLines,
  expandAllLines,
  owingLineId,
  seedBump,
}: {
  order: OrderVM
  open: boolean
  onToggle: () => void
  /** Seed the owing line (single owingLineId) open on (re)selection. */
  autoExpandLines: boolean
  /** 展开全部 — seed EVERY line open. */
  expandAllLines: boolean
  owingLineId: string | null
  seedBump: number
}) {
  const { job, lines, rollup, status } = order
  const overdue = status === 'overdue'

  return (
    <section>
      {/* Card header — collapsible. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 py-3.5 text-left transition-colors hover:bg-[#faf8f2]"
      >
        <Caret open={open} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="mono text-[13px] text-[var(--color-ink)]">{job.id}</span>
            <span className={`text-[11px] ${STATUS_COLOR[status]}`}>
              {STATUS_TEXT[status]}
              {overdue && order.overdueDays > 0 ? ` ${order.overdueDays}天` : ''}
            </span>
          </div>
          <div className="mono mt-0.5 truncate text-[11px] text-[var(--color-ink-3)]">
            {job.product} · 出货 {monthLabel(job.shipDate)}
            {`${+job.shipDate.slice(8, 10)}日`}
          </div>
        </div>
        {/* Order rollup — right-aligned mono. */}
        <div className="shrink-0 text-right">
          <div className="mono text-[13px] tabular-nums text-[var(--color-ink)]">
            待开票 {formatCny(rollup.waitInvoice)}
          </div>
          <div
            className={`mono mt-0.5 text-[11px] tabular-nums ${
              overdue ? 'text-[var(--color-overdue)]' : 'text-[var(--color-info)]'
            }`}
          >
            未收 {formatCny(rollup.unpaid)}
          </div>
        </div>
      </button>

      {/* Expanded → PO lines. A multi-line order NEVER hides a line. */}
      {open && (
        <div className="pb-4">
          <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)]">
            {/* Column header — pr matches the PO row's reserved write gutter so
                the six columns stay aligned with the rows below. */}
            <div className="grid grid-cols-[minmax(150px,1.4fr)_repeat(5,1fr)] items-center gap-x-2 border-b border-[var(--color-border)] bg-[var(--color-bg)] py-2 pl-3 pr-[68px]">
              <span className="label">订单号 / 物料号</span>
              <span className="label text-right">订单额</span>
              <span className="label text-right">已开票</span>
              <span className="label text-right">待开票余额</span>
              <span className="label text-right">已收</span>
              <span className="label text-right">未收余额</span>
            </div>
            {lines.map((line) => (
              <PoLineRow
                key={line.id}
                line={line}
                initialOpen={expandAllLines || (autoExpandLines && line.id === owingLineId)}
                seedBump={seedBump}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

// ── PO LINE ROW (+ drilled ledger) ────────────────────────────────────
function PoLineRow({
  line,
  initialOpen,
  seedBump,
}: {
  line: PoLine
  /** Parent-seeded open state (auto-expand owing line / 展开全部). */
  initialOpen: boolean
  /** Re-seed `open` from `initialOpen` whenever this changes. */
  seedBump: number
}) {
  const store = useMockStore()
  const { events } = store
  // Drive open from the parent seed, but allow manual toggle thereafter: a new
  // seedBump re-applies initialOpen (selection / 展开全部 flips); clicks override.
  const [open, setOpen] = useState(initialOpen)
  useEffect(() => {
    setOpen(initialOpen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedBump])

  // Quick-append composer surfaced from the summary row (no drill needed).
  const [quickAdd, setQuickAdd] = useState<EventKind | null>(null)

  const invoiced = lineInvoiced(events, line.id)
  const paid = linePaid(events, line.id)
  const wait = lineWaitInvoice(line, events)
  const unpaid = lineUnpaid(line, events)
  const status = lineStatus(line, events)
  const hasInvoices = invoiced > 0

  // The applicable write verb, one tap from the order: owes invoice → +开票;
  // invoiced-but-unpaid → +收款. Show at most one (the live next action).
  const quickVerb: EventKind | null = wait > 0 ? 'invoice' : unpaid > 0 ? 'payment' : null

  return (
    <div className="group/line border-b border-[var(--color-border)] last:border-b-0">
      {/* The summary row — caret drops the ledger. role=button (not <button>)
          so the inline +write affordance can be a real, nested button. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen((o) => !o)
          }
        }}
        aria-expanded={open}
        className="relative grid w-full cursor-pointer grid-cols-[minmax(150px,1.4fr)_repeat(5,1fr)] items-center gap-x-2 py-2.5 pl-3 pr-[68px] text-left transition-colors hover:bg-[#faf8f2]"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Caret open={open} small />
          <span className="min-w-0">
            <span className="mono block truncate text-[13px] text-[var(--color-ink)]">
              {line.poNo}
            </span>
            {line.materialNo && (
              <span className="mono block truncate text-[11px] text-[var(--color-ink-4)]">
                {line.materialNo}
              </span>
            )}
          </span>
        </span>
        <span className="mono text-right text-[13px] tabular-nums text-[var(--color-ink)]">
          {formatCny(line.poAmountCny)}
        </span>
        <span className="mono text-right text-[13px] tabular-nums text-[var(--color-ink-2)]">
          {invoiced > 0 ? formatCny(invoiced) : <span className="text-[var(--color-ink-4)]">—</span>}
        </span>
        {/* 待开票余额 — '0' ONLY when invoices exist and drove it to zero;
            otherwise (no invoices yet) a faint '—'. */}
        <span className="mono text-right text-[13px] tabular-nums text-[var(--color-ink-3)]">
          {wait > 0 ? (
            formatCny(wait)
          ) : hasInvoices ? (
            <span className="text-[var(--color-ink-4)]">0</span>
          ) : (
            <span className="text-[var(--color-ink-4)]">—</span>
          )}
        </span>
        <span className="mono text-right text-[13px] tabular-nums text-[var(--color-ink-2)]">
          {paid > 0 ? formatCny(paid) : <span className="text-[var(--color-ink-4)]">—</span>}
        </span>
        <span
          className={`mono text-right text-[13px] tabular-nums ${
            status === 'overdue' ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink-3)]'
          }`}
        >
          {/* 未收余额 — '0' once invoiced-and-collected; '—' before any invoice. */}
          {unpaid > 0 ? (
            formatCny(unpaid)
          ) : hasInvoices ? (
            <span className="text-[var(--color-ink-4)]">0</span>
          ) : (
            <span className="text-[var(--color-ink-4)]">—</span>
          )}
        </span>

        {/* Persistent write affordance — append one tap from the order without
            drilling. Always faintly visible on owing lines (ink-4 at rest,
            brightening to ink on hover — same low-contrast treatment as 撤销),
            so the daily write path is discoverable without a hover. Sits in the
            row's reserved right gutter so it never covers the 未收余额 figure.
            stopPropagation so it never toggles the drill. */}
        {quickVerb && quickAdd === null && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setQuickAdd(quickVerb)
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-[2px] px-1 py-0.5 text-[12px] tabular-nums text-[var(--color-ink-4)] transition-colors hover:text-[var(--color-ink)] focus:text-[var(--color-ink)] focus:outline-none"
          >
            + {quickVerb === 'invoice' ? '开票' : '收款'}
          </button>
        )}
      </div>

      {/* Quick-append strip — the SAME AddInstallment composer, mounted inline
          beneath the summary row, pre-opened to editing. Dismisses on commit. */}
      {quickAdd && (
        <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2">
          <div className="label mb-1">{quickAdd === 'invoice' ? '开票' : '收款'}</div>
          <AddInstallment
            line={line}
            kind={quickAdd}
            ceiling={quickAdd === 'invoice' ? wait : unpaid}
            autoEdit
            onClose={() => setQuickAdd(null)}
          />
        </div>
      )}

      {/* Drilled → two stacked mini event-lists. */}
      {open && (
        <div className="grid grid-cols-2 gap-px border-t border-[var(--color-border)] bg-[var(--color-border)]">
          <EventList line={line} kind="invoice" />
          <EventList line={line} kind="payment" />
        </div>
      )}
    </div>
  )
}

// ── MINI EVENT LIST (开票 or 收款) ─────────────────────────────────────
function EventList({ line, kind }: { line: PoLine; kind: EventKind }) {
  const store = useMockStore()
  const { events } = store

  const ledger = ledgerForLine(line, events)
  const rows = ledger.filter((r) => r.event.kind === kind)
  // The remaining for THIS list: 开票 → 待开票余额, 收款 → 未收余额.
  const remaining =
    kind === 'invoice' ? lineWaitInvoice(line, events) : lineUnpaid(line, events)

  const isInvoice = kind === 'invoice'
  const title = isInvoice ? '开票' : '收款'
  const remLabel = isInvoice ? '待开票' : '未收'

  return (
    <div className="bg-[var(--color-surface)] px-4 py-3">
      {/* 剩余 header — pinned (sticky) so the latest remainder stays visible
          while older months scroll in a long line. */}
      <div className="sticky top-0 z-[1] mb-2 flex items-center justify-between bg-[var(--color-surface)]">
        <span className="label">{title}</span>
        <span
          className={`mono text-[11px] tabular-nums ${
            isInvoice ? 'text-[var(--color-ink-3)]' : 'text-[var(--color-info)]'
          }`}
        >
          剩余{remLabel} {formatCny(remaining)}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="py-1 text-[12px] text-[var(--color-ink-4)]">
          {isInvoice ? '未开票' : '未收款'}
        </p>
      ) : (
        // Cap at 220px → a 14+-month line scrolls instead of ballooning.
        <ul className="max-h-[220px] overflow-y-auto">
          {rows.map((row) => (
            <EventRow
              key={row.event.id}
              event={row.event}
              running={row.running}
              isLast={row.isLast}
              isInvoice={isInvoice}
            />
          ))}
        </ul>
      )}

      <AddInstallment line={line} kind={kind} ceiling={remaining} />
    </div>
  )
}

function EventRow({
  event,
  running,
  isLast,
  isInvoice,
}: {
  event: MoneyEvent
  /** The running 剩余 AFTER this installment (from ledgerForLine). */
  running: number
  isLast: boolean
  isInvoice: boolean
}) {
  const store = useMockStore()
  return (
    <li className="flex items-baseline justify-between gap-3 py-1">
      <span className="mono shrink-0 text-[13px] tabular-nums text-[var(--color-ink-2)]">
        {monthLabel(event.date)} · {formatCny(event.amountCny)}
      </span>
      <span className="flex items-baseline gap-2">
        {/* Per-installment running 剩余 — the joy-trigger. Reads cleanly down
            the column; 撤销 sits AFTER it on the last row only. */}
        <span className="mono text-[12px] tabular-nums text-[var(--color-ink-3)]">
          {isInvoice ? '剩余待开票' : '剩余未收'} {formatCny(running)}
        </span>
        {isLast && (
          <button
            type="button"
            onClick={() => store.voidLastEvent(event.poLineId)}
            className="rounded-[2px] px-1 text-[11px] text-[var(--color-ink-4)] transition-colors hover:text-[var(--color-overdue)]"
          >
            撤销
          </button>
        )}
      </span>
    </li>
  )
}

// ── ADD INSTALLMENT — morphs in place into amount + DatePop ────────────
function AddInstallment({
  line,
  kind,
  ceiling,
  autoEdit = false,
  onClose,
}: {
  line: PoLine
  kind: EventKind
  ceiling: number
  /** Mount already in the editing state (the summary-row quick-append). */
  autoEdit?: boolean
  /** Called when the composer commits or cancels (lets a host strip dismiss). */
  onClose?: () => void
}) {
  const store = useMockStore()
  const [editing, setEditing] = useState(autoEdit)
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const isInvoice = kind === 'invoice'
  const label = isInvoice ? '开票' : '收款'

  // The placeholder is the current ceiling (余 ¥…), NEVER pre-filled — she
  // reads the cap, types the actual amount.
  const placeholder = ceiling > 0 ? `余 ${formatCny(ceiling)}` : '金额'

  // Preview the assumed month BEFORE commit: once an amount is typed but no
  // date picked, show '{月} (今天)' faint where '月份' would sit — making the
  // Enter-commits-today default visible. The amount itself is never pre-filled.
  const amountFilled = Number(amount.trim()) > 0
  const datePlaceholder = amountFilled && !date ? `${monthLabel(TODAY)} (今天)` : '月份'

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const reset = () => {
    setEditing(false)
    setAmount('')
    setDate('')
    onClose?.()
  }

  const commit = () => {
    const n = Number(amount.trim())
    if (!Number.isFinite(n) || n <= 0) return
    // Default the date to today if she Enters without touching the picker —
    // the most common case is "I'm logging it today".
    const iso = date || TODAY
    store.addEvent(line.id, kind, n, iso)
    reset()
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="mt-1.5 rounded-[2px] px-1 -mx-1 py-0.5 text-[12px] text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink)]"
      >
        + {label}
      </button>
    )
  }

  return (
    <div className="mt-1.5 flex items-center gap-2">
      <input
        ref={inputRef}
        type="number"
        inputMode="decimal"
        min={0}
        step={1}
        value={amount}
        placeholder={placeholder}
        onChange={(e) => setAmount(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            reset()
          }
        }}
        className={`${baseInputClass} mono flex-1 text-right text-[13px] tabular-nums placeholder:text-[var(--color-ink-4)]`}
      />
      <DatePop
        value={date}
        onChange={setDate}
        allowFuture={isInvoice}
        formatLabel={monthLabel}
        placeholder={datePlaceholder}
        hideIcon
        className="shrink-0"
      />
      <button
        type="button"
        onClick={commit}
        aria-label={`保存${label}`}
        className="shrink-0 rounded-[2px] px-1.5 py-0.5 text-[13px] text-[var(--color-ink-2)] transition-colors hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink)]"
      >
        ↵
      </button>
      <button
        type="button"
        onClick={reset}
        aria-label="取消"
        className="shrink-0 rounded-[2px] px-1 py-0.5 text-[13px] leading-none text-[var(--color-ink-4)] transition-colors hover:text-[var(--color-ink-2)]"
      >
        ✕
      </button>
    </div>
  )
}

// ── caret glyph ───────────────────────────────────────────────────────
function Caret({ open, small = false }: { open: boolean; small?: boolean }) {
  const sz = small ? 10 : 12
  return (
    <svg
      width={sz}
      height={sz}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={`shrink-0 text-[var(--color-ink-4)] transition-transform duration-150 ${
        open ? 'rotate-90' : ''
      }`}
    >
      <path
        d="M4 2.5 L8 6 L4 9.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
