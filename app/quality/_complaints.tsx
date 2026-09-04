'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { EditableText, EditableTextArea } from '@/app/_editable'
import { formatCny } from '@/lib/data'
import type { Complaint } from '@/lib/complaints'

// 客诉异常 — 客户那边反馈回来的质量问题。
//
// 跟隔壁那张「质量异常」是两回事: 那张是厂里自己检出来的, 一条都不用录 (检
// 验员按下判定就有了); 这张是客户打电话过来的, 系统无从知道, 只能商务落笔。
//
// 一条客诉回答七件事: 谁家的 · 坏了几个 · 为什么 · 怎么处理 · 谁的责任 · 赔
// 了多少 · 以后怎么不再犯。那个钱数是这张表存在的理由 —— 质量问题只有换算成
// 钱, 才谈得上跟谁算账、值不值得改; 而措施定下来, 这条客诉才算完, 所以顶上
// 数着还没定措施的条数。
//
// 一行录入, 之后每一格都能点着改 —— 客诉是拖着办的, 今天先记下"客户说坏了
// 20 个", 处理方式和损失金额可能一周后才定。

const MONTHS = [
  '01', '02', '03', '04', '05', '06',
  '07', '08', '09', '10', '11', '12',
]

const COLS =
  'grid-cols-[64px_minmax(0,0.7fr)_108px_48px_minmax(0,1.1fr)_minmax(0,0.9fr)_64px_minmax(0,1.1fr)_80px_28px]'

export function ComplaintsBoard({
  rows,
  todayStr,
  customers,
  canEdit,
}: {
  rows: Complaint[]
  todayStr: string
  /** 历史客户名 — 输入时的建议, 免得同一家写出三种写法。 */
  customers: string[]
  /**
   * 改已经填下去的东西 / 删一条 — 工程 + 商务于海伟。
   * 记一条、补一个还空着的格, 有账号的人都可以, 不看这个。
   */
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [month, setMonth] = useState(todayStr.slice(5, 7))
  const [q, setQ] = useState('')
  const [armDelete, setArmDelete] = useState<string | null>(null)
  const year = todayStr.slice(0, 4)

  // 记一笔
  const [date, setDate] = useState(todayStr)
  const [customer, setCustomer] = useState('')
  const [jobNo, setJobNo] = useState('')
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('')
  const [handling, setHandling] = useState('')
  const [owner, setOwner] = useState('')
  const [action, setAction] = useState('')
  const [loss, setLoss] = useState('')
  const [error, setError] = useState<string | null>(null)

  const monthRows = useMemo(() => {
    const ym = `${year}-${month}`
    const needle = q.trim().toLowerCase()
    return rows
      .filter((r) => r.date.slice(0, 7) === ym)
      .filter((r) =>
        !needle
          ? true
          : [
              r.customer,
              r.jobNo,
              r.reason,
              r.handling,
              r.owner,
              r.action,
              r.by,
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(needle),
      )
  }, [rows, year, month, q])

  const stats = useMemo(() => {
    let qtySum = 0
    let lossSum = 0
    let open = 0
    for (const r of monthRows) {
      qtySum += r.qty
      lossSum += r.lossCny
      if (!r.action) open += 1
    }
    return { qtySum, lossSum: Math.round(lossSum * 100) / 100, open }
  }, [monthRows])

  function add() {
    if (!customer.trim()) return setError('先填客户')
    if (!reason.trim()) return setError('填一下不良原因')
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'addComplaint',
          input: {
            date,
            customer: customer.trim(),
            jobNo: jobNo.trim() || undefined,
            qty: Number(qty.trim()) || 0,
            reason: reason.trim(),
            handling: handling.trim(),
            owner: owner.trim(),
            action: action.trim(),
            lossCny: Number(loss.trim().replace(/[¥,，元]/g, '')) || 0,
          },
        })
        setCustomer('')
        setJobNo('')
        setQty('')
        setReason('')
        setHandling('')
        setOwner('')
        setAction('')
        setLoss('')
        setDate(todayStr)
        setMonth(date.slice(5, 7))
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '记不上')
      }
    })
  }

  async function patch(id: string, p: Record<string, unknown>) {
    await mutate({ kind: 'updateComplaint', complaintId: id, patch: p })
    router.refresh()
  }

  function remove(id: string) {
    start(async () => {
      try {
        await mutate({ kind: 'deleteComplaint', complaintId: id })
        setArmDelete(null)
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '删不掉', 'warning')
      }
    })
  }

  const inp =
    'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'

  const exportHref = `/quality/export?v=complaint&m=${year}-${month}${
    q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''
  }`

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
            value={customer}
            onChange={(e) => setCustomer(e.target.value)}
            placeholder="客户"
            list="complaint-customers"
            className={`${inp} w-[150px]`}
          />
          <datalist id="complaint-customers">
            {customers.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <input
            value={jobNo}
            onChange={(e) => setJobNo(e.target.value)}
            placeholder="工号 · 可空"
            className={`mono ${inp} w-[110px]`}
          />
          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="不良数"
            inputMode="numeric"
            className={`mono ${inp} w-[76px] text-right`}
          />
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="不良原因"
            className={`${inp} min-w-[140px] flex-1`}
          />
          <input
            value={handling}
            onChange={(e) => setHandling(e.target.value)}
            placeholder="处理方式"
            className={`${inp} min-w-[120px] flex-1`}
          />
          <input
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="责任人"
            className={`${inp} w-[92px]`}
          />
          <input
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="纠正预防措施 · 可后补"
            className={`${inp} min-w-[160px] flex-1`}
          />
          <input
            value={loss}
            onChange={(e) => setLoss(e.target.value)}
            placeholder="损失¥"
            inputMode="decimal"
            onKeyDown={(e) => e.key === 'Enter' && add()}
            className={`mono ${inp} w-[92px] text-right`}
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
            {monthRows.length}
          </p>
          <p className="label mt-2.5">{Number(month)}月客诉</p>
          <p className="mt-1 text-[12px] tabular-nums text-[var(--color-ink-3)]">
            不良 {stats.qtySum} 件
          </p>
        </div>
        <div>
          <p className="text-[22px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-overdue)]">
            {formatCny(stats.lossSum)}
          </p>
          <p className="label mt-2.5">损失金额</p>
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
          <p className="label mt-2.5">待定措施</p>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索 · 客户 / 原因 / 责任人"
            className="h-9 w-[200px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
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
            onClick={() => setMonth(m)}
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
          <span className="label">日期</span>
          <span className="label">客户</span>
          <span className="label">工号</span>
          <span className="label text-right">不良数</span>
          <span className="label">不良原因</span>
          <span className="label">处理方式</span>
          <span className="label">责任人</span>
          <span className="label">纠正预防措施</span>
          <span className="label text-right">损失金额</span>
          <span />
        </div>

        {monthRows.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {q ? '没有匹配的记录' : '这个月没有客诉'}
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
                canEdit={canEdit || !r.customer}
                value={r.customer}
                strong
                onSave={(v) => patch(r.id, { customer: v })}
              />
              <Cell
                canEdit={canEdit || !r.jobNo}
                mono
                value={r.jobNo}
                onSave={(v) => patch(r.id, { jobNo: v })}
              />
              <NumCell
                canEdit={canEdit || r.qty === 0}
                value={r.qty}
                onSave={(v) => patch(r.id, { qty: v })}
              />
              <Cell
                canEdit={canEdit || !r.reason}
                value={r.reason}
                onSave={(v) => patch(r.id, { reason: v })}
              />
              <Cell
                canEdit={canEdit || !r.handling}
                value={r.handling}
                placeholder="待处理…"
                onSave={(v) => patch(r.id, { handling: v })}
              />
              <Cell
                canEdit={canEdit || !r.owner}
                value={r.owner}
                placeholder="待定"
                onSave={(v) => patch(r.id, { owner: v })}
              />
              <Cell
                canEdit={canEdit || !r.action}
                value={r.action}
                placeholder="待定措施…"
                onSave={(v) => patch(r.id, { action: v })}
              />
              <NumCell
                canEdit={canEdit || r.lossCny === 0}
                value={r.lossCny}
                money
                onSave={(v) => patch(r.id, { lossCny: v })}
              />
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
        客诉是拖着办的——先记下客户说坏了几个，处理方式、损失金额和纠正预防措施
        定下来再回来补，还空着的格谁都填得上；填过的要改，找工程或于海伟。导出
        的就是屏幕上这一批。
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
  onSave,
  money,
}: {
  canEdit: boolean
  value: number
  onSave: (v: number) => Promise<void>
  money?: boolean
}) {
  const shown = money ? formatCny(value) : String(value)
  if (!canEdit) {
    return (
      <span
        className={`mono truncate text-right text-[12.5px] tabular-nums ${
          money && value > 0
            ? 'font-semibold text-[var(--color-overdue)]'
            : 'text-[var(--color-ink-2)]'
        }`}
      >
        {shown}
      </span>
    )
  }
  return (
    <EditableText
      mono
      align="right"
      value={value === 0 ? '' : String(value)}
      placeholder={money ? '¥0' : '0'}
      className={`text-[12.5px] tabular-nums ${
        money && value > 0 ? 'font-semibold text-[var(--color-overdue)]' : ''
      }`}
      onSave={async (next) => {
        const t = next.trim().replace(/[¥,，元\s]/g, '')
        const n = t === '' ? 0 : Number(t)
        if (!Number.isFinite(n) || n < 0) throw new Error('要填数字')
        await onSave(n)
      }}
    />
  )
}
