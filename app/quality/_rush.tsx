'use client'

import { useColFilters } from './_col_head'
import { RUSH_COLS } from '@/lib/quality-filter'
import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { EditableText, EditableTextArea } from '@/app/_editable'
import { formatCny } from '@/lib/data'
import type { RushRecord } from '@/lib/rush-fee'

// 加急费用 — 为了赶交期多花的钱 (于海伟 2026-11-21)。
//
// 跟报废登记同一个用法: 顶上一行记下, 还空着的格谁都能补, 填过的要改是工程
// 和商务于海伟那一档。一条: 订单号 · 数量 · 加急费用 · 加急原因 · 责任部门 /
// 责任人 · 造成加急的原因。顶上数这个月加急一共花了多少、各算在哪个部门头上。

const MONTHS = [
  '01', '02', '03', '04', '05', '06',
  '07', '08', '09', '10', '11', '12',
]

const COLS =
  'grid-cols-[56px_150px_44px_84px_minmax(0,1fr)_72px_64px_minmax(0,1.1fr)_minmax(0,1fr)_60px_28px]'

export function RushBoard({
  rows,
  todayStr,
  depts,
  canEdit,
  canEditOwner = canEdit,
}: {
  rows: RushRecord[]
  todayStr: string
  /** 责任部门那一格的联想。 */
  depts: string[]
  /** 改已经填下去的东西 / 删一条 — 工程 + 商务于海伟。 */
  canEdit: boolean
  /** 责任那几格填过的也能改 —— 程江华、戴棵、潘健、范小唱也算 (于海伟 2026-11-02)。 */
  canEditOwner?: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [month, setMonth] = useState(todayStr.slice(5, 7))
  const [q, setQ] = useState('')
  const [armDelete, setArmDelete] = useState<string | null>(null)
  const year = todayStr.slice(0, 4)

  // 记一笔
  const [date, setDate] = useState(todayStr)
  const [jobNo, setJobNo] = useState('')
  const [qty, setQty] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [dept, setDept] = useState('')
  const [owner, setOwner] = useState('')
  const [cause, setCause] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  // 表头筛选 (于海伟 2026-11-02) —— 这个月的那一批里按列筛 (_col_head)。
  const inMonth = useMemo(
    () => rows.filter((r) => r.date.slice(0, 7) === `${year}-${month}`),
    [rows, year, month],
  )
  const cf = useColFilters(inMonth, RUSH_COLS)

  const monthRows = useMemo(() => {
    const ym = `${year}-${month}`
    const needle = q.trim().toLowerCase()
    return rows
      .filter((r) => r.date.slice(0, 7) === ym && cf.match(r))
      .filter((r) =>
        !needle
          ? true
          : [r.jobNo, r.reason, r.dept, r.owner, r.cause, r.note, r.by]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(needle),
      )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, year, month, q, cf.filters])

  const stats = useMemo(() => {
    let amountSum = 0
    let open = 0
    const byDept: Record<string, number> = {}
    for (const r of monthRows) {
      amountSum += r.amount
      if (!r.cause) open += 1
      if (r.dept) byDept[r.dept] = (byDept[r.dept] ?? 0) + r.amount
    }
    // 算在谁头上最多的排前面。
    const depts = Object.entries(byDept).sort((a, b) => b[1] - a[1])
    return { amountSum: Math.round(amountSum * 100) / 100, open, depts }
  }, [monthRows])

  function add() {
    if (!jobNo.trim()) return setError('先填订单号')
    const amt = Number(amount.trim().replace(/[¥,，元\s]/g, '')) || 0
    if (amt < 0) return setError('加急费用要填数字')
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'addRush',
          input: {
            date,
            jobNo: jobNo.trim(),
            qty: Number(qty.trim()) || 0,
            amount: amt,
            reason: reason.trim(),
            dept: dept.trim(),
            owner: owner.trim(),
            cause: cause.trim(),
            note: note.trim(),
          },
        })
        setJobNo('')
        setQty('')
        setAmount('')
        setReason('')
        setOwner('')
        setCause('')
        setNote('')
        setDate(todayStr)
        setMonth(date.slice(5, 7))
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '记不上')
      }
    })
  }

  async function patch(id: string, p: Record<string, unknown>) {
    await mutate({ kind: 'updateRush', rushId: id, patch: p })
    router.refresh()
  }

  function remove(id: string) {
    start(async () => {
      try {
        await mutate({ kind: 'deleteRush', rushId: id })
        setArmDelete(null)
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '删不掉', 'warning')
      }
    })
  }

  const inp =
    'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'

  const exportHref = `/quality/export?v=rush&m=${year}-${month}${
    q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''
  }${cf.params}`

  return (
    <div>
      <div className="mb-5 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 md:px-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            type="date"
            value={date}
            max={todayStr}
            onChange={(e) => setDate(e.target.value || todayStr)}
            className={`mono ${inp}`}
          />
          <input
            value={jobNo}
            onChange={(e) => setJobNo(e.target.value)}
            placeholder="订单号"
            className={`mono ${inp} w-[140px]`}
          />
          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="数量"
            inputMode="numeric"
            className={`mono ${inp} w-[68px] text-right`}
          />
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="增加成本 ¥"
            inputMode="decimal"
            className={`mono ${inp} w-[96px] text-right`}
          />
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="加急原因"
            className={`${inp} min-w-[140px] flex-1`}
          />
          <input
            value={dept}
            onChange={(e) => setDept(e.target.value)}
            placeholder="责任部门"
            list="rush-depts"
            className={`${inp} w-[96px]`}
          />
          <datalist id="rush-depts">
            {depts.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
          <input
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="责任人"
            className={`${inp} w-[88px]`}
          />
          <input
            value={cause}
            onChange={(e) => setCause(e.target.value)}
            placeholder="造成加急的原因 · 可后补"
            className={`${inp} min-w-[160px] flex-1`}
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="备注 · 增加的成本花在哪"
            onKeyDown={(e) => e.key === 'Enter' && add()}
            className={`${inp} min-w-[160px] flex-1`}
          />
          <button
            type="button"
            onClick={add}
            disabled={pending}
            className="h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
          >
            记下
          </button>
        </div>
        {error && (
          <p className="mt-2 text-[12px] text-[var(--color-overdue)]">
            {error}
          </p>
        )}
      </div>

      <div className="mb-6 flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <p className="text-[32px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">
            {formatCny(stats.amountSum)}
          </p>
          <p className="label mt-2.5">{Number(month)}月加急增加成本 · {monthRows.length} 条</p>
          <p className="mt-1 text-[12px] tabular-nums text-[var(--color-ink-3)]">
            {stats.depts.map(([d, v]) => `${d} ${formatCny(v)}`).join(' · ')}
          </p>
        </div>
        <div>
          <p
            className={`text-[22px] font-semibold leading-none tracking-tight tabular-nums ${
              stats.open > 0
                ? 'text-[var(--color-overdue)]'
                : 'text-[var(--color-ink-3)]'
            }`}
          >
            {stats.open}
          </p>
          <p className="label mt-2.5">待填原因</p>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          {cf.active && (
            <button
              type="button"
              onClick={cf.clear}
              className="text-[12.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            >
              清除筛选
            </button>
          )}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索 · 订单号 / 原因 / 责任人"
            className="h-9 w-[210px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
          />
          {canEdit && (
            <Link
              href={exportHref}
              prefetch={false}
              className="rounded-[2px] border border-[var(--color-border)] px-3.5 py-2 text-[13px] font-medium text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)]"
            >
              导出
            </Link>
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {MONTHS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              // 换个月, 表头的选项跟着变 —— 选过的清掉。
              setMonth(m)
              cf.clear()
            }}
            className={`rounded-[2px] border bg-[var(--color-surface)] px-2.5 py-1 text-[12.5px] font-medium ${
              m === month
                ? 'border-[var(--color-ink)] text-[var(--color-ink)] shadow-[inset_0_0_0_1px_var(--color-ink)]'
                : 'border-[var(--color-border)] text-[var(--color-ink-3)] hover:border-[var(--color-border-strong)]'
            }`}
          >
            {Number(m)}月
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div
          className={`hidden ${COLS} items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid`}
        >
          {cf.head('date')}
          {cf.head('jobNo')}
          <span className="label text-right">数量</span>
          <span className="label text-right">增加成本</span>
          {cf.head('reason')}
          {cf.head('dept')}
          {cf.head('owner')}
          {cf.head('cause')}
          <span className="label">备注</span>
          {cf.head('by')}
          <span />
        </div>

        {monthRows.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {q || cf.active ? '没有匹配的记录' : '这个月没有加急费用'}
          </p>
        ) : (
          monthRows.map((r) => (
            <div
              key={r.id}
              className={`grid ${COLS} items-start gap-3 border-b border-[var(--color-border)] px-4 py-2.5 last:border-b-0 hover:bg-[#faf8f2] md:px-5`}
            >
              <span className="mono text-[12.5px] tabular-nums text-[var(--color-ink-2)]">
                {r.date.slice(5)}
              </span>
              <Cell
                canEdit={canEdit || !r.jobNo}
                mono
                strong
                value={r.jobNo}
                onSave={(v) => patch(r.id, { jobNo: v })}
              />
              <NumCell
                canEdit={canEdit || r.qty === 0}
                value={r.qty}
                onSave={(v) => patch(r.id, { qty: v })}
              />
              <NumCell
                canEdit={canEdit || r.amount === 0}
                value={r.amount}
                money
                onSave={(v) => patch(r.id, { amount: v })}
              />
              <Cell
                canEdit={canEdit || !r.reason}
                value={r.reason}
                onSave={(v) => patch(r.id, { reason: v })}
              />
              <Cell
                canEdit={canEditOwner || !r.dept}
                value={r.dept}
                placeholder="待定"
                onSave={(v) => patch(r.id, { dept: v })}
              />
              <Cell
                canEdit={canEditOwner || !r.owner}
                value={r.owner}
                placeholder="待定"
                onSave={(v) => patch(r.id, { owner: v })}
              />
              <Cell
                canEdit={canEditOwner || !r.cause}
                value={r.cause}
                placeholder="待填原因…"
                onSave={(v) => patch(r.id, { cause: v })}
              />
              <Cell
                canEdit={canEdit || !r.note}
                value={r.note}
                onSave={(v) => patch(r.id, { note: v })}
              />
              {/* 填写人是落笔那一刻的账号, 不给改。 */}
              <span
                className="break-words text-[12.5px] text-[var(--color-ink-2)]"
                title={r.createdAt ? `记于 ${r.createdAt.slice(0, 10)}` : undefined}
              >
                {r.by || '—'}
              </span>
              <span className="text-right">
                {canEdit &&
                  (armDelete === r.id ? (
                    <button
                      type="button"
                      onClick={() => remove(r.id)}
                      disabled={pending}
                      className="text-[11.5px] font-medium text-[var(--color-overdue)] hover:underline disabled:opacity-50"
                    >
                      确认
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setArmDelete(r.id)}
                      className="text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                    >
                      删
                    </button>
                  ))}
              </span>
            </div>
          ))
        )}
      </div>

      <p className="mt-4 text-[12px] text-[var(--color-ink-3)]">
        加急一发生就记下来，责任部门、责任人和造成加急的原因查清了再回来补——还空着的格谁都填得上，
        填过的要改找工程或于海伟。填写人是落笔那一刻自动签的。导出的就是屏幕上这一批。
      </p>
    </div>
  )
}

function Cell({
  canEdit,
  value,
  onSave,
  mono,
  strong,
  placeholder = '—',
}: {
  canEdit: boolean
  value?: string
  onSave: (v: string) => Promise<void>
  mono?: boolean
  strong?: boolean
  placeholder?: string
}) {
  const cls = `text-[12.5px] ${
    strong
      ? 'font-medium tracking-tight text-[var(--color-ink)]'
      : 'text-[var(--color-ink-2)]'
  }`
  if (!canEdit) {
    return (
      <span className={`${mono ? 'mono ' : ''}break-words ${cls}`}>
        {value || placeholder}
      </span>
    )
  }
  // 工号 / 工单号 这种短的留在单行框里; 原因、处理方式、措施这些会写成一句
  // 话, 用会自己长高的多行框 —— 写多长就显多长, 不再截在一格里。
  if (mono) {
    return (
      <EditableText
        mono
        value={value}
        placeholder={placeholder}
        className={cls}
        onSave={onSave}
      />
    )
  }
  return (
    <EditableTextArea
      value={value}
      placeholder={placeholder}
      className={cls}
      onSave={onSave}
    />
  )
}

function NumCell({
  canEdit,
  value,
  money,
  onSave,
}: {
  canEdit: boolean
  value: number
  /** 钱 —— 能填小数, 看的时候带 ¥。 */
  money?: boolean
  onSave: (v: number) => Promise<void>
}) {
  if (!canEdit) {
    return (
      <span className="mono truncate text-right text-[12.5px] tabular-nums text-[var(--color-ink-2)]">
        {money ? formatCny(value) : value}
      </span>
    )
  }
  return (
    <EditableText
      mono
      align="right"
      value={value === 0 ? '' : String(value)}
      placeholder="0"
      className="text-[12.5px] tabular-nums"
      onSave={async (next) => {
        const t = next.trim().replace(/[¥,，元\s]/g, '')
        const n = t === '' ? 0 : Number(t)
        if (!Number.isFinite(n) || n < 0) throw new Error('要填数字')
        await onSave(n)
      }}
    />
  )
}
