'use client'

// 分期账 (Fēnqī Zhàng) — Customers → Orders → PO lines → Append-in-Place.
//
// The single 生产编号 queue, now FOLDED INTO CUSTOMER GROUPS. The body is a list
// of customer headers (dozens), each collapsed by default; tap one to burn it
// down — its orders expand in place, each order is the round-1 row (BOTH
// remainders side-by-side, drills into PO lines), and the ONLY write is the
// inline append-row that grows a line's ledger by exactly one event while 剩余
// falls out gray and un-typeable.
//
// Two things make scale unmistakable: (1) COLLAPSE-BY-DEFAULT — the rendered
// list is customer headers, never hundreds of order rows; (2) the customer-group
// list is WINDOWED with @tanstack/react-virtual (the master board's idiom) with
// dynamic measureElement so an expanded group sizes correctly, and a scale line
// near the lenses states the dataset out loud ("238 单 · 60 客户").
//
// Nothing here recomputes a 余额. Every number derives from _derive over the
// shared store, so a single store.addEvent re-renders the ledger row, both
// remainders, the order rollups, the customer-header sums, the top-strip totals
// and the 对账 panel in one pass. The composer is the whole product — an in-place
// editable row appended to the BOTTOM of a line's ledger; Enter / ✓ commits,
// Escape / ✕ discards with no write.

import {
  useMemo,
  useState,
  useRef,
  useEffect,
  type KeyboardEvent,
} from 'react'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { formatCny } from '@/lib/data'
import { DatePop } from '@/app/_datepop'
import { showToast } from '@/app/_toast'
import { useMockStore } from './_store'
import {
  buildOrders,
  buildCustomers,
  sortByAnxiety,
  ledgerForLine,
  lineWaitInvoice,
  lineUnpaid,
  lineInvoiced,
  linePaid,
  matchesQuery,
  monthLabel,
  STATUS_TEXT,
  STATUS_WEIGHT,
  type OrderVM,
  type CustomerVM,
  type MoneyStatus,
} from './_derive'
import {
  TODAY,
  DATASET_STATS,
  type PoLine,
  type EventKind,
  type MoneyEvent,
} from './_mock'

// Lenses, not categories. 全部 last so the anxious ones lead.
type Lens = 'await_invoice' | 'collecting' | 'all' | 'settled'
const LENSES: { key: Lens; label: string }[] = [
  { key: 'await_invoice', label: '待开票' },
  { key: 'collecting', label: '收款中' },
  { key: 'all', label: '全部' },
  { key: 'settled', label: '已结清' },
]

// Status = colored TEXT, never a filled pill. 逾期 floats to the top in red,
// 已结清 fades to ink-3.
const STATUS_COLOR: Record<MoneyStatus, string> = {
  overdue: 'text-[var(--color-overdue)] font-medium',
  await_invoice: 'text-[var(--color-info)]',
  collecting: 'text-[var(--color-warning)]',
  settled: 'text-[var(--color-ink-3)]',
}

// Does this order survive the active lens? 全部 keeps everything; the others
// keep an order whose most-anxious status matches (逾期 always rides along with
// 待开票 + 收款中 because an overdue order still owes invoice/收款 attention).
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

// A customer group as the body renders it: the customer name, the subset of its
// orders that survive the active lens + search, and the WHOLE-customer balance.
//
// The two header 余额 numbers are LENS-INDEPENDENT — they come from the same
// buildCustomers rollup the 对账 panel uses, so the header number ALWAYS equals
// the 对账 number (one balance per customer; the lens only decides which
// customers/orders are SHOWN, never the totals). Lens-scoped magnitude lives in
// the scale-line counts instead.
interface GroupVM {
  customer: string
  orders: OrderVM[] // lens + search filtered, anxiety-sorted
  waitInvoice: number // whole-customer 待开票余额 (== 对账)
  unpaid: number // whole-customer 未收余额 (== 对账)
  status: MoneyStatus // most-anxious status among visible orders (group sort key)
  // Quantitative red token: how many visible orders are aging, and how old the
  // oldest is. A small VARYING number on a minority of headers — not a red wall.
  overdueOrderCount: number
  maxOverdueDays: number
  // Work-remaining on the 待开票 / 收款中 lenses: visible orders still owing an
  // invoice (so '4 单 · 3 待开' reads as "4 here, 3 still to bill").
  awaitInvoiceVisibleCount: number
  recon: CustomerVM | null // whole-customer rollup for the 对账 panel
}

// The shared inline-edit field vocabulary, adapted for a right-aligned mono
// amount. Transparent at rest; underline on focus — reads like every other
// editable cell in the app.
const baseInputClass =
  'block w-full bg-transparent border-0 outline-none rounded-[2px] px-1 -mx-1 py-0.5 transition-[background-color,box-shadow] duration-150 hover:bg-[var(--color-active-bg)] hover:shadow-[inset_0_-1px_0_var(--color-border-strong)] focus:bg-[var(--color-active-bg)] focus:shadow-[inset_0_-1px_0_var(--color-ink)]'

// Render the first MAX_GROUPS groups directly; windowing handles the rest. The
// virtualizer keeps the DOM tiny regardless, but the cap is a second floor: even
// if measurement ever misbehaves, the page can never try to paint thousands of
// headers at once.
const SOFT_GROUP_CAP = 400

export default function FenqiDesign() {
  const store = useMockStore()
  const [lens, setLens] = useState<Lens>('await_invoice')
  const [query, setQuery] = useState('')
  // 对账 door: the customer whose four-number reconciliation panel is open. The
  // panel renders INLINE beneath that customer's header (push-down, same idiom
  // as the order expansion), so the answer lands where her finger already is —
  // never off-screen in the top strip. Lens-INDEPENDENT (FULL balance).
  const [reconCustomer, setReconCustomer] = useState<string | null>(null)
  // Which customer GROUPS are expanded. Empty by default == every group
  // collapsed: the scale floor. The eye sees customers, opens one, burns it down.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  // Which ORDERS are open inside an expanded group. Multi-line orders default
  // expanded so a folded PO line is never missed; seeded once, then she's in
  // control. (Preserves round-1 behavior verbatim.)
  const [openOrders, setOpenOrders] = useState<Record<string, boolean>>(() => {
    const seed: Record<string, boolean> = {}
    for (const job of store.jobs) {
      const n = store.lines.filter((l) => l.jobId === job.id).length
      if (n > 1) seed[job.id] = true
    }
    return seed
  })

  // One truth: derive every order from the store, sort by anxiety.
  const orders = useMemo(
    () => sortByAnxiety(buildOrders(store.jobs, store.lines, store.events)),
    [store.jobs, store.lines, store.events],
  )

  // Per-customer reconciliation, derived from the same orders. The 对账 panel
  // reads its four numbers straight from here — never a local sum, and never
  // narrowed by the lens.
  const customers = useMemo(() => buildCustomers(orders), [orders])
  const customerByName = useMemo(() => {
    const m = new Map<string, CustomerVM>()
    for (const c of customers) m.set(c.customer, c)
    return m
  }, [customers])

  // Orders that survive search (counts are over the search-narrowed set so a
  // lens count never lies about what tapping it will show).
  const searched = useMemo(
    () => orders.filter((o) => matchesQuery(o, query)),
    [orders, query],
  )

  const counts = useMemo(() => {
    const c: Record<Lens, number> = {
      await_invoice: 0,
      collecting: 0,
      all: 0,
      settled: 0,
    }
    for (const o of searched) {
      c.all += 1
      if (passesLens(o, 'await_invoice')) c.await_invoice += 1
      if (passesLens(o, 'collecting')) c.collecting += 1
      if (passesLens(o, 'settled')) c.settled += 1
    }
    return c
  }, [searched])

  // Orders shown under the active lens (drives every header sum + the top strip).
  const visible = useMemo(
    () => searched.filter((o) => passesLens(o, lens)),
    [searched, lens],
  )

  // GROUP the visible orders by customer, sort orders within a group by anxiety,
  // and sort the groups by their most-anxious visible order (then larger 未收余额,
  // then 待开票余额). Header 余额 are the WHOLE-customer rollup (== 对账), not a sum
  // over the lens-filtered orders. Drop customers with zero visible orders.
  const groups = useMemo<GroupVM[]>(() => {
    const byName = new Map<string, OrderVM[]>()
    for (const o of visible) {
      const arr = byName.get(o.job.customer)
      if (arr) arr.push(o)
      else byName.set(o.job.customer, [o])
    }
    const out: GroupVM[] = []
    for (const [customer, custOrders] of byName) {
      const sorted = sortByAnxiety(custOrders)
      const cust = customerByName.get(customer) ?? null
      let weight = STATUS_WEIGHT.settled
      let overdueOrderCount = 0
      let maxOverdueDays = 0
      let awaitInvoiceVisibleCount = 0
      for (const o of sorted) {
        if (STATUS_WEIGHT[o.status] < weight) weight = STATUS_WEIGHT[o.status]
        if (o.overdueDays > 0) {
          overdueOrderCount += 1
          if (o.overdueDays > maxOverdueDays) maxOverdueDays = o.overdueDays
        }
        if (o.rollup.waitInvoice > 0) awaitInvoiceVisibleCount += 1
      }
      const status = (Object.keys(STATUS_WEIGHT) as MoneyStatus[]).find(
        (k) => STATUS_WEIGHT[k] === weight,
      ) as MoneyStatus
      out.push({
        customer,
        orders: sorted,
        // Lens-INDEPENDENT whole-customer balance (== 对账). Falls back to the
        // visible sum only in the impossible case of a missing rollup.
        waitInvoice: cust?.rollup.waitInvoice ?? 0,
        unpaid: cust?.rollup.unpaid ?? 0,
        status,
        overdueOrderCount,
        maxOverdueDays,
        awaitInvoiceVisibleCount,
        recon: cust,
      })
    }
    return out.sort((a, b) => {
      const w = STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status]
      if (w !== 0) return w
      if (b.unpaid !== a.unpaid) return b.unpaid - a.unpaid
      return b.waitInvoice - a.waitInvoice
    })
  }, [visible, customerByName])

  // Soft cap on the rendered group count — windowing already keeps the DOM
  // small, but this guarantees the work the virtualizer does stays bounded.
  const cappedGroups = useMemo(
    () => (groups.length > SOFT_GROUP_CAP ? groups.slice(0, SOFT_GROUP_CAP) : groups),
    [groups],
  )
  const hiddenGroupCount = groups.length - cappedGroups.length

  // Top-strip totals — Σ of the whole-customer header values over the currently
  // visible customers (each counted ONCE). Consistent with the headers below:
  // both are whole-customer balances, so the strip == Σ headers, always.
  const totals = useMemo(() => {
    let waitInvoice = 0
    let unpaid = 0
    for (const g of groups) {
      waitInvoice += g.waitInvoice
      unpaid += g.unpaid
    }
    return { waitInvoice, unpaid }
  }, [groups])

  // Lens-filtered scale line: how many customers the active lens holds (over the
  // search-narrowed set). Sits beside the dataset headline.
  const lensCustomerCount = groups.length

  // When search narrows to exactly one customer, auto-expand that group so she
  // jumps straight into it — the search box is a teleporter, not just a filter.
  const soloCustomer = useMemo(() => {
    if (!query.trim()) return null
    return groups.length === 1 ? groups[0].customer : null
  }, [groups, query])

  useEffect(() => {
    if (soloCustomer) {
      setOpenGroups((prev) =>
        prev[soloCustomer] ? prev : { ...prev, [soloCustomer]: true },
      )
    }
  }, [soloCustomer])

  const toggleGroup = (customer: string) =>
    setOpenGroups((prev) => ({ ...prev, [customer]: !prev[customer] }))
  const toggleOrder = (jobId: string) =>
    setOpenOrders((prev) => ({ ...prev, [jobId]: !prev[jobId] }))

  const openRecon = (customer: string) =>
    setReconCustomer((cur) => (cur === customer ? null : customer))

  // Are all currently-visible (capped) groups already expanded? Drives the
  // 展开全部 / 收起全部 escape hatch — grind the burn without tapping each header.
  const allVisibleExpanded =
    cappedGroups.length > 0 &&
    cappedGroups.every((g) => openGroups[g.customer])
  const toggleAllGroups = () =>
    setOpenGroups((prev) => {
      const next = { ...prev }
      const collapse = allVisibleExpanded
      for (const g of cappedGroups) next[g.customer] = !collapse
      return next
    })

  const copyBalance = (c: CustomerVM) => {
    const summary = [
      `${c.customer} 对账`,
      `已开票 ${formatCny(c.rollup.invoiced)}`,
      `已收款 ${formatCny(c.rollup.paid)}`,
      `待开票余额 ${formatCny(c.rollup.waitInvoice)}`,
      `未收余额 ${formatCny(c.rollup.unpaid)}`,
    ].join('\n')
    void navigator.clipboard?.writeText(summary)
    showToast('已复制', 'success')
  }

  // --- WINDOWING — the customer-group list is virtualized over the window
  // scroll, the master board's exact idiom. measureElement gives every group its
  // real height, so a collapsed header (~52px) and an expanded group (tall)
  // coexist without layout drift. Collapse-by-default is the floor; this is the
  // enhancement that makes thousand-scale scroll smooth. ---
  const listRef = useRef<HTMLDivElement>(null)
  const [listOffsetTop, setListOffsetTop] = useState(0)
  useEffect(() => {
    const el = listRef.current
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
  }, [cappedGroups.length])

  const groupVirtualizer = useWindowVirtualizer<HTMLDivElement>({
    count: cappedGroups.length,
    // Collapsed header ≈ 52px; measureElement corrects expanded groups instantly.
    estimateSize: () => 52,
    getItemKey: (index) => cappedGroups[index]?.customer ?? index,
    overscan: 8,
    scrollMargin: listOffsetTop,
  })
  const virtualItems = groupVirtualizer.getVirtualItems()
  const topSpacer =
    virtualItems.length > 0
      ? Math.max(0, virtualItems[0].start - listOffsetTop)
      : 0
  const bottomSpacer =
    virtualItems.length > 0
      ? Math.max(
          0,
          groupVirtualizer.getTotalSize() -
            (virtualItems[virtualItems.length - 1].end - listOffsetTop),
        )
      : 0

  return (
    <div className="px-6 py-8">
      <div className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        {/* TOP STRIP — two big ambient roll-ups only. Whole-customer balances
            summed over the visible customers; consistent with every header
            below. Not inputs. The 对账 panel now opens INLINE under its header. */}
        <div className="px-6 pt-6 pb-5 border-b border-[var(--color-border)]">
          <div className="flex flex-wrap items-end gap-x-12 gap-y-4">
            <RollupNumber
              label="待开票余额"
              value={totals.waitInvoice}
              tone="info"
            />
            <RollupNumber label="未收余额" value={totals.unpaid} tone="ink" />
          </div>
        </div>

        {/* TOOLBAR — underline-active lens toggles left, search + quiet export
            right. The SCALE LINE sits under the lenses, always visible. */}
        <div className="px-6 py-4 border-b border-[var(--color-border)]">
          <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
            <div
              role="tablist"
              aria-label="筛选"
              className="flex items-baseline gap-x-6"
            >
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

            <div className="ml-auto flex items-center gap-4">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索跳转 · 客户 / 工号 / 订单号 / 商务"
                className="w-[260px] bg-transparent border-0 border-b border-[var(--color-border)] outline-none rounded-none px-0.5 py-1 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] transition-colors focus:border-[var(--color-ink)]"
              />
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-[13px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors whitespace-nowrap"
              >
                导出 Excel
                <span aria-hidden className="text-[14px] leading-none">
                  ↓
                </span>
              </button>
            </div>
          </div>

          {/* SCALE LINE — the dataset said out loud. Dataset headline (always),
              then the active lens's slice (orders · customers). Makes it
              unmistakable the tool holds hundreds of orders across dozens of
              customers and stays calm. The 展开/收起全部 toggle is the burn-down
              escape hatch. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
            <span className="mono tabular-nums text-[var(--color-ink-3)]">
              {DATASET_STATS.orders} 单 · {DATASET_STATS.customers} 客户
            </span>
            <span className="text-[var(--color-ink-4)]">·</span>
            <span className="text-[var(--color-ink-3)]">
              {LENSES.find((l) => l.key === lens)?.label}
            </span>
            <span className="mono tabular-nums text-[var(--color-ink-2)]">
              {counts[lens]} 单 · {lensCustomerCount} 客户
            </span>
            {cappedGroups.length > 0 && (
              <button
                type="button"
                onClick={toggleAllGroups}
                className="ml-3 rounded-[2px] px-1.5 py-0.5 text-[12px] text-[var(--color-ink-3)] hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink)] transition-colors"
              >
                {allVisibleExpanded ? '收起全部' : '展开全部'}
              </button>
            )}
          </div>
        </div>

        {/* COLUMN HEADERS — the two remainder columns are fixed and never
            collapse, so the numbers always sit under a header. */}
        <div className="flex items-center px-6 py-2 border-b border-[var(--color-border)]">
          <div className="flex-1 min-w-0">
            <span className="label">客户 · 订单</span>
          </div>
          <div className="w-[160px] shrink-0 pr-2 text-right">
            <span className="label">待开票余额</span>
          </div>
          <div className="w-[160px] shrink-0 pr-2 text-right">
            <span className="label">未收余额</span>
          </div>
          <div className="w-8 shrink-0" aria-hidden />
        </div>

        {/* THE CUSTOMER-GROUP QUEUE — windowed. Each item is one collapsed
            customer header that expands its orders in place. */}
        <div ref={listRef}>
          {topSpacer > 0 && <div style={{ height: topSpacer }} aria-hidden />}
          {virtualItems.map((vItem) => {
            const group = cappedGroups[vItem.index]
            if (!group) return null
            return (
              <CustomerGroup
                key={group.customer}
                group={group}
                measureRef={groupVirtualizer.measureElement}
                virtualIndex={vItem.index}
                expanded={!!openGroups[group.customer]}
                onToggle={() => toggleGroup(group.customer)}
                reconOpen={reconCustomer === group.customer}
                onToggleRecon={() => openRecon(group.customer)}
                onCloseRecon={() => setReconCustomer(null)}
                onCopyBalance={copyBalance}
                workLens={lens === 'await_invoice' || lens === 'collecting'}
                openOrders={openOrders}
                onToggleOrder={toggleOrder}
              />
            )
          })}
          {bottomSpacer > 0 && (
            <div style={{ height: bottomSpacer }} aria-hidden />
          )}

          {/* Capped-overflow line — windowing keeps the DOM tiny, but if the
              filtered set ever exceeds the soft cap, point her at search. */}
          {hiddenGroupCount > 0 && (
            <div className="border-t border-[var(--color-border)] px-6 py-4 text-[12px] text-[var(--color-ink-3)]">
              + {hiddenGroupCount} 更多客户 · 搜索跳转
            </div>
          )}

          {groups.length === 0 && (
            <div className="py-20 text-center text-[13px] text-[var(--color-ink-3)]">
              {lens === 'await_invoice'
                ? '待开票已清空 · 按时开票'
                : '没有匹配的客户'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// --- top strip pieces ---

function RollupNumber({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'info' | 'ink'
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] tracking-[0.14em] uppercase text-[var(--color-ink-4)]">
        {label}
      </span>
      <span
        className={`mono tabular-nums text-[30px] leading-none ${
          tone === 'info' ? 'text-[var(--color-info)]' : 'text-[var(--color-ink)]'
        }`}
      >
        {formatCny(value)}
      </span>
    </div>
  )
}

function ReconCell({
  label,
  value,
  tone = 'ink-2',
}: {
  label: string
  value: number
  tone?: 'info' | 'ink' | 'ink-2'
}) {
  const color =
    tone === 'info'
      ? 'text-[var(--color-info)]'
      : tone === 'ink'
        ? 'text-[var(--color-ink)]'
        : 'text-[var(--color-ink-2)]'
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[11px] text-[var(--color-ink-3)]">{label}</span>
      <span className={`mono tabular-nums text-[13px] ${color}`}>
        {formatCny(value)}
      </span>
    </div>
  )
}

// A derived remainder of exactly 0 is NOISE — it fights the one live number on
// the screen. So a 0 remainder renders a muted em-dash, never "¥0"; the eye only
// ever lands on live money. `live` is the className for a real (non-zero) amount;
// the dash always falls to ink-4. `size` is the shared font-size class so the
// dash and the amount line up.
function Remainder({
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

// --- CUSTOMER GROUP (~52px header) → expands its orders in place ---
//
// The new top-level row. A touch heavier than an order row so the hierarchy
// reads: caret, customer name (15px), a faint mono "N 单" count (+ 待开 remaining
// on the work lenses), a SCARCE quantitative red 逾期 token (逾期 N单 · oldest
// days) only when this customer is actually aging, and the two WHOLE-customer
// remainders under the same fixed columns. The 对账 button toggles an INLINE
// panel beneath the header (push-down). Expanding renders the customer's visible
// orders, each the round-1 OrderRow (which drills into PO lines → ledger +
// composer).
//
// measureRef + virtualIndex wire this group into the window virtualizer so its
// real height (collapsed, recon-open, OR fully expanded) is measured.

function CustomerGroup({
  group,
  measureRef,
  virtualIndex,
  expanded,
  onToggle,
  reconOpen,
  onToggleRecon,
  onCloseRecon,
  onCopyBalance,
  workLens,
  openOrders,
  onToggleOrder,
}: {
  group: GroupVM
  measureRef: (node: HTMLDivElement | null) => void
  virtualIndex: number
  expanded: boolean
  onToggle: () => void
  reconOpen: boolean
  onToggleRecon: () => void
  onCloseRecon: () => void
  onCopyBalance: (c: CustomerVM) => void
  workLens: boolean
  openOrders: Record<string, boolean>
  onToggleOrder: (jobId: string) => void
}) {
  // Work-remaining suffix only on the work lenses (待开票 / 收款中) and only when
  // this customer actually has orders still owing an invoice. Plain 'N 单' on
  // 全部 / 已结清.
  const showAwaitSuffix = workLens && group.awaitInvoiceVisibleCount > 0
  return (
    <div
      ref={measureRef}
      data-index={virtualIndex}
      className="border-t border-[var(--color-border)] first:border-t-0"
    >
      {/* HEADER ROW — visually heavier than an order row. The caret + name
          toggle the group; the 对账 button toggles the inline panel below. */}
      <div
        className={`flex w-full items-center px-6 min-h-[52px] py-2 text-left transition-colors hover:bg-[#faf8f2] ${
          reconOpen ? 'bg-[#faf8f2]' : ''
        }`}
      >
        {/* caret + identity */}
        <div className="flex flex-1 min-w-0 items-center gap-2 pr-4">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={expanded ? '收起客户' : '展开客户'}
            className="inline-flex h-6 w-5 shrink-0 items-center justify-center text-[13px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
          >
            {expanded ? '⌄' : '›'}
          </button>
          <button
            type="button"
            onClick={onToggle}
            className="min-w-0 text-left"
          >
            <span className="flex items-baseline gap-2">
              <span className="text-[15px] font-medium text-[var(--color-ink)] truncate">
                {group.customer}
              </span>
              {/* count — plain 'N 单', + work-remaining '· M 待开' on the work
                  lenses so the header says how much is left to bill. */}
              <span className="mono text-[11px] tabular-nums text-[var(--color-ink-4)] shrink-0">
                {group.orders.length} 单
                {showAwaitSuffix ? ` · ${group.awaitInvoiceVisibleCount} 待开` : ''}
              </span>
              {/* QUANTITATIVE red token — only when this customer is actually
                  aging. A small VARYING number (逾期 N单 · oldest 天), so the band
                  self-ranks instead of becoming a red wall. */}
              {group.overdueOrderCount > 0 ? (
                <span className="text-[11px] tracking-wide shrink-0 text-[var(--color-overdue)] font-medium">
                  逾期 {group.overdueOrderCount}单 · {group.maxOverdueDays}天
                </span>
              ) : (
                // Non-overdue status word keeps its own info/warning color; drop
                // it for fully-settled customers (no nag needed).
                group.status !== 'settled' && (
                  <span
                    className={`text-[11px] tracking-wide shrink-0 ${STATUS_COLOR[group.status]}`}
                  >
                    {STATUS_TEXT[group.status]}
                  </span>
                )
              )}
            </span>
          </button>
          {/* 对账 — the phone-reconciliation door. Toggles the inline panel. */}
          <button
            type="button"
            onClick={onToggleRecon}
            aria-pressed={reconOpen}
            title="对账 · 全部订单余额"
            className={`shrink-0 rounded-[2px] px-2 py-0.5 text-[12px] transition-colors ${
              reconOpen
                ? 'text-[var(--color-info)] bg-[var(--color-active-bg)]'
                : 'text-[var(--color-ink-3)] hover:bg-[var(--color-active-bg)] hover:text-[var(--color-info)]'
            }`}
          >
            对账
          </button>
        </div>

        {/* 待开票余额 — whole-customer balance (== 对账), under the fixed column.
            0 → muted "—" so the eye only lands on live money. */}
        <div className="w-[160px] shrink-0 pr-2 text-right border-l border-[var(--color-border)] pl-3">
          <Remainder value={group.waitInvoice} live="text-[var(--color-ink)]" />
        </div>

        {/* 未收余额 — whole-customer balance (== 对账). Normal ink: the red signal
            lives in the scarce 逾期 token, not as a column-wide red wall. */}
        <div className="w-[160px] shrink-0 pr-2 text-right border-l border-[var(--color-border)] pl-3">
          <Remainder value={group.unpaid} live="text-[var(--color-ink)]" />
        </div>

        <div className="w-8 shrink-0" aria-hidden />
      </div>

      {/* 对账 PANEL — INLINE beneath this header (push-down, same idiom as the
          order expansion). Four lens-INDEPENDENT whole-customer numbers from
          buildCustomers, tagged 全部订单, with one-tap 复制余额. Lands where her
          finger already is, and folds away with the customer. */}
      {reconOpen && group.recon && (
        <div className="bg-[var(--color-bg)] border-t border-[var(--color-border)] px-6 py-3">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
            <span className="text-[11px] tracking-[0.14em] uppercase text-[var(--color-ink-4)]">
              对账
            </span>
            <span className="rounded-[2px] bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] tracking-wide text-[var(--color-ink-3)] border border-[var(--color-border)]">
              全部订单
            </span>
            <ReconCell label="已开票" value={group.recon.rollup.invoiced} />
            <ReconCell label="已收款" value={group.recon.rollup.paid} />
            <ReconCell
              label="待开票余额"
              value={group.recon.rollup.waitInvoice}
              tone="info"
            />
            <ReconCell
              label="未收余额"
              value={group.recon.rollup.unpaid}
              tone="ink"
            />
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => group.recon && onCopyBalance(group.recon)}
                className="inline-flex items-center gap-1.5 rounded-[2px] px-2 py-0.5 text-[12px] text-[var(--color-ink-3)] hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink)] transition-colors whitespace-nowrap"
              >
                <span aria-hidden className="text-[12px] leading-none">
                  ⧉
                </span>
                复制余额
              </button>
              <button
                type="button"
                onClick={onCloseRecon}
                aria-label="关闭对账"
                title="关闭对账"
                className="rounded-[2px] px-1.5 py-0.5 text-[13px] text-[var(--color-ink-4)] hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink-2)] transition-colors"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      )}

      {/* EXPANDED — the customer's visible orders, each the round-1 OrderRow.
          All per-order / per-line / composer behavior is preserved verbatim. */}
      {expanded && (
        <div className="bg-[var(--color-bg)] border-t border-[var(--color-border)]">
          {group.orders.map((o) => (
            <OrderRow
              key={o.job.id}
              order={o}
              expanded={!!openOrders[o.job.id]}
              onToggle={() => onToggleOrder(o.job.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// --- collapsed order row (~48px) → expands in place ---
//
// PRESERVED VERBATIM from round 1, save for two things now owned by the group:
// the customer name is no longer a 对账 door here (the group header is), and the
// row carries a faint mono customer label in the meta line for orientation when
// scrolling a long expanded group. Everything else — both remainders, the PO
// accordion, the single-line inline action + composer — is untouched.

function OrderRow({
  order,
  expanded,
  onToggle,
}: {
  order: OrderVM
  expanded: boolean
  onToggle: () => void
}) {
  const { job, lines, rollup, status, overdueDays } = order
  const multi = lines.length > 1
  const singleLine = lines[0]

  // A single-line order has no accordion. Its one ghost action + composer live
  // inline on / beneath this row. We track whether the inline composer is open
  // and which kind it's appending.
  const [composing, setComposing] = useState<EventKind | null>(null)

  return (
    <div className="border-t border-[var(--color-border)] first:border-t-0">
      {/* Header. Identity (left) is NEVER editable. The caret toggles PO
          sub-rows for multi-line orders. */}
      <div className="flex w-full items-center px-6 min-h-[48px] py-2 text-left transition-colors hover:bg-[#faf8f2]">
        {/* Sticky-left identity */}
        <div className="flex-1 min-w-0 pr-4 pl-6">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] text-[var(--color-ink)] truncate">
              {job.product}
            </span>
            <span
              className={`text-[11px] tracking-wide shrink-0 ${STATUS_COLOR[status]}`}
            >
              {STATUS_TEXT[status]}
              {status === 'overdue' && overdueDays > 0 ? ` ${overdueDays}天` : ''}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="mono text-[11px] text-[var(--color-ink-3)] truncate">
              {job.id} · {job.salesperson}
            </span>
            {multi && (
              <span className="mono text-[11px] text-[var(--color-ink-4)] shrink-0">
                {lines.length} 订单号
              </span>
            )}
            {/* Single-line order: the one applicable ghost action sits inline
                here (no accordion), so a one-line order is a one-tap append.
                Hidden while the composer is open (it lands below). */}
            {!multi && singleLine && !composing && (
              <InlineLineAction
                line={singleLine}
                onCompose={(k) => setComposing(k)}
              />
            )}
          </div>
        </div>

        {/* 待开票余额 — faint left hairline signals 'formula, not field'.
            0 → muted "—". */}
        <div className="w-[160px] shrink-0 pr-2 text-right border-l border-[var(--color-border)] pl-3">
          <Remainder value={rollup.waitInvoice} live="text-[var(--color-ink)]" />
        </div>

        {/* 未收余额 — overdue-red font-medium when this order is aging; 0 → "—". */}
        <div className="w-[160px] shrink-0 pr-2 text-right border-l border-[var(--color-border)] pl-3">
          <Remainder
            value={rollup.unpaid}
            live={
              overdueDays > 0
                ? 'text-[var(--color-overdue)] font-medium'
                : 'text-[var(--color-ink)]'
            }
          />
        </div>

        {/* Disclosure caret — bare chevron, IDENTICAL to the customer caret (same
            size, color, no box). Only multi-line orders accordion; single-line
            orders append inline above, so no caret. */}
        <div className="w-8 shrink-0 flex justify-center">
          {multi ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              aria-label={expanded ? '收起订单号' : '展开订单号'}
              className="inline-flex h-6 w-5 shrink-0 items-center justify-center text-[13px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
            >
              {expanded ? '⌄' : '›'}
            </button>
          ) : null}
        </div>
      </div>

      {/* MULTI-LINE — PO lines as indented sub-rows. Accordion in place, never a
          modal or a route hop. Reserved strictly for multi-line orders. */}
      {multi && expanded && (
        <div className="bg-[var(--color-surface)] border-t border-[var(--color-border)]">
          {lines.map((line) => (
            <LineBlock key={line.id} line={line} indented />
          ))}
        </div>
      )}

      {/* SINGLE-LINE — the composer (and the line's ledger for context) appends
          in place beneath the row when she taps the inline action. No accordion
          caret, no PO sub-row chrome. */}
      {!multi && singleLine && composing && (
        <div className="bg-[var(--color-surface)] border-t border-[var(--color-border)]">
          <LineBlock
            line={singleLine}
            indented={false}
            composeKind={composing}
            onComposeChange={setComposing}
          />
        </div>
      )}
    </div>
  )
}

// The single applicable ghost action for a line. Renders 开票 when
// 待开票余额 > 0; else 收款 when there is invoiced-but-unpaid; if both are live,
// the primary shows inline and the other tucks behind a quiet secondary.
// Returns null when nothing is live — absence is the cleanest disabled state.
function lineActions(line: PoLine, events: MoneyEvent[]) {
  const wait = lineWaitInvoice(line, events)
  const owed = lineInvoiced(events, line.id) - linePaid(events, line.id)
  const canInvoice = wait > 0
  const canPay = owed > 0
  // Primary = the more anxious open obligation. 开票 leads (you can't collect
  // what you haven't billed), 收款 only when nothing is left to bill.
  const primary: EventKind | null = canInvoice
    ? 'invoice'
    : canPay
      ? 'payment'
      : null
  const secondary: EventKind | null = canInvoice && canPay ? 'payment' : null
  return { primary, secondary, canInvoice, canPay }
}

function actionLabel(kind: EventKind): string {
  return kind === 'invoice' ? '+ 开票' : '+ 收款'
}

function InlineLineAction({
  line,
  onCompose,
}: {
  line: PoLine
  onCompose: (kind: EventKind) => void
}) {
  const store = useMockStore()
  const { primary, secondary } = lineActions(line, store.events)
  if (!primary) return null
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0">
      <GhostAction
        label={actionLabel(primary)}
        onClick={() => onCompose(primary)}
      />
      {secondary && (
        <GhostAction
          label={actionLabel(secondary)}
          quiet
          onClick={() => onCompose(secondary)}
        />
      )}
    </span>
  )
}

// --- per-line block: header · two remainders · one ghost action · ledger ---
//
// Shared by the multi-line accordion (indented sub-row) and the single-line
// inline tail. `composeKind` / `onComposeChange` let the parent OrderRow drive
// the composer for single-line orders (the action lives on the order row); when
// omitted the block owns its own composer state (multi-line accordion path).

function LineBlock({
  line,
  indented,
  composeKind,
  onComposeChange,
}: {
  line: PoLine
  indented: boolean
  composeKind?: EventKind | null
  onComposeChange?: (kind: EventKind | null) => void
}) {
  const store = useMockStore()
  // Local composer state for the multi-line accordion path. For single-line,
  // the parent drives it via composeKind/onComposeChange.
  const [localCompose, setLocalCompose] = useState<EventKind | null>(null)
  const controlled = onComposeChange !== undefined
  const composing = controlled ? composeKind ?? null : localCompose
  const setComposing = (k: EventKind | null) =>
    controlled ? onComposeChange!(k) : setLocalCompose(k)

  const wait = lineWaitInvoice(line, store.events)
  const unpaid = lineUnpaid(line, store.events)
  const ledger = ledgerForLine(line, store.events)

  const { primary, secondary } = lineActions(line, store.events)

  // Cap a long ledger into an internal scroll region (~8 rows visible). On
  // expand, orient her to the BOTTOM where the newest event (and her work) is.
  const scroll = ledger.length > 8
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (scroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    // Re-pin to bottom whenever the row count changes (append / void / mount).
  }, [scroll, ledger.length])

  return (
    <div
      className={`${
        indented ? 'pl-16' : 'pl-12'
      } pr-6 py-3 border-t border-[var(--color-border)] first:border-t-0`}
    >
      {/* Line header — read-only identity + the two line remainders. */}
      <div className="flex items-center">
        <div className="flex-1 min-w-0 pr-4">
          <div className="flex items-baseline gap-2">
            <span className="mono text-[12px] text-[var(--color-ink-2)]">
              {line.poNo}
            </span>
            {line.materialNo && (
              <span className="mono text-[11px] text-[var(--color-ink-4)]">
                {line.materialNo}
              </span>
            )}
            <span className="mono text-[11px] text-[var(--color-ink-3)]">
              订单额 {formatCny(line.poAmountCny)}
            </span>
          </div>
        </div>
        {/* One bold LIVE number + one muted "—" per line. The live obligation is
            the primary action's column: an un-invoiced line bolds 待开票余额, a
            fully-invoiced line bolds 未收余额. 0 always renders "—". */}
        <div className="w-[160px] shrink-0 pr-2 text-right border-l border-[var(--color-border)] pl-3">
          <Remainder
            value={wait}
            size="text-[12px]"
            live={
              primary === 'invoice'
                ? 'text-[var(--color-ink)] font-medium'
                : 'text-[var(--color-ink-3)]'
            }
          />
        </div>
        <div className="w-[160px] shrink-0 pr-2 text-right border-l border-[var(--color-border)] pl-3">
          <Remainder
            value={unpaid}
            size="text-[12px]"
            live={
              primary === 'payment'
                ? 'text-[var(--color-ink)] font-medium'
                : 'text-[var(--color-ink-3)]'
            }
          />
        </div>
        <div className="w-8 shrink-0" aria-hidden />
      </div>

      {/* Long-ledger orientation caption — newest is at the bottom. */}
      {scroll && (
        <div className="mt-2 -mb-1 pl-1 text-[11px] text-[var(--color-ink-4)]">
          {ledger.length} 笔 · 最新在底部
        </div>
      )}

      {/* Append-only ledger — immutable rows, newest at BOTTOM. */}
      {ledger.length > 0 && (
        <div
          ref={scrollRef}
          className={`mt-2 ${scroll ? 'max-h-[288px] overflow-y-auto' : ''}`}
        >
          {ledger.map((row) => (
            <LedgerLine
              key={row.event.id}
              monthLbl={monthLabel(row.event.date)}
              kind={row.event.kind}
              amount={row.event.amountCny}
              running={row.running}
              canVoid={row.isLast}
              onVoid={() => store.voidLastEvent(line.id)}
            />
          ))}
        </div>
      )}

      {/* The composer or the single ghost action. The composer is appended to
          the BOTTOM of the ledger so she watches where the event lands. */}
      {composing ? (
        <Composer
          line={line}
          kind={composing}
          ceiling={composing === 'invoice' ? wait : unpaid}
          onCommit={(amount, dateIso) => {
            store.addEvent(line.id, composing, amount, dateIso)
            setComposing(null)
          }}
          onCancel={() => setComposing(null)}
        />
      ) : (
        // ONE primary action per line; never a disabled button. For the
        // multi-line accordion path we render the action here; for single-line
        // it already lives on the order row (InlineLineAction), so only render
        // when there's a live action AND we own the composer (multi-line).
        !controlled &&
        primary && (
          // Tied to THIS line: sits immediately under the ledger events,
          // left-aligned with them (same pl-1 indent), small gap — reads as
          // "…and here's the next thing to add to this line." (A bit more air
          // when the line has no events yet, so it doesn't crowd the header.)
          <div
            className={`flex items-center gap-2 pl-1 ${
              ledger.length > 0 ? 'mt-0.5' : 'mt-2'
            }`}
          >
            <GhostAction
              label={actionLabel(primary)}
              onClick={() => setComposing(primary)}
            />
            {secondary && (
              <GhostAction
                label={actionLabel(secondary)}
                quiet
                onClick={() => setComposing(secondary)}
              />
            )}
          </div>
        )
      )}
    </div>
  )
}

// One immutable ledger line: month chip · type word (开票/收款 colored text) ·
// amount · running 剩余 AFTER the event, right-aligned UNDER its remainder
// column (invoice → 待开票余额, payment → 未收余额) so the last ledger value sits
// directly beneath the rollup it sums to. The column header names '剩余', so the
// word is dropped from every row. When the event zeroes its remainder, the
// running cell reads a success-colored completion word (开完 / 收清) instead of
// "¥0" — the milestone, not the noise.
function LedgerLine({
  monthLbl,
  kind,
  amount,
  running,
  canVoid,
  onVoid,
}: {
  monthLbl: string
  kind: EventKind
  amount: number
  running: number
  canVoid: boolean
  onVoid: () => void
}) {
  const isInvoice = kind === 'invoice'
  const done = running === 0
  const runningCell = done ? (
    <span className="text-[12px] text-[var(--color-success)]">
      {isInvoice ? '开完' : '收清'}
    </span>
  ) : (
    <span className="mono tabular-nums text-[12px] text-[var(--color-ink-2)]">
      {formatCny(running)}
    </span>
  )
  return (
    <div className="group/led flex items-center py-1 pl-1">
      {/* identity cluster mirrors the line header's flex-1 identity block */}
      <div className="flex flex-1 min-w-0 items-center gap-3 pr-4">
        {/* month chip */}
        <span className="mono text-[11px] tabular-nums text-[var(--color-ink-3)] w-9 shrink-0">
          {monthLbl}
        </span>
        {/* type word — full 开票 / 收款 as colored text, not a pill. */}
        <span
          className={`text-[11px] shrink-0 w-9 ${
            isInvoice
              ? 'text-[var(--color-info)]'
              : 'text-[var(--color-success)]'
          }`}
        >
          {isInvoice ? '开票' : '收款'}
        </span>
        {/* amount */}
        <span className="mono tabular-nums text-[12px] text-[var(--color-ink-2)] w-[112px] text-right">
          {formatCny(amount)}
        </span>
      </div>

      {/* running 剩余 AFTER this event, right-aligned UNDER the matching fixed
          remainder column. Invoice rows fall under 待开票余额; payment rows under
          未收余额. The other column stays empty so the eye tracks one ladder. A
          zeroing event shows 开完 / 收清 instead of ¥0. */}
      <div className="w-[160px] shrink-0 pr-2 text-right">
        {isInvoice && runningCell}
      </div>
      <div className="w-[160px] shrink-0 pr-2 text-right">
        {!isInvoice && runningCell}
      </div>

      {/* the only undo: a quiet hover ⌫ on the last row */}
      <span className="w-8 shrink-0 text-center">
        {canVoid && (
          <button
            type="button"
            onClick={onVoid}
            aria-label="撤销最近一笔"
            title="撤销最近一笔"
            className="text-[12px] text-[var(--color-ink-4)] opacity-0 group-hover/led:opacity-100 hover:text-[var(--color-overdue)] transition-opacity"
          >
            ⌫
          </button>
        )}
      </span>
    </div>
  )
}

function GhostAction({
  label,
  onClick,
  quiet,
}: {
  label: string
  onClick: () => void
  quiet?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[2px] px-2 py-0.5 text-[12px] transition-colors ${
        quiet
          ? 'text-[var(--color-ink-4)] hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink-2)]'
          : 'text-[var(--color-ink-3)] hover:bg-[var(--color-active-bg)] hover:text-[var(--color-info)]'
      }`}
    >
      {label}
    </button>
  )
}

// --- THE COMPOSER — the whole product ---
//
// An in-place editable row appended to the BOTTOM of the line's ledger. NOT a
// modal. There is NO customer / 订单号 / 剩余 field — identity is the row above.
// 收款 is byte-identical to 开票 but writes kind 'payment' and drops 未收余额.
//
// The composer NEVER commits an over-ceiling amount: she sees the bad number in
// red ('超出余额'), the ✓ greys out, and Enter is ignored — the write is blocked
// at the boundary, not the typing.
function Composer({
  line,
  kind,
  ceiling,
  onCommit,
  onCancel,
}: {
  line: PoLine
  kind: EventKind
  ceiling: number
  onCommit: (amount: number, dateIso: string) => void
  onCancel: () => void
}) {
  const isInvoice = kind === 'invoice'
  const [raw, setRaw] = useState('')
  // Initialize to TODAY so the DatePop trigger shows the real month ('6月'), not
  // the empty placeholder — she can never commit a month she didn't see, and
  // can still re-pick in one tap. 收款 still forbids future dates.
  const [date, setDate] = useState<string>(TODAY)
  const inputRef = useRef<HTMLInputElement>(null)

  // Autofocus the amount input the instant the composer appears.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const amount = Number(raw)
  const valid = raw.trim() !== '' && Number.isFinite(amount) && amount > 0
  // The trust guard. An over-ceiling amount must NEVER commit. We do not
  // silently clamp; she sees and fixes her own number.
  const over = valid && amount > ceiling
  const committable = valid && !over

  // Live preview — the remainder this event will leave behind. Clamped only for
  // DISPLAY so the preview never goes negative; the write is blocked separately.
  const previewAfter = ceiling - (valid ? amount : 0)
  const monthLbl = date ? monthLabel(date) : '月份'

  const commit = () => {
    // Block the bad write at the boundary — never silently clamp.
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
    <div className="mt-2 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-2">
      <div className="flex items-center gap-3 pl-1">
        {/* type word — full 开票 / 收款, matches the immutable ledger rows so it
            reads as 'the next row', already in its place. */}
        <span
          className={`text-[11px] shrink-0 w-9 ${
            isInvoice
              ? 'text-[var(--color-info)]'
              : 'text-[var(--color-success)]'
          }`}
        >
          {isInvoice ? '开票' : '收款'}
        </span>

        {/* amount — autofocused, mono, right-aligned, the 余额 ceiling shown
            faintly as placeholder but NEVER pre-filled. Always editable; only
            the write is blocked when over. */}
        <div className="w-[140px] shrink-0">
          <input
            ref={inputRef}
            value={raw}
            inputMode="decimal"
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`余 ${formatCny(ceiling)}`}
            className={`${baseInputClass} mono tabular-nums text-right text-[13px] placeholder:text-[var(--color-ink-4)] ${
              over ? 'text-[var(--color-overdue)]' : ''
            }`}
          />
        </div>

        {/* date — DatePop, month label, initialized to TODAY, 收款 forbids
            future. */}
        <DatePop
          value={date}
          onChange={setDate}
          allowFuture={isInvoice}
          formatLabel={monthLabel}
          placeholder="月份"
          hideIcon
        />

        {/* live preview line — '{month} · 余 → ¥X'. Reddens with the note when
            the amount exceeds the ceiling. */}
        <span
          className={`mono tabular-nums text-[11px] ml-auto whitespace-nowrap ${
            over ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink-3)]'
          }`}
        >
          {over ? (
            <>超出余额 · 余 {formatCny(ceiling)}</>
          ) : (
            <>
              {monthLbl} · 余 → {formatCny(previewAfter)}
            </>
          )}
        </span>

        {/* commit / discard */}
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={commit}
            disabled={!committable}
            aria-label="确认"
            className={`rounded-[2px] px-1.5 py-0.5 text-[13px] transition-colors ${
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
            className="rounded-[2px] px-1.5 py-0.5 text-[13px] text-[var(--color-ink-4)] hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink-2)] transition-colors"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  )
}
