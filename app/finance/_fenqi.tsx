'use client'

// 分期账 — the finance clerk's ledger, shaped as HER Excel (same columns, same
// words, same order — 状态 rides last, never first) so there is nothing to
// learn. The two sheets she keeps today are the two leading lenses (未开票 /
// 已开待收); the yellow 开票情况 cell and the green 收款记录 cell are SENTENCES
// GENERATED from the installment events — she reads what she has always read,
// but never writes or computes a 剩余 again.
//
// Interaction rules that keep it a ledger, not a form:
//   • Text at rest. Every row cell is plain text on the scan path — 是否收费 is
//     a WORD, not a button (a misclick must never silently write 免收). In the
//     detail panel the 订单号 / 物料号 / 订单额 render as text; you click a value
//     to swap in its input (ClickEdit), commit or Escape returns to text.
//   • Drafts, not empty rows. ＋订单号 opens a LOCAL draft row (no DB write until
//     保存); a zero-line job opens one automatically. Nothing hits po_lines
//     until she's typed a 订单号 or a 金额.
//   • 免收 lives in the panel. The only way to flip 是否收费 is the deliberate
//     标为免收 / 恢复收费 button inside the expanded job — off the row scan path.
//
// Fully client-driven: one FenqiData payload from the server, every lens /
// search / expand / append is a local state change (the 报工 cockpit lesson —
// no per-click server round-trips). Writes go through /api/mutate and are
// applied optimistically to local state; a failed write toasts and re-syncs.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { formatCny } from '@/lib/data'
import { SearchInput } from '@/app/_search'
import { DatePop } from '@/app/_datepop'
import { shipDateLabel } from '@/lib/finance'
import {
  buildRows,
  sortRows,
  passLens,
  matchesQuery,
  lensCounts,
  fenqiTotals,
  invoiceSentence,
  paymentSentence,
  formatNum,
  FENQI_LENSES,
  FENQI_LENS_LABEL,
  FENQI_STATUS_LABEL,
  FENQI_AGING_DAYS,
  type FenqiData,
  type FenqiEvent,
  type FenqiJob,
  type FenqiLens,
  type FenqiLine,
  type FenqiStatus,
  type LineVM,
  type RowVM,
  type SentenceSeg,
} from '@/lib/fenqi'

const PAGE_SIZE = 50

// Identical to _editable.tsx's baseInputClass so ledger fields read the same
// as every other inline edit in the product.
const baseInputClass =
  'block w-full bg-transparent border-0 outline-none rounded-[2px] px-1 -mx-1 py-0.5 transition-[background-color,box-shadow] duration-150 hover:bg-[var(--color-active-bg)] hover:shadow-[inset_0_-1px_0_var(--color-border-strong)] focus:bg-[var(--color-active-bg)] focus:shadow-[inset_0_-1px_0_var(--color-ink)]'

// State as colored text — the app's idiom (see finance _ledger / DueCell).
const STATUS_TEXT: Record<FenqiStatus, string> = {
  overdue: 'text-[var(--color-overdue)] font-medium',
  unbooked: 'text-[var(--color-warning)]',
  await: 'text-[var(--color-info)]',
  collect: 'text-[var(--color-warning)]',
  settled: 'text-[var(--color-success)]',
  free: 'text-[var(--color-ink-4)]',
}

const SEG_TEXT: Record<SentenceSeg['k'], string> = {
  po: 'text-[var(--color-ink)] font-medium',
  txt: 'text-[var(--color-ink-2)]',
  rem: 'text-[var(--color-ink-3)]',
  done: 'text-[var(--color-success)]',
}

export function FenqiLedger({
  data,
  todayStr,
  month,
  monthLabel,
  initialQ,
}: {
  data: FenqiData
  todayStr: string
  month: string
  monthLabel: string
  initialQ: string
}) {
  const router = useRouter()

  // Local mirrors of the server payload — the optimistic-write surface. A new
  // server payload (navigation / refresh) resets them wholesale.
  const [jobs, setJobs] = useState<FenqiJob[]>(data.jobs)
  const [lines, setLines] = useState<FenqiLine[]>(data.lines)
  const [events, setEvents] = useState<FenqiEvent[]>(data.events)
  useEffect(() => {
    setJobs(data.jobs)
    setLines(data.lines)
    setEvents(data.events)
  }, [data])

  const [lens, setLens] = useState<FenqiLens>('wei')
  const [q, setQ] = useState(initialQ)
  useEffect(() => setQ(initialQ), [initialQ])
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // One composer at a time: which PO line is taking a new 开票/收款.
  const [composer, setComposer] = useState<{
    lineId: string
    kind: 'invoice' | 'payment'
  } | null>(null)

  const rows = useMemo(
    () => sortRows(buildRows({ jobs, lines, events }, todayStr)),
    [jobs, lines, events, todayStr],
  )
  const totals = useMemo(
    () => fenqiTotals(rows, events, month),
    [rows, events, month],
  )
  const counts = useMemo(() => lensCounts(rows), [rows])

  const visible = useMemo(
    () => rows.filter((r) => passLens(r, lens) && matchesQuery(r, q)),
    [rows, lens, q],
  )
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const display = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const resync = () => router.refresh()

  // === writes (optimistic; server errors toast + resync) ===

  // Book a real PO line from a committed draft row. Optimistic append with the
  // values she typed; returns whether the write landed so the panel can clear
  // its draft only on success.
  const addLine = async (
    jobId: string,
    init: { poNo?: string; materialNo?: string; amountCny?: number },
  ): Promise<boolean> => {
    try {
      const r = await mutate<{ id: string }>({ kind: 'createPoLine', jobId, init })
      setLines((prev) => [
        ...prev,
        {
          id: r.data.id,
          jobId,
          poNo: init.poNo?.trim() ?? '',
          materialNo: init.materialNo?.trim() || undefined,
          amountCny: init.amountCny ?? 0,
          createdAt: new Date().toISOString(),
        },
      ])
      return true
    } catch (e) {
      showToast(`没加上 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
      return false
    }
  }

  const saveLine = async (
    lineId: string,
    patch: { poNo?: string; materialNo?: string | null; amountCny?: number },
  ) => {
    const prev = lines
    setLines((ls) =>
      ls.map((l) =>
        l.id === lineId
          ? {
              ...l,
              ...(patch.poNo !== undefined ? { poNo: patch.poNo } : {}),
              ...(patch.materialNo !== undefined
                ? { materialNo: patch.materialNo ?? undefined }
                : {}),
              ...(patch.amountCny !== undefined
                ? { amountCny: patch.amountCny }
                : {}),
            }
          : l,
      ),
    )
    try {
      await mutate({ kind: 'updatePoLine', lineId, patch })
    } catch (e) {
      setLines(prev)
      showToast(`保存失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
      resync()
    }
  }

  const removeLine = async (lineId: string) => {
    const prev = lines
    setLines((ls) => ls.filter((l) => l.id !== lineId))
    try {
      await mutate({ kind: 'deletePoLine', lineId })
    } catch (e) {
      setLines(prev)
      showToast(e instanceof Error ? e.message : '删除失败', 'warning')
    }
  }

  const addEvent = async (
    line: FenqiLine,
    kind: 'invoice' | 'payment',
    draft: { amountCny: number; eventDate: string; invoiceNo?: string },
  ) => {
    const input = {
      poLineId: line.id,
      kind,
      amountCny: draft.amountCny,
      eventDate: draft.eventDate,
      ...(draft.invoiceNo ? { invoiceNo: draft.invoiceNo } : {}),
    }
    const r = await mutate<{ id: string }>({ kind: 'createMoneyEvent', input })
    setEvents((prev) => [
      ...prev,
      {
        id: r.data.id,
        poLineId: line.id,
        kind,
        amountCny: draft.amountCny,
        eventDate: draft.eventDate,
        invoiceNo: draft.invoiceNo,
        createdAt: new Date().toISOString(),
      },
    ])
    setComposer(null)
    showToast(kind === 'invoice' ? '开票已记 — 剩余已自动更新' : '收款已记 — 余额已自动更新')
  }

  const voidEvent = async (ev: FenqiEvent) => {
    try {
      const r = await mutate<{ id: string }>({
        kind: 'voidMoneyEvent',
        eventId: ev.id,
      })
      setEvents((prev) => [
        ...prev,
        {
          id: r.data.id,
          poLineId: ev.poLineId,
          kind: ev.kind,
          amountCny: ev.amountCny,
          eventDate: todayStr,
          note: '红冲',
          reversalOf: ev.id,
          createdAt: new Date().toISOString(),
        },
      ])
      showToast('已作废（红冲一笔，历史原样保留）')
    } catch (e) {
      showToast(e instanceof Error ? e.message : '作废失败', 'warning')
    }
  }

  const toggleBillable = async (job: FenqiJob) => {
    const next = !job.billable
    const prev = jobs
    setJobs((js) =>
      js.map((j) => (j.jobId === job.jobId ? { ...j, billable: next } : j)),
    )
    try {
      await mutate({ kind: 'setJobBillable', jobId: job.jobId, billable: next })
      showToast(next ? '已改回收费' : '已标为免收 — 不再计入任何合计')
    } catch (e) {
      setJobs(prev)
      showToast(`保存失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
    }
  }

  const toggleExpand = (jobId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(jobId)) next.delete(jobId)
      else next.add(jobId)
      return next
    })
    setComposer(null)
  }

  const colSpan = lens === 'all' || lens === 'settled' ? 9 : 8

  return (
    <div>
      {/* KPI strip — live: appending an event moves these in the same frame. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-10 mb-14">
        <Stat label="待开票" value={formatCny(totals.waitCny)} sub="订单额 − 已开票" />
        <Stat
          label="应收未收"
          value={formatCny(totals.unpaidCny)}
          sub="已开票 − 已收款"
        />
        <Stat
          label="其中逾期"
          value={formatCny(totals.overdueCny)}
          sub={
            totals.overdueCount > 0
              ? `${totals.overdueCount} 单 · 开票超 ${FENQI_AGING_DAYS} 天`
              : '无逾期'
          }
          tone={totals.overdueCny > 0 ? 'overdue' : undefined}
        />
        <Stat
          label={`${monthLabel}回款`}
          value={formatCny(totals.paidThisMonthCny)}
          sub={`${monthLabel}开票 ${formatCny(totals.invoicedThisMonthCny)}`}
          tone="success"
        />
      </div>

      {/* Toolbar — underline-active lens toggles (= her two sheets) + search. */}
      <div className="flex flex-wrap items-end gap-x-8 gap-y-4 mb-6">
        <div role="tablist" aria-label="页签" className="flex items-baseline gap-x-6">
          {FENQI_LENSES.map((l) => {
            const active = l === lens
            return (
              <button
                key={l}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setLens(l)
                  setPage(1)
                }}
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
                  {FENQI_LENS_LABEL[l]}
                </span>
                <span className="mono text-[11px] text-[var(--color-ink-4)] tabular-nums">
                  {counts[l]}
                </span>
              </button>
            )
          })}
        </div>

        <div className="ml-auto flex items-center gap-6">
          <SearchInput
            q={q}
            setQ={(v) => {
              setQ(v)
              setPage(1)
            }}
            placeholder="搜索 · 客户 / 流水号 / 订单号 / 发票号"
          />
          <a
            href="/finance/export"
            className="inline-flex items-center gap-1.5 text-[13px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors whitespace-nowrap"
          >
            导出 Excel
            <span aria-hidden className="text-[14px] leading-none">↓</span>
          </a>
        </div>
      </div>

      {/* Ledger surface — columns swap with the lens, exactly like switching
          between her two sheets. */}
      <div className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              {lens === 'shou' ? (
                <>
                  <Th className="min-w-[170px]">客户名称</Th>
                  <Th>内部流水号</Th>
                  <Th className="text-right">订单金额</Th>
                  <Th>开票日期</Th>
                  <Th className="min-w-[150px]">发票号码</Th>
                  <Th className="text-right">未收</Th>
                  <Th className="min-w-[260px]">收款记录（自动）</Th>
                  <Th>状态</Th>
                </>
              ) : lens === 'wei' ? (
                <>
                  <Th>日期</Th>
                  <Th className="min-w-[170px]">客户名称</Th>
                  <Th className="min-w-[150px]">订单号 / 物料号</Th>
                  <Th>是否收费</Th>
                  <Th className="text-right">未开票金额</Th>
                  <Th>内部流水号</Th>
                  <Th className="min-w-[260px]">开票情况（自动）</Th>
                  <Th>状态</Th>
                </>
              ) : (
                <>
                  <Th>日期</Th>
                  <Th className="min-w-[170px]">客户</Th>
                  <Th>内部流水号</Th>
                  <Th className="text-right">订单额</Th>
                  <Th className="text-right">已开票</Th>
                  <Th className="text-right">待开票</Th>
                  <Th className="text-right">已收款</Th>
                  <Th className="text-right">未收</Th>
                  <Th>状态</Th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {display.map((r) => {
              const open = expanded.has(r.job.jobId)
              return (
                <RowGroup
                  key={r.job.jobId}
                  row={r}
                  lens={lens}
                  open={open}
                  colSpan={colSpan}
                  todayStr={todayStr}
                  composer={composer}
                  onToggle={() => toggleExpand(r.job.jobId)}
                  onToggleBillable={() => toggleBillable(r.job)}
                  onAddLine={(init) => addLine(r.job.jobId, init)}
                  onSaveLine={saveLine}
                  onRemoveLine={removeLine}
                  onSetComposer={setComposer}
                  onAddEvent={addEvent}
                  onVoid={voidEvent}
                />
              )
            })}
            {display.length === 0 && (
              <tr>
                <td
                  colSpan={colSpan}
                  className="py-20 text-center text-[13px] text-[var(--color-ink-3)]"
                >
                  {q ? '没有匹配的单' : '这个页签下没有单'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination + scale line */}
      {visible.length > 0 && (
        <div className="mt-5 flex items-center justify-between">
          <p className="label tabular-nums">
            {(safePage - 1) * PAGE_SIZE + 1}–
            {Math.min(safePage * PAGE_SIZE, visible.length)} / 共 {visible.length} 单
            · 出货自动进池
          </p>
          <div className="flex items-center gap-5">
            <PageBtn dir="prev" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} />
            <span className="mono text-[12px] text-[var(--color-ink-2)] tabular-nums">
              {safePage} / {totalPages}
            </span>
            <PageBtn dir="next" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)} />
          </div>
        </div>
      )}
    </div>
  )
}

// === one order: the lens row + (expanded) the per-PO installment panel ===

function RowGroup({
  row,
  lens,
  open,
  colSpan,
  todayStr,
  composer,
  onToggle,
  onToggleBillable,
  onAddLine,
  onSaveLine,
  onRemoveLine,
  onSetComposer,
  onAddEvent,
  onVoid,
}: {
  row: RowVM
  lens: FenqiLens
  open: boolean
  colSpan: number
  todayStr: string
  composer: { lineId: string; kind: 'invoice' | 'payment' } | null
  onToggle: () => void
  onToggleBillable: () => void
  onAddLine: (init: {
    poNo?: string
    materialNo?: string
    amountCny?: number
  }) => Promise<boolean>
  onSaveLine: (
    lineId: string,
    patch: { poNo?: string; materialNo?: string | null; amountCny?: number },
  ) => void
  onRemoveLine: (lineId: string) => void
  onSetComposer: (c: { lineId: string; kind: 'invoice' | 'payment' } | null) => void
  onAddEvent: (
    line: FenqiLine,
    kind: 'invoice' | 'payment',
    draft: { amountCny: number; eventDate: string; invoiceNo?: string },
  ) => Promise<void>
  onVoid: (ev: FenqiEvent) => void
}) {
  const free = row.status === 'free'
  // Expand caret — prefixes the first cell of every row.
  const caret = (
    <span aria-hidden className="inline-block w-[14px] text-[var(--color-ink-4)]">
      {open ? '▾' : '▸'}
    </span>
  )
  const statusCell = (
    <Td className="whitespace-nowrap">
      <span className={`text-[12px] tracking-wide ${STATUS_TEXT[row.status]}`}>
        {FENQI_STATUS_LABEL[row.status]}
        {row.status === 'overdue' ? ` ${row.overdueDays}天` : ''}
      </span>
    </Td>
  )
  // 内部流水号 — its own column now (was a second line under 客户).
  const jobNoCell = (
    <Td className="mono text-[12px] whitespace-nowrap text-[var(--color-ink-2)]">
      {row.job.jobNo}
    </Td>
  )
  // 日期 = latest 出货. `withCaret` is true when 日期 leads the row (wei / all).
  const dateCell = (withCaret: boolean) => (
    <Td className="mono text-[12px] whitespace-nowrap text-[var(--color-ink-2)]">
      <span className="flex items-center gap-1">
        {withCaret && caret}
        <span>{row.job.shipDate ? shipDateLabel(row.job.shipDate) : '—'}</span>
      </span>
    </Td>
  )
  // 客户名称 — single line, links to the job. `withCaret` for 已开待收 where
  // 客户 leads the row.
  const customerCell = (withCaret: boolean) => (
    <Td>
      <span className="flex items-center gap-1">
        {withCaret && caret}
        <Link
          href={`/jobs/${row.job.jobId}`}
          onClick={(e) => e.stopPropagation()}
          className={`block text-[13px] font-medium truncate max-w-[180px] hover:underline decoration-[var(--color-border-strong)] underline-offset-2 ${
            free ? 'text-[var(--color-ink-3)]' : 'text-[var(--color-ink)]'
          }`}
        >
          {row.job.customer || '—'}
        </Link>
      </span>
    </Td>
  )

  return (
    <>
      <tr
        onClick={onToggle}
        aria-expanded={open}
        className={`border-t border-[var(--color-border)] transition-colors cursor-pointer ${
          open ? 'bg-[var(--color-bg)]' : 'hover:bg-[var(--color-bg)]'
        } ${free ? 'opacity-70' : ''}`}
      >
        {lens === 'shou' ? (
          <>
            {customerCell(true)}
            {jobNoCell}
            <Td className="text-right mono text-[13px] whitespace-nowrap">
              {formatCny(row.amountCny)}
            </Td>
            <Td className="mono text-[13px] whitespace-nowrap text-[var(--color-ink-2)]">
              {row.firstInvoiceDate ? shipDateLabel(row.firstInvoiceDate) : '—'}
            </Td>
            <Td>
              <span className="block mono text-[11px] text-[var(--color-ink-2)] max-w-[190px] truncate">
                {row.invoiceNos.length > 0 ? row.invoiceNos.join('、') : '—'}
              </span>
            </Td>
            <Td className="text-right mono text-[13px] whitespace-nowrap">
              <Money amount={row.unpaid} tone={row.status === 'overdue' ? 'overdue' : 'warning'} />
            </Td>
            <Td>
              <Sentence segs={paymentSentence(row)} tone="pay" empty="还没收款 — 点行追加" />
            </Td>
            {statusCell}
          </>
        ) : lens === 'wei' ? (
          <>
            {dateCell(true)}
            {customerCell(false)}
            <Td>
              {row.lines.length === 0 ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggle()
                  }}
                  className="rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-2 py-0.5 text-[12px] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:border-[var(--color-ink-3)] transition-colors"
                >
                  ＋ 补录
                </button>
              ) : (
                <span className="block mono text-[11.5px] leading-relaxed text-[var(--color-ink-2)]">
                  {row.lines.map((lv) => (
                    <span key={lv.line.id} className="block whitespace-nowrap">
                      {lv.line.poNo || '未填'}（{formatNum(lv.line.amountCny)}）
                    </span>
                  ))}
                </span>
              )}
            </Td>
            <Td>
              <span
                className={`text-[12px] ${
                  row.job.billable
                    ? 'text-[var(--color-ink-3)]'
                    : 'text-[var(--color-ink-4)]'
                }`}
              >
                {row.job.billable ? '是' : '否'}
              </span>
            </Td>
            <Td className="text-right mono text-[13px] whitespace-nowrap">
              {free ? (
                <span className="text-[var(--color-ink-4)]">—</span>
              ) : row.status === 'unbooked' ? (
                <span className="text-[var(--color-ink-4)]">待录</span>
              ) : (
                <Money amount={row.wait} tone="info" />
              )}
            </Td>
            {jobNoCell}
            <Td>
              <Sentence
                segs={invoiceSentence(row, todayStr)}
                tone="inv"
                empty={row.lines.length === 0 ? '—' : '还没开票 — 点行追加第一笔'}
              />
            </Td>
            {statusCell}
          </>
        ) : (
          <>
            {dateCell(true)}
            {customerCell(false)}
            {jobNoCell}
            <Td className="text-right mono text-[13px] whitespace-nowrap">
              {formatCny(row.amountCny)}
            </Td>
            <Td className="text-right mono text-[13px] whitespace-nowrap text-[var(--color-ink-3)]">
              {row.invoiced > 0 ? formatCny(row.invoiced) : '—'}
            </Td>
            <Td className="text-right mono text-[13px] whitespace-nowrap">
              <Money amount={free ? 0 : row.wait} tone="info" />
            </Td>
            <Td className="text-right mono text-[13px] whitespace-nowrap text-[var(--color-ink-3)]">
              {row.paid > 0 ? formatCny(row.paid) : '—'}
            </Td>
            <Td className="text-right mono text-[13px] whitespace-nowrap">
              <Money
                amount={free ? 0 : row.unpaid}
                tone={row.status === 'overdue' ? 'overdue' : 'warning'}
              />
            </Td>
            {statusCell}
          </>
        )}
      </tr>

      {open && (
        <tr className="border-t border-[var(--color-border)]">
          <td colSpan={colSpan} className="bg-[var(--color-bg)] px-4 py-4 md:px-6">
            <DetailPanel
              row={row}
              todayStr={todayStr}
              composer={composer}
              onAddLine={onAddLine}
              onToggleBillable={onToggleBillable}
              onSaveLine={onSaveLine}
              onRemoveLine={onRemoveLine}
              onSetComposer={onSetComposer}
              onAddEvent={onAddEvent}
              onVoid={onVoid}
            />
          </td>
        </tr>
      )}
    </>
  )
}

// === the per-PO installment panel (the whole write surface) ===

function DetailPanel({
  row,
  todayStr,
  composer,
  onAddLine,
  onToggleBillable,
  onSaveLine,
  onRemoveLine,
  onSetComposer,
  onAddEvent,
  onVoid,
}: {
  row: RowVM
  todayStr: string
  composer: { lineId: string; kind: 'invoice' | 'payment' } | null
  onAddLine: (init: {
    poNo?: string
    materialNo?: string
    amountCny?: number
  }) => Promise<boolean>
  onToggleBillable: () => void
  onSaveLine: (
    lineId: string,
    patch: { poNo?: string; materialNo?: string | null; amountCny?: number },
  ) => void
  onRemoveLine: (lineId: string) => void
  onSetComposer: (c: { lineId: string; kind: 'invoice' | 'payment' } | null) => void
  onAddEvent: (
    line: FenqiLine,
    kind: 'invoice' | 'payment',
    draft: { amountCny: number; eventDate: string; invoiceNo?: string },
  ) => Promise<void>
  onVoid: (ev: FenqiEvent) => void
}) {
  // Local draft = a 订单号 line she is typing but has NOT written to the DB.
  // A zero-line job opens one immediately so the inputs are live on expand.
  const [draft, setDraft] = useState<
    { poNo: string; materialNo: string; amt: string } | null
  >(row.lines.length === 0 ? { poNo: '', materialNo: '', amt: '' } : null)

  const commitDraft = async () => {
    if (!draft) return
    const n = Number(draft.amt.replace(/[,，\s元]/g, ''))
    const amount = Number.isFinite(n) && n > 0 ? n : 0
    if (draft.poNo.trim() === '' && amount <= 0) {
      showToast('先填订单号或金额', 'warning')
      return
    }
    const landed = await onAddLine({
      poNo: draft.poNo.trim() || undefined,
      materialNo: draft.materialNo.trim() || undefined,
      amountCny: amount,
    })
    if (landed) setDraft(null)
  }

  return (
    <div className="max-w-[880px]">
      <div className="mb-3 flex items-start justify-between gap-3">
        <p className="text-[11px] text-[var(--color-ink-3)]">
          {row.job.jobNo} · 钱挂在订单号下 — 追加一笔，句子和所有余额自动更新
        </p>
        {/* 免收 lives here now — deliberate, off the row scan path. */}
        <button
          type="button"
          onClick={onToggleBillable}
          title={row.job.billable ? '补件/样品，不进任何合计' : '改回收费'}
          className="shrink-0 rounded-[2px] border border-[var(--color-border-strong)] px-2 py-0.5 text-[12px] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:border-[var(--color-ink-3)] transition-colors"
        >
          {row.job.billable ? '标为免收' : '恢复收费'}
        </button>
      </div>
      <div className="space-y-3">
        {row.lines.map((lv) => (
          <LineBlock
            key={lv.line.id}
            lv={lv}
            composer={composer}
            onSaveLine={onSaveLine}
            onRemoveLine={onRemoveLine}
            onSetComposer={onSetComposer}
            onAddEvent={onAddEvent}
            onVoid={onVoid}
            todayStr={todayStr}
          />
        ))}
        {draft && (
          <DraftLine
            draft={draft}
            setDraft={setDraft}
            amountHint={row.job.jobAmountCny}
            onCommit={commitDraft}
            onCancel={() => setDraft(null)}
          />
        )}
      </div>
      <div className="mt-3 flex items-center gap-3">
        {!draft && (
          <button
            type="button"
            onClick={() => setDraft({ poNo: '', materialNo: '', amt: '' })}
            className="rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-2.5 py-1 text-[12px] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:border-[var(--color-ink-3)] transition-colors"
          >
            ＋订单号
          </button>
        )}
        {row.lines.length === 0 && (
          <span className="text-[12px] text-[var(--color-ink-3)]">
            客户下单 / 对账后补录 — 开票收款都挂在订单号下
          </span>
        )}
      </div>
    </div>
  )
}

// A 订单号 line she is typing — three inputs + 保存 / 取消, nothing written to
// the DB until 保存 (or Enter). Escape cancels. Mirrors a LineBlock header so
// it reads like the row it will become.
function DraftLine({
  draft,
  setDraft,
  amountHint,
  onCommit,
  onCancel,
}: {
  draft: { poNo: string; materialNo: string; amt: string }
  setDraft: (d: { poNo: string; materialNo: string; amt: string }) => void
  amountHint?: number
  onCommit: () => void
  onCancel: () => void
}) {
  const poRef = useRef<HTMLInputElement>(null)
  useEffect(() => poRef.current?.focus(), [])
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onCommit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }
  return (
    <div className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center gap-x-4 gap-y-2 flex-wrap px-3 py-2">
        <input
          ref={poRef}
          value={draft.poNo}
          onChange={(e) => setDraft({ ...draft, poNo: e.target.value })}
          onKeyDown={onKey}
          placeholder="订单号"
          className={`${baseInputClass} mono text-[13px] font-medium w-[150px] placeholder:text-[var(--color-ink-4)]`}
        />
        <input
          value={draft.materialNo}
          onChange={(e) => setDraft({ ...draft, materialNo: e.target.value })}
          onKeyDown={onKey}
          placeholder="物料号"
          className={`${baseInputClass} mono text-[12px] w-[120px] placeholder:text-[var(--color-ink-4)]`}
        />
        <span className="inline-flex items-baseline gap-1.5 text-[12px] text-[var(--color-ink-3)] whitespace-nowrap">
          订单额
          <input
            value={draft.amt}
            onChange={(e) => setDraft({ ...draft, amt: e.target.value })}
            onKeyDown={onKey}
            inputMode="decimal"
            placeholder={amountHint != null ? formatNum(amountHint) : '金额'}
            className={`${baseInputClass} mono text-right text-[13px] w-[110px] placeholder:text-[var(--color-ink-4)]`}
          />
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onCommit}
            className="rounded-[2px] border border-[var(--color-ink)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-ink)] hover:bg-[var(--color-active-bg)] transition-colors whitespace-nowrap"
          >
            保存
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors px-1"
          >
            取消
          </button>
        </span>
      </div>
    </div>
  )
}

function LineBlock({
  lv,
  composer,
  todayStr,
  onSaveLine,
  onRemoveLine,
  onSetComposer,
  onAddEvent,
  onVoid,
}: {
  lv: LineVM
  composer: { lineId: string; kind: 'invoice' | 'payment' } | null
  todayStr: string
  onSaveLine: (
    lineId: string,
    patch: { poNo?: string; materialNo?: string | null; amountCny?: number },
  ) => void
  onRemoveLine: (lineId: string) => void
  onSetComposer: (c: { lineId: string; kind: 'invoice' | 'payment' } | null) => void
  onAddEvent: (
    line: FenqiLine,
    kind: 'invoice' | 'payment',
    draft: { amountCny: number; eventDate: string; invoiceNo?: string },
  ) => Promise<void>
  onVoid: (ev: FenqiEvent) => void
}) {
  const active = composer?.lineId === lv.line.id ? composer : null
  // 作废 only offers on the LAST live event — corrections walk back one at a
  // time, matching how she'd strike the tail of her Excel sentence.
  const lastLiveId = [...lv.ledger].reverse().find((le) => !le.voided)?.ev.id

  return (
    <div className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
      {/* line header: 订单号 / 物料号 / 订单额 — text at rest, click a value to
          swap in its input (ClickEdit); commit / Escape returns to text. */}
      <div className="flex items-center gap-x-4 gap-y-1 flex-wrap px-3 py-2 border-b border-[var(--color-border)]">
        <ClickEdit
          display={
            lv.line.poNo ? (
              <span className="mono text-[13px] font-semibold text-[var(--color-ink)]">
                {lv.line.poNo}
              </span>
            ) : (
              <span className="mono text-[13px] text-[var(--color-ink-4)] border-b border-dashed border-[var(--color-border-strong)]">
                订单号
              </span>
            )
          }
        >
          {(done) => (
            <InlineField
              value={lv.line.poNo}
              placeholder="订单号"
              width="w-[150px]"
              strong
              autoFocus
              onDone={done}
              onCommit={(v) => onSaveLine(lv.line.id, { poNo: v })}
            />
          )}
        </ClickEdit>
        <ClickEdit
          display={
            lv.line.materialNo ? (
              <span className="mono text-[12px] text-[var(--color-ink-3)]">
                {lv.line.materialNo}
              </span>
            ) : (
              <span className="mono text-[12px] text-[var(--color-ink-4)] border-b border-dashed border-[var(--color-border-strong)]">
                物料号
              </span>
            )
          }
        >
          {(done) => (
            <InlineField
              value={lv.line.materialNo ?? ''}
              placeholder="物料号"
              width="w-[120px]"
              autoFocus
              onDone={done}
              onCommit={(v) => onSaveLine(lv.line.id, { materialNo: v === '' ? null : v })}
            />
          )}
        </ClickEdit>
        <ClickEdit
          display={
            <span className="inline-flex items-baseline gap-1.5 text-[12px] text-[var(--color-ink-3)] whitespace-nowrap">
              订单额
              <span className="mono text-[var(--color-ink-2)]">
                {lv.line.amountCny > 0 ? formatNum(lv.line.amountCny) : '—'}
              </span>
            </span>
          }
        >
          {(done) => (
            <span className="inline-flex items-baseline gap-1.5 text-[12px] text-[var(--color-ink-3)] whitespace-nowrap">
              订单额
              <InlineMoney
                value={lv.line.amountCny}
                autoFocus
                onDone={done}
                onCommit={(n) => onSaveLine(lv.line.id, { amountCny: n })}
              />
            </span>
          )}
        </ClickEdit>
        <span className="ml-auto inline-flex items-baseline gap-4 mono text-[12px] whitespace-nowrap">
          <span className="text-[var(--color-info)]">
            待开 {formatNum(Math.max(0, lv.wait))}
          </span>
          <span
            className={
              lv.overdueDays > 0
                ? 'text-[var(--color-overdue)] font-medium'
                : 'text-[var(--color-warning)]'
            }
          >
            未收 {formatNum(Math.max(0, lv.unpaid))}
          </span>
        </span>
        {lv.ledger.length === 0 && (
          <button
            type="button"
            onClick={() => onRemoveLine(lv.line.id)}
            title="删除这个订单号"
            className="text-[12px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)] transition-colors px-1"
          >
            ✕
          </button>
        )}
      </div>

      {/* the installment ledger — strictly one line per event */}
      {lv.ledger.length > 0 && (
        <div className="max-h-[300px] overflow-y-auto">
          {lv.ledger.map((le) => {
            const isInv = le.ev.kind === 'invoice'
            return (
              <div
                key={le.ev.id}
                className="group grid grid-cols-[92px_44px_minmax(0,1fr)_110px_150px_48px] items-center gap-x-2 px-3 py-1.5 border-b border-[var(--color-border)] last:border-b-0 text-[13px]"
              >
                <span
                  className={`mono text-[12px] whitespace-nowrap ${
                    le.voided ? 'text-[var(--color-ink-4)] line-through' : 'text-[var(--color-ink-2)]'
                  }`}
                >
                  {le.ev.eventDate.slice(2)}
                </span>
                <span
                  className={`text-[12px] font-medium whitespace-nowrap ${
                    le.voided
                      ? 'text-[var(--color-ink-4)] line-through'
                      : isInv
                        ? 'text-[var(--color-info)]'
                        : 'text-[var(--color-success)]'
                  }`}
                >
                  {isInv ? '开票' : '收款'}
                </span>
                <span
                  className={`mono text-[11px] truncate ${
                    le.voided ? 'text-[var(--color-ink-4)] line-through' : 'text-[var(--color-ink-3)]'
                  }`}
                  title={le.ev.invoiceNo ?? ''}
                >
                  {le.ev.invoiceNo ? `发票 ${le.ev.invoiceNo}` : ''}
                </span>
                <span
                  className={`mono text-right whitespace-nowrap tabular-nums ${
                    le.voided ? 'text-[var(--color-ink-4)] line-through' : 'text-[var(--color-ink)]'
                  }`}
                >
                  {formatNum(le.ev.amountCny)}
                </span>
                <span className="mono text-[12px] text-right whitespace-nowrap tabular-nums text-[var(--color-ink-3)]">
                  {le.voided ? (
                    '已作废'
                  ) : le.cleared ? (
                    <span className="text-[var(--color-success)]">
                      {isInv ? '开完' : '收清'}
                    </span>
                  ) : (
                    `剩 ${formatNum(le.remainder)}`
                  )}
                </span>
                <span className="text-right">
                  {!le.voided && le.ev.id === lastLiveId && (
                    <button
                      type="button"
                      onClick={() => onVoid(le.ev)}
                      title="作废这一笔（红冲，历史保留）"
                      className="text-[11px] text-[var(--color-ink-4)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-[var(--color-overdue)] transition-all px-1"
                    >
                      作废
                    </button>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* composer — the only write that matters: append one installment */}
      <div className="px-3 py-2 border-t border-[var(--color-border)]">
        {active ? (
          <Composer
            kind={active.kind}
            todayStr={todayStr}
            onCancel={() => onSetComposer(null)}
            onCommit={(draft) => onAddEvent(lv.line, active.kind, draft)}
          />
        ) : (
          <div className="flex items-center gap-2">
            <GhostBtn
              label="＋开票"
              hoverTone="info"
              onClick={() => onSetComposer({ lineId: lv.line.id, kind: 'invoice' })}
            />
            <GhostBtn
              label="＋收款"
              hoverTone="success"
              onClick={() => onSetComposer({ lineId: lv.line.id, kind: 'payment' })}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// One horizontal row: 类别 · 日期 · 金额 · (发票号) · 记一笔 / 取消. Enter
// commits, Escape closes. DatePop (the product's date idiom — never a native
// date input).
function Composer({
  kind,
  todayStr,
  onCancel,
  onCommit,
}: {
  kind: 'invoice' | 'payment'
  todayStr: string
  onCancel: () => void
  onCommit: (draft: {
    amountCny: number
    eventDate: string
    invoiceNo?: string
  }) => Promise<void>
}) {
  const [date, setDate] = useState(todayStr)
  const [amt, setAmt] = useState('')
  const [invNo, setInvNo] = useState('')
  const [pending, setPending] = useState(false)
  const amtRef = useRef<HTMLInputElement>(null)
  useEffect(() => amtRef.current?.focus(), [])

  const commit = async () => {
    const n = Number(amt.replace(/[,，\s元]/g, ''))
    if (!Number.isFinite(n) || n <= 0) {
      showToast('金额得是个正数', 'warning')
      amtRef.current?.focus()
      return
    }
    setPending(true)
    try {
      await onCommit({
        amountCny: n,
        eventDate: date,
        invoiceNo: invNo.trim() || undefined,
      })
    } catch (e) {
      showToast(`没记上 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
    } finally {
      setPending(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      onCancel()
    }
  }

  return (
    <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
      <span
        className={`text-[12px] font-semibold whitespace-nowrap ${
          kind === 'invoice' ? 'text-[var(--color-info)]' : 'text-[var(--color-success)]'
        }`}
      >
        ＋{kind === 'invoice' ? '开票' : '收款'}
      </span>
      <DatePop value={date} onChange={setDate} portal hideIcon />
      <input
        ref={amtRef}
        inputMode="decimal"
        value={amt}
        onChange={(e) => setAmt(e.target.value)}
        onKeyDown={onKey}
        placeholder="金额"
        className={`${baseInputClass} mono text-right text-[13px] w-[110px] placeholder:text-[var(--color-ink-4)]`}
      />
      {kind === 'invoice' && (
        <input
          value={invNo}
          onChange={(e) => setInvNo(e.target.value)}
          onKeyDown={onKey}
          placeholder="发票号（可空）"
          className={`${baseInputClass} mono text-[12px] w-[190px] placeholder:text-[var(--color-ink-4)]`}
        />
      )}
      <button
        type="button"
        disabled={pending}
        onClick={commit}
        className={`rounded-[2px] border border-[var(--color-ink)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-ink)] hover:bg-[var(--color-active-bg)] transition-colors whitespace-nowrap ${
          pending ? 'opacity-50' : ''
        }`}
      >
        记一笔
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors px-1"
      >
        取消
      </button>
    </div>
  )
}

// === small shared pieces ===

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub: string
  tone?: 'success' | 'overdue'
}) {
  const valueColor =
    tone === 'success'
      ? 'text-[var(--color-success)]'
      : tone === 'overdue'
        ? 'text-[var(--color-overdue)]'
        : 'text-[var(--color-ink)]'
  return (
    <div>
      <p
        className={`text-[32px] md:text-[36px] font-semibold tracking-tight tabular-nums leading-none ${valueColor}`}
      >
        {value}
      </p>
      <p className="label mt-3">{label}</p>
      <p className="text-[12px] text-[var(--color-ink-3)] mt-1 tabular-nums">{sub}</p>
    </div>
  )
}

// The auto-written cell — her yellow (开票) / green (收款) Excel cell, now
// generated. Clamped to two lines at rest; the expanded panel is the full book.
function Sentence({
  segs,
  tone,
  empty,
}: {
  segs: SentenceSeg[]
  tone: 'inv' | 'pay'
  empty: string
}) {
  if (segs.length === 0) {
    return <span className="text-[12px] text-[var(--color-ink-4)]">{empty}</span>
  }
  return (
    <span
      className={`block rounded-[2px] px-2 py-1 text-[12px] leading-relaxed max-w-[420px] ${
        tone === 'inv'
          ? 'bg-[var(--color-warning-soft)] border-l-2 border-[var(--color-warning)]'
          : 'bg-[var(--color-success-soft)] border-l-2 border-[var(--color-success)]'
      }`}
      style={{
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}
    >
      {segs.map((s, i) => (
        <span key={i} className={SEG_TEXT[s.k]}>
          {s.t}
        </span>
      ))}
    </span>
  )
}

function Money({
  amount,
  tone,
}: {
  amount: number
  tone: 'info' | 'warning' | 'overdue'
}) {
  if (amount <= 0) return <span className="text-[var(--color-ink-4)]">—</span>
  const cls =
    tone === 'overdue'
      ? 'text-[var(--color-overdue)] font-medium'
      : tone === 'warning'
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--color-info)]'
  return <span className={cls}>{formatCny(amount)}</span>
}

// Click-to-edit wrapper — renders `display` (text) at rest; a click swaps in
// the input via the render-prop child, which calls `done()` on commit / blur /
// Escape to return to text. Keeps the row reading like a ledger, not a form.
function ClickEdit({
  display,
  children,
}: {
  display: ReactNode
  children: (done: () => void) => ReactNode
}) {
  const [editing, setEditing] = useState(false)
  if (editing) return <>{children(() => setEditing(false))}</>
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="text-left rounded-[2px] px-1 -mx-1 hover:bg-[var(--color-active-bg)] transition-colors"
    >
      {display}
    </button>
  )
}

// Commit-on-blur/Enter text field (the _editable idiom, local to this panel).
// `autoFocus` + `onDone` let a ClickEdit open it focused and close on exit.
function InlineField({
  value,
  placeholder,
  width,
  strong,
  autoFocus,
  onDone,
  onCommit,
}: {
  value: string
  placeholder: string
  width: string
  strong?: boolean
  autoFocus?: boolean
  onDone?: () => void
  onCommit: (v: string) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])
  const commit = () => {
    const v = draft.trim()
    if (v !== value) onCommit(v)
    onDone?.()
  }
  return (
    <input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ref.current?.blur()
        } else if (e.key === 'Escape') {
          setDraft(value)
          requestAnimationFrame(() => ref.current?.blur())
        }
      }}
      placeholder={placeholder}
      className={`${baseInputClass} mono text-[13px] ${width} ${
        strong ? 'font-medium' : ''
      } placeholder:text-[var(--color-ink-4)]`}
    />
  )
}

function InlineMoney({
  value,
  autoFocus,
  onDone,
  onCommit,
}: {
  value: number
  autoFocus?: boolean
  onDone?: () => void
  onCommit: (n: number) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const initial = value > 0 ? String(value) : ''
  const [draft, setDraft] = useState(initial)
  useEffect(() => setDraft(value > 0 ? String(value) : ''), [value])
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])
  const commit = () => {
    const t = draft.trim()
    if (t === '') {
      if (value !== 0) onCommit(0)
      onDone?.()
      return
    }
    const n = Number(t.replace(/[,，\s元]/g, ''))
    if (!Number.isFinite(n) || n < 0) {
      setDraft(initial)
      onDone?.()
      return
    }
    if (n !== value) onCommit(n)
    onDone?.()
  }
  return (
    <input
      ref={ref}
      inputMode="decimal"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ref.current?.blur()
        } else if (e.key === 'Escape') {
          setDraft(initial)
          requestAnimationFrame(() => ref.current?.blur())
        }
      }}
      placeholder="0"
      className={`${baseInputClass} mono text-right text-[13px] w-[96px] placeholder:text-[var(--color-ink-4)]`}
    />
  )
}

function GhostBtn({
  label,
  hoverTone,
  onClick,
}: {
  label: string
  hoverTone: 'info' | 'success'
  onClick: () => void
}) {
  const hover =
    hoverTone === 'info'
      ? 'hover:text-[var(--color-info)] hover:border-[var(--color-info)]'
      : 'hover:text-[var(--color-success)] hover:border-[var(--color-success)]'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-2.5 py-1 text-[12px] text-[var(--color-ink-2)] transition-colors ${hover}`}
    >
      {label}
    </button>
  )
}

function PageBtn({
  dir,
  disabled,
  onClick,
}: {
  dir: 'prev' | 'next'
  disabled: boolean
  onClick: () => void
}) {
  const glyph = dir === 'prev' ? '‹' : '›'
  if (disabled) {
    return (
      <span
        className="text-[18px] leading-none text-[var(--color-ink-4)] cursor-default px-1"
        aria-disabled
      >
        {glyph}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={dir === 'prev' ? '上一页' : '下一页'}
      className="text-[18px] leading-none text-[var(--color-ink-2)] hover:text-[var(--color-ink)] transition-colors px-1"
    >
      {glyph}
    </button>
  )
}

function Th({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <th className={`label font-medium px-3 py-3 text-left whitespace-nowrap ${className}`}>
      {children}
    </th>
  )
}

function Td({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <td className={`px-3 py-2 align-middle ${className}`}>{children}</td>
}
