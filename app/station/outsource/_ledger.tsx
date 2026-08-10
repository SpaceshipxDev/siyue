'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  blockActivityLabel,
  blockClosedAt,
  daysFromToday,
  formatCny,
  isBlockClosed,
  memberRemainingQty,
  memberReturnedQty,
  vendorById,
  type OpenBlockRow,
  type OutsourceBlock,
  type Vendor,
} from '@/lib/data'
import { shiftDate, windowDateBounds, type Granularity } from '@/lib/today'
import { mutate } from '@/lib/mutate'
import { DatePop } from '@/app/_datepop'
import {
  BlockMemberQty,
  NameCombobox,
  OutsourceBlockAmount,
  OutsourceBlockDate,
  OutsourceBlockNotes,
} from '@/app/_editable'
import { BlockStagesEditor } from '@/app/_routing'
import { BlockThreadStrip } from '@/app/_vendor_share'
import { OutsourceExportButton } from './_export'
import { withBase } from '@/lib/base-path'

// 外协台 — one ledger, read top-down like the Excel sheet it replaces.
//
// The page answers three questions and nothing else:
//   看   — what went out, to whom, when it's due back
//   核对 — did we tell the vendor, did they answer, are they late
//   收件 — click the row, confirm, the parts are back
//
// So it's ONE table. Same cells every row, newest dispatch on top, day
// separators as the only structure. Vendor grouping is gone — a vendor is a
// filter you pick, not a wall of headers you scroll past. Everything else
// (parts, prices, the vendor thread, 打印/撤销) lives in the row's panel,
// one click away, never in the scan path.

const CN = new Intl.NumberFormat('zh-CN')

// The one column template. Header and rows share it, so the sheet stays a sheet
// — but EIGHT cells, not eleven. Narrow columns of same-sized grey are a data
// dump; the eye needs somewhere to land on every line. Facts that don't earn a
// column ride inside one (工序 under its 供应商, 产品 under its 客户) or are
// already implied (寄出 = the day header the row sits under, 工号 = the first
// half of the 外协单号 in column one).
const COLS =
  'grid-cols-[196px_minmax(220px,1.4fr)_146px_minmax(150px,1fr)_96px_104px_136px_78px]'
const MINW = 'min-w-[1140px]'

type Tab = 'open' | 'done' | 'all'
type Gran = 'all' | Granularity
type Scope = { kind: 'vendor' | 'customer'; name: string }
type Flag = 'overdue'

type Line = {
  key: string
  jobId: string
  jobNo: string
  customer: string
  product: string
  block: OutsourceBlock
  vendor?: Vendor
  vendorName: string
  activity: string
  closed: boolean
  /** The date this row files under: 回厂 once closed, else 寄出. */
  ledgerDate: string
  closedAt?: string
  totalQty: number
  returnedQty: number
  remainingQty: number
  daysLeft: number
  overdue: boolean
  hay: string
}

export function OutsourceLedger({
  rows,
  vendors,
  today,
}: {
  rows: OpenBlockRow[]
  vendors: Vendor[]
  today: string
}) {
  // Local echo of server rows. Receiving parts, stamping 微信 and 撤销外协 all
  // repaint from here instead of a full RSC refresh — the mainland↔HK link is
  // slow enough that a refresh reads as a hang (and scrolls the sheet away).
  const [patched, setPatched] = useState<Record<string, OutsourceBlock>>({})
  const [deleted, setDeleted] = useState<Set<string>>(() => new Set())
  // A fresh server payload is authoritative — drop the echoes. Reset during
  // render off the previous props (React's recommended pattern) rather than in
  // an effect, which would paint stale rows for a frame first.
  const [prevRows, setPrevRows] = useState(rows)
  if (rows !== prevRows) {
    setPrevRows(rows)
    setPatched({})
    setDeleted(new Set())
  }

  const [tab, setTab] = useState<Tab>('open')
  const [gran, setGran] = useState<Gran>('all')
  const [anchor, setAnchor] = useState<string>(today)
  const [scope, setScope] = useState<Scope | null>(null)
  const [activity, setActivity] = useState<string | null>(null)
  const [flag, setFlag] = useState<Flag | null>(null)
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [limit, setLimit] = useState(200)

  const lines = useMemo(
    () =>
      rows
        .filter((r) => !deleted.has(r.block.id))
        .map((r) => toLine(r, patched[r.block.id], vendors, today)),
    [rows, patched, deleted, vendors, today],
  )

  // ① tab — 在外 / 已回 / 全部
  const byTab = useMemo(
    () =>
      lines.filter((l) =>
        tab === 'open' ? !l.closed : tab === 'done' ? l.closed : true,
      ),
    [lines, tab],
  )

  // ② period — on 寄出 for live rows, on 回厂 for the archive. 全部 = no window.
  const window = gran === 'all' ? null : windowDateBounds(anchor, gran)
  const byPeriod = useMemo(
    () =>
      window
        ? byTab.filter(
            (l) => l.ledgerDate >= window.from && l.ledgerDate <= window.to,
          )
        : byTab,
    [byTab, window?.from, window?.to], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // ③ scope (供应商 / 客户) + ④ 工序 + ⑤ free text. 逾期 filters last so its own
  // count stays stable while it's toggled on.
  const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const scoped = useMemo(() => {
    return byPeriod.filter((l) => {
      if (scope) {
        const v = scope.kind === 'vendor' ? l.vendorName : l.customer
        if (v !== scope.name) return false
      }
      if (activity && l.activity !== activity) return false
      if (tokens.length > 0 && !tokens.every((t) => l.hay.includes(t))) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byPeriod, scope, activity, q])

  const shown = useMemo(() => {
    const kept = flag === 'overdue' ? scoped.filter((l) => l.overdue) : scoped
    // Newest first — the sheet reads like a bank statement.
    return kept.sort(
      (a, b) =>
        b.ledgerDate.localeCompare(a.ledgerDate) ||
        b.block.sentDate.localeCompare(a.block.sentDate) ||
        (b.block.docNo ?? '').localeCompare(a.block.docNo ?? ''),
    )
  }, [scoped, flag])

  // Totals + the three actionable counts, all over the current view.
  const stats = useMemo(() => {
    let qty = 0
    let remaining = 0
    let amount = 0
    let overdue = 0
    for (const l of scoped) {
      qty += l.totalQty
      remaining += l.remainingQty
      amount += l.block.amountCny ?? 0
      if (l.overdue) overdue++
    }
    return { count: scoped.length, qty, remaining, amount, overdue }
  }, [scoped])

  // Pickers are built from the tab+period slice, so a vendor with nothing in
  // this window doesn't sit in the list pretending to be a filter.
  const { vendorOpts, customerOpts, activityOpts } = useMemo(
    () => buildOptions(byPeriod),
    [byPeriod],
  )

  const groups = useMemo(() => groupByDate(shown.slice(0, limit)), [shown, limit])

  const switchTab = (next: Tab) => {
    setTab(next)
    setOpenId(null)
    setLimit(200)
    // 已回 is a ledger you browse a month at a time (498 rows and counting);
    // 在外 is a live list you always want whole.
    if (next === 'done' && gran === 'all') {
      setGran('month')
      setAnchor(today)
    }
    if (next !== 'done' && gran === 'month') setGran('all')
  }

  const receive = async (blockId: string, next: OutsourceBlock) => {
    setPatched((p) => ({ ...p, [blockId]: next }))
  }

  return (
    <main className={`w-full flex-1 px-4 py-6 md:px-10 md:py-8`}>
      {/* ── hero: the numbers, then the period this page is showing ───────── */}
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
        <div>
          <h2 className="text-[26px] font-semibold tracking-tight text-[var(--color-ink)]">
            外协
          </h2>
          <div className="mt-4 flex items-baseline gap-8">
            <Stat
              value={CN.format(stats.count)}
              sub={`${CN.format(tab === 'open' ? stats.remaining : stats.qty)} 件`}
              label={tab === 'done' ? '已回外协单' : '外协单'}
            />
            <Stat value={formatCny(stats.amount)} label="外发金额" />
          </div>
        </div>
        <PeriodBar
          gran={gran}
          anchor={anchor}
          today={today}
          onGran={(g) => {
            setGran(g)
            if (g !== 'all') setAnchor(today)
          }}
          onStep={(d) => setAnchor((a) => shiftDate(a, gran === 'all' ? 'day' : gran, d))}
          onToday={() => setAnchor(today)}
        />
      </div>

      {/* ── filters: tab · 找厂商/客户 · 逾期 ─────────────────────────────── */}
      <div className="mt-7 flex flex-wrap items-center gap-x-4 gap-y-3">
        <Segmented
          value={tab}
          onChange={switchTab}
          options={[
            { value: 'open', label: '在外' },
            { value: 'done', label: '已回' },
            { value: 'all', label: '全部' },
          ]}
        />
        <ScopeSearch
          q={q}
          setQ={setQ}
          scope={scope}
          setScope={(s) => {
            setScope(s)
            setLimit(200)
          }}
          vendorOpts={vendorOpts}
          customerOpts={customerOpts}
        />
        {stats.overdue > 0 && (
          <FlagChip
            tone="overdue"
            label="逾期"
            value={stats.overdue}
            on={flag === 'overdue'}
            onClick={() => setFlag(flag === 'overdue' ? null : 'overdue')}
          />
        )}
      </div>

      {activityOpts.length > 1 && (
        <div className="mt-3">
          <Chips
            current={activity}
            onSelect={(a) => {
              setActivity(a)
              setLimit(200)
            }}
            options={activityOpts}
          />
        </div>
      )}

      {/* ── the sheet ─────────────────────────────────────────────────────── */}
      <div className="mt-5 flex items-baseline justify-between gap-4">
        <p className="label tabular-nums">
          {CN.format(shown.length)} 单
          {shown.length !== stats.count ? ` / ${CN.format(stats.count)}` : ''}
          <span className="mx-1.5 text-[var(--color-ink-4)]">·</span>
          {formatCny(shown.reduce((s, l) => s + (l.block.amountCny ?? 0), 0))}
        </p>
        <OutsourceExportButton
          lines={shown}
          filename={`外协_${tab === 'done' ? '已回' : tab === 'open' ? '在外' : '全部'}_${gran === 'all' ? today : readout(anchor, gran).replace(/[月日 ]/g, '')}`}
        />
      </div>

      <div className="mt-2 overflow-x-auto">
        <div className={MINW}>
          <div
            className={`grid ${COLS} items-baseline gap-x-4 border-y border-[var(--color-border)] px-3 py-2`}
          >
            <span className="label pl-5">外协单号</span>
            <span className="label">零件</span>
            <span className="label">供应商</span>
            <span className="label">客户</span>
            <span className="label text-right">数量</span>
            <span className="label text-right">金额</span>
            <span className="label">回厂</span>
            <span />
          </div>

          {shown.length === 0 ? (
            <p className="px-3 py-16 text-center text-[13px] text-[var(--color-ink-3)]">
              {q.trim() || scope || activity || flag
                ? '没有匹配的外协单'
                : tab === 'open'
                  ? '暂无在外零件 — 从工单明细页 · 新增外协 送出'
                  : '此周期无回厂记录'}
            </p>
          ) : (
            groups.map((g) => (
              <div key={g.date}>
                {gran !== 'day' && (
                  // A date and a hairline — rhythm, not furniture. A filled
                  // grey band every few rows is what makes a table read as a
                  // report nobody opens.
                  <div className="flex items-baseline gap-3 px-3 pb-1 pt-5">
                    <span className="text-[12px] font-medium tabular-nums text-[var(--color-ink-2)]">
                      {dayLabel(g.date)}
                    </span>
                    <span className="h-px flex-1 translate-y-[-3px] bg-[var(--color-border)]" />
                    <span className="text-[11px] tabular-nums text-[var(--color-ink-4)]">
                      {g.lines.length} 单 ·{' '}
                      {formatCny(g.lines.reduce((s, l) => s + (l.block.amountCny ?? 0), 0))}
                    </span>
                  </div>
                )}
                {g.lines.map((l) => (
                  <Row
                    key={l.key}
                    line={l}
                    vendors={vendors}
                    open={openId === l.block.id}
                    onToggle={() =>
                      setOpenId((cur) => (cur === l.block.id ? null : l.block.id))
                    }
                    onPatch={(next) => receive(l.block.id, next)}
                    onDeleted={() =>
                      setDeleted((s) => {
                        const n = new Set(s)
                        n.add(l.block.id)
                        return n
                      })
                    }
                  />
                ))}
              </div>
            ))
          )}

          {shown.length > limit && (
            <button
              type="button"
              onClick={() => setLimit((n) => n + 400)}
              className="w-full border-t border-[var(--color-border)] py-3 text-center text-[12px] text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
            >
              还有 {CN.format(shown.length - limit)} 单 · 继续显示
            </button>
          )}
        </div>
      </div>
    </main>
  )
}

// ── one row ────────────────────────────────────────────────────────────────

function Row({
  line,
  vendors,
  open,
  onToggle,
  onPatch,
  onDeleted,
}: {
  line: Line
  vendors: Vendor[]
  open: boolean
  onToggle: () => void
  onPatch: (next: OutsourceBlock) => void
  onDeleted: () => void
}) {
  const { block, closed } = line

  return (
    <div
      className={`group relative border-b border-[var(--color-border)] last:border-b-0 ${
        open ? 'bg-[var(--color-surface)]' : ''
      }`}
    >
      {/* The sheet's only rail. Red = late, and nothing else on the page is
          ever red, so "what's late" is answered from across the room. */}
      {line.overdue && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[2px] bg-[var(--color-overdue)]"
        />
      )}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        className={`grid ${COLS} cursor-pointer items-baseline gap-x-5 px-3 py-[10px] transition-colors ${
          open ? '' : 'hover:bg-[var(--color-active-bg)]'
        }`}
      >
        {/* 外协单号 — the row's identity, and the thing printed on the paper
            that travels with the parts. It opens with the 工号, so a separate
            工号 column would just repeat its first half. Legacy rows (pre-July)
            have no 单号 and fall back to the bare 工号. */}
        <span className="flex min-w-0 items-baseline gap-2">
          <Caret open={open} />
          <DocNo docNo={block.docNo} jobNo={line.jobNo} />
        </span>

        {/* 零件 — the thing the floor says out loud, so it carries the weight. */}
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className={`truncate text-[14.5px] ${
              closed ? 'text-[var(--color-ink-3)]' : 'text-[var(--color-ink)]'
            }`}
            title={partsTitle(block)}
          >
            {block.members[0]?.name ?? '—'}
          </span>
          {block.members.length > 1 && (
            <span className="shrink-0 text-[12px] text-[var(--color-ink-4)]">
              +{block.members.length - 1}
            </span>
          )}
        </span>

        {/* 供应商, with 工序 riding underneath — one glance, two facts, no
            second column. */}
        <span className="min-w-0">
          <span
            className={`block truncate text-[13.5px] ${
              closed ? 'text-[var(--color-ink-3)]' : 'text-[var(--color-ink)]'
            }`}
            title={line.vendorName}
          >
            {line.vendorName}
          </span>
          <span className="mt-[2px] block truncate text-[11.5px] text-[var(--color-ink-3)]">
            {line.activity}
          </span>
        </span>

        {/* 客户 · 产品 */}
        <span className="min-w-0">
          <span
            className={`block truncate text-[13px] ${
              closed ? 'text-[var(--color-ink-3)]' : 'text-[var(--color-ink)]'
            }`}
            title={line.customer}
          >
            {line.customer}
          </span>
          {line.product && (
            <span
              className="mt-[2px] block truncate text-[11.5px] text-[var(--color-ink-4)]"
              title={line.product}
            >
              {line.product}
            </span>
          )}
        </span>

        {/* 数量 — the big number. 在外 when some already came back. */}
        <span className="text-right tabular-nums">
          <span
            className={`text-[18px] font-semibold leading-none ${
              closed ? 'text-[var(--color-ink-3)]' : 'text-[var(--color-ink)]'
            }`}
          >
            {closed ? line.totalQty : line.remainingQty}
          </span>
          <span className="ml-1 text-[11px] text-[var(--color-ink-4)]">
            {!closed && line.returnedQty > 0 ? `/${line.totalQty}` : '件'}
          </span>
        </span>

        {/* 金额 — a missing price is a blank, not an alarm. Painting 30 rows
            amber only taught the eye to ignore amber. */}
        <span className="text-right tabular-nums text-[13.5px]">
          {block.amountCny == null ? (
            <span className="text-[var(--color-ink-4)]">—</span>
          ) : (
            <span className="text-[var(--color-ink)]">{formatCny(block.amountCny)}</span>
          )}
        </span>

        {/* 回厂 — the date, and how it stands. */}
        <span className="tabular-nums">
          <span
            className={`block text-[14px] ${
              line.overdue
                ? 'font-medium text-[var(--color-overdue)]'
                : closed
                  ? 'text-[var(--color-ink-3)]'
                  : 'text-[var(--color-ink)]'
            }`}
          >
            {md(closed ? line.closedAt ?? block.expectedReturn : block.expectedReturn)}
          </span>
          <span
            className={`mt-[2px] block text-[11px] ${
              closed || (!closed && block.vendorShippedAt)
                ? 'text-[var(--color-success)]'
                : line.overdue
                  ? 'text-[var(--color-overdue)]'
                  : 'text-[var(--color-ink-4)]'
            }`}
          >
            {closed
              ? '已回'
              : block.vendorShippedAt
                ? '厂商已发货'
                : line.overdue
                  ? `逾期 ${Math.abs(line.daysLeft)} 天`
                  : line.daysLeft === 0
                    ? '今天到期'
                    : `剩 ${line.daysLeft} 天`}
          </span>
        </span>

        {/* Action gutter — empty until the cursor lands on the row. A column of
            38 resting buttons is what made this read as a report. */}
        <span className="text-right" onClick={(e) => e.stopPropagation()}>
          {!closed && line.remainingQty > 0 && (
            <button
              type="button"
              onClick={onToggle}
              className={`rounded-[2px] px-2.5 py-[5px] text-[12px] transition-opacity ${
                open
                  ? 'bg-[var(--color-ink)] text-[var(--color-surface)] opacity-100'
                  : 'bg-[var(--color-success)] text-[var(--color-surface)] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
              }`}
            >
              收件
            </button>
          )}
        </span>
      </div>

      {open && (
        <Panel
          line={line}
          vendors={vendors}
          onPatch={onPatch}
          onDeleted={onDeleted}
          onClose={onToggle}
        />
      )}
    </div>
  )
}

// The 单号 with its sequence tail carrying the weight — YNMX-26-8-7-084 is the
// 工号 you already know; -WF-01 / -WF-02 is which dispatch this is.
function DocNo({ docNo, jobNo }: { docNo?: string; jobNo: string }) {
  if (!docNo) {
    return (
      <span className="truncate font-mono text-[12px] text-[var(--color-ink-4)]" title={jobNo}>
        {jobNo || '—'}
      </span>
    )
  }
  const i = docNo.lastIndexOf('-WF-')
  const head = i > 0 ? docNo.slice(0, i) : docNo
  const tail = i > 0 ? docNo.slice(i + 1) : ''
  return (
    <span className="truncate font-mono text-[12px]" title={docNo}>
      <span className="text-[var(--color-ink-3)]">{head}</span>
      {tail && (
        <>
          <span className="text-[var(--color-ink-4)]">-</span>
          <span className="font-medium text-[var(--color-ink)]">{tail}</span>
        </>
      )}
    </span>
  )
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
      className={`shrink-0 translate-y-[-1px] text-[var(--color-ink-4)] transition-transform ${
        open ? 'rotate-90' : ''
      }`}
    >
      <path
        d="M4.5 2.5 L8 6 L4.5 9.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// ── the panel: parts, 收件, and every editable fact about this dispatch ────

function Panel({
  line,
  vendors,
  onPatch,
  onDeleted,
  onClose,
}: {
  line: Line
  vendors: Vendor[]
  onPatch: (next: OutsourceBlock) => void
  onDeleted: () => void
  onClose: () => void
}) {
  const { block, jobId, closed } = line
  const [pending, start] = useTransition()
  const [date, setDate] = useState(() => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }))
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [armed, setArmed] = useState(false)

  const pendingMembers = block.members.filter((m) => memberRemainingQty(m) > 0)
  const qtyFor = (componentId: string, fallback: number) =>
    draft[componentId] ?? String(fallback)

  const batch = pendingMembers.reduce((s, m) => {
    const v = parseInt(qtyFor(m.componentId, memberRemainingQty(m)), 10)
    if (!Number.isFinite(v) || v <= 0) return s
    return s + Math.min(v, memberRemainingQty(m))
  }, 0)

  const submit = () => {
    if (batch <= 0) return
    const items: { componentId: string; qty: number }[] = []
    for (const m of pendingMembers) {
      const raw = parseInt(qtyFor(m.componentId, memberRemainingQty(m)), 10)
      if (!Number.isFinite(raw) || raw <= 0) continue
      const inc = Math.min(raw, memberRemainingQty(m))
      // The action takes a running total, not a delta.
      items.push({ componentId: m.componentId, qty: memberReturnedQty(m) + inc })
    }
    if (items.length === 0) return
    const byId = new Map(items.map((i) => [i.componentId, i.qty]))
    start(async () => {
      await mutate({ kind: 'setBlockMembersReturnedQty', blockId: block.id, items, date, jobId })
      onPatch({
        ...block,
        members: block.members.map((m) =>
          byId.has(m.componentId)
            ? { ...m, returnedQty: byId.get(m.componentId)!, returnedAt: date }
            : m,
        ),
      })
      setDraft({})
    })
  }

  const unreturn = (componentId: string) => {
    start(async () => {
      await mutate({ kind: 'setMemberReturnedQty', blockId: block.id, componentId, qty: 0, date: null, jobId })
      onPatch({
        ...block,
        members: block.members.map((m) =>
          m.componentId === componentId ? { ...m, returnedQty: 0, returnedAt: undefined } : m,
        ),
      })
    })
  }

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-4">
      <div className="flex flex-wrap gap-x-10 gap-y-6">
        {/* 零件 + 收件 — the reason this panel exists. */}
        <div className="min-w-[420px] flex-1">
          <div className="grid grid-cols-[1fr_60px_92px_88px] items-baseline gap-x-3 border-b border-[var(--color-border)] pb-1">
            <span className="label">零件</span>
            <span className="label text-right">数量</span>
            <span className="label text-right">状态</span>
            <span className="label text-right">本次回件</span>
          </div>
          <ul>
            {block.members.map((m) => {
              const remaining = memberRemainingQty(m)
              const back = memberReturnedQty(m)
              const full = remaining === 0
              return (
                <li
                  key={m.componentId}
                  className="group grid grid-cols-[1fr_60px_92px_88px] items-baseline gap-x-3 border-b border-[var(--color-border)] py-1.5 text-[13px] last:border-b-0"
                >
                  <span className={`min-w-0 break-words leading-snug ${full ? 'text-[var(--color-ink-3)]' : 'text-[var(--color-ink)]'}`}>
                    {m.name}
                    {m.partNo && (
                      <span className="ml-2 font-mono text-[11px] text-[var(--color-ink-4)]">{m.partNo}</span>
                    )}
                  </span>
                  <span className="text-right font-mono text-[12px] text-[var(--color-ink-3)]">
                    <BlockMemberQty
                      blockId={block.id}
                      componentId={m.componentId}
                      jobId={jobId}
                      value={m.qty}
                      className="w-full text-right text-[12px] text-[var(--color-ink-3)]"
                    />
                  </span>
                  <span className="flex items-baseline justify-end gap-2 text-right text-[12px]">
                    {full ? (
                      <span className="text-[var(--color-success)]">
                        已回{m.returnedAt ? ` ${md(m.returnedAt)}` : ''}
                      </span>
                    ) : back > 0 ? (
                      <span className="text-[var(--color-warning)]">在外 {remaining}</span>
                    ) : (
                      <span className="text-[var(--color-ink-3)]">在外 {remaining}</span>
                    )}
                    {back > 0 && (
                      <button
                        type="button"
                        onClick={() => unreturn(m.componentId)}
                        disabled={pending}
                        title="撤销回厂"
                        className="label shrink-0 text-[var(--color-ink-4)] opacity-0 transition-opacity hover:text-[var(--color-ink)] group-hover:opacity-100"
                      >
                        撤销
                      </button>
                    )}
                  </span>
                  <span className="text-right">
                    {full ? (
                      <span className="text-[12px] text-[var(--color-ink-4)]">—</span>
                    ) : (
                      <input
                        type="text"
                        inputMode="numeric"
                        value={qtyFor(m.componentId, remaining)}
                        onChange={(e) => {
                          const v = e.target.value
                          if (v === '' || /^\d+$/.test(v))
                            setDraft((d) => ({ ...d, [m.componentId]: v }))
                        }}
                        disabled={pending}
                        aria-label={`${m.name} 本次回件数`}
                        className="w-[64px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-[2px] text-right font-mono text-[12px] focus:border-[var(--color-ink)] focus:outline-none"
                      />
                    )}
                  </span>
                </li>
              )
            })}
          </ul>

          {!closed && pendingMembers.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span className="label">收件日期</span>
              <DatePop value={date} onChange={setDate} allowFuture={false} disabled={pending} />
              <button
                type="button"
                onClick={submit}
                disabled={pending || batch <= 0}
                className="rounded-[2px] bg-[var(--color-success)] px-3 py-1 text-[13px] tracking-wider text-[var(--color-surface)] hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
              >
                确认收件 <span className="ml-1 font-mono">{batch} 件</span>
              </button>
              <button
                type="button"
                onClick={onClose}
                className="label text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                收起
              </button>
            </div>
          )}
        </div>

        {/* the dispatch itself — every cell editable, none of it in the scan path */}
        <div className="w-[320px] shrink-0">
          <BlockThreadStrip block={block} vendor={line.vendor} jobId={jobId} />
          <dl className="mt-3 flex flex-col gap-1.5 text-[13px]">
            <Field label="供应商">
              <NameCombobox
                target={{ kind: 'vendor', blockId: block.id, jobId }}
                value={line.vendorName}
                options={vendors.map((v) => ({ id: v.id, name: v.name }))}
                className="text-[13px] text-[var(--color-ink)]"
              />
            </Field>
            <Field label="金额">
              <span className="flex items-baseline gap-0.5">
                <span className="font-mono text-[12px] text-[var(--color-ink-3)]">¥</span>
                <OutsourceBlockAmount
                  blockId={block.id}
                  jobId={jobId}
                  value={block.amountCny}
                  className="min-w-[4ch] text-[13px] text-[var(--color-ink)] [field-sizing:content]"
                />
              </span>
            </Field>
            <Field label="寄出">
              <OutsourceBlockDate
                blockId={block.id}
                jobId={jobId}
                field="sentDate"
                value={block.sentDate}
                className="text-[13px] text-[var(--color-ink-2)]"
                formatLabel={md}
                hideIcon
              />
            </Field>
            <Field label="要求回厂">
              <OutsourceBlockDate
                blockId={block.id}
                jobId={jobId}
                field="expectedReturn"
                value={block.expectedReturn}
                className="text-[13px] text-[var(--color-ink-2)]"
                formatLabel={md}
                hideIcon
              />
            </Field>
            <Field label="工序">
              <BlockStagesEditor
                blockId={block.id}
                jobId={jobId}
                stages={block.stages}
                activity={block.activity}
                vendors={vendors}
                disabled={pending}
                onSaved={() => {}}
              />
            </Field>
            <Field label="工单">
              <Link
                href={`/jobs/${jobId}`}
                className="font-mono text-[12px] text-[var(--color-ink-2)] underline-offset-4 hover:underline"
              >
                {line.jobNo || '—'}
              </Link>
              <span className="ml-2 text-[12px] text-[var(--color-ink-3)]">
                {line.customer} · {line.product}
              </span>
            </Field>
            {block.docNo && (
              <Field label="单号">
                <span className="font-mono text-[12px] text-[var(--color-ink-2)]">{block.docNo}</span>
              </Field>
            )}
          </dl>

          <div className="mt-2 text-[12px] leading-snug">
            <OutsourceBlockNotes
              blockId={block.id}
              jobId={jobId}
              value={block.notes}
              className={block.notes ? 'text-[var(--color-ink-2)]' : 'text-[var(--color-ink-3)]'}
            />
          </div>

          <div className="mt-3 flex items-center gap-4 text-[12px]">
            <a
              href={withBase(`/print/outsource/${block.id}`)}
              target="_blank"
              rel="noopener"
              className="text-[var(--color-ink-2)] underline-offset-4 hover:text-[var(--color-ink)] hover:underline"
            >
              打印外协单
            </a>
            {armed ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setArmed(false)
                  onDeleted()
                  start(async () => {
                    await mutate({ kind: 'deleteOutsourceBlock', blockId: block.id, jobId })
                  })
                }}
                className="text-[var(--color-overdue)]"
              >
                确认撤销外协
              </button>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={() => setArmed(true)}
                className="text-[var(--color-ink-3)] hover:text-[var(--color-overdue)]"
              >
                撤销外协
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="label w-[52px] shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  )
}

// ── 找厂商 / 客户 ───────────────────────────────────────────────────────────

type Opt = { name: string; count: number }

// Clicking the field drops the vendors and customers already in view, ranked
// by how many 外协单 they hold — so the common case ("何秀龙 的单呢") is one
// click, no typing. Typing narrows the lists AND live-filters the sheet, so a
// 工号 or 零件 you type still works even though it's in neither list.
function ScopeSearch({
  q,
  setQ,
  scope,
  setScope,
  vendorOpts,
  customerOpts,
}: {
  q: string
  setQ: (s: string) => void
  scope: Scope | null
  setScope: (s: Scope | null) => void
  vendorOpts: Opt[]
  customerOpts: Opt[]
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const needle = q.trim().toLowerCase()
  const match = (o: Opt) => !needle || o.name.toLowerCase().includes(needle)
  const vs = vendorOpts.filter(match).slice(0, 12)
  const cs = customerOpts.filter(match).slice(0, 12)
  const flat: Scope[] = [
    ...vs.map((o) => ({ kind: 'vendor' as const, name: o.name })),
    ...cs.map((o) => ({ kind: 'customer' as const, name: o.name })),
  ]

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const choose = (s: Scope | null) => {
    setScope(s)
    setQ('')
    setOpen(false)
    inputRef.current?.blur()
  }

  return (
    <div ref={wrapRef} className="relative w-[280px]">
      <div
        className={`flex h-[30px] items-center gap-1.5 rounded-[2px] border bg-[var(--color-surface)] px-2 transition-colors ${
          open || scope ? 'border-[var(--color-ink)]' : 'border-[var(--color-border-strong)]'
        }`}
      >
        <span className="shrink-0 text-[var(--color-ink-3)]">
          <SearchIcon />
        </span>
        {scope && (
          <span className="flex shrink-0 items-baseline gap-1 rounded-[2px] bg-[var(--color-active-bg)] px-1.5 py-[1px] text-[12px] text-[var(--color-ink)]">
            <span className="text-[10px] text-[var(--color-ink-3)]">
              {scope.kind === 'vendor' ? '厂' : '客'}
            </span>
            {scope.name}
          </span>
        )}
        <input
          ref={inputRef}
          type="text"
          value={q}
          onFocus={() => {
            setActive(0)
            setOpen(true)
          }}
          onChange={(e) => {
            setQ(e.target.value)
            setActive(0)
            if (!open) setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setOpen(true)
              setActive((i) => Math.min(i + 1, flat.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const s = flat[active]
              if (s) choose(s)
              else setOpen(false)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setOpen(false)
              inputRef.current?.blur()
            }
          }}
          placeholder={scope ? '' : '供应商 · 客户 · 工号 · 零件…'}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-3)] focus:outline-none"
        />
        {(scope || q) && (
          <button
            type="button"
            onClick={() => choose(null)}
            aria-label="清除筛选"
            className="shrink-0 text-[var(--color-ink-3)] transition-colors hover:text-[var(--color-ink)]"
          >
            <ClearIcon />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute left-0 z-40 mt-1 w-[300px] overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg">
          <div className="max-h-[340px] overflow-auto py-1">
            {scope && (
              <button
                type="button"
                onClick={() => choose(null)}
                className="w-full px-2.5 py-1.5 text-left text-[13px] text-[var(--color-ink-2)] hover:bg-black/5"
              >
                全部
              </button>
            )}
            <OptGroup
              title="供应商"
              opts={vs}
              kind="vendor"
              offset={0}
              active={active}
              scope={scope}
              onHover={setActive}
              onPick={choose}
            />
            <OptGroup
              title="客户"
              opts={cs}
              kind="customer"
              offset={vs.length}
              active={active}
              scope={scope}
              onHover={setActive}
              onPick={choose}
            />
            {flat.length === 0 && (
              <p className="px-2.5 py-2 text-[12px] text-[var(--color-ink-3)]">
                无匹配的供应商或客户 — 按回车用它搜工号 / 零件
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function OptGroup({
  title,
  opts,
  kind,
  offset,
  active,
  scope,
  onHover,
  onPick,
}: {
  title: string
  opts: Opt[]
  kind: 'vendor' | 'customer'
  offset: number
  active: number
  scope: Scope | null
  onHover: (i: number) => void
  onPick: (s: Scope) => void
}) {
  if (opts.length === 0) return null
  return (
    <>
      <p className="label px-2.5 pb-0.5 pt-1.5">{title}</p>
      {opts.map((o, i) => {
        const idx = offset + i
        const on = scope?.kind === kind && scope.name === o.name
        return (
          <button
            key={`${kind}-${o.name}`}
            type="button"
            onMouseEnter={() => onHover(idx)}
            onClick={() => onPick({ kind, name: o.name })}
            className={`flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left ${
              idx === active ? 'bg-black/5' : ''
            }`}
          >
            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-ink)]">
              {o.name}
              {on && <span className="ml-1.5 text-[var(--color-ink-3)]">✓</span>}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-ink-3)]">
              {o.count}
            </span>
          </button>
        )
      })}
    </>
  )
}

// ── controls ───────────────────────────────────────────────────────────────

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-[2px] border border-[var(--color-border)]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-3 py-1 text-[13px] transition-colors ${
            value === o.value
              ? 'bg-[var(--color-active-bg)] font-medium text-[var(--color-ink)]'
              : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Chips({
  current,
  onSelect,
  options,
}: {
  current: string | null
  onSelect: (v: string | null) => void
  options: Opt[]
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Chip label="全部工序" on={current === null} onClick={() => onSelect(null)} />
      {options.map((o) => (
        <Chip
          key={o.name}
          label={o.name}
          count={o.count}
          on={current === o.name}
          onClick={() => onSelect(current === o.name ? null : o.name)}
        />
      ))}
    </div>
  )
}

function Chip({
  label,
  count,
  on,
  onClick,
}: {
  label: string
  count?: number
  on: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={on ? 'true' : undefined}
      className={`whitespace-nowrap rounded-[2px] px-2.5 py-1 text-[13px] transition-colors ${
        on
          ? 'bg-[var(--color-active-bg)] font-medium text-[var(--color-ink)]'
          : 'text-[var(--color-ink-3)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]'
      }`}
    >
      {label}
      {count != null && (
        <span className="ml-1.5 text-[11px] tabular-nums text-[var(--color-ink-4)]">{count}</span>
      )}
    </button>
  )
}

function FlagChip({
  tone,
  label,
  value,
  on,
  onClick,
}: {
  tone: 'overdue' | 'warning'
  label: string
  value: number
  on: boolean
  onClick: () => void
}) {
  const color = tone === 'overdue' ? 'var(--color-overdue)' : 'var(--color-warning)'
  const soft = tone === 'overdue' ? 'var(--color-overdue-soft)' : 'var(--color-warning-soft)'
  return (
    <button
      type="button"
      onClick={onClick}
      title={`只看${label}`}
      className="inline-flex items-baseline gap-1.5 rounded-[2px] border px-2 py-[3px] text-[10px] uppercase tracking-[0.14em] transition-colors"
      style={{
        borderColor: color,
        color,
        backgroundColor: on ? soft : 'transparent',
      }}
    >
      <span>{label}</span>
      <span className="font-mono text-[12px] font-medium tracking-normal">{value}</span>
    </button>
  )
}

function PeriodBar({
  gran,
  anchor,
  today,
  onGran,
  onStep,
  onToday,
}: {
  gran: Gran
  anchor: string
  today: string
  onGran: (g: Gran) => void
  onStep: (d: number) => void
  onToday: () => void
}) {
  const bounds = gran === 'all' ? null : windowDateBounds(anchor, gran)
  const containsToday = bounds ? bounds.from <= today && today <= bounds.to : true
  return (
    <div className="flex items-center gap-1.5">
      <div className="inline-flex overflow-hidden rounded-[2px] border border-[var(--color-border)]">
        {(['all', 'day', 'week', 'month'] as Gran[]).map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => onGran(g)}
            className={`px-2.5 py-1 text-[12px] transition-colors ${
              gran === g
                ? 'bg-[var(--color-active-bg)] font-medium text-[var(--color-ink)]'
                : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
            }`}
          >
            {g === 'all' ? '全部' : g === 'day' ? '日' : g === 'week' ? '周' : '月'}
          </button>
        ))}
      </div>
      {gran !== 'all' && (
        <>
          <div className="flex items-center gap-0.5">
            <Step dir={-1} onClick={() => onStep(-1)} />
            <span className="min-w-[128px] text-center text-[13px] font-medium tabular-nums text-[var(--color-ink)]">
              {readout(anchor, gran)}
            </span>
            <Step dir={1} onClick={() => onStep(1)} />
          </div>
          {!containsToday && (
            <button
              type="button"
              onClick={onToday}
              className="rounded-[2px] px-2 py-1 text-[12px] text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
            >
              今天
            </button>
          )}
        </>
      )}
    </div>
  )
}

function Step({ dir, onClick }: { dir: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={dir < 0 ? '上一周期' : '下一周期'}
      className="inline-flex h-7 w-7 items-center justify-center rounded-[2px] text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden className={dir > 0 ? 'rotate-180' : ''}>
        <path d="M8.5 3.5 L5 7 L8.5 10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

function Stat({ value, sub, label }: { value: string; sub?: string; label: string }) {
  return (
    <div>
      <p className="text-[24px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)] md:text-[28px]">
        {value}
        {sub && <span className="ml-2 text-[13px] font-normal text-[var(--color-ink-3)]">{sub}</span>}
      </p>
      <p className="label mt-1.5">{label}</p>
    </div>
  )
}

function SearchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <circle cx="5" cy="5" r="3.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7.6 7.6 L10.5 10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function ClearIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

// ── pure helpers ───────────────────────────────────────────────────────────

export type LedgerLine = Line

function toLine(
  r: OpenBlockRow,
  patch: OutsourceBlock | undefined,
  vendors: Vendor[],
  today: string,
): Line {
  const block = patch ?? r.block
  const vendor = vendorById(block.vendorId, vendors)
  const vendorName = vendor?.name ?? block.vendorId
  const activity = blockActivityLabel(block)
  const closed = isBlockClosed(block)
  const closedAt = blockClosedAt(block)
  const totalQty = block.members.reduce((s, m) => s + m.qty, 0)
  const returnedQty = block.members.reduce((s, m) => s + memberReturnedQty(m), 0)
  const daysLeft = daysFromToday(block.expectedReturn, today)

  const hayParts: string[] = [
    r.jobNo,
    r.customer,
    r.product,
    vendorName,
    vendor?.notes ?? '',
    block.docNo ?? '',
    activity,
    ...block.stages,
    block.notes ?? '',
  ]
  for (const m of block.members) {
    hayParts.push(m.name)
    if (m.partNo) hayParts.push(m.partNo)
    if (m.material) hayParts.push(m.material)
  }

  return {
    key: block.id,
    jobId: r.jobId,
    jobNo: r.jobNo,
    customer: r.customer,
    product: r.product,
    block,
    vendor,
    vendorName,
    activity,
    closed,
    closedAt,
    ledgerDate: (closed ? closedAt : undefined) ?? block.sentDate,
    totalQty,
    returnedQty,
    remainingQty: Math.max(0, totalQty - returnedQty),
    daysLeft,
    overdue: !closed && daysLeft < 0,
    hay: hayParts.join(' ').toLowerCase(),
  }
}

function buildOptions(lines: Line[]): {
  vendorOpts: Opt[]
  customerOpts: Opt[]
  activityOpts: Opt[]
} {
  const v = new Map<string, number>()
  const c = new Map<string, number>()
  const a = new Map<string, number>()
  for (const l of lines) {
    v.set(l.vendorName, (v.get(l.vendorName) ?? 0) + 1)
    c.set(l.customer, (c.get(l.customer) ?? 0) + 1)
    a.set(l.activity, (a.get(l.activity) ?? 0) + 1)
  }
  const rank = (m: Map<string, number>): Opt[] =>
    [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))
  return { vendorOpts: rank(v), customerOpts: rank(c), activityOpts: rank(a) }
}

function groupByDate(lines: Line[]): { date: string; lines: Line[] }[] {
  const out: { date: string; lines: Line[] }[] = []
  for (const l of lines) {
    const d = l.ledgerDate
    const last = out[out.length - 1]
    if (last && last.date === d) last.lines.push(l)
    else out.push({ date: d, lines: [l] })
  }
  return out
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

function md(ymd?: string): string {
  if (!ymd) return '—'
  const p = ymd.slice(0, 10).split('-')
  if (p.length < 3) return ymd
  return `${Number(p[1])}-${Number(p[2])}`
}

function dayLabel(ymd: string): string {
  const p = ymd.split('-').map(Number)
  if (p.length < 3) return ymd
  const wd = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()
  return `${p[1]}月${p[2]}日 周${WEEKDAY[wd]}`
}

function readout(anchor: string, gran: Gran): string {
  const [y, m] = anchor.split('-').map(Number)
  if (gran === 'month') return `${y}年${m}月`
  if (gran === 'day') return dayLabel(anchor)
  const b = windowDateBounds(anchor, 'week')
  const [, fm, fd] = b.from.split('-').map(Number)
  const [, tm, td] = b.to.split('-').map(Number)
  return `${fm}月${fd}日 – ${tm}月${td}日`
}

function partsTitle(block: OutsourceBlock): string {
  return block.members.map((m) => `${m.name} ×${m.qty}`).join(' · ')
}
