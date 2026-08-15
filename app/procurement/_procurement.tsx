'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { SearchSelect } from '@/app/_search_select'
import { ProcurementExportButton } from './_export_excel'
import {
  dueState,
  daysFromToday,
  formatCny,
  procurementTotalCny,
  PROCUREMENT_CATEGORIES,
} from '@/lib/data'
import type {
  Procurement,
  ProcurementProduct,
  ProcurementStatus,
} from '@/lib/data'
import type { ProcurementJobOption } from '@/lib/db'

// 采购 board — a five-step conveyor read through five rectangular filter
// boxes: 待审批 → 待采购 → 待到货 → 待领料 → 已领料. One table per box; each
// table carries its own money strip (笔数 · ¥) at the top, the 已领料 ledger
// browses month by month with 导出. A row click opens an inline panel holding
// that row's whole story (请购 → 批 → 下单 → 到货 → 领) and exactly the
// actions its stage allows. ＋请购 is the only entry point — every request,
// approvers' included, is born 待审批; approval moves it to 待采购, placing
// (paying) the order to 待到货, arrival to 待领料, and the named 领料人
// collecting it closes the loop.

type Tab = 'requested' | 'purchase' | 'buying' | 'arrived' | 'ledger'

const TAB_DEF: Record<
  Tab,
  { label: string; col: string; match: (p: Procurement) => boolean }
> = {
  requested: {
    label: '待审批',
    col: '请购',
    match: (p) => p.status === 'requested',
  },
  purchase: {
    label: '待采购',
    col: '批准',
    match: (p) => p.status === 'approved',
  },
  buying: {
    label: '待到货',
    col: '预计到货',
    match: (p) => p.status === 'ordered',
  },
  arrived: {
    label: '待领料',
    col: '领料人',
    match: (p) => p.status === 'arrived',
  },
  ledger: {
    label: '已领料',
    col: '领料',
    match: (p) => p.status === 'done' || p.status === 'rejected',
  },
}

const TAB_EMPTY: Record<Tab, string> = {
  requested: '没有等审批的请购',
  purchase: '没有等下单的采购',
  buying: '料都到齐了',
  arrived: '到了的料都领走了',
  ledger: '本月没有记录',
}

type ModalMode = { kind: 'request' } | { kind: 'edit'; row: Procurement } | null

export function ProcurementBoard({
  procurements,
  products,
  jobOptions,
  roster,
  currentUser,
  canApprove,
  today,
}: {
  procurements: Procurement[]
  products: ProcurementProduct[]
  jobOptions: ProcurementJobOption[]
  roster: string[]
  currentUser: string
  canApprove: boolean
  today: string
}) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<Tab>('buying')
  const [openId, setOpenId] = useState<string | null>(null)
  const [modal, setModal] = useState<ModalMode>(null)

  const query = q.trim().toLowerCase()
  const matches = (p: Procurement) =>
    !query ||
    p.item.toLowerCase().includes(query) ||
    (p.supplier ?? '').toLowerCase().includes(query) ||
    (p.jobNo ?? '').toLowerCase().includes(query) ||
    (p.notes ?? '').toLowerCase().includes(query) ||
    (p.requester ?? '').toLowerCase().includes(query) ||
    (p.picker ?? '').toLowerCase().includes(query) ||
    p.buyer.toLowerCase().includes(query)

  const counts = useMemo(() => {
    const n = (t: Tab) => procurements.filter(TAB_DEF[t].match).length
    const overdue = procurements.filter(
      (p) =>
        p.status === 'ordered' &&
        p.expectedDate &&
        dueState(p.expectedDate, today) === 'overdue',
    ).length
    const done = procurements.filter((p) => p.status === 'done').length
    return {
      requested: n('requested'),
      purchase: n('purchase'),
      buying: n('buying'),
      arrived: n('arrived'),
      done,
      overdue,
    }
  }, [procurements, today])

  // The active tab's rows, queue-sorted. 待到货 reads soonest-expected first;
  // the waiting queues read oldest-first; the ledger reads newest-first.
  const rows = useMemo(() => {
    const list = procurements.filter(TAB_DEF[tab].match).filter(matches)
    if (tab === 'buying') {
      list.sort((a, b) => {
        const ae = a.expectedDate ?? '9999-99-99'
        const be = b.expectedDate ?? '9999-99-99'
        if (ae !== be) return ae < be ? -1 : 1
        return a.orderDate < b.orderDate ? -1 : 1
      })
    } else if (tab === 'requested') {
      list.sort((a, b) =>
        (a.reqDate ?? a.orderDate) < (b.reqDate ?? b.orderDate) ? -1 : 1,
      )
    } else if (tab === 'purchase') {
      list.sort((a, b) =>
        (a.approveDate ?? a.reqDate ?? a.orderDate) <
        (b.approveDate ?? b.reqDate ?? b.orderDate)
          ? -1
          : 1,
      )
    } else if (tab === 'arrived') {
      list.sort((a, b) =>
        (a.arrivedDate ?? a.orderDate) < (b.arrivedDate ?? b.orderDate) ? -1 : 1,
      )
    } else {
      list.sort((a, b) => (ledgerDate(a) < ledgerDate(b) ? 1 : -1))
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [procurements, tab, query])

  // 已领料 months (by 领料 date), newest first — browsed one month at a time.
  const ledgerMonths = useMemo(() => {
    const s = new Set<string>()
    for (const p of procurements) {
      if (TAB_DEF.ledger.match(p)) s.add(ledgerDate(p).slice(0, 7))
    }
    return [...s].sort().reverse()
  }, [procurements])

  // Split-off picks grouped under the row they were taken from, oldest first
  // — the remainder's panel lists them so the whole 领料 story reads in place.
  const picksByParent = useMemo(() => {
    const m = new Map<string, Procurement[]>()
    for (const p of procurements) {
      if (p.parentId && p.status === 'done') {
        const l = m.get(p.parentId) ?? []
        l.push(p)
        m.set(p.parentId, l)
      }
    }
    for (const l of m.values())
      l.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    return m
  }, [procurements])

  const [pickedMonth, setPickedMonth] = useState<string | null>(null)
  const ledgerMonth =
    pickedMonth && ledgerMonths.includes(pickedMonth)
      ? pickedMonth
      : (ledgerMonths[0] ?? null)

  const ledgerRows = useMemo(
    () => rows.filter((p) => ledgerDate(p).slice(0, 7) === ledgerMonth),
    [rows, ledgerMonth],
  )

  const shown = tab === 'ledger' ? ledgerRows : rows

  // The money strip over each table — the 笔数 counts what's listed, the ¥
  // sums the rows that carry a price. 驳回 rows are dead, not spend.
  const strip = useMemo(() => {
    const counted = shown.filter((p) => p.status !== 'rejected')
    let sum = 0
    for (const p of counted) {
      const t = procurementTotalCny(p)
      if (typeof t === 'number') sum += t
    }
    return { count: counted.length, sum }
  }, [shown])

  function onDone() {
    setModal(null)
    router.refresh()
  }

  const boxes: { key: Tab; count: number | null; hot?: number }[] = [
    { key: 'requested', count: counts.requested },
    { key: 'purchase', count: counts.purchase },
    { key: 'buying', count: counts.buying, hot: counts.overdue },
    { key: 'arrived', count: counts.arrived },
    { key: 'ledger', count: counts.done },
  ]

  return (
    <div className="mx-auto max-w-5xl">
      {/* Top row — rectangular filter boxes, search, ＋请购. */}
      <div className="mb-4 flex flex-wrap items-stretch gap-2">
        {boxes.map((b) => {
          const on = tab === b.key
          return (
            <button
              key={b.key}
              type="button"
              onClick={() => {
                setTab(b.key)
                setOpenId(null)
              }}
              className={`inline-flex items-baseline gap-2 whitespace-nowrap rounded-[2px] border bg-[var(--color-surface)] px-3.5 py-[7px] ${
                on
                  ? 'border-[var(--color-ink)] shadow-[inset_0_0_0_1px_var(--color-ink)]'
                  : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
              }`}
            >
              <span
                className={`text-[12.5px] ${
                  on
                    ? 'font-semibold text-[var(--color-ink)]'
                    : 'font-medium text-[var(--color-ink-2)]'
                }`}
              >
                {TAB_DEF[b.key].label}
              </span>
              {b.count !== null && (
                <span className="mono text-[14px] font-semibold text-[var(--color-ink)]">
                  {b.count}
                </span>
              )}
              {b.hot ? (
                <span className="text-[11px] font-semibold text-[var(--color-overdue)]">
                  · 逾期{b.hot}
                </span>
              ) : null}
            </button>
          )
        })}
        <div className="flex-1" />
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <SearchIcon />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索 · 品名 / 供应商 / 工号"
              className="h-9 w-[190px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] pl-8 pr-3 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)] md:w-[240px]"
            />
          </div>
          <button
            type="button"
            onClick={() => setModal({ kind: 'request' })}
            className="h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85"
          >
            ＋ 请购
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        {/* The table's own header strip — its money lives with its list. */}
        {tab === 'ledger' ? (
          <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] px-5 py-2.5">
            <MonthNav
              months={ledgerMonths}
              month={ledgerMonth}
              onPick={setPickedMonth}
            />
            <span className="mono text-[13px] font-semibold text-[var(--color-ink)]">
              {strip.count} 笔 · {formatCny(strip.sum)}
            </span>
            <div className="ml-auto">
              <ProcurementExportButton
                rows={ledgerRows}
                filename={`采购台账_${ledgerMonth ?? today.slice(0, 7)}`}
                compact
              />
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-5 py-2.5">
            <span className="mono text-[13px] font-semibold text-[var(--color-ink)]">
              {strip.count} 笔 · {formatCny(strip.sum)}
            </span>
          </div>
        )}

        {/* Column header — desktop only. */}
        <div className="hidden grid-cols-[14px_minmax(0,1fr)_170px_150px_110px] items-center gap-4 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid">
          <span />
          <span className="label">品名 · 供应商</span>
          <span className="label text-right">金额 · 数量</span>
          <span className="label">{TAB_DEF[tab].col}</span>
          <span className="label text-right">经手</span>
        </div>

        {shown.length === 0 ? (
          <p className="px-5 py-10 text-center text-[13px] text-[var(--color-ink-3)]">
            {query ? '没有匹配的记录' : TAB_EMPTY[tab]}
          </p>
        ) : (
          shown.map((p) => (
            <Row
              key={p.id}
              p={p}
              today={today}
              dim={tab === 'ledger'}
              open={openId === p.id}
              onToggle={() => setOpenId(openId === p.id ? null : p.id)}
              canApprove={canApprove}
              jobOptions={jobOptions}
              roster={roster}
              pastPicks={(picksByParent.get(p.parentId ?? p.id) ?? []).filter(
                (x) => x.id !== p.id,
              )}
              onEdit={() => setModal({ kind: 'edit', row: p })}
            />
          ))
        )}
      </div>

      {modal && (
        <ProcurementModal
          mode={modal.kind === 'edit' ? 'edit' : 'request'}
          initial={modal.kind === 'edit' ? modal.row : null}
          products={products}
          jobOptions={jobOptions}
          roster={roster}
          currentUser={currentUser}
          today={today}
          onDone={(created) => {
            if (created) setTab('requested')
            onDone()
          }}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  )
}

// A row's date in the 已领料 ledger — 领料 day for done rows, 驳回 day for
// rejected ones (they never got picked).
function ledgerDate(p: Procurement): string {
  return p.pickDate ?? p.rejectDate ?? p.arrivedDate ?? p.orderDate
}

// 数量 with its ordered total once partial 领料 has split the row —
// `17 / 20 件` reads 17 left of the 20 ordered (待领料), or 3 of 20 taken
// (a split-off 已领料 row). Never-split rows stay plain `20 件`.
function qtyText(p: Procurement): string {
  if (typeof p.qty !== 'number') return ''
  return p.orderedQty != null && p.orderedQty !== p.qty
    ? `${p.qty} / ${p.orderedQty} 件`
    : `${p.qty} 件`
}

// ===========================================================================
// Row + inline panel
// ===========================================================================

function Row({
  p,
  today,
  dim,
  open,
  onToggle,
  canApprove,
  jobOptions,
  roster,
  pastPicks,
  onEdit,
}: {
  p: Procurement
  today: string
  dim: boolean
  open: boolean
  onToggle: () => void
  canApprove: boolean
  jobOptions: ProcurementJobOption[]
  roster: string[]
  pastPicks: Procurement[]
  onEdit: () => void
}) {
  const total = procurementTotalCny(p)
  return (
    <>
      <div
        onClick={onToggle}
        className={`grid cursor-pointer grid-cols-[14px_minmax(0,1fr)_130px] items-center gap-3 border-b border-[var(--color-border)] px-4 py-3.5 last:border-b-0 md:grid-cols-[14px_minmax(0,1fr)_170px_150px_110px] md:gap-4 md:px-5 md:py-4 ${
          open ? 'bg-[#faf8f2]' : 'hover:bg-[#faf8f2]'
        }`}
      >
        <span className="flex justify-center">
          <StatusDot p={p} today={today} />
        </span>
        <div className="min-w-0">
          <div
            className={`truncate tracking-tight ${
              dim
                ? 'text-[14px] font-medium text-[var(--color-ink-2)]'
                : 'text-[15px] font-semibold text-[var(--color-ink)]'
            }`}
          >
            {p.item}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-[var(--color-ink-3)]">
            {p.jobNo && (
              <span className="mono text-[var(--color-ink-2)]">{p.jobNo} · </span>
            )}
            {p.supplier || '供应商待定'}
            {p.notes ? ` · ${p.notes}` : ''}
          </div>
        </div>
        <div className="hidden text-right md:block">
          {typeof total === 'number' ? (
            <>
              <div className="mono text-[15px] font-semibold text-[var(--color-ink)]">
                {formatCny(total)}
              </div>
              <div className="mono text-[11.5px] text-[var(--color-ink-3)]">
                {qtyText(p)}{typeof p.unitPriceCny === 'number' ? ` × ¥${p.unitPriceCny}` : ''}
              </div>
            </>
          ) : (
            <>
              <div className="text-[15px] text-[var(--color-ink-4)]">—</div>
              <div className="mono text-[11.5px] text-[var(--color-ink-3)]">
                {qtyText(p)}
              </div>
            </>
          )}
        </div>
        <div className="truncate text-right text-[12.5px] md:text-left">
          <StateCell p={p} today={today} />
        </div>
        <div className="hidden truncate text-right text-[12.5px] text-[var(--color-ink-2)] md:block">
          {whoFor(p)}
        </div>
      </div>
      {open && (
        <Panel
          p={p}
          today={today}
          canApprove={canApprove}
          jobOptions={jobOptions}
          roster={roster}
          pastPicks={pastPicks}
          onEdit={onEdit}
          onClose={onToggle}
        />
      )}
    </>
  )
}

function whoFor(p: Procurement): string {
  if (p.status === 'requested' || p.status === 'rejected')
    return p.requester ?? ''
  if (p.status === 'arrived' || p.status === 'done')
    return p.picker ?? p.requester ?? ''
  return p.buyer || p.requester || ''
}

function StatusDot({ p, today }: { p: Procurement; today: string }) {
  // 待下单 — hollow amber ring: cleared, but nothing is moving yet.
  if (p.status === 'approved') {
    return (
      <span
        className="inline-block h-[7px] w-[7px] shrink-0 rounded-full border-[1.5px]"
        style={{ borderColor: 'var(--color-warning)' }}
        aria-hidden="true"
      />
    )
  }
  const st =
    p.status === 'ordered' && p.expectedDate
      ? dueState(p.expectedDate, today)
      : null
  const color =
    p.status === 'arrived'
      ? 'var(--color-success)'
      : p.status === 'done' || p.status === 'rejected'
        ? 'var(--color-ink-4)'
        : st === 'overdue'
          ? 'var(--color-overdue)'
          : st === 'today' || st === 'soon'
            ? 'var(--color-warning)'
            : 'var(--color-info)'
  return (
    <span
      className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  )
}

// The tab's third column — each status answers its own question there.
function StateCell({ p, today }: { p: Procurement; today: string }) {
  if (p.status === 'requested')
    return (
      <span className="text-[var(--color-ink)]">
        {p.requester}
        <span className="text-[var(--color-ink-3)]">
          {' '}
          · {relDay(p.reqDate ?? p.orderDate, today)}
        </span>
      </span>
    )
  if (p.status === 'approved')
    return (
      <span className="text-[var(--color-ink)]">
        {p.approver ?? '—'}
        <span className="text-[var(--color-ink-3)]">
          {' '}
          · {relDay(p.approveDate ?? p.reqDate ?? p.orderDate, today)}批
        </span>
      </span>
    )
  if (p.status === 'ordered') {
    if (!p.expectedDate)
      return <span className="text-[var(--color-ink-3)]">未定到货</span>
    const d = daysFromToday(p.expectedDate, today)
    if (d < 0)
      return (
        <span className="font-medium text-[var(--color-overdue)]">
          逾期 {-d} 天
        </span>
      )
    if (d === 0)
      return <span className="font-medium text-[var(--color-ink)]">今天到</span>
    return (
      <span className="mono text-[var(--color-ink)]">{mdCn(p.expectedDate)}</span>
    )
  }
  if (p.status === 'arrived')
    return (
      <span className="text-[var(--color-ink)]">
        {p.picker ?? '—'}
        <span className="text-[var(--color-ink-3)]">
          {' '}
          · {relDay(p.arrivedDate ?? p.orderDate, today)}到
        </span>
      </span>
    )
  if (p.status === 'rejected')
    return <span className="text-[var(--color-ink-3)]">已驳回</span>
  return (
    <span className="text-[var(--color-ink-3)]">
      <span className="mono">{p.pickDate ? mdCn(p.pickDate) : ''}</span>
      {p.picker ? ` ${p.picker} 领` : ' 已领料'}
      {p.pickQty != null && <span className="mono"> {p.pickQty} 件</span>}
      {p.inspectResult === 'defect' && (
        <span className="font-medium text-[var(--color-overdue)]"> 不良</span>
      )}
    </span>
  )
}

// The expanded panel — the row's whole story, then exactly the actions its
// stage allows. Every mutation is a labeled button; nothing writes silently.
function Panel({
  p,
  today,
  canApprove,
  jobOptions,
  roster,
  pastPicks,
  onEdit,
  onClose,
}: {
  p: Procurement
  today: string
  canApprove: boolean
  jobOptions: ProcurementJobOption[]
  roster: string[]
  pastPicks: Procurement[]
  onEdit: () => void
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [armReject, setArmReject] = useState(false)
  const [armBad, setArmBad] = useState(false)
  const [armDelete, setArmDelete] = useState(false)
  const [note, setNote] = useState('')
  const [calOpen, setCalOpen] = useState(false)
  // 待采购 panel edits — held locally, committed by the labeled 已下单 button.
  const [supplier, setSupplier] = useState(p.supplier ?? '')
  const [price, setPrice] = useState(
    p.unitPriceCny != null ? String(p.unitPriceCny) : '',
  )
  const [expected, setExpected] = useState(p.expectedDate ?? '')
  // 待领料 — who actually walks off with the material, and how many. Name is
  // free text (仓库 hands material to people who aren't in the system); qty
  // presets to the ordered 数量 so the full-pick case is one tap. The 领料
  // button won't fire without both.
  const [pickerSel, setPickerSel] = useState(p.picker ?? '')
  const [pickQty, setPickQty] = useState(p.qty ? String(p.qty) : '')

  function run(patch: Record<string, unknown>, close = true) {
    start(async () => {
      await mutate({ kind: 'updateProcurement', procurementId: p.id, patch })
      if (close) onClose()
      router.refresh()
    })
  }

  function del() {
    start(async () => {
      await mutate({ kind: 'deleteProcurement', procurementId: p.id })
      router.refresh()
    })
  }

  const job = p.jobId ? jobOptions.find((j) => j.id === p.jobId) : undefined

  const btn =
    'rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--color-ink-2)] hover:border-[var(--color-ink-3)] hover:text-[var(--color-ink)] disabled:opacity-50'
  const btnPri =
    'rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-ink)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50'
  const btnDanger =
    'rounded-[2px] bg-[var(--color-overdue-soft)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--color-overdue)] hover:opacity-85 disabled:opacity-50'
  const inp =
    'rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'

  return (
    <div className="border-b border-[var(--color-border)] bg-[#faf8f2] px-5 pb-4 pt-3 last:border-b-0 md:pl-[52px]">
      {(p.jobNo || job) && (
        <div className="my-0.5 text-[12px] text-[var(--color-ink-3)]">
          {p.jobId ? (
            <Link
              href={`/jobs/${p.jobId}`}
              className="mono text-[var(--color-info)] hover:underline"
            >
              {p.jobNo || job?.jobNo}
            </Link>
          ) : (
            <span className="mono text-[var(--color-ink-2)]">{p.jobNo}</span>
          )}
          {job?.product ? ` · ${job.product}` : ''}
        </div>
      )}
      {p.notes && (
        <div className="my-0.5 text-[12px] text-[var(--color-ink-3)]">
          {p.notes}
        </div>
      )}
      <div className="my-0.5 text-[12px] text-[var(--color-ink-3)]">
        <HistoryLine p={p} picks={pastPicks} />
      </div>

      {/* Stage actions */}
      {p.status === 'requested' &&
        (canApprove ? (
          armReject ? (
            <>
              <div className="mt-2.5 max-w-[480px]">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  placeholder={`驳回原因 · 让 ${p.requester ?? '请购人'} 知道为什么`}
                  autoFocus
                  className="w-full resize-none rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12.5px] outline-none"
                />
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  className={btn}
                  onClick={() => setArmReject(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={btnDanger}
                  disabled={pending}
                  onClick={() =>
                    run({ status: 'rejected', rejectNote: note.trim() || null })
                  }
                >
                  确认驳回
                </button>
              </div>
            </>
          ) : (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <span className="text-[12px] text-[var(--color-ink-3)]">
                领料人 {p.picker ?? '—'}
              </span>
              <button
                type="button"
                className={`${btnPri} ml-auto`}
                disabled={pending}
                onClick={() => run({ status: 'approved' })}
              >
                批准
              </button>
              <button
                type="button"
                className={btn}
                onClick={() => setArmReject(true)}
              >
                驳回
              </button>
            </div>
          )
        ) : (
          <div className="mt-2.5 text-[12px] text-[var(--color-ink-3)]">
            等审批 · 领料人 {p.picker ?? '—'}
          </div>
        ))}

      {p.status === 'approved' && (
        <>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <input
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              placeholder="供应商"
              className={`${inp} w-[160px]`}
            />
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="decimal"
              placeholder="单价 ¥"
              className={`${inp} mono w-[84px]`}
            />
            <button
              type="button"
              className={calOpen ? btnPri : btn}
              onClick={() => setCalOpen((v) => !v)}
            >
              {expected ? `${mdCn(expected)} 到` : '几号到？'}
            </button>
            <button
              type="button"
              className={`${btnPri} ml-auto`}
              disabled={pending}
              onClick={() =>
                run({
                  status: 'ordered',
                  orderDate: today,
                  supplier: supplier.trim() || null,
                  unitPriceCny: parseNum(price) ?? null,
                  expectedDate: expected || null,
                })
              }
            >
              已下单
            </button>
          </div>
          {calOpen && (
            <MiniCalendar
              value={expected || undefined}
              today={today}
              onPick={(iso) => {
                setExpected(iso)
                setCalOpen(false)
              }}
            />
          )}
        </>
      )}

      {p.status === 'ordered' && (
        <>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={calOpen ? btnPri : btn}
              onClick={() => setCalOpen((v) => !v)}
            >
              {p.expectedDate ? `${mdCn(p.expectedDate)} 到 · 改` : '几号到？'}
            </button>
            <button
              type="button"
              className={`${btnPri} ml-auto`}
              disabled={pending}
              onClick={() => run({ status: 'arrived' })}
            >
              到货了
            </button>
          </div>
          {calOpen && (
            <MiniCalendar
              value={p.expectedDate}
              today={today}
              onPick={(iso) => {
                setCalOpen(false)
                run({ expectedDate: iso }, false)
              }}
            />
          )}
        </>
      )}

      {p.status === 'arrived' && (
        <>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className="inline-flex overflow-hidden rounded-[2px] border border-[var(--color-border-strong)]">
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(
                    p.inspectResult === 'ok'
                      ? { inspectResult: null }
                      : { inspectResult: 'ok', inspectNote: null },
                    false,
                  )
                }
                className={`px-3 py-1.5 text-[12px] ${
                  p.inspectResult === 'ok'
                    ? 'bg-[var(--color-success-soft)] font-semibold text-[var(--color-success)]'
                    : 'bg-[var(--color-surface)] text-[var(--color-ink-3)]'
                }`}
              >
                合格
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  if (p.inspectResult === 'defect') run({ inspectResult: null }, false)
                  else setArmBad(true)
                }}
                className={`border-l border-[var(--color-border)] px-3 py-1.5 text-[12px] ${
                  p.inspectResult === 'defect'
                    ? 'bg-[var(--color-overdue-soft)] font-semibold text-[var(--color-overdue)]'
                    : 'bg-[var(--color-surface)] text-[var(--color-ink-3)]'
                }`}
              >
                不良
              </button>
            </span>
            <div className="ml-auto flex items-center gap-2">
              <SearchSelect
                options={roster.map((n) => ({ id: n, label: n }))}
                value={pickerSel}
                onChange={setPickerSel}
                placeholder="谁领料"
                searchPlaceholder="选人或直接输入姓名…"
                createLabel="领料人"
                onCreate={setPickerSel}
                triggerLabel={
                  pickerSel && !roster.includes(pickerSel)
                    ? pickerSel
                    : undefined
                }
              />
              <input
                value={pickQty}
                onChange={(e) => setPickQty(e.target.value)}
                inputMode="decimal"
                placeholder="领几件"
                className={`${inp} mono w-[76px]`}
              />
              <button
                type="button"
                className={btnPri}
                disabled={
                  pending || !pickerSel.trim() || !(parseNum(pickQty)! > 0)
                }
                onClick={() =>
                  run({
                    status: 'done',
                    picker: pickerSel.trim(),
                    pickQty: parseNum(pickQty) ?? null,
                    ...(p.inspectResult ? {} : { inspectResult: 'ok' }),
                  })
                }
              >
                领料
              </button>
            </div>
          </div>
          {armBad && (
            <>
              <div className="mt-2.5 max-w-[480px]">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  placeholder="哪里不对 · 怎么处理"
                  autoFocus
                  className="w-full resize-none rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[12.5px] outline-none"
                />
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  className={btn}
                  onClick={() => setArmBad(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={btnDanger}
                  disabled={pending}
                  onClick={() => {
                    setArmBad(false)
                    run(
                      {
                        inspectResult: 'defect',
                        inspectNote: note.trim() || null,
                      },
                      false,
                    )
                  }}
                >
                  确认不良
                </button>
              </div>
            </>
          )}
        </>
      )}

      {/* Quiet corrections — every stage. */}
      <div className="mt-2.5 flex items-center justify-end gap-3">
        {armDelete ? (
          <>
            <button
              type="button"
              onClick={del}
              disabled={pending}
              className="text-[11.5px] font-medium text-[var(--color-overdue)] hover:underline disabled:opacity-50"
            >
              确认删除
            </button>
            <button
              type="button"
              onClick={() => setArmDelete(false)}
              className="text-[11.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            >
              取消
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onEdit}
              className="text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-ink)]"
            >
              编辑
            </button>
            <button
              type="button"
              onClick={() => setArmDelete(true)}
              className="text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
            >
              删除
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// 谁请购 → 谁批 → 谁下单 → 到货 → 谁领 — one soft line, dates in 月日.
// `picks` = the split-off partial 领料 rows of this row's family, oldest
// first, so the remainder (and every sibling) tells the whole pickup story.
function HistoryLine({
  p,
  picks = [],
}: {
  p: Procurement
  picks?: Procurement[]
}) {
  const parts: React.ReactNode[] = []
  if (p.requester)
    parts.push(
      `${p.requester} ${p.reqDate ? mdCn(p.reqDate) : ''} 请购`.replace('  ', ' '),
    )
  if (p.status === 'rejected') {
    parts.push(
      <span key="rej" className="text-[var(--color-overdue)]">
        {p.rejectedBy} {p.rejectDate ? mdCn(p.rejectDate) : ''} 驳回
        {p.rejectNote ? ` — ${p.rejectNote}` : ''}
      </span>,
    )
  } else {
    if (p.approver) {
      parts.push(
        p.approver === p.requester
          ? '免审批'
          : `${p.approver} ${p.approveDate ? mdCn(p.approveDate) : ''} 批`,
      )
    }
    if (
      p.status === 'ordered' ||
      p.status === 'arrived' ||
      p.status === 'done'
    ) {
      parts.push(`${p.buyer || ''} ${mdCn(p.orderDate)} 下单`.trim())
    }
    if (p.arrivedDate) parts.push(`${mdCn(p.arrivedDate)} 到货`)
    for (const k of picks)
      if (k.pickDate)
        parts.push(
          `${k.picker ?? ''} ${mdCn(k.pickDate)} 领 ${k.pickQty ?? k.qty ?? ''} 件`.trim(),
        )
    if (p.inspectResult === 'defect')
      parts.push(
        <span key="bad" className="text-[var(--color-overdue)]">
          不良{p.inspectNote ? ` — ${p.inspectNote}` : ''}
        </span>,
      )
    if (p.status === 'done' && p.pickDate)
      parts.push(
        `${p.picker ?? ''} ${mdCn(p.pickDate)} 领${
          p.pickQty != null ? ` ${p.pickQty} 件` : ''
        }`.trim(),
      )
  }
  return (
    <>
      {parts.map((x, i) => (
        <span key={i}>
          {i > 0 && <span className="mx-1.5 text-[var(--color-ink-4)]">·</span>}
          {x}
        </span>
      ))}
    </>
  )
}

// ===========================================================================
// Mini calendar — the 预计到货 picker. Month grid, ‹ › nav, past days off,
// today ringed, tap a day and done. Never the native date input.
// ===========================================================================

function MiniCalendar({
  value,
  today,
  onPick,
}: {
  value?: string
  today: string
  onPick: (iso: string) => void
}) {
  const [month, setMonth] = useState((value || today).slice(0, 7))
  const [y, m] = month.split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1, 1))
  const offset = (first.getUTCDay() + 6) % 7 // Monday start
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate()

  function nav(step: number) {
    const d = new Date(Date.UTC(y, m - 1 + step, 1))
    setMonth(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
    )
  }

  const days: React.ReactNode[] = []
  for (let i = 0; i < offset; i++) days.push(<span key={`o${i}`} />)
  for (let d = 1; d <= daysIn; d++) {
    const iso = `${month}-${String(d).padStart(2, '0')}`
    const past = iso < today
    days.push(
      <button
        key={iso}
        type="button"
        disabled={past}
        onClick={() => onPick(iso)}
        className={`h-7 rounded-[2px] text-[12px] ${
          iso === value
            ? 'bg-[var(--color-ink)] font-semibold text-[var(--color-surface)]'
            : past
              ? 'cursor-default text-[var(--color-ink-4)]'
              : 'text-[var(--color-ink)] hover:bg-[#f1efe9]'
        } ${iso === today && iso !== value ? 'shadow-[inset_0_0_0_1px_var(--color-border-strong)]' : ''}`}
      >
        {d}
      </button>,
    )
  }

  return (
    <div className="mt-2.5 w-[256px] rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 pb-3 pt-2.5">
      <div className="mb-2 flex items-center">
        <button
          type="button"
          onClick={() => nav(-1)}
          className="rounded-[2px] px-2 py-0.5 text-[13px] text-[var(--color-ink-3)] hover:bg-[#f1efe9] hover:text-[var(--color-ink)]"
        >
          ‹
        </button>
        <span className="mono flex-1 text-center text-[12.5px] font-semibold">
          {y}年{m}月
        </span>
        <button
          type="button"
          onClick={() => nav(1)}
          className="rounded-[2px] px-2 py-0.5 text-[13px] text-[var(--color-ink-3)] hover:bg-[#f1efe9] hover:text-[var(--color-ink)]"
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
          <span
            key={w}
            className="pb-1 text-center text-[10px] text-[var(--color-ink-3)]"
          >
            {w}
          </span>
        ))}
        {days}
      </div>
    </div>
  )
}

// ‹ 8月 › — step through the months that actually have ledger rows.
// `months` is newest-first, so ‹ walks back in time and › walks forward.
function MonthNav({
  months,
  month,
  onPick,
}: {
  months: string[]
  month: string | null
  onPick: (m: string) => void
}) {
  const i = month ? months.indexOf(month) : -1
  const older = i >= 0 && i < months.length - 1 ? months[i + 1] : null
  const newer = i > 0 ? months[i - 1] : null
  const btn =
    'flex h-6 w-6 items-center justify-center rounded-[2px] border border-[var(--color-border)] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] disabled:cursor-default disabled:opacity-30 disabled:hover:border-[var(--color-border)] disabled:hover:text-[var(--color-ink-2)]'
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => older && onPick(older)}
        disabled={!older}
        aria-label="上一个月"
        className={btn}
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path
            d="M7.5 3 L4.5 6 L7.5 9"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <span className="mono min-w-[44px] text-center text-[12.5px] font-semibold text-[var(--color-ink)]">
        {month ? monthLabel(month) : '—'}
      </span>
      <button
        type="button"
        onClick={() => newer && onPick(newer)}
        disabled={!newer}
        aria-label="下一个月"
        className={btn}
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path
            d="M4.5 3 L7.5 6 L4.5 9"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  )
}

// ===========================================================================
// ＋请购 / 编辑 modal — product-first, three faces:
//   'pick'   — search the 物料库 or jump to 新建物料
//   'create' — the 物料 form (name + 链接 + shop + price + spec)
//   'form'   — the request itself: 数量 / 单价 / 工号 / 领料人 / 备注
// ===========================================================================

type Selected = {
  productId?: string
  name: string
  category?: string
  supplier: string
  link: string
}

type Face = 'pick' | 'create' | 'form'

function ProcurementModal({
  mode,
  initial,
  products,
  jobOptions,
  roster,
  currentUser,
  today,
  onDone,
  onCancel,
}: {
  mode: 'request' | 'edit'
  initial: Procurement | null
  products: ProcurementProduct[]
  jobOptions: ProcurementJobOption[]
  roster: string[]
  currentUser: string
  today: string
  onDone: (created?: ProcurementStatus) => void
  onCancel: () => void
}) {
  const router = useRouter()
  // Locally tracked so a 新建物料 / edit shows up in the picker immediately,
  // before the page-level router.refresh() catches up.
  const [catalog, setCatalog] = useState<ProcurementProduct[]>(products)

  const [selected, setSelected] = useState<Selected | null>(() =>
    initial
      ? {
          productId: initial.productId,
          name: initial.item,
          supplier: initial.supplier ?? '',
          link: initial.link ?? '',
        }
      : null,
  )
  const [face, setFace] = useState<Face>(initial ? 'form' : 'pick')
  const [createSeedName, setCreateSeedName] = useState('')
  const [editing, setEditing] = useState<ProcurementProduct | null>(null)

  const [qty, setQty] = useState(initial?.qty != null ? String(initial.qty) : '')
  const [unitPrice, setUnitPrice] = useState(
    initial?.unitPriceCny != null ? String(initial.unitPriceCny) : '',
  )
  const [picker, setPicker] = useState(initial?.picker ?? currentUser)
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [jobPick, setJobPick] = useState<{ id: string; jobNo: string } | null>(
    initial && (initial.jobId || initial.jobNo)
      ? { id: initial.jobId ?? '', jobNo: initial.jobNo ?? '' }
      : null,
  )

  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Esc closes; lock body scroll while open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onCancel])

  function pickProduct(p: ProcurementProduct) {
    setSelected({
      productId: p.id,
      name: p.name,
      category: p.category,
      supplier: p.supplier ?? '',
      link: p.link ?? '',
    })
    // Default the 单价 to the 物料's going price; the row snapshots whatever
    // gets confirmed.
    if (typeof p.unitPriceCny === 'number' && !unitPrice) {
      setUnitPrice(String(p.unitPriceCny))
    }
    setError(null)
    setFace('form')
  }

  const qtyNum = parseNum(qty)
  const priceNum = parseNum(unitPrice)
  const liveTotal = procurementTotalCny({ qty: qtyNum, unitPriceCny: priceNum })

  function submit() {
    if (!selected || !selected.name.trim()) {
      setError('请先选择或新建一个物料')
      setFace('pick')
      return
    }
    setError(null)

    start(async () => {
      try {
        if (mode === 'edit' && initial) {
          await mutate({
            kind: 'updateProcurement',
            procurementId: initial.id,
            patch: {
              item: selected.name.trim(),
              supplier: selected.supplier.trim() || null,
              link: selected.link.trim() || null,
              qty: qtyNum ?? null,
              unitPriceCny: priceNum ?? null,
              notes: notes.trim() || null,
              jobId: jobPick?.id || null,
              jobNo: jobPick?.jobNo || null,
              picker: picker.trim() || null,
            },
          })
          onDone()
        } else {
          // Every request is born 待审批 — the server enforces it too.
          const status: ProcurementStatus = 'requested'
          await mutate({
            kind: 'createProcurement',
            input: {
              item: selected.name.trim(),
              productId: selected.productId || undefined,
              supplier: selected.supplier.trim() || undefined,
              link: selected.link.trim() || undefined,
              qty: qtyNum,
              unitPriceCny: priceNum,
              orderDate: today,
              reqDate: today,
              notes: notes.trim() || undefined,
              status,
              jobId: jobPick?.id || undefined,
              jobNo: jobPick?.jobNo || undefined,
              picker: picker.trim() || undefined,
            },
          })
          onDone(status)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : '保存失败')
      }
    })
  }

  const title =
    face === 'pick'
      ? '选择物料'
      : face === 'create'
        ? '新建物料'
        : mode === 'edit'
          ? '编辑采购'
          : '请购'

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 py-10 md:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="w-full max-w-[480px] rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-xl">
        <div className="flex items-baseline justify-between border-b border-[var(--color-border)] px-5 py-3.5">
          <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
            {title}
          </h2>
          <span className="label text-[var(--color-ink-3)]">
            请购人 · {mode === 'edit' ? (initial?.requester ?? currentUser) : currentUser}
          </span>
        </div>

        {face === 'pick' && (
          <ProductPicker
            catalog={catalog}
            onPick={pickProduct}
            onCreateNew={(seed) => {
              setCreateSeedName(seed)
              setFace('create')
            }}
            onEdit={(p) => {
              setCreateSeedName('')
              setEditing(p)
              setFace('create')
            }}
          />
        )}

        {face === 'create' && (
          <ProductForm
            seedName={createSeedName}
            editing={editing}
            onSaved={(p) => {
              setCatalog((c) => {
                const without = c.filter((x) => x.id !== p.id)
                return [p, ...without]
              })
              setEditing(null)
              router.refresh()
              // A freshly created 物料 selects straight into the request;
              // an edit just returns to the picker.
              if (editing) setFace('pick')
              else pickProduct(p)
            }}
            onDeleted={(id) => {
              setCatalog((c) => c.filter((x) => x.id !== id))
              setEditing(null)
              router.refresh()
              setFace('pick')
            }}
            onCancel={() => {
              setEditing(null)
              setFace('pick')
            }}
          />
        )}

        {face === 'form' && selected && (
          <>
            <div className="px-5 py-5">
              <SelectedCard
                selected={selected}
                onChange={() => setFace('pick')}
              />

              <div className="mt-4 grid grid-cols-3 gap-4">
                <Field label="数量">
                  <Input
                    value={qty}
                    onChange={setQty}
                    placeholder="0"
                    mono
                    inputMode="decimal"
                    autoFocus
                  />
                </Field>
                <Field label="单价 ¥">
                  <Input
                    value={unitPrice}
                    onChange={setUnitPrice}
                    placeholder="可留空"
                    mono
                    inputMode="decimal"
                  />
                </Field>
                <div className="flex flex-col justify-end pb-2">
                  <span className="label text-[var(--color-ink-3)]">
                    合计{' '}
                    <span className="mono text-[13px] font-semibold text-[var(--color-ink)]">
                      {typeof liveTotal === 'number' ? formatCny(liveTotal) : '—'}
                    </span>
                  </span>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-4">
                <Field label="关联工号 · 可空">
                  <div className="flex items-center gap-1">
                    <SearchSelect
                      options={jobOptions.map((j) => ({
                        id: j.id,
                        label: j.product ? `${j.jobNo} · ${j.product}` : j.jobNo,
                      }))}
                      value={jobPick?.id ?? ''}
                      onChange={(id) => {
                        const j = jobOptions.find((x) => x.id === id)
                        if (j) setJobPick({ id: j.id, jobNo: j.jobNo })
                      }}
                      placeholder="可留空"
                      searchPlaceholder="搜索工号 / 产品…"
                      triggerClass="flex-1 min-w-0"
                      triggerLabel={
                        jobPick && !jobOptions.some((j) => j.id === jobPick.id)
                          ? jobPick.jobNo
                          : undefined
                      }
                    />
                    {jobPick && (
                      <button
                        type="button"
                        onClick={() => setJobPick(null)}
                        title="清除关联"
                        aria-label="清除关联工号"
                        className="shrink-0 rounded-[2px] px-1.5 py-1 text-[13px] leading-none text-[var(--color-ink-4)] hover:text-[var(--color-ink)]"
                      >
                        ×
                      </button>
                    )}
                  </div>
                </Field>
                <Field label="领料人">
                  <SearchSelect
                    options={roster.map((n) => ({ id: n, label: n }))}
                    value={picker}
                    onChange={setPicker}
                    placeholder="谁来领"
                    searchPlaceholder="选人或直接输入姓名…"
                    createLabel="领料人"
                    onCreate={setPicker}
                    triggerLabel={
                      picker && !roster.includes(picker) ? picker : undefined
                    }
                    triggerClass="w-full"
                  />
                </Field>
              </div>

              <div className="mt-4">
                <Field label="备注 · 可空">
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="给审批和采购的一句话"
                    rows={2}
                    className="w-full resize-none rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
                  />
                </Field>
              </div>

              {error && (
                <p className="mt-4 text-[12px] text-[var(--color-overdue)]">
                  {error}
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-[var(--color-border)] px-5 py-3.5">
              <button
                type="button"
                onClick={onCancel}
                className="text-[13px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={pending}
                className="rounded-[2px] bg-[var(--color-ink)] px-4 py-1.5 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
              >
                {pending ? '保存中…' : mode === 'edit' ? '保存' : '提交请购'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ===========================================================================

function SelectedCard({
  selected,
  onChange,
}: {
  selected: Selected
  onChange: () => void
}) {
  return (
    <div className="rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {selected.category && <CategoryChip category={selected.category} />}
            <span className="truncate text-[14px] font-medium tracking-tight text-[var(--color-ink)]">
              {selected.name}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-[var(--color-ink-3)]">
            <span>{selected.supplier || '供应商未填'}</span>
            {selected.link && isHttp(selected.link) && (
              <a
                href={selected.link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[var(--color-info)] hover:underline"
              >
                链接 <LinkGlyph />
              </a>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onChange}
          className="shrink-0 rounded-[2px] border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
        >
          更换
        </button>
      </div>
    </div>
  )
}

function ProductPicker({
  catalog,
  onPick,
  onCreateNew,
  onEdit,
}: {
  catalog: ProcurementProduct[]
  onPick: (p: ProcurementProduct) => void
  onCreateNew: (seed: string) => void
  onEdit: (p: ProcurementProduct) => void
}) {
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()
  const results = useMemo(() => {
    if (!query) return catalog
    return catalog.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        (p.supplier ?? '').toLowerCase().includes(query) ||
        (p.category ?? '').toLowerCase().includes(query) ||
        (p.notes ?? '').toLowerCase().includes(query),
    )
  }, [catalog, query])

  return (
    <div className="px-5 py-5">
      <div className="relative">
        <SearchIcon />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索物料 · 品名 / 类别 / 供应商"
          autoFocus
          className="h-10 w-full rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] pl-8 pr-3 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
        />
      </div>

      <div className="mt-3 max-h-[320px] overflow-y-auto rounded-[2px] border border-[var(--color-border)]">
        {results.length === 0 ? (
          <p className="px-4 py-8 text-center text-[12px] text-[var(--color-ink-4)]">
            {catalog.length === 0
              ? '物料库还是空的 —— 新建第一个常用物料'
              : '没有匹配的物料'}
          </p>
        ) : (
          results.map((p) => (
            <div
              key={p.id}
              className="group/item flex items-center gap-3 border-b border-[var(--color-border)] last:border-b-0 hover:bg-[#faf8f2]"
            >
              <button
                type="button"
                onClick={() => onPick(p)}
                className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {p.category && <CategoryChip category={p.category} />}
                    <span className="truncate text-[13px] font-medium text-[var(--color-ink)]">
                      {p.name}
                    </span>
                    {p.link && isHttp(p.link) && (
                      <span className="text-[var(--color-info)]">
                        <LinkGlyph />
                      </span>
                    )}
                  </div>
                  <span className="mt-0.5 block truncate text-[11px] text-[var(--color-ink-3)]">
                    {p.supplier || '供应商未填'}
                  </span>
                </div>
                <span className="mono shrink-0 text-[12px] text-[var(--color-ink-2)]">
                  {typeof p.unitPriceCny === 'number'
                    ? formatCny(p.unitPriceCny)
                    : '—'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onEdit(p)}
                className="shrink-0 rounded-[2px] py-0.5 pr-4 pl-1.5 text-[11px] text-[var(--color-ink-4)] opacity-0 hover:text-[var(--color-ink)] group-hover/item:opacity-100"
              >
                编辑
              </button>
            </div>
          ))
        )}
      </div>

      <button
        type="button"
        onClick={() => onCreateNew(q.trim())}
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-3 py-2.5 text-[13px] font-medium text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
      >
        <Plus />
        {q.trim() ? `新建物料「${q.trim()}」` : '新建物料'}
      </button>
    </div>
  )
}

function ProductForm({
  seedName,
  editing,
  onSaved,
  onDeleted,
  onCancel,
}: {
  seedName: string
  editing: ProcurementProduct | null
  onSaved: (p: ProcurementProduct) => void
  onDeleted: (id: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(editing?.name ?? seedName)
  const [category, setCategory] = useState(editing?.category ?? '')
  const [supplier, setSupplier] = useState(editing?.supplier ?? '')
  const [link, setLink] = useState(editing?.link ?? '')
  const [price, setPrice] = useState(
    editing?.unitPriceCny != null ? String(editing.unitPriceCny) : '',
  )
  const [notes, setNotes] = useState(editing?.notes ?? '')
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  function save() {
    if (!name.trim()) {
      setError('请填写品名')
      return
    }
    if (link.trim() && !isHttp(link.trim())) {
      setError('链接需以 http(s):// 开头')
      return
    }
    setError(null)
    const priceNum = parseNum(price)
    start(async () => {
      try {
        if (editing) {
          await mutate({
            kind: 'updateProcurementProduct',
            productId: editing.id,
            patch: {
              name: name.trim(),
              category: category.trim() || null,
              supplier: supplier.trim() || null,
              link: link.trim() || null,
              unitPriceCny: priceNum ?? null,
              notes: notes.trim() || null,
            },
          })
          onSaved({
            ...editing,
            name: name.trim(),
            category: category.trim() || undefined,
            supplier: supplier.trim() || undefined,
            link: link.trim() || undefined,
            unitPriceCny: priceNum,
            notes: notes.trim() || undefined,
          })
        } else {
          const res = await mutate<{ product: ProcurementProduct }>({
            kind: 'createProcurementProduct',
            input: {
              name: name.trim(),
              category: category.trim() || undefined,
              supplier: supplier.trim() || undefined,
              link: link.trim() || undefined,
              unitPriceCny: priceNum,
              notes: notes.trim() || undefined,
            },
          })
          onSaved(res.data.product)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : '保存失败')
      }
    })
  }

  function del() {
    if (!editing) return
    start(async () => {
      try {
        await mutate({
          kind: 'deleteProcurementProduct',
          productId: editing.id,
        })
        onDeleted(editing.id)
      } catch (e) {
        setError(e instanceof Error ? e.message : '删除失败')
      }
    })
  }

  return (
    <>
      <div className="px-5 py-5">
        <Field label="品名" required>
          <Input
            value={name}
            onChange={setName}
            placeholder="如 6mm 四刃硬质合金立铣刀"
            autoFocus
          />
        </Field>

        <div className="mt-4">
          <p className="label mb-1.5">类别</p>
          <div className="flex flex-wrap gap-1.5">
            {PROCUREMENT_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory((cur) => (cur === c ? '' : c))}
                className={`rounded-[2px] border px-2.5 py-1 text-[12px] ${
                  category === c
                    ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-surface)]'
                    : 'border-[var(--color-border)] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <Field label="链接 · 淘宝 / 1688 / 京东">
            <Input
              value={link}
              onChange={setLink}
              placeholder="https://item.taobao.com/…"
            />
          </Field>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4">
          <Field label="默认供应商 / 店铺">
            <Input
              value={supplier}
              onChange={setSupplier}
              placeholder="店铺名 · 可留空"
            />
          </Field>
          <Field label="参考单价 ¥">
            <Input
              value={price}
              onChange={setPrice}
              placeholder="0"
              mono
              inputMode="decimal"
            />
          </Field>
        </div>

        <div className="mt-4">
          <Field label="规格 / 型号">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="材质 / 尺寸 / 型号 · 可留空"
              rows={2}
              className="w-full resize-none rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
            />
          </Field>
        </div>

        {error && (
          <p className="mt-4 text-[12px] text-[var(--color-overdue)]">{error}</p>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] px-5 py-3.5">
        <div>
          {editing &&
            (confirmingDelete ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={del}
                  disabled={pending}
                  className="text-[12px] font-medium text-[var(--color-overdue)] hover:underline disabled:opacity-50"
                >
                  确认删除
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="text-[12px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
              >
                删除物料
              </button>
            ))}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="text-[13px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            返回
          </button>
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="rounded-[2px] bg-[var(--color-ink)] px-4 py-1.5 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
          >
            {pending ? '保存中…' : editing ? '保存物料' : '新建并选用'}
          </button>
        </div>
      </div>
    </>
  )
}

function CategoryChip({ category }: { category: string }) {
  return (
    <span className="shrink-0 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] leading-none text-[var(--color-ink-3)]">
      {category}
    </span>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="label mb-1.5">
        {label}
        {required && <span className="text-[var(--color-overdue)]"> ·</span>}
      </p>
      {children}
    </div>
  )
}

function Input({
  value,
  onChange,
  placeholder,
  mono,
  autoFocus,
  inputMode,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
  autoFocus?: boolean
  inputMode?: 'text' | 'decimal'
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      inputMode={inputMode}
      className={`w-full rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)] ${
        mono ? 'mono' : ''
      }`}
    />
  )
}

// === helpers ===

function parseNum(s: string): number | undefined {
  const t = s.trim()
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

function isHttp(s: string): boolean {
  return /^https?:\/\//i.test(s.trim())
}

// 2026-08-16 → 8月16日
function mdCn(d: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d
  return `${parseInt(d.slice(5, 7), 10)}月${parseInt(d.slice(8, 10), 10)}日`
}

// 今天 / 昨天 / 明天, otherwise 8月16日
function relDay(d: string, today: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d
  const n = daysFromToday(d, today)
  if (n === 0) return '今天'
  if (n === -1) return '昨天'
  if (n === 1) return '明天'
  return mdCn(d)
}

// 2026-08 → 8月 (same year) / 2025年12月 (other years)
function monthLabel(m: string): string {
  const y = m.slice(0, 4)
  const mo = `${parseInt(m.slice(5, 7), 10)}月`
  const nowY = String(new Date().getFullYear())
  return y === nowY ? mo : `${y}年${mo}`
}

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-ink-3)]"
    >
      <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.4" />
      <line
        x1="10.5"
        y1="10.5"
        x2="14"
        y2="14"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function LinkGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M4.5 2.5 H9.5 V7.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 2.5 L4 8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M8 9.5 H2.5 V4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Plus() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M6 2.5 V9.5 M2.5 6 H9.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}
