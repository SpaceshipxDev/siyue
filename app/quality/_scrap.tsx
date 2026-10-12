'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { EditableText, EditableTextArea } from '@/app/_editable'
import type { ScrapRecord } from '@/lib/scrap'

// 报废登记 — 彻底做坏、不能再用的件。
//
// 跟制程不良同一个用法: 顶上一行记下, 还空着的格谁都能补, 填过的要改是工程
// 和商务于海伟那一档。多一格「来源」—— 自制加工 / 外协加工 / 客退, 点一下选;
// 责任在不在厂里是先要分清的。顶上数这个月扔了几件、各来自哪里。

const MONTHS = [
  '01', '02', '03', '04', '05', '06',
  '07', '08', '09', '10', '11', '12',
]

// 跟 lib/scrap 的 SCRAP_SOURCES 同一份 (那边是 server-only)。
const SOURCES = ['自制加工', '外协加工', '客退'] as const

const COLS =
  'grid-cols-[56px_112px_48px_minmax(0,1.1fr)_76px_76px_68px_minmax(0,1.2fr)_64px_28px]'

export function ScrapBoard({
  rows,
  todayStr,
  depts,
  canEdit,
}: {
  rows: ScrapRecord[]
  todayStr: string
  /** 责任部门那一格的联想。 */
  depts: string[]
  /** 改已经填下去的东西 / 删一条 — 工程 + 商务于海伟。 */
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
  const [jobNo, setJobNo] = useState('')
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('')
  const [source, setSource] = useState<string>('自制加工')
  const [dept, setDept] = useState('')
  const [owner, setOwner] = useState('')
  const [action, setAction] = useState('')
  const [error, setError] = useState<string | null>(null)

  const monthRows = useMemo(() => {
    const ym = `${year}-${month}`
    const needle = q.trim().toLowerCase()
    return rows
      .filter((r) => r.date.slice(0, 7) === ym)
      .filter((r) =>
        !needle
          ? true
          : [r.jobNo, r.reason, r.source, r.dept, r.owner, r.action, r.by]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(needle),
      )
  }, [rows, year, month, q])

  const stats = useMemo(() => {
    let qtySum = 0
    let open = 0
    const bySource: Record<string, number> = {}
    for (const r of monthRows) {
      qtySum += r.qty
      if (!r.action) open += 1
      if (r.source) bySource[r.source] = (bySource[r.source] ?? 0) + r.qty
    }
    return { qtySum, open, bySource }
  }, [monthRows])

  function add() {
    if (!jobNo.trim()) return setError('先填工单号')
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'addScrap',
          input: {
            date,
            jobNo: jobNo.trim(),
            qty: Number(qty.trim()) || 0,
            reason: reason.trim(),
            source,
            dept: dept.trim(),
            owner: owner.trim(),
            action: action.trim(),
          },
        })
        setJobNo('')
        setQty('')
        setReason('')
        setOwner('')
        setAction('')
        setDate(todayStr)
        setMonth(date.slice(5, 7))
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '记不上')
      }
    })
  }

  async function patch(id: string, p: Record<string, unknown>) {
    await mutate({ kind: 'updateScrap', scrapId: id, patch: p })
    router.refresh()
  }

  function remove(id: string) {
    start(async () => {
      try {
        await mutate({ kind: 'deleteScrap', scrapId: id })
        setArmDelete(null)
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '删不掉', 'warning')
      }
    })
  }

  const inp =
    'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'

  const exportHref = `/quality/export?v=scrap&m=${year}-${month}${
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
            value={jobNo}
            onChange={(e) => setJobNo(e.target.value)}
            placeholder="工单号"
            className={`mono ${inp} w-[120px]`}
          />
          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="数量"
            inputMode="numeric"
            className={`mono ${inp} w-[68px] text-right`}
          />
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="报废原因"
            className={`${inp} min-w-[140px] flex-1`}
          />
          <div className="flex h-9 overflow-hidden rounded-[2px] border border-[var(--color-border)]">
            {SOURCES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSource(s)}
                className={`px-2.5 text-[12.5px] ${
                  source === s
                    ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
                    : 'bg-[var(--color-bg)] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <input
            value={dept}
            onChange={(e) => setDept(e.target.value)}
            placeholder="责任部门"
            list="scrap-depts"
            className={`${inp} w-[96px]`}
          />
          <datalist id="scrap-depts">
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
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="纠正预防措施 · 可后补"
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
            {stats.qtySum}
          </p>
          <p className="label mt-2.5">{Number(month)}月报废件数</p>
          <p className="mt-1 text-[12px] tabular-nums text-[var(--color-ink-3)]">
            {SOURCES.filter((s) => stats.bySource[s]).map((s) => `${s} ${stats.bySource[s]}`).join(' · ') ||
              `${monthRows.length} 条`}
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
          <p className="label mt-2.5">待定措施</p>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索 · 工单号 / 原因 / 责任人"
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
          <span className="label">工单号</span>
          <span className="label text-right">数量</span>
          <span className="label">报废原因</span>
          <span className="label">来源</span>
          <span className="label">责任部门</span>
          <span className="label">责任人</span>
          <span className="label">纠正预防措施</span>
          <span className="label">填写人</span>
          <span />
        </div>

        {monthRows.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {q ? '没有匹配的记录' : '这个月没有报废'}
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
              <Cell
                canEdit={canEdit || !r.reason}
                value={r.reason}
                onSave={(v) => patch(r.id, { reason: v })}
              />
              {canEdit || !r.source ? (
                <select
                  value={r.source}
                  onChange={(e) => {
                    const v = e.target.value
                    patch(r.id, { source: v }).catch((err) =>
                      showToast(err instanceof Error ? err.message : '改不了', 'warning'),
                    )
                  }}
                  className="-ml-1 bg-transparent text-[12.5px] text-[var(--color-ink-2)] outline-none"
                >
                  {!r.source && <option value="">—</option>}
                  {SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-[12.5px] text-[var(--color-ink-2)]">{r.source}</span>
              )}
              <Cell
                canEdit={canEdit || !r.dept}
                value={r.dept}
                placeholder="待定"
                onSave={(v) => patch(r.id, { dept: v })}
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
        先把报废记下来，责任和纠正预防措施定了再回来补——还空着的格谁都填得上，
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
  onSave,
}: {
  canEdit: boolean
  value: number
  onSave: (v: number) => Promise<void>
}) {
  if (!canEdit) {
    return (
      <span className="mono truncate text-right text-[12.5px] tabular-nums text-[var(--color-ink-2)]">
        {value}
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
        const t = next.trim()
        const n = t === '' ? 0 : Number(t)
        if (!Number.isFinite(n) || n < 0) throw new Error('要填数字')
        await onSave(n)
      }}
    />
  )
}
