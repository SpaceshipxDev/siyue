'use client'

import { useRef, useState, useTransition, type KeyboardEvent } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { formatCny } from '@/lib/data'
import { EditableText } from '@/app/_editable'
import { SearchInput } from '@/app/_search'
import {
  effectiveAmount,
  financeStatus,
  outstanding,
  shipDateLabel,
  STATUS_LABEL,
  FILTER_LABEL,
  type FinanceFilter,
  type FinanceRow,
  type FinanceStatus,
} from '@/lib/finance'

// Reuses the app's inline-edit vocabulary: the shared baseInputClass (the same
// transparent / underline-on-focus field used everywhere in _editable), the
// bottom-border SearchInput, underline-active text toggles, and a rounded-[2px]
// bordered table surface — matching the master board exactly. Commits go
// through /api/mutate (kind 'updateShipmentFinance').

const FILTERS: FinanceFilter[] = ['all', 'uninvoiced', 'unpaid', 'overdue']

// Identical to _editable.tsx's baseInputClass so finance fields read the same
// as every other editable cell in the product.
const baseInputClass =
  'block w-full bg-transparent border-0 outline-none rounded-[2px] px-1 -mx-1 py-0.5 transition-[background-color,box-shadow] duration-150 hover:bg-[var(--color-active-bg)] hover:shadow-[inset_0_-1px_0_var(--color-border-strong)] focus:bg-[var(--color-active-bg)] focus:shadow-[inset_0_-1px_0_var(--color-ink)]'

// State as colored text (the app's idiom — see DueCell), not a pill or dot.
const STATUS_TEXT: Record<FinanceStatus, string> = {
  uninvoiced: 'text-[var(--color-ink-3)]',
  invoiced: 'text-[var(--color-info)]',
  partial: 'text-[var(--color-warning)]',
  paid: 'text-[var(--color-success)]',
  overdue: 'text-[var(--color-overdue)] font-medium',
}

// Nullable money field — mirrors _editable's ComponentMoney/OutsourceBlockAmount
// (empty clears to null; faint placeholder shows the auto-computed default).
function FinanceMoney({
  shipmentId,
  field,
  value,
  hint,
}: {
  shipmentId: string
  field: 'saleAmountCny' | 'invoiceAmountCny' | 'paymentAmountCny'
  value: number | undefined
  hint?: number
}) {
  const ref = useRef<HTMLInputElement>(null)
  const initialStr = typeof value === 'number' ? String(value) : ''
  const [draft, setDraft] = useState(initialStr)
  const [pending, start] = useTransition()

  const commit = (next: string) => {
    const trimmed = next.trim()
    const save = (patchVal: number | null, revert: string) =>
      start(async () => {
        try {
          await mutate({
            kind: 'updateShipmentFinance',
            shipmentId,
            patch: { [field]: patchVal },
          })
        } catch (e) {
          showToast(`保存失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
          setDraft(revert)
        }
      })
    if (trimmed === '') {
      if (value === undefined) return
      save(null, initialStr)
      return
    }
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n < 0 || n === value) return
    save(n, initialStr)
  }

  return (
    <input
      ref={ref}
      type="number"
      inputMode="decimal"
      min={0}
      step={1}
      value={draft}
      placeholder={hint != null ? formatCny(hint) : '—'}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit(draft)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ref.current?.blur()
        } else if (e.key === 'Escape') {
          setDraft(initialStr)
          requestAnimationFrame(() => ref.current?.blur())
        }
      }}
      className={`${baseInputClass} mono text-right text-[13px] placeholder:text-[var(--color-ink-4)] ${
        pending ? 'opacity-60' : ''
      }`}
    />
  )
}

// Date cell: plain text at rest ("—" when empty), revealing the field only on
// click. Most rows are uninvoiced, so an always-on <input type=date> would
// litter the ledger with empty "dd/mm/yyyy 📅" boxes. The edit field reuses
// baseInputClass so an active date cell matches every other edit in the app.
function InlineDate({
  shipmentId,
  field,
  value,
}: {
  shipmentId: string
  field: 'invoiceDate' | 'paymentDate'
  value: string | undefined
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const [pending, start] = useTransition()

  const commit = (raw: string) => {
    setEditing(false)
    const next = raw === '' ? null : raw
    if (next === (value ?? null)) return
    start(async () => {
      try {
        await mutate({
          kind: 'updateShipmentFinance',
          shipmentId,
          patch: { [field]: next },
        })
      } catch (e) {
        showToast(`保存失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
        setDraft(value ?? '')
      }
    })
  }

  if (editing) {
    return (
      <input
        autoFocus
        type="date"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          commit(e.target.value)
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Escape') {
            setDraft(value ?? '')
            setEditing(false)
          }
        }}
        className={`${baseInputClass} mono text-[13px]`}
      />
    )
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={`block w-full text-left rounded-[2px] px-1 -mx-1 py-0.5 mono text-[13px] transition-colors hover:bg-[var(--color-active-bg)] ${
        pending ? 'opacity-60' : ''
      } ${value ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-4)]'}`}
    >
      {value ? shipDateLabel(value) : '—'}
    </button>
  )
}

export function FinanceLedger({
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
  rows: FinanceRow[]
  q: string
  filter: FinanceFilter
  counts: Record<FinanceFilter, number>
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

  const hrefFor = (opts: { q?: string; filter?: FinanceFilter; page?: number }) => {
    const p = new URLSearchParams()
    const nq = (opts.q ?? q).trim()
    const nf = opts.filter ?? filter
    if (nq) p.set('q', nq)
    if (nf !== 'all') p.set('filter', nf)
    if (opts.page && opts.page > 1) p.set('page', String(opts.page))
    const qs = p.toString()
    return qs ? `${pathname}?${qs}` : pathname
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
      {/* Toolbar — underline-active text toggles + bottom-border search, the
          same chrome as the master board. */}
      <div className="flex flex-wrap items-end gap-x-8 gap-y-4 mb-6">
        <div role="tablist" aria-label="筛选" className="flex items-baseline gap-x-6">
          {FILTERS.map((f) => {
            const active = f === filter
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
                  {FILTER_LABEL[f]}
                </span>
                <span className="mono text-[11px] text-[var(--color-ink-4)] tabular-nums">
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
            placeholder="搜索 · 客户 / 派单号 / 商务"
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

      {/* Ledger surface */}
      <div className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              <Th>状态</Th>
              <Th>出货</Th>
              <Th className="min-w-[180px]">客户 / 派单号</Th>
              <Th>对接人</Th>
              <Th className="text-right">金额</Th>
              <Th>开票日期</Th>
              <Th className="text-right">开票金额</Th>
              <Th>回款时间</Th>
              <Th className="text-right">回款金额</Th>
              <Th className="text-right">应收</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const status = financeStatus(r, todayStr)
              const owed = outstanding(r)
              return (
                <tr
                  key={r.shipmentId}
                  className="border-t border-[var(--color-border)] hover:bg-[var(--color-bg)] transition-colors"
                >
                  <Td className="whitespace-nowrap">
                    <span className={`text-[12px] tracking-wide ${STATUS_TEXT[status]}`}>
                      {STATUS_LABEL[status]}
                    </span>
                  </Td>
                  <Td className="mono text-[13px] whitespace-nowrap text-[var(--color-ink-2)]">
                    {shipDateLabel(r.shipDate)}
                  </Td>
                  <Td>
                    <Link href={`/jobs/${r.jobId}`} className="block group/cell">
                      <span className="block text-[14px] text-[var(--color-ink)] group-hover/cell:underline decoration-[var(--color-border-strong)] underline-offset-2">
                        {r.customer || '—'}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-[var(--color-ink-3)] mono whitespace-nowrap">
                        {r.docNo || r.jobNo || '—'}
                        {r.salesperson ? ` · ${r.salesperson}` : ''}
                      </span>
                    </Link>
                  </Td>
                  <Td>
                    <EditableText
                      value={r.contact}
                      placeholder="—"
                      className="text-[13px]"
                      onSave={async (v) => {
                        await mutate({
                          kind: 'updateShipmentFinance',
                          shipmentId: r.shipmentId,
                          patch: { contact: v.trim() === '' ? null : v },
                        })
                      }}
                    />
                  </Td>
                  <Td className="text-right">
                    <FinanceMoney
                      shipmentId={r.shipmentId}
                      field="saleAmountCny"
                      value={r.saleAmountCny}
                      hint={r.computedAmountCny}
                    />
                  </Td>
                  <Td>
                    <InlineDate shipmentId={r.shipmentId} field="invoiceDate" value={r.invoiceDate} />
                  </Td>
                  <Td className="text-right">
                    <FinanceMoney
                      shipmentId={r.shipmentId}
                      field="invoiceAmountCny"
                      value={r.invoiceAmountCny}
                      hint={effectiveAmount(r)}
                    />
                  </Td>
                  <Td>
                    <InlineDate shipmentId={r.shipmentId} field="paymentDate" value={r.paymentDate} />
                  </Td>
                  <Td className="text-right">
                    <FinanceMoney
                      shipmentId={r.shipmentId}
                      field="paymentAmountCny"
                      value={r.paymentAmountCny}
                    />
                  </Td>
                  <Td className="text-right mono text-[13px] whitespace-nowrap">
                    {!r.invoiceDate ? (
                      <span className="text-[var(--color-ink-4)]">—</span>
                    ) : owed <= 0 ? (
                      <span className="text-[var(--color-success)]">已结清</span>
                    ) : (
                      <span
                        className={
                          status === 'overdue'
                            ? 'text-[var(--color-overdue)] font-medium'
                            : 'text-[var(--color-ink)]'
                        }
                      >
                        {formatCny(owed)}
                      </span>
                    )}
                  </Td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="py-20 text-center text-[13px] text-[var(--color-ink-3)]">
                  没有匹配的出货记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > 0 && (
        <div className="mt-5 flex items-center justify-between">
          <p className="label tabular-nums">
            {rangeStart}–{rangeEnd} / 共 {total} 条
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
