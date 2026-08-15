'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { formatCny, type OrderLedgerRow, type ProcurementStatus } from '@/lib/data'
import { shiftDate, windowDateBounds, type Granularity } from '@/lib/today'
import { SearchInput } from '@/app/_search'
import { DatePop } from '@/app/_datepop'

// 订单 — the money read of the order book, one row per 工单:
//
//   订单额 (hand-typed, 未定 until commerce sets it)
//   − 外协   every block the order paid for — which 厂商, how much
//   − 采购   every 关联工号 buy — what was bought, from whom, how much
//   = 毛利
//
// One payload from getOrderLedgerRows(); everything here — the period, the
// search, the export — is client-side, like the 分期账 next tab over. The
// period is ONE from→to range: 日/周/月 are presets that fill it, the two
// dates are directly editable (→ 自定义), 全部 drops it. Default = this month.
//
// 导出 writes THREE sheets: 订单 (one row per order with its money summary),
// 外协明细 and 采购明细 (the receipts behind the numbers) — so the file
// answers "这单花在哪了" without opening the app.

const PAGE_SIZE = 50

type Gran = Granularity | 'all' | 'custom'

const BUY_STATUS_LABEL: Record<ProcurementStatus, string> = {
  requested: '待审批',
  approved: '待采购',
  ordered: '待到货',
  arrived: '待领料',
  done: '已领料',
  rejected: '已驳回', // never reaches the ledger (filtered server-side)
}

export function OrderLedger({
  rows,
  todayStr,
}: {
  rows: OrderLedgerRow[]
  todayStr: string
}) {
  const [gran, setGran] = useState<Gran>('month')
  const [anchor, setAnchor] = useState(todayStr)
  const [custom, setCustom] = useState<{ from: string; to: string }>(() =>
    windowDateBounds(todayStr, 'month'),
  )
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const bounds =
    gran === 'all'
      ? null
      : gran === 'custom'
        ? custom
        : windowDateBounds(anchor, gran)

  // Search haystack per row — 工号/客户/产品 plus every vendor, 品名 and
  // supplier inside, so "旺发" finds the orders that used that vendor.
  const hays = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of rows) {
      m.set(
        r.jobId,
        [
          r.jobNo,
          r.customer,
          r.product,
          ...r.outsource.map((o) => `${o.vendorName} ${o.activity ?? ''} ${o.docNo ?? ''}`),
          ...r.buys.map((b) => `${b.item} ${b.supplier ?? ''}`),
        ]
          .join(' ')
          .toLowerCase(),
      )
    }
    return m
  }, [rows])

  // Cheap enough to run per render (string compares over ~a few thousand
  // rows) — no memo, so the deps can't go stale.
  const query = q.trim().toLowerCase()
  const filtered = rows.filter((r) => {
    if (bounds && (r.createdDate < bounds.from || r.createdDate > bounds.to))
      return false
    if (query && !(hays.get(r.jobId) ?? '').includes(query)) return false
    return true
  })

  // Rollup over the FILTERED set — the stats always describe what the sheet
  // below shows (and what 导出 will write). 毛利 only sums 已定价 orders, but
  // their 成本 still includes every 外协/采购 receipt.
  const totals = { amount: 0, unpriced: 0, outsource: 0, procurement: 0, margin: 0, priced: 0 }
  for (const r of filtered) {
    totals.outsource += r.outsourceCny
    totals.procurement += r.procurementCny
    if (r.amountCny == null) {
      totals.unpriced += 1
    } else {
      totals.amount += r.amountCny
      totals.margin += r.amountCny - r.outsourceCny - r.procurementCny
      totals.priced += 1
    }
  }

  const safePage = Math.min(page, Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)))
  const display = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const setPeriod = (g: Gran) => {
    setGran(g)
    setPage(1)
  }
  const step = (dir: number) => {
    setPage(1)
    if (gran === 'custom') {
      // Slide the custom window by its own span (inclusive days).
      const span =
        Math.round(
          (Date.parse(custom.to) - Date.parse(custom.from)) / 86400000,
        ) + 1
      setCustom({
        from: shiftDate(custom.from, 'day', dir * span),
        to: shiftDate(custom.to, 'day', dir * span),
      })
      return
    }
    if (gran !== 'all') setAnchor((a) => shiftDate(a, gran, dir))
  }
  const setCustomEdge = (edge: 'from' | 'to', value: string) => {
    if (!value) return
    const base = bounds ?? { from: value, to: value }
    let next = { ...base, [edge]: value }
    // Inverted pick (从 after 到 or vice versa) → collapse to that single day.
    if (next.from > next.to) next = { from: value, to: value }
    setCustom(next)
    setGran('custom')
    setPage(1)
  }
  const containsToday =
    !bounds || (todayStr >= bounds.from && todayStr <= bounds.to)

  return (
    <div>
      {/* The four numbers the boss actually asks for, scoped to the period. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-10 mb-14">
        <Stat
          label="订单"
          value={String(filtered.length)}
          sub={totals.unpriced > 0 ? `其中 ${totals.unpriced} 单价格未定` : '全部已定价'}
        />
        <Stat label="订单额" value={formatCny(totals.amount)} sub="已定价订单合计" />
        <Stat
          label="成本"
          value={formatCny(totals.outsource + totals.procurement)}
          sub={`外协 ${formatCny(totals.outsource)} · 采购 ${formatCny(totals.procurement)}`}
        />
        <Stat
          label="毛利"
          value={formatCny(totals.margin)}
          sub={`按已定价 ${totals.priced} 单 · 订单额 − 外协 − 采购`}
          tone={totals.margin < 0 ? 'overdue' : undefined}
        />
      </div>

      {/* Period + search + export — one control row. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4 mb-6">
        <div className="inline-flex rounded-[2px] border border-[var(--color-border)] overflow-hidden">
          {(
            [
              ['day', '日'],
              ['week', '周'],
              ['month', '月'],
              ['all', '全部'],
            ] as [Gran, string][]
          ).map(([g, label]) => (
            <button
              key={g}
              type="button"
              onClick={() => setPeriod(g)}
              className={`px-2.5 py-1 text-[12px] transition-colors ${
                gran === g
                  ? 'bg-[var(--color-active-bg)] font-medium text-[var(--color-ink)]'
                  : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {bounds && (
          <div className="flex items-center gap-0.5">
            <Step dir={-1} onClick={() => step(-1)} />
            <span className="inline-flex items-center gap-1 text-[13px] tabular-nums">
              <DatePop
                value={bounds.from}
                onChange={(v) => setCustomEdge('from', v)}
                formatLabel={dateLabel(todayStr)}
                hideIcon
              />
              <span className="text-[var(--color-ink-4)]">–</span>
              <DatePop
                value={bounds.to}
                onChange={(v) => setCustomEdge('to', v)}
                formatLabel={dateLabel(todayStr)}
                hideIcon
              />
            </span>
            <Step dir={1} onClick={() => step(1)} />
            {!containsToday && (
              <button
                type="button"
                onClick={() => {
                  setGran(gran === 'custom' || gran === 'all' ? 'month' : gran)
                  setAnchor(todayStr)
                  setPage(1)
                }}
                className="ml-1 px-2 py-1 rounded-[2px] text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface)] transition-colors"
              >
                本月
              </button>
            )}
          </div>
        )}

        <div className="ml-auto flex items-center gap-6">
          <SearchInput
            q={q}
            setQ={(v) => {
              setQ(v)
              setPage(1)
            }}
            placeholder="搜索 · 工号 / 客户 / 产品 / 厂商"
          />
          <ExportButton rows={filtered} bounds={bounds} todayStr={todayStr} />
        </div>
      </div>

      {/* The sheet. 订单额 is the row's one big number; 成本 carries its own
          外协/采购 split in the panel, one click down. */}
      <div className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              <Th>下单</Th>
              <Th className="min-w-[130px]">工号</Th>
              <Th className="min-w-[150px]">客户</Th>
              <Th className="min-w-[150px]">产品</Th>
              <Th className="text-right">订单额</Th>
              <Th className="text-right">外协</Th>
              <Th className="text-right">采购</Th>
              <Th className="text-right pr-4">毛利</Th>
            </tr>
          </thead>
          <tbody>
            {display.map((r) => (
              <OrderRow
                key={r.jobId}
                row={r}
                open={expanded.has(r.jobId)}
                onToggle={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev)
                    if (next.has(r.jobId)) next.delete(r.jobId)
                    else next.add(r.jobId)
                    return next
                  })
                }
              />
            ))}
            {display.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="py-20 text-center text-[13px] text-[var(--color-ink-3)]"
                >
                  {query ? '没有匹配的订单' : '这个时间段没有订单'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {filtered.length > 0 && (
        <div className="mt-5 flex items-center justify-between">
          <p className="label tabular-nums">
            {(safePage - 1) * PAGE_SIZE + 1}–
            {Math.min(safePage * PAGE_SIZE, filtered.length)} / 共 {filtered.length} 单
          </p>
          {filtered.length > PAGE_SIZE && (
            <div className="flex items-center gap-1">
              <PageBtn
                label="上一页"
                disabled={safePage <= 1}
                onClick={() => setPage(safePage - 1)}
              />
              <PageBtn
                label="下一页"
                disabled={safePage * PAGE_SIZE >= filtered.length}
                onClick={() => setPage(safePage + 1)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// One order. The row is a summary at rest; the click opens the receipts —
// never a mutation on the scan path (this whole tab is read-only).
function OrderRow({
  row,
  open,
  onToggle,
}: {
  row: OrderLedgerRow
  open: boolean
  onToggle: () => void
}) {
  const margin =
    row.amountCny == null
      ? undefined
      : row.amountCny - row.outsourceCny - row.procurementCny
  return (
    <>
      <tr
        onClick={onToggle}
        className={`border-b border-[var(--color-border)] cursor-pointer transition-colors hover:bg-[var(--color-active-bg)] ${
          open ? 'bg-[var(--color-active-bg)]' : ''
        }`}
      >
        <Td className="whitespace-nowrap text-[12px] text-[var(--color-ink-3)] tabular-nums">
          {mmdd(row.createdDate)}
        </Td>
        <Td className="whitespace-nowrap">
          <span className="mono text-[13px] text-[var(--color-ink)]">{row.jobNo || '—'}</span>
        </Td>
        <Td className="text-[13px] text-[var(--color-ink-2)] max-w-[240px] truncate">
          {row.customer}
        </Td>
        <Td className="text-[13px] text-[var(--color-ink-2)] max-w-[240px] truncate">
          {row.product}
        </Td>
        <Td className="text-right whitespace-nowrap">
          {row.amountCny == null ? (
            <span className="text-[12px] text-[var(--color-ink-4)]">未定</span>
          ) : (
            <span className="text-[14px] font-semibold tabular-nums text-[var(--color-ink)]">
              {formatCny(row.amountCny)}
            </span>
          )}
        </Td>
        <Td className="text-right whitespace-nowrap">
          <CostCell amount={row.outsourceCny} count={row.outsource.length} />
        </Td>
        <Td className="text-right whitespace-nowrap">
          <CostCell amount={row.procurementCny} count={row.buys.length} />
        </Td>
        <Td className="text-right pr-4 whitespace-nowrap">
          {margin == null ? (
            <span className="text-[12px] text-[var(--color-ink-4)]">—</span>
          ) : (
            <span
              className={`text-[13px] font-medium tabular-nums ${
                margin < 0 ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink)]'
              }`}
            >
              {formatCny(margin)}
            </span>
          )}
        </Td>
      </tr>
      {open && (
        <tr className="border-b border-[var(--color-border)]">
          <td colSpan={8} className="px-3 pb-5 pt-1">
            <ReceiptsPanel row={row} margin={margin} />
          </td>
        </tr>
      )}
    </>
  )
}

// 外协/采购 cell: the number when there's spend, the count greyed when the
// lines exist but nothing is priced yet, a dash when there's nothing at all.
function CostCell({ amount, count }: { amount: number; count: number }) {
  if (count === 0)
    return <span className="text-[12px] text-[var(--color-ink-4)]">—</span>
  if (amount === 0)
    return (
      <span className="text-[12px] text-[var(--color-ink-4)]">{count} 笔未定价</span>
    )
  return (
    <span className="text-[13px] tabular-nums text-[var(--color-ink-2)]">
      {formatCny(amount)}
    </span>
  )
}

// Per-厂 rollup of an order's 外协 spend — several blocks to the same vendor
// collapse into one slice. Drives the panel's 分厂 subtotal line and the
// export's 外协(分厂) column, in first-dispatch order.
type VendorSlice = { name: string; amountCny: number; unpriced: number }

function vendorSlices(row: OrderLedgerRow): VendorSlice[] {
  const m = new Map<string, VendorSlice>()
  for (const o of row.outsource) {
    let s = m.get(o.vendorName)
    if (!s) {
      s = { name: o.vendorName, amountCny: 0, unpriced: 0 }
      m.set(o.vendorName, s)
    }
    if (o.amountCny == null) s.unpriced += 1
    else s.amountCny += o.amountCny
  }
  return [...m.values()]
}

// '科恒 ¥700' / '科恒 ¥700 (含1笔未定价)' / '科恒 未定价' — one slice as text.
function sliceText(s: VendorSlice): string {
  if (s.amountCny === 0 && s.unpriced > 0) return `${s.name} 未定价`
  return `${s.name} ${formatCny(s.amountCny)}${s.unpriced > 0 ? ` (含${s.unpriced}笔未定价)` : ''}`
}

// The receipts behind the row: every 外协 block and every 采购 buy, each with
// its own money line, plus the derived total. Read-only by design.
function ReceiptsPanel({
  row,
  margin,
}: {
  row: OrderLedgerRow
  margin: number | undefined
}) {
  const slices = vendorSlices(row)
  return (
    <div className="pl-1 md:pl-6">
      <div className="grid gap-x-14 gap-y-6 md:grid-cols-2 items-start">
        <section>
          <p className="label mb-2">外协 · {row.outsource.length} 笔</p>
          {row.outsource.length === 0 ? (
            <p className="text-[12px] text-[var(--color-ink-4)]">无外协</p>
          ) : (
            <ul className="space-y-1.5">
              {row.outsource.map((o) => (
                <li key={o.blockId} className="flex items-baseline gap-3 text-[13px]">
                  <span className="text-[var(--color-ink)]">{o.vendorName}</span>
                  {o.activity && (
                    <span className="text-[12px] text-[var(--color-ink-3)]">{o.activity}</span>
                  )}
                  <span className="text-[12px] text-[var(--color-ink-4)] tabular-nums">
                    {mmdd(o.sentDate)}
                    {o.docNo ? ` · ${o.docNo}` : ''}
                  </span>
                  <span className="ml-auto tabular-nums text-[var(--color-ink-2)]">
                    {o.amountCny == null ? (
                      <span className="text-[12px] text-[var(--color-ink-4)]">未定价</span>
                    ) : (
                      formatCny(o.amountCny)
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {/* 分厂小计 — only earns its line when the order actually split
              across vendors; a single-厂 order's total IS its block list. */}
          {slices.length > 1 && (
            <p className="mt-2.5 pt-2 border-t border-[var(--color-border)] text-[12px] text-[var(--color-ink-3)] tabular-nums">
              {slices.map((s, i) => (
                <span key={s.name}>
                  {i > 0 && <span className="text-[var(--color-ink-4)]"> · </span>}
                  {s.name}{' '}
                  <span className="text-[var(--color-ink-2)] font-medium">
                    {s.amountCny === 0 && s.unpriced > 0 ? '未定价' : formatCny(s.amountCny)}
                  </span>
                </span>
              ))}
            </p>
          )}
        </section>
        <section>
          <p className="label mb-2">采购 · {row.buys.length} 笔</p>
          {row.buys.length === 0 ? (
            <p className="text-[12px] text-[var(--color-ink-4)]">无关联采购</p>
          ) : (
            <ul className="space-y-1.5">
              {row.buys.map((b) => (
                <li key={b.id} className="flex items-baseline gap-3 text-[13px]">
                  <span className="text-[var(--color-ink)] max-w-[220px] truncate">{b.item}</span>
                  {b.supplier && (
                    <span className="text-[12px] text-[var(--color-ink-3)] max-w-[140px] truncate">
                      {b.supplier}
                    </span>
                  )}
                  <span className="text-[12px] text-[var(--color-ink-4)] tabular-nums">
                    {b.qty != null && b.unitPriceCny != null
                      ? `${b.qty} × ${formatCny(b.unitPriceCny)}`
                      : BUY_STATUS_LABEL[b.status]}
                  </span>
                  <span className="ml-auto tabular-nums text-[var(--color-ink-2)]">
                    {b.totalCny == null ? (
                      <span className="text-[12px] text-[var(--color-ink-4)]">未定价</span>
                    ) : (
                      formatCny(b.totalCny)
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <div className="mt-4 flex items-baseline gap-5 text-[12px] text-[var(--color-ink-3)]">
        <span className="tabular-nums">
          订单额 {row.amountCny == null ? '未定' : formatCny(row.amountCny)} − 外协{' '}
          {formatCny(row.outsourceCny)} − 采购 {formatCny(row.procurementCny)} ={' '}
          <span
            className={`font-medium ${
              margin != null && margin < 0
                ? 'text-[var(--color-overdue)]'
                : 'text-[var(--color-ink)]'
            }`}
          >
            毛利 {margin == null ? '未定' : formatCny(margin)}
          </span>
        </span>
        <Link
          href={`/jobs/${row.jobId}`}
          onClick={(e) => e.stopPropagation()}
          className="ml-auto text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] underline underline-offset-2 decoration-[var(--color-border-strong)] transition-colors"
        >
          打开工单 →
        </Link>
      </div>
    </div>
  )
}

// === 导出 — the current filtered view, receipts included ====================

function ExportButton({
  rows,
  bounds,
  todayStr,
}: {
  rows: OrderLedgerRow[]
  bounds: { from: string; to: string } | null
  todayStr: string
}) {
  const [busy, setBusy] = useState(false)
  const disabled = busy || rows.length === 0

  const onExport = async () => {
    if (disabled) return
    setBusy(true)
    try {
      const XLSX = await import('xlsx')
      const num = (n: number | null | undefined): number | string =>
        typeof n === 'number' && Number.isFinite(n) ? n : ''

      // Sheet 1 — one row per order. Raw numbers so 财务 can SUM the columns;
      // 订单额 stays blank (not 0) on a 未定 order so averages don't lie.
      const orderHead = [
        '下单日期',
        '工号',
        '客户',
        '产品',
        '订单额',
        '外协成本',
        '采购成本',
        '成本合计',
        '毛利',
        '外协分厂', // per-厂 money, e.g. 科恒 ¥700、旺发 ¥1,200
        '交期',
      ]
      const orderBody = rows.map((r) => [
        r.createdDate,
        r.jobNo,
        r.customer,
        r.product,
        num(r.amountCny),
        num(r.outsourceCny || undefined),
        num(r.procurementCny || undefined),
        num(r.outsourceCny + r.procurementCny || undefined),
        r.amountCny == null
          ? ''
          : r.amountCny - r.outsourceCny - r.procurementCny,
        vendorSlices(r).map(sliceText).join('、'),
        r.dueDate,
      ])

      // Sheet 2 — 外协 receipts, one row per block.
      const wxHead = ['工号', '客户', '产品', '厂商', '工序', '寄出日期', '外协单号', '金额']
      const wxBody = rows.flatMap((r) =>
        r.outsource.map((o) => [
          r.jobNo,
          r.customer,
          r.product,
          o.vendorName,
          o.activity ?? '',
          o.sentDate,
          o.docNo ?? '',
          num(o.amountCny),
        ]),
      )

      // Sheet 3 — 采购 receipts, one row per buy.
      const cgHead = ['工号', '客户', '产品', '品名', '供应商', '数量', '单价', '金额', '状态', '采购日期']
      const cgBody = rows.flatMap((r) =>
        r.buys.map((b) => [
          r.jobNo,
          r.customer,
          r.product,
          b.item,
          b.supplier ?? '',
          num(b.qty),
          num(b.unitPriceCny),
          num(b.totalCny),
          BUY_STATUS_LABEL[b.status],
          b.orderDate,
        ]),
      )

      const wb = XLSX.utils.book_new()
      const sheet = (head: string[], body: (string | number)[][], widths: number[]) => {
        const ws = XLSX.utils.aoa_to_sheet([head, ...body])
        ws['!cols'] = widths.map((wch) => ({ wch }))
        return ws
      }
      XLSX.utils.book_append_sheet(
        wb,
        sheet(orderHead, orderBody, [11, 16, 20, 22, 10, 10, 10, 10, 10, 32, 11]),
        '订单',
      )
      XLSX.utils.book_append_sheet(
        wb,
        sheet(wxHead, wxBody, [16, 20, 22, 16, 10, 11, 18, 10]),
        '外协明细',
      )
      XLSX.utils.book_append_sheet(
        wb,
        sheet(cgHead, cgBody, [16, 20, 22, 24, 16, 7, 9, 10, 9, 11]),
        '采购明细',
      )

      const span = bounds ? `${bounds.from}_${bounds.to}` : `全部_${todayStr}`
      XLSX.writeFile(wb, `订单账_${span}.xlsx`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={onExport}
      disabled={disabled}
      title="导出当前筛选的订单 (含外协/采购明细)"
      className={`inline-flex items-center gap-1.5 text-[13px] transition-colors whitespace-nowrap ${
        disabled
          ? 'text-[var(--color-ink-4)] cursor-default'
          : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
      }`}
    >
      {busy ? '导出中…' : '导出 Excel'}
      <span aria-hidden className="text-[14px] leading-none">↓</span>
    </button>
  )
}

// === Small pieces ===========================================================

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub: string
  tone?: 'overdue'
}) {
  return (
    <div>
      <p
        className={`text-[32px] md:text-[36px] font-semibold tracking-tight tabular-nums leading-none ${
          tone === 'overdue' ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink)]'
        }`}
      >
        {value}
      </p>
      <p className="label mt-3">{label}</p>
      <p className="text-[12px] text-[var(--color-ink-3)] mt-1 tabular-nums">{sub}</p>
    </div>
  )
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <th className={`label font-medium px-3 py-3 text-left whitespace-nowrap ${className}`}>
      {children}
    </th>
  )
}

function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 align-middle ${className}`}>{children}</td>
}

function Step({ dir, onClick }: { dir: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={dir < 0 ? '上一周期' : '下一周期'}
      className="inline-flex h-7 w-7 items-center justify-center rounded-[2px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface)] transition-colors"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        aria-hidden="true"
        className={dir > 0 ? 'rotate-180' : ''}
      >
        <path
          d="M8.5 3.5 L5 7 L8.5 10.5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

function PageBtn({
  label,
  disabled,
  onClick,
}: {
  label: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-2.5 py-1 rounded-[2px] border text-[12px] transition-colors ${
        disabled
          ? 'border-[var(--color-border)] text-[var(--color-ink-4)] cursor-default'
          : 'border-[var(--color-border)] text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-ink)]'
      }`}
    >
      {label}
    </button>
  )
}

// '2026-08-05' → '8月5日' (year shown only when it differs from today's).
function dateLabel(todayStr: string): (iso: string) => string {
  const curYear = todayStr.slice(0, 4)
  return (iso: string) => {
    const [y, m, d] = iso.split('-')
    const base = `${parseInt(m, 10)}月${parseInt(d, 10)}日`
    return y === curYear ? base : `${y}年${base}`
  }
}

function mmdd(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso
  return iso.slice(5, 10)
}
