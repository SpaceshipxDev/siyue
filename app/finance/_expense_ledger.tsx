'use client'

import { useEffect, useRef, useState, useTransition, type KeyboardEvent } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { formatCny } from '@/lib/data'
import { EditableText } from '@/app/_editable'
import { SearchInput } from '@/app/_search'
import { VoucherCell } from './_vouchers'
import type { VoucherFile } from '@/lib/data'
import {
  CATEGORY_LABEL,
  EXPENSE_CATEGORIES,
  type Expense,
  type ExpenseCategory,
  type ExpenseFilter,
} from '@/lib/expenses'

// 支出台账 — the cash-out twin of the AR ledger (_ledger.tsx). Same chrome:
// underline-active toggles, bottom-border search, bordered table surface,
// inline edits through /api/mutate. The 记一笔 modal is the core flow — a
// secretary records an expense in under ten seconds: tap category, type
// amount, Enter. 工资 gets 复制上月 so payday is one click, not N retypes.

const baseInputClass =
  'block w-full bg-transparent border-0 outline-none rounded-[2px] px-1 -mx-1 py-0.5 transition-[background-color,box-shadow] duration-150 hover:bg-[var(--color-active-bg)] hover:shadow-[inset_0_-1px_0_var(--color-border-strong)] focus:bg-[var(--color-active-bg)] focus:shadow-[inset_0_-1px_0_var(--color-ink)]'

const FILTERS: ExpenseFilter[] = ['all', ...EXPENSE_CATEGORIES]

const FILTER_LABEL: Record<ExpenseFilter, string> = {
  all: '全部',
  ...CATEGORY_LABEL,
}

export type PayrollCopyRow = { payee: string; amountCny: number; note: string }

function isDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime())
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function ExpenseLedger({
  rows,
  q,
  filter,
  counts,
  total,
  page,
  totalPages,
  rangeStart,
  rangeEnd,
  exportHref,
  payees,
  lastMonthPayroll,
  lastMonthLabel,
  userName,
  vouchers,
}: {
  rows: Expense[]
  q: string
  filter: ExpenseFilter
  counts: Record<ExpenseFilter, number>
  total: number
  page: number
  totalPages: number
  rangeStart: number
  rangeEnd: number
  exportHref: string
  payees: Record<ExpenseCategory, string[]>
  lastMonthPayroll: PayrollCopyRow[]
  lastMonthLabel: string
  userName: string
  vouchers: Record<string, VoucherFile[]>
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [search, setSearch] = useState(q)
  const [modalOpen, setModalOpen] = useState(false)
  const [, startNav] = useTransition()
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hrefFor = (opts: { q?: string; filter?: ExpenseFilter; page?: number }) => {
    const p = new URLSearchParams()
    p.set('tab', 'expense')
    const nq = (opts.q ?? q).trim()
    const nf = opts.filter ?? filter
    if (nq) p.set('q', nq)
    if (nf !== 'all') p.set('cat', nf)
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
      <div className="flex flex-wrap items-end gap-x-8 gap-y-4 mb-6">
        <div role="tablist" aria-label="类别" className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
          {FILTERS.map((f) => {
            const active = f === filter
            // Hide untouched categories from the toggle row to keep it calm —
            // 全部 and any category with rows (or the active one) show.
            if (f !== 'all' && counts[f] === 0 && !active) return null
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
          <SearchInput q={search} setQ={onSearchChange} placeholder="搜索 · 对象 / 备注" />
          <a
            href={exportHref}
            className="inline-flex items-center gap-1.5 text-[13px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors whitespace-nowrap"
          >
            导出 Excel
            <span aria-hidden className="text-[14px] leading-none">↓</span>
          </a>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="rounded-[2px] bg-[var(--color-ink)] px-4 py-1.5 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 transition-opacity whitespace-nowrap"
          >
            记一笔
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              <Th>日期</Th>
              <Th>类别</Th>
              <Th className="min-w-[120px]">对象</Th>
              <Th className="text-right">金额</Th>
              <Th className="min-w-[160px]">备注</Th>
              <Th>凭证</Th>
              <Th>记录人</Th>
              <Th> </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <ExpenseRow
                key={r.id}
                row={r}
                vouchers={vouchers[r.id] ?? []}
                onDeleted={() => router.refresh()}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="py-20 text-center text-[13px] text-[var(--color-ink-3)]">
                  还没有支出记录 · 点右上「记一笔」
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

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

      {modalOpen && (
        <NewExpenseModal
          payees={payees}
          lastMonthPayroll={lastMonthPayroll}
          lastMonthLabel={lastMonthLabel}
          userName={userName}
          onDone={() => {
            setModalOpen(false)
            router.refresh()
          }}
          onCancel={() => setModalOpen(false)}
        />
      )}
    </div>
  )
}

// === Table row (inline edits, same vocabulary as the AR ledger) ===

function ExpenseRow({
  row,
  vouchers,
  onDeleted,
}: {
  row: Expense
  vouchers: VoucherFile[]
  onDeleted: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [pending, start] = useTransition()

  const del = () =>
    start(async () => {
      try {
        await mutate({ kind: 'deleteExpense', expenseId: row.id })
        onDeleted()
      } catch (e) {
        showToast(`删除失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
        setConfirming(false)
      }
    })

  return (
    <tr className="border-t border-[var(--color-border)] hover:bg-[var(--color-bg)] transition-colors">
      <Td className="whitespace-nowrap">
        <InlineDateText expenseId={row.id} value={row.expenseDate} />
      </Td>
      <Td className="whitespace-nowrap">
        <CategorySelect expenseId={row.id} value={row.category} />
      </Td>
      <Td>
        <EditableText
          value={row.payee}
          placeholder="—"
          className="text-[13px]"
          onSave={async (v) => {
            await mutate({
              kind: 'updateExpense',
              expenseId: row.id,
              patch: { payee: v.trim() === '' ? null : v },
            })
          }}
        />
      </Td>
      <Td className="text-right">
        <ExpenseMoney expenseId={row.id} value={row.amountCny} />
      </Td>
      <Td>
        <EditableText
          value={row.note}
          placeholder="—"
          className="text-[13px]"
          onSave={async (v) => {
            await mutate({
              kind: 'updateExpense',
              expenseId: row.id,
              patch: { note: v.trim() === '' ? null : v },
            })
          }}
        />
      </Td>
      <Td className="whitespace-nowrap">
        <VoucherCell expenseId={row.id} initial={vouchers} />
      </Td>
      <Td className="whitespace-nowrap text-[12px] text-[var(--color-ink-3)]">
        {row.createdBy ?? '—'}
      </Td>
      <Td className="text-right whitespace-nowrap">
        {confirming ? (
          <span className="inline-flex items-center gap-2">
            <button
              type="button"
              onClick={del}
              disabled={pending}
              className="text-[12px] text-[var(--color-overdue)] hover:underline underline-offset-2 disabled:opacity-50"
            >
              确认删除
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            >
              取消
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            aria-label="删除"
            className="h-5 w-5 inline-flex items-center justify-center rounded-[2px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)] transition-colors text-[14px] leading-none"
          >
            ×
          </button>
        )}
      </Td>
    </tr>
  )
}

// Nullable-free money field — an expense always has an amount, so empty
// reverts rather than clearing.
function ExpenseMoney({ expenseId, value }: { expenseId: string; value: number }) {
  const ref = useRef<HTMLInputElement>(null)
  const initialStr = String(value)
  const [draft, setDraft] = useState(initialStr)
  const [pending, start] = useTransition()

  const commit = (next: string) => {
    const trimmed = next.trim()
    const n = Number(trimmed)
    if (trimmed === '' || !Number.isFinite(n) || n < 0) {
      setDraft(initialStr)
      return
    }
    if (n === value) return
    start(async () => {
      try {
        await mutate({ kind: 'updateExpense', expenseId, patch: { amountCny: n } })
      } catch (e) {
        showToast(`保存失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
        setDraft(initialStr)
      }
    })
  }

  return (
    <input
      ref={ref}
      type="number"
      inputMode="decimal"
      min={0}
      step={1}
      value={draft}
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
      className={`${baseInputClass} mono text-right text-[13px] ${pending ? 'opacity-60' : ''}`}
    />
  )
}

// Date as editable text (YYYY-MM-DD) — the project deliberately avoids native
// <input type=date> (auto-commits on scroll). Plain text at rest.
function InlineDateText({ expenseId, value }: { expenseId: string; value: string }) {
  const ref = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(value)
  const [pending, start] = useTransition()

  const commit = (next: string) => {
    const trimmed = next.trim()
    if (trimmed === value) return
    if (!isDate(trimmed)) {
      setDraft(value)
      return
    }
    start(async () => {
      try {
        await mutate({ kind: 'updateExpense', expenseId, patch: { expenseDate: trimmed } })
      } catch (e) {
        showToast(`保存失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
        setDraft(value)
      }
    })
  }

  return (
    <input
      ref={ref}
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit(draft)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ref.current?.blur()
        } else if (e.key === 'Escape') {
          setDraft(value)
          requestAnimationFrame(() => ref.current?.blur())
        }
      }}
      spellCheck={false}
      className={`${baseInputClass} mono text-[13px] w-[100px] ${pending ? 'opacity-60' : ''}`}
    />
  )
}

// Category as a borderless select — reads as text at rest, native dropdown on
// click (selects are fine; it's only date inputs the project bans).
function CategorySelect({
  expenseId,
  value,
}: {
  expenseId: string
  value: ExpenseCategory
}) {
  const [current, setCurrent] = useState(value)
  const [pending, start] = useTransition()

  const commit = (next: ExpenseCategory) => {
    if (next === current) return
    const prev = current
    setCurrent(next)
    start(async () => {
      try {
        await mutate({ kind: 'updateExpense', expenseId, patch: { category: next } })
      } catch (e) {
        showToast(`保存失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
        setCurrent(prev)
      }
    })
  }

  return (
    <select
      value={current}
      onChange={(e) => commit(e.target.value as ExpenseCategory)}
      className={`bg-transparent border-0 outline-none rounded-[2px] px-1 -mx-1 py-0.5 text-[13px] text-[var(--color-ink)] cursor-pointer hover:bg-[var(--color-active-bg)] transition-colors appearance-none ${
        pending ? 'opacity-60' : ''
      }`}
    >
      {EXPENSE_CATEGORIES.map((c) => (
        <option key={c} value={c}>
          {CATEGORY_LABEL[c]}
        </option>
      ))}
    </select>
  )
}

// === 记一笔 modal ===

function NewExpenseModal({
  payees,
  lastMonthPayroll,
  lastMonthLabel,
  userName,
  onDone,
  onCancel,
}: {
  payees: Record<ExpenseCategory, string[]>
  lastMonthPayroll: PayrollCopyRow[]
  lastMonthLabel: string
  userName: string
  onDone: () => void
  onCancel: () => void
}) {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
  const [category, setCategory] = useState<ExpenseCategory>('daily')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayStr)
  const [payee, setPayee] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const amountRef = useRef<HTMLInputElement>(null)

  // Esc closes; lock body scroll while open.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
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

  const lastMonthTotal = lastMonthPayroll.reduce((s, r) => s + r.amountCny, 0)

  function submit() {
    const n = Number(amount.trim())
    if (!amount.trim() || !Number.isFinite(n) || n < 0) {
      setError('请输入金额')
      amountRef.current?.focus()
      return
    }
    if (!isDate(date)) {
      setError('日期格式应为 YYYY-MM-DD')
      return
    }
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'createExpense',
          input: {
            expenseDate: date.trim(),
            category,
            amountCny: n,
            payee: payee.trim() || undefined,
            note: note.trim() || undefined,
          },
        })
        showToast(`已记 ${CATEGORY_LABEL[category]} ${formatCny(n)}`, 'success')
        onDone()
      } catch (e) {
        setError(e instanceof Error ? e.message : '保存失败')
      }
    })
  }

  // 复制上月工资 — one click replays last month's payroll with this form's
  // date. The secretary edits the one or two rows that changed afterwards.
  function copyLastMonthPayroll() {
    if (!isDate(date)) {
      setError('日期格式应为 YYYY-MM-DD')
      return
    }
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'createExpenses',
          inputs: lastMonthPayroll.map((r) => ({
            expenseDate: date.trim(),
            category: 'payroll' as const,
            amountCny: r.amountCny,
            payee: r.payee || undefined,
            note: r.note || undefined,
          })),
        })
        showToast(
          `已复制${lastMonthLabel}工资 · ${lastMonthPayroll.length} 人 · ${formatCny(lastMonthTotal)}`,
          'success',
        )
        onDone()
      } catch (e) {
        setError(e instanceof Error ? e.message : '保存失败')
      }
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 py-10 md:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="w-full max-w-[440px] rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-xl">
        <div className="flex items-baseline justify-between border-b border-[var(--color-border)] px-5 py-3.5">
          <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">记一笔</h2>
          <span className="label text-[var(--color-ink-3)]">记录人 · {userName}</span>
        </div>

        <div className="px-5 py-5">
          {/* Category chips — one tap, no dropdown. */}
          <div className="grid grid-cols-4 gap-1.5">
            {EXPENSE_CATEGORIES.map((c) => {
              const active = c === category
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    setCategory(c)
                    amountRef.current?.focus()
                  }}
                  className={`rounded-[2px] border px-2 py-1.5 text-[13px] transition-colors ${
                    active
                      ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-surface)] font-medium'
                      : 'border-[var(--color-border)] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]'
                  }`}
                >
                  {CATEGORY_LABEL[c]}
                </button>
              )
            })}
          </div>

          {category === 'payroll' && lastMonthPayroll.length > 0 && (
            <button
              type="button"
              onClick={copyLastMonthPayroll}
              disabled={pending}
              className="mt-3 w-full rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-3 py-2 text-[13px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] transition-colors disabled:opacity-50"
            >
              复制{lastMonthLabel}工资 · {lastMonthPayroll.length} 人 ·{' '}
              <span className="mono">{formatCny(lastMonthTotal)}</span>
            </button>
          )}

          <div className="mt-4 grid grid-cols-2 gap-4">
            <Field label="金额 ¥" required>
              <input
                ref={amountRef}
                autoFocus
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit()
                }}
                placeholder="0"
                inputMode="decimal"
                className="mono w-full rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[14px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
              />
            </Field>
            <Field label="日期" required>
              <input
                value={date}
                onChange={(e) => setDate(e.target.value)}
                placeholder="YYYY-MM-DD"
                spellCheck={false}
                className="mono w-full rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[14px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
              />
            </Field>
          </div>

          {/* Date presets — intuition over typing dates. */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {[
              { label: '今天', value: todayStr },
              { label: '昨天', value: addDays(todayStr, -1) },
              { label: '月初', value: `${todayStr.slice(0, 7)}-01` },
            ].map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => setDate(preset.value)}
                className="rounded-[2px] border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-4">
            <Field label={category === 'payroll' || category === 'daily' ? '对象 · 人名' : '对象 · 收款方'}>
              <input
                value={payee}
                onChange={(e) => setPayee(e.target.value)}
                list="expense-payees"
                placeholder="可留空"
                className="w-full rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[14px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
              />
              <datalist id="expense-payees">
                {payees[category].map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </Field>
            <Field label="备注">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit()
                }}
                placeholder="可留空"
                className="w-full rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[14px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
              />
            </Field>
          </div>

          {error && <p className="mt-4 text-[12px] text-[var(--color-overdue)]">{error}</p>}
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
            {pending ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
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
    <label className="block">
      <span className="label block mb-1.5">
        {label}
        {required && <span className="text-[var(--color-overdue)] ml-0.5">*</span>}
      </span>
      {children}
    </label>
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
