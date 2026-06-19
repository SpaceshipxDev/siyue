'use client'

import { useRef, useState, useTransition, type KeyboardEvent } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { formatCny } from '@/lib/data'
import { shipDateLabel } from '@/lib/finance'
import { SearchInput } from '@/app/_search'
import {
  ORDER_FILTER_LABEL,
  ORDER_STATUS_LABEL,
  orderMoneyStatus,
  outsourceDurationDays,
  type OrderMoneyFilter,
  type OrderMoneyRow,
  type OrderMoneyStatus,
} from '@/lib/order-money'

// 订单资金 — the boss's per-order money board. One row per order, read
// left-to-right through its MONEY pipeline (合同 → 金额 → 外协 → 出货 → 开票 →
// 回款 → 应收) the same way the master board reads a part through its WORK
// pipeline. Every stage carries a hard ¥ AND a scannable state.
//
// Color discipline = Excel conditional formatting: plain text everywhere, a red
// cell wash on ONLY the two questions the boss scans columns for — 无合同 and
// 逾期 — so problems jump out without teaching anyone anything new.

const FILTERS: OrderMoneyFilter[] = [
  'all',
  'no_contract',
  'outsourced',
  'unpaid',
  'overdue',
]

// Leading 状态 column — the single L→R answer to "where's the money stuck?".
// Colored text, the app idiom (see DueCell / the AR ledger), not a pill.
const STATUS_TEXT: Record<OrderMoneyStatus, string> = {
  overdue: 'text-[var(--color-overdue)] font-medium',
  in_production: 'text-[var(--color-ink-3)]',
  uninvoiced: 'text-[var(--color-info)]',
  unpaid: 'text-[var(--color-warning)]',
  settled: 'text-[var(--color-success)]',
}

const ALARM_WASH = 'bg-[var(--color-overdue-soft)]'

// Same inline-edit field vocabulary as the AR ledger / _editable — transparent,
// underline-on-focus — so an editing money cell reads like every other edit in
// the app. Both editors commit through /api/mutate (kind 'updateJob').
const baseInputClass =
  'block w-full bg-transparent border-0 outline-none rounded-[2px] px-1 -mx-1 py-0.5 transition-[background-color,box-shadow] duration-150 hover:bg-[var(--color-active-bg)] hover:shadow-[inset_0_-1px_0_var(--color-border-strong)] focus:bg-[var(--color-active-bg)] focus:shadow-[inset_0_-1px_0_var(--color-ink)]'

// 合同号 — text at rest (红 无合同 when missing, the boss's flag), click to type.
// He fixes the 合同 gap right where he spots it, no page hop.
function ContractCell({ jobId, value }: { jobId: string; value?: string }) {
  const ref = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const [pending, start] = useTransition()

  const commit = (raw: string) => {
    setEditing(false)
    const next = raw.trim() === '' ? null : raw.trim()
    if (next === (value ?? null)) return
    start(async () => {
      try {
        await mutate({ kind: 'updateJob', jobId, patch: { contractNo: next } })
      } catch (e) {
        showToast(`保存失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
        setDraft(value ?? '')
      }
    })
  }

  if (editing) {
    return (
      <input
        ref={ref}
        autoFocus
        value={draft}
        placeholder="合同号"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ref.current?.blur()
          } else if (e.key === 'Escape') {
            setDraft(value ?? '')
            requestAnimationFrame(() => ref.current?.blur())
          }
        }}
        className={`${baseInputClass} mono text-[12px] placeholder:text-[var(--color-ink-4)]`}
      />
    )
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={`block w-full text-left rounded-[2px] px-1 -mx-1 py-0.5 transition-colors hover:bg-[var(--color-active-bg)] ${pending ? 'opacity-60' : ''}`}
    >
      {value ? (
        <span className="mono text-[12px] text-[var(--color-ink-2)]">{value}</span>
      ) : (
        <span className="text-[12px] text-[var(--color-overdue)]">无合同</span>
      )}
    </button>
  )
}

// 金额 — formatted ¥ at rest, click to type the raw number. Empty clears to null.
function AmountCell({ jobId, value }: { jobId: string; value?: number }) {
  const ref = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(typeof value === 'number' ? String(value) : '')
  const [pending, start] = useTransition()

  const commit = (raw: string) => {
    setEditing(false)
    const trimmed = raw.trim()
    const next = trimmed === '' ? null : Number(trimmed)
    if (next !== null && (!Number.isFinite(next) || next < 0)) {
      setDraft(typeof value === 'number' ? String(value) : '')
      return
    }
    if (next === (value ?? null)) return
    start(async () => {
      try {
        await mutate({ kind: 'updateJob', jobId, patch: { amountCny: next } })
      } catch (e) {
        showToast(`保存失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
        setDraft(typeof value === 'number' ? String(value) : '')
      }
    })
  }

  if (editing) {
    return (
      <input
        ref={ref}
        autoFocus
        type="number"
        inputMode="decimal"
        min={0}
        step={1}
        value={draft}
        placeholder="金额"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ref.current?.blur()
          } else if (e.key === 'Escape') {
            setDraft(typeof value === 'number' ? String(value) : '')
            requestAnimationFrame(() => ref.current?.blur())
          }
        }}
        className={`${baseInputClass} mono text-right text-[13px] placeholder:text-[var(--color-ink-4)]`}
      />
    )
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={`block w-full text-right rounded-[2px] px-1 -mx-1 py-0.5 mono text-[13px] transition-colors hover:bg-[var(--color-active-bg)] ${pending ? 'opacity-60' : ''} ${typeof value === 'number' ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-4)]'}`}
    >
      {typeof value === 'number' ? formatCny(value) : '—'}
    </button>
  )
}

export function OrderMoneyBoard({
  rows,
  q,
  filter,
  counts,
  todayStr,
  total,
  page,
  totalPages,
  rangeStart,
  rangeEnd,
  exportHref,
}: {
  rows: OrderMoneyRow[]
  q: string
  filter: OrderMoneyFilter
  counts: Record<OrderMoneyFilter, number>
  todayStr: string
  total: number
  page: number
  totalPages: number
  rangeStart: number
  rangeEnd: number
  exportHref: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [search, setSearch] = useState(q)
  const [, startNav] = useTransition()
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hrefFor = (opts: {
    q?: string
    filter?: OrderMoneyFilter
    page?: number
  }) => {
    const p = new URLSearchParams()
    p.set('tab', 'orders')
    const nq = (opts.q ?? q).trim()
    const nf = opts.filter ?? filter
    if (nq) p.set('q', nq)
    if (nf !== 'all') p.set('filter', nf)
    if (opts.page && opts.page > 1) p.set('page', String(opts.page))
    return `${pathname}?${p.toString()}`
  }

  const onSearchChange = (v: string) => {
    setSearch(v)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => {
      startNav(() => router.replace(hrefFor({ q: v, page: 1 })))
    }, 300)
  }

  return (
    <div>
      {/* Toolbar — underline-active filter toggles + search + export, the same
          chrome as the master board and the AR ledger. */}
      <div className="flex flex-wrap items-end gap-x-8 gap-y-4 mb-6">
        <div role="tablist" aria-label="筛选" className="flex items-baseline gap-x-6">
          {FILTERS.map((f) => {
            const active = f === filter
            const alarm =
              (f === 'no_contract' || f === 'overdue') && counts[f] > 0
            return (
              <Link
                key={f}
                href={hrefFor({ filter: f, page: 1 })}
                replace
                role="tab"
                aria-selected={active}
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
                  {ORDER_FILTER_LABEL[f]}
                </span>
                <span
                  className={`mono text-[11px] tabular-nums ${
                    alarm
                      ? 'text-[var(--color-overdue)] font-medium'
                      : 'text-[var(--color-ink-4)]'
                  }`}
                >
                  {counts[f]}
                </span>
              </Link>
            )
          })}
        </div>

        <div className="ml-auto flex items-center gap-6">
          <SearchInput
            q={search}
            setQ={onSearchChange}
            placeholder="搜索 · 客户 / 工号 / 合同号 / 商务"
          />
          <a
            href={exportHref}
            className="inline-flex items-center gap-1.5 text-[13px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors whitespace-nowrap"
          >
            导出 Excel
            <span aria-hidden className="text-[14px] leading-none">↓</span>
          </a>
        </div>
      </div>

      {/* The money pipeline. */}
      <div className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              <Th>状态</Th>
              <Th className="min-w-[200px]">客户 / 工号</Th>
              <Th>合同</Th>
              <Th className="text-right">金额</Th>
              <Th className="min-w-[120px]">外协</Th>
              <Th>出货</Th>
              <Th className="text-right">已开票</Th>
              <Th className="text-right">已回款</Th>
              <Th className="text-right">应收</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const status = orderMoneyStatus(r)
              const days = outsourceDurationDays(r, todayStr)
              const settled = r.hasInvoice && r.outstandingCny <= 0
              return (
                <tr
                  key={r.jobId}
                  className="border-t border-[var(--color-border)] hover:bg-[var(--color-bg)] transition-colors"
                >
                  {/* 状态 */}
                  <Td className="whitespace-nowrap">
                    <span className={`text-[12px] tracking-wide ${STATUS_TEXT[status]}`}>
                      {ORDER_STATUS_LABEL[status]}
                    </span>
                  </Td>

                  {/* 客户 / 工号 — links into the order, like the AR ledger. */}
                  <Td>
                    <Link href={`/jobs/${r.jobId}`} className="block group/cell">
                      <span className="block text-[14px] text-[var(--color-ink)] group-hover/cell:underline decoration-[var(--color-border-strong)] underline-offset-2">
                        {r.customer || '—'}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-[var(--color-ink-3)] mono whitespace-nowrap">
                        {r.jobNo || '—'}
                        {r.product ? ` · ${r.product}` : ''}
                        {r.salesperson ? ` · ${r.salesperson}` : ''}
                      </span>
                    </Link>
                  </Td>

                  {/* 合同 — editable: 红 无合同 when missing (the boss's flag),
                      click to type the 合同号 right where he spots the gap. */}
                  <Td className="whitespace-nowrap">
                    <ContractCell jobId={r.jobId} value={r.contractNo} />
                  </Td>

                  {/* 金额 — editable: the order's contract value, fix it inline. */}
                  <Td className="text-right whitespace-nowrap">
                    <AmountCell jobId={r.jobId} value={r.amountCny} />
                  </Td>

                  {/* 外协 — count · spend · turnaround days; flags 在外协中. */}
                  <Td className="whitespace-nowrap">
                    {r.outsourceCount === 0 ? (
                      <span className="text-[13px] text-[var(--color-ink-4)]">—</span>
                    ) : (
                      <div className="leading-tight">
                        <span className="mono text-[13px] text-[var(--color-ink)]">
                          {formatCny(r.outsourceSpendCny || undefined)}
                        </span>
                        <span
                          className={`mt-0.5 block text-[11px] mono ${
                            r.outsourceOpenCount > 0
                              ? 'text-[var(--color-info)] font-medium'
                              : 'text-[var(--color-ink-3)]'
                          }`}
                        >
                          {r.outsourceCount}单
                          {days != null ? ` · ${days}天` : ''}
                          {r.outsourceOpenCount > 0 ? ' · 在外协中' : ''}
                        </span>
                      </div>
                    )}
                  </Td>

                  {/* 出货 */}
                  <Td className="whitespace-nowrap mono text-[13px]">
                    {r.isShipped ? (
                      <span className="text-[var(--color-ink-2)]">
                        {r.lastShipDate ? shipDateLabel(r.lastShipDate) : '已出货'}
                      </span>
                    ) : (
                      <span className="text-[var(--color-ink-4)]">未出货</span>
                    )}
                  </Td>

                  {/* 已开票 */}
                  <Td className="text-right mono text-[13px] whitespace-nowrap">
                    {r.hasInvoice ? (
                      <span className="text-[var(--color-info)]">
                        {formatCny(r.invoicedCny || undefined)}
                      </span>
                    ) : (
                      <span className="text-[var(--color-ink-4)]">未开票</span>
                    )}
                  </Td>

                  {/* 已回款 */}
                  <Td className="text-right mono text-[13px] whitespace-nowrap">
                    {r.paidCny > 0 ? (
                      <span className="text-[var(--color-success)]">{formatCny(r.paidCny)}</span>
                    ) : (
                      <span className="text-[var(--color-ink-4)]">—</span>
                    )}
                  </Td>

                  {/* 应收 — red wash on overdue (the other column the boss scans). */}
                  <Td
                    className={`text-right mono text-[13px] whitespace-nowrap ${
                      r.hasOverdue && r.outstandingCny > 0 ? ALARM_WASH : ''
                    }`}
                  >
                    {!r.hasInvoice ? (
                      <span className="text-[var(--color-ink-4)]">—</span>
                    ) : settled ? (
                      <span className="text-[var(--color-success)]">已结清</span>
                    ) : (
                      <span
                        className={
                          r.hasOverdue
                            ? 'text-[var(--color-overdue)] font-medium'
                            : 'text-[var(--color-ink)]'
                        }
                      >
                        {formatCny(r.outstandingCny)}
                      </span>
                    )}
                  </Td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="py-20 text-center text-[13px] text-[var(--color-ink-3)]">
                  没有匹配的订单
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination — identical chrome to the AR ledger. */}
      {total > 0 && (
        <div className="mt-5 flex items-center justify-between">
          <p className="label tabular-nums">
            {rangeStart}–{rangeEnd} / 共 {total} 单
          </p>
          <div className="flex items-center gap-5">
            <PageArrow href={hrefFor({ page: page - 1 })} disabled={page <= 1} dir="prev" />
            <span className="mono text-[12px] text-[var(--color-ink-2)] tabular-nums">
              {page} / {totalPages}
            </span>
            <PageArrow href={hrefFor({ page: page + 1 })} disabled={page >= totalPages} dir="next" />
          </div>
        </div>
      )}
    </div>
  )
}

function PageArrow({
  href,
  disabled,
  dir,
}: {
  href: string
  disabled: boolean
  dir: 'prev' | 'next'
}) {
  const glyph = dir === 'prev' ? '‹' : '›'
  if (disabled) {
    return (
      <span className="text-[18px] leading-none text-[var(--color-ink-4)] cursor-default px-1" aria-disabled>
        {glyph}
      </span>
    )
  }
  return (
    <Link
      href={href}
      replace
      scroll
      aria-label={dir === 'prev' ? '上一页' : '下一页'}
      className="text-[18px] leading-none text-[var(--color-ink-2)] hover:text-[var(--color-ink)] transition-colors px-1"
    >
      {glyph}
    </Link>
  )
}

function Th({
  children,
  className = '',
}: {
  children: React.ReactNode
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
  children: React.ReactNode
  className?: string
}) {
  return <td className={`px-3 py-2.5 align-middle ${className}`}>{children}</td>
}
