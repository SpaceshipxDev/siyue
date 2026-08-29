'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
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
import type { ProcurementJobOption, ProcurementNeed } from '@/lib/db'

// 采购 board — a six-step conveyor read through six rectangular filter
// boxes: 需求 → 待审批 → 待采购 → 待到货 → 待领料 → 已领料. One table per box;
// each table carries its own money strip (笔数 · ¥) at the top, the 已领料
// ledger browses month by month with 导出. A row click opens an inline panel
// holding that row's whole story (请购 → 批 → 下单 → 到货 → 领) and exactly the
// actions its stage allows. 请购 is the only entry point — every request,
// approvers' included, is born 待审批; approval moves it to 待采购, placing
// (paying) the order to 待到货, arrival to 待领料, and the named 领料人
// collecting it closes the loop.
//
// 需求 is the mouth of the conveyor and the only box that isn't procurements
// rows: it's the live list of parts 工程 routed through 采购 and nobody has
// bought yet, so what the shop decided to buy shows up here without anyone
// having to retype it. Each row is one yes/no question — 确认 files the 请购
// in a single tap and the board jumps to 待审批 where it landed; 删除 takes
// 采购 back off that part's route for the ones that shouldn't be bought.
type Tab = 'need' | 'requested' | 'purchase' | 'buying' | 'arrived' | 'ledger'

const TAB_DEF: Record<
  Tab,
  { label: string; col: string; match: (p: Procurement) => boolean }
> = {
  // 需求 rows aren't procurements at all — it renders its own table, so this
  // matcher never runs. It's here to keep the box labels in one place.
  need: { label: '需求', col: '交期', match: () => false },
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
  need: '工程还没派下要买的活',
  requested: '没有等审批的请购',
  purchase: '没有等下单的采购',
  buying: '料都到齐了',
  arrived: '到了的料都领走了',
  ledger: '本月没有记录',
}

type ModalMode =
  | { kind: 'request' }
  | { kind: 'edit'; row: Procurement }
  | null

export function ProcurementBoard({
  procurements,
  products,
  jobOptions,
  needs,
  roster,
  currentUser,
  canApprove,
  canEditRoute,
  today,
}: {
  procurements: Procurement[]
  products: ProcurementProduct[]
  jobOptions: ProcurementJobOption[]
  needs: ProcurementNeed[]
  roster: string[]
  currentUser: string
  canApprove: boolean
  canEditRoute: boolean
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

  // A 需求 is "已请购" once a live 请购 on the same 工号 names that part —
  // either as the 物料 bought or in the 备注 the 需求 seeds. Those stay
  // listed, dimmed and sorted last, so nobody buys the same part twice while
  // the 采购 工段 waits for the material to physically land; the box counts
  // only the ones still needing someone.
  const needAll = useMemo(() => {
    const key = (s: string) => s.trim().toLowerCase()
    const byJob = new Map<string, Procurement[]>()
    for (const p of procurements) {
      if (!p.jobId || p.status === 'rejected') continue
      const l = byJob.get(p.jobId) ?? []
      l.push(p)
      byJob.set(p.jobId, l)
    }
    return needs.map((n) => {
      const part = key(n.part)
      const asked =
        part.length > 0 &&
        (byJob.get(n.jobId) ?? []).some((p) => {
          const item = key(p.item)
          // The reverse direction (零件 "6061铝板-A" bought as 物料 "6061铝板")
          // needs a real name to lean on — a one-character 物料 would match
          // half the job.
          return (
            item.includes(part) ||
            (item.length > 1 && part.includes(item)) ||
            key(p.notes ?? '').includes(part)
          )
        })
      return { need: n, asked }
    })
  }, [needs, procurements])

  // 需求 reads by 订单, not by part: one 工号 is one block, and everything
  // that 订单 needs bought sits under it. The buyer works an order at a time
  // — one drawing pack, one supplier call — so splitting a job's parts across
  // the list was making him re-find the same 工号 three times.
  //
  // Blocks with something still to confirm come first, then by 交期 (a job's
  // parts all share it) and 工号. Inside a block the server's 零件进度 order
  // holds, 待确认 above 已请购.
  const needMatch = (n: ProcurementNeed) =>
    !query ||
    n.part.toLowerCase().includes(query) ||
    n.jobNo.toLowerCase().includes(query) ||
    n.product.toLowerCase().includes(query) ||
    (n.material ?? '').toLowerCase().includes(query)

  const needGroups = useMemo(() => {
    const byJob = new Map<string, typeof needAll>()
    for (const r of needAll) {
      if (!needMatch(r.need)) continue
      const l = byJob.get(r.need.jobId) ?? []
      l.push(r)
      byJob.set(r.need.jobId, l)
    }
    const groups = [...byJob.values()].map((rows) => ({
      head: rows[0].need,
      open: rows.filter((r) => !r.asked).length,
      rows: [...rows.filter((r) => !r.asked), ...rows.filter((r) => r.asked)],
    }))
    groups.sort((a, b) => {
      const ao = a.open > 0
      const bo = b.open > 0
      if (ao !== bo) return ao ? -1 : 1
      const ad = a.head.dueDate || '9999-99-99'
      const bd = b.head.dueDate || '9999-99-99'
      if (ad !== bd) return ad < bd ? -1 : 1
      return a.head.jobNo < b.head.jobNo ? -1 : 1
    })
    return groups
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needAll, query])

  const needOpen = needAll.filter((n) => !n.asked).length
  const needOpenShown = needGroups.reduce((s, g) => s + g.open, 0)

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
    { key: 'need', count: needOpen },
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
        {tab === 'need' ? (
          /* 需求 — its own table: parts, not purchases, so no money strip. */
          <>
            <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-5 py-2.5">
              <span className="mono text-[13px] font-semibold text-[var(--color-ink)]">
                {needOpenShown} 项待确认 · {needGroups.length} 个订单
              </span>
            </div>
            {needGroups.length === 0 ? (
              <p className="px-5 py-10 text-center text-[13px] text-[var(--color-ink-3)]">
                {query ? '没有匹配的记录' : TAB_EMPTY.need}
              </p>
            ) : (
              needGroups.map((g) => (
                <div
                  key={g.head.jobId}
                  className="border-b border-[var(--color-border)] last:border-b-0"
                >
                  <NeedJobHead n={g.head} open={g.open} today={today} />
                  {g.rows.map(({ need, asked }) => (
                    <NeedRow
                      key={need.partId}
                      n={need}
                      asked={asked}
                      today={today}
                      currentUser={currentUser}
                      canEditRoute={canEditRoute}
                      onFiled={() => {
                        setTab('requested')
                        router.refresh()
                      }}
                    />
                  ))}
                </div>
              ))
            )}
          </>
        ) : (
          <>
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
                  pastPicks={(
                    picksByParent.get(p.parentId ?? p.id) ?? []
                  ).filter((x) => x.id !== p.id)}
                  onEdit={() => setModal({ kind: 'edit', row: p })}
                />
              ))
            )}
          </>
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

// The 订单 a block of 需求 belongs to. Carries what's true of all of them —
// 工号 (linking to the order so the buyer can read the drawings before
// buying), 产品, 交期 — so the parts underneath only have to say what makes
// them different from each other.
function NeedJobHead({
  n,
  open,
  today,
}: {
  n: ProcurementNeed
  open: number
  today: string
}) {
  const st = n.dueDate ? dueState(n.dueDate, today) : null
  return (
    <div className="flex items-baseline gap-2.5 border-b border-[var(--color-border)] bg-[#f5f3ed] px-4 py-2 md:px-5">
      <Link
        href={`/jobs/${n.jobId}`}
        className="mono shrink-0 text-[13px] font-semibold text-[var(--color-ink)] hover:underline"
      >
        {n.jobNo}
      </Link>
      <span className="truncate text-[12.5px] text-[var(--color-ink-3)]">
        {n.product}
      </span>
      <span className="ml-auto shrink-0 text-[12px] text-[var(--color-ink-3)]">
        {open > 0 ? `${open} 项待确认` : '都已请购'}
      </span>
      <span
        className={`shrink-0 text-[12.5px] ${
          st === 'overdue'
            ? 'font-semibold text-[var(--color-overdue)]'
            : st === 'today' || st === 'soon'
              ? 'font-medium text-[var(--color-ink)]'
              : 'mono text-[var(--color-ink-2)]'
        }`}
      >
        {n.dueDate ? relDay(n.dueDate, today) : '无交期'}
      </span>
    </div>
  )
}

// One 采购需求 — a part 工程 routed through 采购, listed under its 订单. The
// 工号 / 产品 / 交期 live on the block header above it, so the row says only
// 零件名 · 材料 · 数量 and asks one question: 这个要买吗?
//
//   确认 — yes. One tap files the 请购 (物料 = the part's 材料, or its name
//          when there's none; 备注 carries the 零件名) and the board jumps to
//          待审批 where it now sits. Nothing to type: everything a 需求 knows
//          is already what the form would have been filled with, and 供应商 /
//          单价 get filled in downstream by whoever places the order anyway.
//          For anything the shop buys that isn't a 需求 — 刀具, consumables —
//          ＋请购 up top still opens the full form.
//   删除 — no. Takes 采购 back off that part's route (工程 ticked it by
//          mistake / the material was already in the rack). Two taps, and
//          only for whoever may edit a route.
//
// Once a 请购 exists the row stays, dimmed, until the material lands and 采购
// gets 报工'd — the list answers "还有什么没买" without being tidied by hand.
function NeedRow({
  n,
  asked,
  today,
  currentUser,
  canEditRoute,
  onFiled,
}: {
  n: ProcurementNeed
  asked: boolean
  today: string
  currentUser: string
  canEditRoute: boolean
  onFiled: () => void
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [armDelete, setArmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function confirmNeed() {
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'createProcurement',
          input: {
            // What gets bought is the 材料; the 零件名 rides in 备注 so the
            // approver reads what it's for — and so the 需求 list can tell
            // this one has been asked for.
            item: (n.material?.trim() || n.part).trim(),
            qty: n.qty,
            orderDate: today,
            reqDate: today,
            requester: currentUser,
            notes: n.part,
            jobId: n.jobId,
            jobNo: n.jobNo,
            status: 'requested',
          },
        })
        onFiled()
      } catch (e) {
        setError(e instanceof Error ? e.message : '请购失败')
      }
    })
  }

  function removeNeed() {
    setError(null)
    start(async () => {
      try {
        const r = await mutate<{ ok: boolean; reason?: string }>({
          kind: 'dismissProcurementNeed',
          partId: n.partId,
          jobId: n.jobId,
        })
        setArmDelete(false)
        // 'not_found' means it's already gone (another tab, or 工程 unticked
        // it) — the refresh makes the row vanish, which is the same outcome.
        if (!r.data.ok && r.data.reason === 'started') {
          setError('采购已开工，删不了')
          return
        }
        router.refresh()
      } catch (e) {
        setArmDelete(false)
        setError(e instanceof Error ? e.message : '删除失败')
      }
    })
  }

  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_112px] items-center gap-3 border-b border-[var(--color-border)] py-3 pl-4 pr-4 last:border-b-0 md:grid-cols-[minmax(0,1fr)_100px_136px] md:gap-4 md:py-3.5 md:pl-7 md:pr-5 ${
        asked ? 'opacity-55' : ''
      }`}
    >
      <div className="min-w-0">
        <div className="truncate text-[14.5px] font-medium tracking-tight text-[var(--color-ink)]">
          {n.part}
        </div>
        <div className="mt-0.5 truncate text-[12px] text-[var(--color-ink-3)]">
          {n.material?.trim() || '材料未注'}
          <span className="md:hidden"> · {n.qty} 件</span>
        </div>
      </div>
      <div className="mono hidden text-right text-[13px] text-[var(--color-ink)] md:block">
        {n.qty} 件
      </div>
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center justify-end gap-3">
          {asked ? (
            <span className="text-[12px] text-[var(--color-ink-3)]">
              已请购
            </span>
          ) : armDelete ? (
            <>
              <button
                type="button"
                onClick={removeNeed}
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
                onClick={confirmNeed}
                disabled={pending}
                className="rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--color-ink)] hover:bg-[#faf8f2] disabled:opacity-50"
              >
                确认
              </button>
              {canEditRoute && (
                <button
                  type="button"
                  onClick={() => setArmDelete(true)}
                  className="text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                >
                  删除
                </button>
              )}
            </>
          )}
        </div>
        {error && (
          <span className="text-right text-[11px] leading-tight text-[var(--color-overdue)]">
            {error}
          </span>
        )}
      </div>
    </div>
  )
}

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
              {p.picker && (
                <span className="text-[12px] text-[var(--color-ink-3)]">
                  领料人 {p.picker}
                </span>
              )}
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
            等审批{p.picker ? ` · 领料人 ${p.picker}` : ''}
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
//   'form'   — the request itself: 规格 / 数量 / 单价 / 请购人 / 领料人 /
//              工号 / 备注
// ===========================================================================

// One line of the 请购单 — a 物料 picked from the 库, cut to a size, in a
// quantity, at a price. Everything else on the form is shared by all lines.
type Line = {
  key: string
  productId?: string
  name: string
  category?: string
  supplier: string
  link: string
  l: string
  w: string
  h: string
  qty: string
  unitPrice: string
}

// === 材料规格 — 长 × 宽 × 高, in mm ===
//
// The size belongs to the buy, not to the 物料: the 物料库 keeps the generic
// 「6061铝板」 and each 请购 says how big a piece it wants. So it rides in the
// 品名 snapshot the row already carries — 「6061铝板 200×100×20mm」 — which is
// what the approver reads, what the buyer orders from, and what the 台账
// exports, all without a place of its own.
//
// Written in one fixed shape (no inner spaces, one space before the numbers)
// so 编辑 can lift it straight back out into the three boxes. The leading
// space is what keeps a hand-typed 物料 like 「内六角螺丝 M6×20mm」 out of the
// match — nothing is ever pulled off a name this didn't write.
const SPEC_RE = /\s(\d+(?:\.\d+)?)×(\d+(?:\.\d+)?)×(\d+(?:\.\d+)?)mm$/

type Spec = { name: string; l: string; w: string; h: string }

function splitSpec(item: string): Spec {
  const m = SPEC_RE.exec(item)
  if (!m) return { name: item.trim(), l: '', w: '', h: '' }
  return { name: item.slice(0, m.index).trim(), l: m[1], w: m[2], h: m[3] }
}

// All three or nothing — 「200××20mm」 would read as a typo, and a partial
// size is one the buyer can't order from anyway. The 品名 shown on the card
// updates live, so a half-filled 规格 is visibly not in the name yet.
function joinSpec(name: string, s: Spec): string {
  const n = name.trim()
  const l = s.l.trim()
  const w = s.w.trim()
  const h = s.h.trim()
  if (!l || !w || !h) return n
  return `${n} ${l}×${w}×${h}mm`
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

  // One 请购单, many 物料. Each line becomes its own procurements row on
  // submit (the table is one-row-per-purchase by design, and the conveyor
  // downstream — 审批, 下单, 到货, 领料 — happens per material anyway); what
  // the lines share is the 请购人 / 领料人 / 工号 / 备注 below them, which is
  // the part nobody wants to retype five times.
  //
  // 编辑 opens one existing row, so it stays exactly one line: no 加一行, no
  // per-line 删除.
  const keySeq = useRef(0)
  const newLine = (p?: ProcurementProduct, from?: Line): Line => ({
    key: from?.key ?? `l${keySeq.current++}`,
    productId: p?.id,
    name: p?.name ?? '',
    category: p?.category,
    supplier: p?.supplier ?? '',
    link: p?.link ?? '',
    l: from?.l ?? '',
    w: from?.w ?? '',
    h: from?.h ?? '',
    qty: from?.qty ?? '',
    unitPrice:
      from?.unitPrice ||
      (typeof p?.unitPriceCny === 'number' ? String(p.unitPriceCny) : ''),
  })

  const [lines, setLines] = useState<Line[]>(() => {
    if (!initial) return []
    const s = splitSpec(initial.item)
    return [
      {
        key: 'l0',
        productId: initial.productId,
        name: s.name,
        supplier: initial.supplier ?? '',
        link: initial.link ?? '',
        l: s.l,
        w: s.w,
        h: s.h,
        qty: initial.qty != null ? String(initial.qty) : '',
        unitPrice:
          initial.unitPriceCny != null ? String(initial.unitPriceCny) : '',
      },
    ]
  })
  // Which line the 物料 picker is choosing for; -1 means append a new one.
  const [picking, setPicking] = useState(-1)
  // The line whose 长 should take the cursor — set when a line is born, so
  // adding one and typing its size is a single uninterrupted motion.
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [face, setFace] = useState<Face>(initial ? 'form' : 'pick')
  const [createSeedName, setCreateSeedName] = useState('')
  const [editing, setEditing] = useState<ProcurementProduct | null>(null)
  // 请购人 defaults to whoever is signed in but stays pickable — filing for a
  // colleague is normal. 领料人 starts blank; the 领料 step names the taker.
  const [requester, setRequester] = useState(initial?.requester ?? currentUser)
  const [picker, setPicker] = useState(initial?.picker ?? '')
  // 备注 names the 零件 a 请购 is for — what gets bought is a 物料 (板材,
  // 标准件…), so the part it's for would otherwise be lost, and it's what
  // tells the 需求 list this one has been asked for.
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

  // Picking swaps the 物料 on the target line and keeps what was already
  // typed into it (规格 / 数量), or opens the sheet's first line. The 单价
  // defaults to the 物料's going price; the row snapshots whatever gets
  // submitted.
  function pickProduct(p: ProcurementProduct) {
    const at = picking >= 0 && picking < lines.length ? picking : -1
    const line = newLine(p, at < 0 ? undefined : lines[at])
    setLines((ls) =>
      at < 0 ? [...ls, line] : ls.map((l, x) => (x === at ? line : l)),
    )
    if (at < 0) setFocusKey(line.key)
    setError(null)
    setFace('form')
  }

  function patchLine(i: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l, x) => (x === i ? { ...l, ...patch } : l)))
  }

  // 加一行 carries the 物料 down from the line above — 单价 included, since
  // the same 型号 costs the same until someone says otherwise. Buying one
  // 型号 in four sizes is the normal shape of a 请购单, and re-picking
  // 「6061铝板」 four times out of the 库 was the whole cost of it. Only the
  // 规格 and 数量 — what differs piece to piece — come up empty, with the
  // cursor already in 长. A line that needs a different 物料 says so by
  // tapping its 品名.
  function addLine() {
    const last = lines[lines.length - 1]
    if (!last) return
    const key = `l${keySeq.current++}`
    setLines((ls) => [
      ...ls,
      {
        key,
        productId: last.productId,
        name: last.name,
        category: last.category,
        supplier: last.supplier,
        link: last.link,
        l: '',
        w: '',
        h: '',
        qty: '',
        unitPrice: last.unitPrice,
      },
    ])
    setFocusKey(key)
  }

  // 合计 spans the whole 请购单 — what this one sheet is asking the shop to
  // spend, not what one of its lines costs.
  const liveTotal = lines.reduce<number | undefined>((sum, l) => {
    const t = procurementTotalCny({
      qty: parseNum(l.qty),
      unitPriceCny: parseNum(l.unitPrice),
    })
    if (typeof t !== 'number') return sum
    return (sum ?? 0) + t
  }, undefined)

  function submit() {
    if (lines.length === 0 || !lines[0].name.trim()) {
      setError('请先选择或新建一个物料')
      setPicking(-1)
      setFace('pick')
      return
    }
    setError(null)

    start(async () => {
      try {
        if (mode === 'edit' && initial) {
          const l = lines[0]
          await mutate({
            kind: 'updateProcurement',
            procurementId: initial.id,
            patch: {
              item: joinSpec(l.name, l),
              supplier: l.supplier.trim() || null,
              link: l.link.trim() || null,
              qty: parseNum(l.qty) ?? null,
              unitPriceCny: parseNum(l.unitPrice) ?? null,
              notes: notes.trim() || null,
              jobId: jobPick?.id || null,
              jobNo: jobPick?.jobNo || null,
              picker: picker.trim() || null,
              requester: requester.trim() || undefined,
            },
          })
          onDone()
          return
        }

        // Every request is born 待审批 — the server enforces it too. Lines go
        // one at a time and each one that lands is dropped from the sheet, so
        // if the link dies halfway the form is left holding exactly what
        // didn't make it and pressing 提交 again finishes the job instead of
        // filing everything twice.
        const status: ProcurementStatus = 'requested'
        const rest = [...lines]
        try {
          while (rest.length > 0) {
            const l = rest[0]
            await mutate({
              kind: 'createProcurement',
              input: {
                item: joinSpec(l.name, l),
                productId: l.productId || undefined,
                supplier: l.supplier.trim() || undefined,
                link: l.link.trim() || undefined,
                qty: parseNum(l.qty),
                unitPriceCny: parseNum(l.unitPrice),
                orderDate: today,
                reqDate: today,
                notes: notes.trim() || undefined,
                status,
                jobId: jobPick?.id || undefined,
                jobNo: jobPick?.jobNo || undefined,
                picker: picker.trim() || undefined,
                requester: requester.trim() || undefined,
              },
            })
            rest.shift()
          }
        } catch (e) {
          const done = lines.length - rest.length
          setLines(rest)
          const msg = e instanceof Error ? e.message : '提交失败'
          setError(done > 0 ? `已提交 ${done} 条，剩下的没成功 · ${msg}` : msg)
          if (done > 0) router.refresh()
          return
        }
        onDone(status)
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
      <div className="w-full max-w-[520px] rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-xl">
        <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-5 py-3.5">
          <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
            {title}
          </h2>
          <div className="flex-1" />
          {/* Picking a 物料 for a sheet that already has lines has to be
              escapable — × closes the whole 请购单, and a half-typed form is
              not something to lose to a change of mind. */}
          {face === 'pick' && lines.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setPicking(-1)
                setFace('form')
              }}
              className="text-[12.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            >
              返回
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            aria-label="关闭"
            className="rounded-[2px] px-1 text-[15px] leading-none text-[var(--color-ink-4)] hover:text-[var(--color-ink)]"
          >
            ×
          </button>
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

        {face === 'form' && lines.length > 0 && (
          <>
            <div className="px-5 py-5">
              <div className="space-y-2">
                {lines.map((l, i) => (
                  <LineRow
                    key={l.key}
                    l={l}
                    autoFocus={l.key === focusKey}
                    onPatch={(patch) => patchLine(i, patch)}
                    onChangeProduct={() => {
                      setPicking(i)
                      setFace('pick')
                    }}
                    onRemove={
                      lines.length > 1
                        ? () => {
                            setLines((ls) => ls.filter((_, x) => x !== i))
                            setPicking(-1)
                          }
                        : undefined
                    }
                  />
                ))}
              </div>

              {mode !== 'edit' && (
                <button
                  type="button"
                  onClick={addLine}
                  className="mt-2 w-full rounded-[2px] border border-dashed border-[var(--color-border-strong)] py-2 text-[12.5px] font-medium text-[var(--color-ink-2)] hover:bg-[#faf8f2] hover:text-[var(--color-ink)]"
                >
                  ＋ 加一行
                </button>
              )}

              {/* Everything below the rule belongs to the whole 请购单, not
                  to the line above it. */}
              <div className="mt-5 grid grid-cols-2 gap-4 border-t border-[var(--color-border)] pt-5">
                <Field label="请购人">
                  <SearchSelect
                    options={roster.map((n) => ({ id: n, label: n }))}
                    value={requester}
                    onChange={setRequester}
                    placeholder="谁请购"
                    searchPlaceholder="选人或直接输入姓名…"
                    createLabel="请购人"
                    onCreate={setRequester}
                    triggerLabel={
                      requester && !roster.includes(requester)
                        ? requester
                        : undefined
                    }
                    triggerClass="w-full"
                  />
                </Field>
                <Field label="领料人">
                  <div className="flex items-center gap-1">
                    <div className="min-w-0 flex-1">
                      <SearchSelect
                        options={roster.map((n) => ({ id: n, label: n }))}
                        value={picker}
                        onChange={setPicker}
                        placeholder="可留空"
                        searchPlaceholder="选人或直接输入姓名…"
                        createLabel="领料人"
                        onCreate={setPicker}
                        triggerLabel={
                          picker && !roster.includes(picker)
                            ? picker
                            : undefined
                        }
                        triggerClass="w-full"
                      />
                    </div>
                    {picker && (
                      <button
                        type="button"
                        onClick={() => setPicker('')}
                        title="清除领料人"
                        aria-label="清除领料人"
                        className="shrink-0 rounded-[2px] px-1.5 py-1 text-[13px] leading-none text-[var(--color-ink-4)] hover:text-[var(--color-ink)]"
                      >
                        ×
                      </button>
                    )}
                  </div>
                </Field>
              </div>

              <div className="mt-4">
                <Field label="关联工号">
                  <div className="flex items-center gap-1">
                    <div className="min-w-0 flex-1">
                      <SearchSelect
                        options={jobOptions.map((j) => ({
                          id: j.id,
                          label: j.product
                            ? `${j.jobNo} · ${j.product}`
                            : j.jobNo,
                        }))}
                        value={jobPick?.id ?? ''}
                        onChange={(id) => {
                          const j = jobOptions.find((x) => x.id === id)
                          if (j) setJobPick({ id: j.id, jobNo: j.jobNo })
                        }}
                        placeholder="可留空"
                        searchPlaceholder="搜索工号 / 产品…"
                        triggerClass="w-full"
                        triggerLabel={
                          jobPick && !jobOptions.some((j) => j.id === jobPick.id)
                            ? jobPick.jobNo
                            : undefined
                        }
                      />
                    </div>
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
              </div>

              <div className="mt-4">
                <Field label="备注">
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="给审批和采购的一句话 · 可空"
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

            <div className="flex items-center gap-3 border-t border-[var(--color-border)] px-5 py-3.5">
              <span className="label text-[var(--color-ink-3)]">合计</span>
              <span className="mono text-[15px] font-semibold tracking-tight text-[var(--color-ink)]">
                {typeof liveTotal === 'number' ? formatCny(liveTotal) : '—'}
              </span>
              <div className="flex-1" />
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
                {pending
                  ? '保存中…'
                  : mode === 'edit'
                    ? '保存'
                    : lines.length > 1
                      ? `提交 ${lines.length} 条`
                      : '提交请购'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ===========================================================================

// One line of the 请购单. The 品名 shown is the finished thing being bought —
// 物料 with its 规格 on it — so what the requester reads here is exactly the
// line the approver and the buyer will read later. Tapping it swaps the 物料
// without losing the size and quantity already typed.
function LineRow({
  l,
  autoFocus,
  onPatch,
  onChangeProduct,
  onRemove,
}: {
  l: Line
  autoFocus?: boolean
  onPatch: (patch: Partial<Line>) => void
  onChangeProduct: () => void
  onRemove?: () => void
}) {
  return (
    <div className="rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={onChangeProduct}
          className="group min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-1.5">
            {l.category && <CategoryChip category={l.category} />}
            <span className="truncate text-[14px] font-medium tracking-tight text-[var(--color-ink)] group-hover:underline">
              {joinSpec(l.name, l)}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-[var(--color-ink-3)]">
            {l.supplier || '供应商未填'} · 换物料
          </div>
        </button>
        {l.link && isHttp(l.link) && (
          <a
            href={l.link}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--color-info)] hover:underline"
          >
            链接 <LinkGlyph />
          </a>
        )}
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="删掉这一行"
            title="删掉这一行"
            className="shrink-0 rounded-[2px] px-1 text-[14px] leading-none text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
          >
            ×
          </button>
        )}
      </div>

      {/* 长 × 宽 × 高 mm · 数量 件 · ¥ 单价 — units carry the labels, so the
          row reads the same whether the boxes are empty or full. */}
      <div className="mt-2 flex items-center gap-1.5">
        <Cell
          value={l.l}
          onChange={(v) => onPatch({ l: v })}
          placeholder="长"
          autoFocus={autoFocus}
        />
        <Times />
        <Cell
          value={l.w}
          onChange={(v) => onPatch({ w: v })}
          placeholder="宽"
        />
        <Times />
        <Cell
          value={l.h}
          onChange={(v) => onPatch({ h: v })}
          placeholder="高"
        />
        <Unit>mm</Unit>
        <Cell
          value={l.qty}
          onChange={(v) => onPatch({ qty: v })}
          placeholder="数量"
          wide
        />
        <Unit>件</Unit>
        <Unit>¥</Unit>
        <Cell
          value={l.unitPrice}
          onChange={(v) => onPatch({ unitPrice: v })}
          placeholder="单价"
          wide
        />
      </div>
    </div>
  )
}

function Times() {
  return (
    <span className="shrink-0 text-[12px] text-[var(--color-ink-4)]">×</span>
  )
}

function Unit({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 text-[11.5px] text-[var(--color-ink-3)]">
      {children}
    </span>
  )
}

function Cell({
  value,
  onChange,
  placeholder,
  wide,
  autoFocus,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  wide?: boolean
  autoFocus?: boolean
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      inputMode="decimal"
      className={`mono min-w-0 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-1 text-center text-[12.5px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)] ${
        wide ? 'flex-[1.3]' : 'flex-1'
      }`}
    />
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
