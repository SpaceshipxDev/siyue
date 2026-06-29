'use client'

// 流水卡 (Liúshuǐ Kǎ) — The Inbox That Burns Down.
//
// A money inbox of OWING PO LINES (not orders, not customers). One flat ordered
// list, worked top-down like email. The only write is the inline append-row at
// the bottom of an expanded line's ledger; a line quietly graduates out of the
// active lens the instant its remainder hits zero. The count is the to-do
// badge; clearing it to zero is the felt win. No record ever vanishes — every
// line is always findable in 已结清 / 全部.

import { useMemo, useRef, useState } from 'react'
import { formatCny } from '@/lib/data'
import { DatePop } from '@/app/_datepop'
import { useMockStore } from './_store'
import { TODAY, type EventKind, type Job, type PoLine } from './_mock'
import {
  STATUS_TEXT,
  type MoneyStatus,
  lineInvoiced,
  linePaid,
  lineWaitInvoice,
  lineUnpaid,
  lineStatus,
  lineOverdueDays,
  ledgerForLine,
  rollupForLines,
} from './_derive'

// The composer field idiom — verbatim from _orders / the AR ledger, so an
// editing money cell reads like every other inline edit in the app.
const baseInputClass =
  'block w-full bg-transparent border-0 outline-none rounded-[2px] px-1 -mx-1 py-0.5 transition-[background-color,box-shadow] duration-150 hover:bg-[var(--color-active-bg)] hover:shadow-[inset_0_-1px_0_var(--color-border-strong)] focus:bg-[var(--color-active-bg)] focus:shadow-[inset_0_-1px_0_var(--color-ink)]'

type Lens = 'await_invoice' | 'unpaid' | 'all' | 'settled'

const LENSES: { key: Lens; label: string }[] = [
  { key: 'await_invoice', label: '待开票' },
  { key: 'unpaid', label: '未收款' },
  { key: 'all', label: '全部' },
  { key: 'settled', label: '已结清' },
]

// Status → colored text class. 收款中 reads as plain ink (it's the working
// state, not an alarm); only 逾期 carries red. 已开完 is a transient win state
// shown on a line that just cleared its 待开票余额 this beat.
const STATUS_COLOR: Record<MoneyStatus | 'invoice_done', string> = {
  overdue: 'text-[var(--color-overdue)] font-medium',
  await_invoice: 'text-[var(--color-info)]',
  collecting: 'text-[var(--color-ink-2)]',
  settled: 'text-[var(--color-success)]',
  invoice_done: 'text-[var(--color-success)] font-medium',
}

const STATUS_LABEL_PLUS: Record<MoneyStatus | 'invoice_done', string> = {
  ...STATUS_TEXT,
  invoice_done: '已开完',
}

export default function LiushuiDesign() {
  const { jobs, lines, events, addEvent } = useMockStore()

  const [lens, setLens] = useState<Lens>('await_invoice')
  const [query, setQuery] = useState('')
  // The line currently expanded into its ledger + composer (only one at a time).
  const [openLineId, setOpenLineId] = useState<string | null>(null)
  // Which kind the open composer is appending — driven by the tapped ghost action.
  const [composerKind, setComposerKind] = useState<EventKind>('invoice')
  // A line that just hit zero 待开票余额 and earns ONE beat of green before it
  // slides out of the active lens on the next interaction.
  const [graduatedId, setGraduatedId] = useState<string | null>(null)

  const jobById = useMemo(() => {
    const m = new Map<string, Job>()
    for (const j of jobs) m.set(j.id, j)
    return m
  }, [jobs])

  const q = query.trim().toLowerCase()
  const matchesLine = (line: PoLine): boolean => {
    if (!q) return true
    const job = jobById.get(line.jobId)
    const hay = [
      job?.customer,
      job?.id,
      job?.product,
      job?.salesperson,
      job?.engineer,
      line.poNo,
      line.materialNo,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  }

  // Flatten every PO line into an inbox item, computing per-line status.
  type Item = {
    line: PoLine
    job: Job
    status: MoneyStatus
    overdueDays: number
    wait: number
    unpaid: number
    invoiced: number
    paid: number
    // Transient: graduated this beat (held in the active lens for one moment).
    graduated: boolean
  }

  const allItems: Item[] = useMemo(() => {
    return lines
      .map((line) => {
        const job = jobById.get(line.jobId)
        if (!job) return null
        return {
          line,
          job,
          status: lineStatus(line, events),
          overdueDays: lineOverdueDays(line, events),
          wait: lineWaitInvoice(line, events),
          unpaid: lineUnpaid(line, events),
          invoiced: lineInvoiced(events, line.id),
          paid: linePaid(events, line.id),
          graduated: false,
        } as Item
      })
      .filter((x): x is Item => x !== null)
  }, [lines, events, jobById])

  // Banner totals — the live to-do, summed over ALL owing lines (not the search
  // narrowing). When a search is active the banner re-sums to the match below.
  const bannerSource = q ? allItems.filter((it) => matchesLine(it.line)) : allItems
  const totalWait = bannerSource.reduce((s, it) => s + Math.max(0, it.wait), 0)
  const totalUnpaid = bannerSource.reduce((s, it) => s + Math.max(0, it.unpaid), 0)

  // Lens counts (respect the search narrowing too, so the badges stay honest).
  const lensCount = (l: Lens): number =>
    allItems.filter((it) => matchesLine(it.line) && inLens(it, l, graduatedId)).length

  // Build the visible queue for the active lens, then sort by anxiety.
  const visible = allItems
    .filter((it) => matchesLine(it.line) && inLens(it, lens, graduatedId))
    .map((it) => ({ ...it, graduated: it.line.id === graduatedId && it.wait <= 0 }))
    .sort(sortItems)

  // Per-job exposure counts, so a 〃 group can't silently omit a customer's
  // largest exposure. A fully-invoiced-but-unpaid sibling (e.g. 海康 po-331-c)
  // drops out of the 待开票 lens; the group header surfaces a quiet 本视图 N/M 行
  // when this view shows fewer of the job's owing lines than it actually has.
  const jobVisibleCount = new Map<string, number>()
  for (const it of visible) {
    jobVisibleCount.set(it.job.id, (jobVisibleCount.get(it.job.id) ?? 0) + 1)
  }
  // M = total owing lines of the job (any 待开票 or 未收 exposure), over the
  // current search narrowing — the whole-customer exposure the lens may hide.
  const jobOwingCount = new Map<string, number>()
  for (const it of allItems) {
    if (!matchesLine(it.line)) continue
    if (it.wait <= 0 && it.unpaid <= 0) continue
    jobOwingCount.set(it.job.id, (jobOwingCount.get(it.job.id) ?? 0) + 1)
  }

  // Sibling grouping: lines sharing a 生产编号 read as one order. The first
  // visible sibling shows the full customer block; the rest indent + show 〃.
  const seenJob = new Set<string>()
  const decorated = visible.map((it) => {
    const isFirstOfJob = !seenJob.has(it.job.id)
    seenJob.add(it.job.id)
    const visibleOfJob = jobVisibleCount.get(it.job.id) ?? 0
    const owingOfJob = jobOwingCount.get(it.job.id) ?? visibleOfJob
    // Only worth surfacing when this lens hides at least one owing sibling.
    const hiddenSiblings = isFirstOfJob && owingOfJob > visibleOfJob
    return { ...it, isFirstOfJob, visibleOfJob, owingOfJob, hiddenSiblings }
  })

  // Distinct customers in the current (search-narrowed) result → pin a rollup.
  const customerSet = new Set(
    allItems.filter((it) => matchesLine(it.line)).map((it) => it.job.customer),
  )
  const pinnedCustomer =
    q && customerSet.size === 1 ? [...customerSet][0] : null
  const pinnedRollup = pinnedCustomer
    ? rollupForLines(
        allItems
          .filter((it) => it.job.customer === pinnedCustomer)
          .map((it) => it.line),
        events,
      )
    : null

  // Count of lines that have fully cleared 待开票 (for the calm empty state).
  const invoiceClearedCount = allItems.filter(
    (it) => matchesLine(it.line) && it.wait <= 0,
  ).length

  // --- the email-triage loop ---
  function openComposer(item: Item, kind: EventKind) {
    // Any fresh interaction lets a previously-graduated line slide out.
    if (graduatedId && graduatedId !== item.line.id) setGraduatedId(null)
    setComposerKind(kind)
    setOpenLineId(item.line.id)
  }

  function closeComposer() {
    setOpenLineId(null)
  }

  function commit(item: Item, kind: EventKind, amountCny: number, dateIso: string) {
    addEvent(item.line.id, kind, amountCny, dateIso)
    setOpenLineId(null)
    // If this invoice cleared the 待开票余额, hold the line one beat in green.
    if (kind === 'invoice' && amountCny >= item.wait - 0.5) {
      setGraduatedId(item.line.id)
    } else if (graduatedId === item.line.id) {
      setGraduatedId(null)
    }
  }

  const isEmpty = decorated.length === 0

  return (
    <div className="px-8 pt-7 pb-24">
      {/* TOP BANNER — not a dashboard. One inbox line + two live totals that
          tick down as she clears. */}
      <div className="mb-6 flex items-baseline gap-5">
        <h1 className="text-[19px] font-semibold tracking-tight text-[var(--color-ink)]">
          收件箱
        </h1>
        <div className="flex items-baseline gap-5">
          <BannerTotal
            label="待开票"
            value={totalWait}
            color="var(--color-info)"
            dominant={lens !== 'unpaid'}
          />
          <BannerTotal
            label="未收"
            value={totalUnpaid}
            color="var(--color-warning)"
            dominant={lens === 'unpaid'}
          />
        </div>
      </div>

      {/* LENS TOGGLES — underline-active, mono counts. Filters with an implicit
          needs-action sort. Default = 待开票. */}
      <div className="mb-3 flex items-baseline gap-x-6 border-b border-[var(--color-border)] pb-px">
        {LENSES.map((l) => {
          const active = l.key === lens
          const count = lensCount(l.key)
          const alarm = l.key === 'await_invoice' && count > 0
          return (
            <button
              key={l.key}
              type="button"
              onClick={() => {
                if (graduatedId) setGraduatedId(null)
                setLens(l.key)
              }}
              role="tab"
              aria-selected={active}
              className={`group -mb-px inline-flex items-baseline gap-1.5 border-b pb-2 transition-colors ${
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
              <span
                className={`mono text-[11px] tabular-nums ${
                  alarm
                    ? 'text-[var(--color-overdue)] font-medium'
                    : 'text-[var(--color-ink-4)]'
                }`}
              >
                {count}
              </span>
            </button>
          )
        })}

        {/* 对账 search — filters the queue; banner re-sums to the match. */}
        <div className="ml-auto mb-1.5 inline-flex items-center gap-2">
          <SearchGlyph />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="对账 · 客户 / 工号 / 订单号 / 物料号"
            className="w-[240px] bg-transparent text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)]"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="清除搜索"
              className="text-[var(--color-ink-4)] hover:text-[var(--color-ink-2)] transition-colors"
            >
              <CloseGlyph />
            </button>
          )}
        </div>
      </div>

      {/* 对账 rollup strip — only when narrowed to a single customer. */}
      {pinnedCustomer && pinnedRollup && (
        <div className="mb-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 rounded-[2px] bg-[var(--color-active-bg)] px-3 py-2 text-[12px]">
          <span className="font-medium text-[var(--color-ink)]">{pinnedCustomer}</span>
          <RollupCell label="已开票" value={pinnedRollup.invoiced} color="var(--color-info)" />
          <RollupCell label="已收" value={pinnedRollup.paid} color="var(--color-success)" />
          <RollupCell label="待开票" value={pinnedRollup.waitInvoice} />
          <RollupCell label="未收" value={pinnedRollup.unpaid} color="var(--color-warning)" />
        </div>
      )}

      {/* STICKY COLUMN-HEADER STRIP — the captions lifted out of every row and
          shown ONCE, aligned to the same fixed column widths, switching the
          label set with the lens. Sits directly under the lens bar; rows below
          carry only the mono numbers. */}
      {!isEmpty && <ColumnHeader lens={lens} />}

      {/* THE QUEUE — one flat ordered list. Each row is an OWING PO LINE. */}
      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        {isEmpty ? (
          <EmptyState lens={lens} clearedCount={invoiceClearedCount} hasQuery={!!q} />
        ) : (
          decorated.map((it, idx) => (
            <Row
              key={it.line.id}
              item={it}
              lens={lens}
              events={events}
              isOpen={openLineId === it.line.id}
              composerKind={composerKind}
              isFirstRow={idx === 0}
              onAction={(kind) => openComposer(it, kind)}
              onClose={closeComposer}
              onCommit={(kind, amount, date) => commit(it, kind, amount, date)}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Row — a single owing PO line. Reads top-down: status word + the gray
// remainder this lens is about, plus the co-located ghost action. Tapping the
// action expands the row DOWN in place into its ledger + composer.
// ---------------------------------------------------------------------------

type RowItem = {
  line: PoLine
  job: Job
  status: MoneyStatus
  overdueDays: number
  wait: number
  unpaid: number
  invoiced: number
  paid: number
  graduated: boolean
  isFirstOfJob: boolean
  visibleOfJob: number
  owingOfJob: number
  hiddenSiblings: boolean
}

function Row({
  item,
  lens,
  events,
  isOpen,
  composerKind,
  isFirstRow,
  onAction,
  onClose,
  onCommit,
}: {
  item: RowItem
  lens: Lens
  events: ReturnType<typeof useMockStore>['events']
  isOpen: boolean
  composerKind: EventKind
  isFirstRow: boolean
  onAction: (kind: EventKind) => void
  onClose: () => void
  onCommit: (kind: EventKind, amount: number, date: string) => void
}) {
  const { line, job } = item

  // Which remainder this lens is about, and which ghost action(s) to surface.
  const onInvoiceLens = lens === 'await_invoice'
  const wantsInvoice = item.wait > 0
  const wantsPayment = item.unpaid > 0

  // What status word to show. A line that cleared 待开票 this beat reads 已开完.
  //
  // The 逾期 / 待开票 seam: 逾期 ages the unpaid-INVOICED money (未收余额). On the
  // 待开票 lens the hero number beside the word is 待开票余额 — un-invoiced money
  // that aging does NOT attach to. Naming 逾期 there builds a wrong mental model,
  // so on that lens we show the invoicing posture (待开票) instead. 逾期 (red) +
  // the 逾期N天 meta surface ONLY where the hero number is 未收余额 (未收款 / 全部).
  const statusKey: MoneyStatus | 'invoice_done' = item.graduated
    ? 'invoice_done'
    : onInvoiceLens && item.status === 'overdue'
      ? 'await_invoice'
      : item.status
  const showOverdueMeta = !onInvoiceLens && item.status === 'overdue' && item.overdueDays > 0

  // Top hairline: sibling lines of the same 生产编号 share a faint inner divider
  // (not the full row border) so they visually clump as one order.
  const topBorder = isFirstRow
    ? ''
    : item.isFirstOfJob
      ? 'border-t border-[var(--color-border)]'
      : 'border-t border-[color-mix(in_srgb,var(--color-border)_55%,transparent)]'

  return (
    <div className={topBorder}>
      {/* The ~48px row. */}
      <div
        className={`group flex items-center gap-4 px-4 transition-colors hover:bg-[#faf8f2] ${
          item.graduated ? 'bg-[var(--color-success-soft)]' : ''
        }`}
        style={{ minHeight: 48 }}
      >
        {/* 状态 — colored text, the app idiom. Fixed width so the column lines up. */}
        <span
          className={`w-[44px] shrink-0 text-[12px] tracking-wide ${STATUS_COLOR[statusKey]}`}
        >
          {STATUS_LABEL_PLUS[statusKey]}
        </span>

        {/* Customer block + mono meta line. Siblings replace the name with 〃. */}
        <div className={`min-w-0 flex-1 ${item.isFirstOfJob ? '' : 'pl-4'}`}>
          {item.isFirstOfJob ? (
            <span className="block truncate text-[14px] text-[var(--color-ink)]">
              {job.customer}
              {item.hiddenSiblings ? (
                <span className="ml-2 text-[11px] text-[var(--color-ink-4)] mono">
                  本视图 {item.visibleOfJob}/{item.owingOfJob} 行
                </span>
              ) : null}
            </span>
          ) : (
            <span className="block text-[14px] leading-tight text-[var(--color-ink-4)]">
              〃
            </span>
          )}
          <span className="mt-0.5 block truncate text-[11px] text-[var(--color-ink-3)] mono">
            {job.id} · {line.poNo}
            {line.materialNo ? ` · ${line.materialNo}` : ''} · {job.salesperson}
            {showOverdueMeta ? (
              <span className="text-[var(--color-overdue)]"> · 逾期{item.overdueDays}天</span>
            ) : null}
          </span>
        </div>

        {/* RIGHT — the ONE remainder this lens is about, with read-only context.
            Captions live once in the sticky column-header strip above. */}
        {onInvoiceLens ? (
          <div className="flex shrink-0 items-baseline gap-5 text-right">
            <Amt value={line.poAmountCny} />
            <Amt value={item.invoiced} />
            <AmtRemainder value={item.wait} cleared={item.graduated} />
          </div>
        ) : (
          <div className="flex shrink-0 items-baseline gap-5 text-right">
            <Amt value={item.invoiced} />
            <Amt value={item.paid} />
            <AmtRemainder value={item.unpaid} overdue={item.overdueDays > 0} />
          </div>
        )}

        {/* Ghost action(s) — co-located with the line her eyes are already on.
            The action matches the lens; a 未收款-lens line that still owes an
            invoice ALSO shows '+ 开票' (never hide a real action). */}
        <div className="flex w-[112px] shrink-0 items-center justify-end gap-2">
          {onInvoiceLens
            ? wantsInvoice && <GhostAction label="+ 开票" onClick={() => onAction('invoice')} active={isOpen && composerKind === 'invoice'} />
            : (
              <>
                {wantsPayment && <GhostAction label="+ 收款" onClick={() => onAction('payment')} active={isOpen && composerKind === 'payment'} />}
                {wantsInvoice && <GhostAction label="+ 开票" onClick={() => onAction('invoice')} active={isOpen && composerKind === 'invoice'} subtle />}
              </>
            )}
        </div>
      </div>

      {/* PUSH-DOWN ledger + composer. Smooth max-height/opacity expand; never a
          modal that hides the queue. */}
      <div
        className="overflow-hidden transition-[max-height,opacity] duration-300 ease-out"
        style={{ maxHeight: isOpen ? 560 : 0, opacity: isOpen ? 1 : 0 }}
      >
        {isOpen && (
          <Ledger
            line={line}
            events={events}
            kind={composerKind}
            wait={item.wait}
            unpaid={item.unpaid}
            onClose={onClose}
            onCommit={onCommit}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ledger — the line's append-only history + the inline composer at its bottom.
// ---------------------------------------------------------------------------

function Ledger({
  line,
  events,
  kind,
  wait,
  unpaid,
  onClose,
  onCommit,
}: {
  line: PoLine
  events: ReturnType<typeof useMockStore>['events']
  kind: EventKind
  wait: number
  unpaid: number
  onClose: () => void
  onCommit: (kind: EventKind, amount: number, date: string) => void
}) {
  const rows = ledgerForLine(line, events)
  const inputRef = useRef<HTMLInputElement>(null)

  const [amountStr, setAmountStr] = useState('')
  // Default to the current month (first-of-month, derived from TODAY) so the
  // common in-month installment commits on amount + Enter in one keystroke. The
  // DatePop stays fully available for back-dating; it just isn't required.
  // (TODAY is never a future date, so 收款's no-future rule is preserved.)
  const [dateIso, setDateIso] = useState(`${TODAY.slice(0, 7)}-01`)

  // The ceiling for this composer = the remainder it draws down.
  const ceiling = kind === 'invoice' ? wait : unpaid
  const parsed = Number(amountStr)
  const valid = amountStr.trim() !== '' && Number.isFinite(parsed) && parsed > 0
  const remainderAfter = valid ? ceiling - parsed : ceiling

  const verb = kind === 'invoice' ? '开票' : '收款'

  const doCommit = () => {
    if (!valid || !dateIso) return
    onCommit(kind, parsed, dateIso)
  }

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 pb-3 pl-[64px]">
      {/* Append-only ledger — newest at bottom. Capped to an internal scroll
          region past 8 rows so a fat history never shoves the queue around. */}
      {rows.length > 0 && (
        <div
          className={`mt-3 ${rows.length > 8 ? 'max-h-[200px] overflow-y-auto' : ''}`}
        >
          {rows.map((r) => {
            const isInv = r.event.kind === 'invoice'
            return (
              <div
                key={r.event.id}
                className="flex items-baseline gap-3 py-1 text-[12px]"
              >
                <span className="mono w-[40px] shrink-0 text-[var(--color-ink-3)]">
                  {monthOf(r.event.date)}
                </span>
                <span
                  className={`w-[32px] shrink-0 ${
                    isInv ? 'text-[var(--color-info)]' : 'text-[var(--color-success)]'
                  }`}
                >
                  {isInv ? '开票' : '收款'}
                </span>
                <span className="mono w-[110px] shrink-0 text-right text-[var(--color-ink)]">
                  {formatCny(r.event.amountCny)}
                </span>
                {/* 剩余 tinted to its event verb — an invoice row's remainder is
                    待开票余 (info), a payment row's is 未收余 (success-ink) — the
                    running number's meaning flips per event kind. */}
                <span
                  className="mono"
                  style={{
                    color: `color-mix(in srgb, ${
                      isInv ? 'var(--color-info)' : 'var(--color-success)'
                    } 60%, var(--color-ink-3))`,
                  }}
                >
                  剩余 {formatCny(Math.max(0, r.running))}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* The inline composer — the only write. Amount (autofocused) + DatePop +
          a live preview of the remainder after. Enter commits; Escape/✕ cancels. */}
      <div className="mt-1 flex items-center gap-3 border-t border-dashed border-[var(--color-border)] pt-2">
        <span className="mono w-[40px] shrink-0 text-[var(--color-ink-4)]">+</span>
        <span
          className={`w-[32px] shrink-0 text-[12px] ${
            kind === 'invoice' ? 'text-[var(--color-info)]' : 'text-[var(--color-success)]'
          }`}
        >
          {verb}
        </span>

        <div className="w-[110px] shrink-0">
          <input
            ref={inputRef}
            autoFocus
            inputMode="decimal"
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value.replace(/[^\d.]/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                doCommit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              }
            }}
            placeholder={`余 ${formatCny(Math.max(0, ceiling))}`}
            className={`${baseInputClass} mono text-right text-[13px] placeholder:text-[var(--color-ink-4)]`}
          />
        </div>

        <DatePop
          value={dateIso}
          onChange={setDateIso}
          allowFuture={kind === 'invoice'}
          formatLabel={monthOf}
          placeholder="月份"
          hideIcon
        />

        {/* Live preview — gray, derived; the felt burn-down before she commits. */}
        <span className="mono ml-1 text-[12px] text-[var(--color-ink-3)]">
          {valid && dateIso
            ? `${verb}后 → ${formatCny(Math.max(0, remainderAfter))}`
            : valid
              ? '选择月份'
              : ''}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={doCommit}
            disabled={!valid || !dateIso}
            className={`rounded-[2px] px-2.5 py-1 text-[12px] transition-colors ${
              valid && dateIso
                ? 'bg-[var(--color-ink)] text-[var(--color-bg)] hover:opacity-90'
                : 'cursor-default bg-[var(--color-active-bg)] text-[var(--color-ink-4)]'
            }`}
          >
            记一笔
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="取消"
            className="rounded-[2px] p-1 text-[var(--color-ink-4)] hover:text-[var(--color-ink-2)] transition-colors"
          >
            <CloseGlyph />
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Small presentational bits
// ---------------------------------------------------------------------------

// Sticky column-header strip. Mirrors the Row's flex skeleton exactly so the
// captions sit directly above the mono numbers they name. The label set switches
// with the lens (invoice posture vs. collection posture). Sticky so the captions
// stay legible as the queue scrolls past.
function ColumnHeader({ lens }: { lens: Lens }) {
  const onInvoiceLens = lens === 'await_invoice'
  const labels = onInvoiceLens
    ? ['订单额', '已开票', '待开票余额']
    : ['已开票', '已收款', '未收余额']
  return (
    <div className="sticky top-0 z-10 -mb-px flex items-baseline gap-4 bg-[var(--color-bg)] px-4 pb-1.5 pt-0.5">
      {/* status slot */}
      <span className="w-[44px] shrink-0" aria-hidden="true" />
      {/* customer block — eats the flex like the row's name column */}
      <span className="min-w-0 flex-1" aria-hidden="true" />
      {/* amount columns — same fixed widths + gap as the row */}
      <div className="flex shrink-0 items-baseline gap-5 text-right">
        {labels.map((label, i) => (
          <span
            key={label}
            className={`inline-flex w-[104px] items-baseline justify-end text-[10.5px] tracking-wide ${
              i === labels.length - 1
                ? 'font-medium text-[var(--color-ink-3)]'
                : 'text-[var(--color-ink-4)]'
            }`}
          >
            {label}
          </span>
        ))}
      </div>
      {/* ghost-action slot */}
      <span className="w-[112px] shrink-0" aria-hidden="true" />
    </div>
  )
}

// One dominant banner total — the active lens's figure reads large; the other
// demotes to a small secondary so the eye lands on the number being worked.
function BannerTotal({
  label,
  value,
  color,
  dominant = false,
}: {
  label: string
  value: number
  color: string
  dominant?: boolean
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span
        className={`${dominant ? 'text-[12px]' : 'text-[11px]'} text-[var(--color-ink-3)]`}
      >
        {label}
      </span>
      <span
        className={`mono tabular-nums ${dominant ? 'text-[20px] font-medium' : 'text-[13px]'}`}
        style={{ color: dominant ? color : `color-mix(in srgb, ${color} 70%, var(--color-ink-4))` }}
      >
        {formatCny(Math.max(0, value))}
      </span>
    </span>
  )
}

function RollupCell({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-[var(--color-ink-3)]">{label}</span>
      <span
        className="mono tabular-nums"
        style={{ color: color ?? 'var(--color-ink-2)' }}
      >
        {formatCny(Math.max(0, value))}
      </span>
    </span>
  )
}

// A context figure (订单额 / 已开票 / 已收款) — demoted to ~11px ink-3 so it reads
// as context, never a peer of the burned remainder. Labels live in the sticky
// column-header strip; rows carry only the mono numbers.
function Amt({ value }: { value: number }) {
  return (
    <span className="inline-flex w-[104px] items-baseline justify-end">
      <span className="mono text-[11.5px] tabular-nums text-[var(--color-ink-3)]">
        {formatCny(value)}
      </span>
    </span>
  )
}

// The remainder this lens is about — the ONE number that wins the eye per row.
// Bumped to ~16px, slightly heavier, so exactly one figure dominates.
function AmtRemainder({
  value,
  overdue = false,
  cleared = false,
}: {
  value: number
  overdue?: boolean
  cleared?: boolean
}) {
  const color = cleared
    ? 'var(--color-success)'
    : overdue
      ? 'var(--color-overdue)'
      : 'var(--color-ink)'
  return (
    <span className="inline-flex w-[104px] items-baseline justify-end">
      <span
        className={`mono text-[16px] tabular-nums ${overdue && !cleared ? 'font-semibold' : 'font-medium'}`}
        style={{ color }}
      >
        {formatCny(Math.max(0, value))}
      </span>
    </span>
  )
}

function GhostAction({
  label,
  onClick,
  active = false,
  subtle = false,
}: {
  label: string
  onClick: () => void
  active?: boolean
  subtle?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[2px] px-2 py-1 text-[12px] whitespace-nowrap transition-colors ${
        active
          ? 'bg-[var(--color-active-bg)] text-[var(--color-ink)]'
          : subtle
            ? 'text-[var(--color-ink-4)] opacity-0 hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink-2)] group-hover:opacity-100'
            : // The primary verb is the entire product — it must NEVER hide. Render
              // at rest as low-ink text; the active/open state darkens with a bg fill.
              'text-[var(--color-ink-3)] hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink)]'
      }`}
    >
      {label}
    </button>
  )
}

function EmptyState({
  lens,
  clearedCount,
  hasQuery,
}: {
  lens: Lens
  clearedCount: number
  hasQuery: boolean
}) {
  let msg: string
  if (hasQuery) {
    msg = '没有匹配的订单行'
  } else if (lens === 'await_invoice') {
    // The count of cleared items is ALWAYS present — no record ever vanishes.
    msg = `本月待开票已清空 · ${clearedCount} 笔已开完`
  } else if (lens === 'all') {
    msg = '没有匹配的订单行'
  } else if (lens === 'unpaid') {
    msg = '没有待收的款项'
  } else {
    msg = '还没有已结清的订单行'
  }
  return (
    <div className="flex items-center justify-center py-20 text-[13px] text-[var(--color-ink-3)]">
      {msg}
    </div>
  )
}

function SearchGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="text-[var(--color-ink-4)]">
      <circle cx="6" cy="6" r="4.25" stroke="currentColor" strokeWidth="1.3" />
      <line x1="9.2" y1="9.2" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function CloseGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

// '6月' from a YYYY-MM-DD (matches monthLabel; local to keep the import surface tight).
function monthOf(iso: string): string {
  return `${+iso.slice(5, 7)}月`
}

// Lens membership. 待开票 = lines still owing an invoice. 未收款 = lines that
// have invoiced but not fully collected. 已结清 = both remainders zero. 全部 =
// everything. A line graduated this beat is HELD in 待开票 for one moment.
function inLens(
  it: { wait: number; unpaid: number; status: MoneyStatus; line: PoLine },
  lens: Lens,
  graduatedId: string | null,
): boolean {
  if (lens === 'all') return true
  if (lens === 'await_invoice') {
    if (it.wait > 0) return true
    // The one-beat hold: a just-cleared line stays put until the next interaction.
    return it.line.id === graduatedId && it.wait <= 0
  }
  if (lens === 'unpaid') return it.unpaid > 0
  // settled
  return it.wait <= 0 && it.unpaid <= 0
}

// Sort: 逾期 first, then 待开票 (oldest ship first), then 未收款 / 收款中.
// Within a status, group by job (生产编号) so siblings sit together, oldest
// ship date first, then PO line id for a stable order.
const SORT_WEIGHT: Record<MoneyStatus, number> = {
  overdue: 0,
  await_invoice: 1,
  collecting: 2,
  settled: 3,
}

function sortItems(
  a: { status: MoneyStatus; job: Job; line: PoLine },
  b: { status: MoneyStatus; job: Job; line: PoLine },
): number {
  const w = SORT_WEIGHT[a.status] - SORT_WEIGHT[b.status]
  if (w !== 0) return w
  if (a.job.shipDate !== b.job.shipDate) return a.job.shipDate < b.job.shipDate ? -1 : 1
  // keep siblings of the same order adjacent
  if (a.job.id !== b.job.id) return a.job.id < b.job.id ? -1 : 1
  return a.line.id < b.line.id ? -1 : a.line.id > b.line.id ? 1 : 0
}
