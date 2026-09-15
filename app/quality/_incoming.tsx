'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { formatCny } from '@/lib/data'
import { EditableText, EditableTextArea } from '@/app/_editable'
import type { IncomingDefect } from '@/lib/incoming-defects'

// 来料异常登记 — 料一进厂就不对。
//
// 别的几张表追的是厂里自己这一段, 这一张追的是上游: 哪一单、哪家供应商、什
// 么品名、几个、为什么、怎么处理、损失多少。所以第一眼要看到的不是"出了几
// 条", 是**哪家供应商赔了多少** —— 那才是跟供应商谈价、索赔、换一家的依据。
//
// 一行录入, 之后还空着的格谁都能补 (处理方式和损失常常是几天后才定); 填过的
// 要改是质量和商务于海伟那一档。

const MONTHS = [
  '01', '02', '03', '04', '05', '06',
  '07', '08', '09', '10', '11', '12',
]

const COLS =
  'grid-cols-[64px_110px_120px_minmax(0,1fr)_52px_minmax(0,1.1fr)_minmax(0,1fr)_84px_72px_28px]'

export function IncomingBoard({
  rows,
  todayStr,
  suppliers,
  canEdit,
}: {
  rows: IncomingDefect[]
  todayStr: string
  /** 已经打过交道的供应商 — 录入那一格的联想, 少打几个字也少打错。 */
  suppliers: string[]
  /**
   * 改已经填下去的东西 / 删一条 — 质量 + 工程 + 商务于海伟。
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
  const [docNo, setDocNo] = useState('')
  const [supplier, setSupplier] = useState('')
  const [item, setItem] = useState('')
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('')
  const [handling, setHandling] = useState('')
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
          : [r.docNo, r.supplier, r.item, r.reason, r.handling, r.by]
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
    const byVendor = new Map<string, number>()
    for (const r of monthRows) {
      qtySum += r.qty
      lossSum += r.lossCny
      if (!r.handling) open += 1
      if (r.supplier) {
        byVendor.set(r.supplier, (byVendor.get(r.supplier) ?? 0) + r.lossCny)
      }
    }
    // 损失最大的那一家排头 —— 这张表真正要回答的问题。
    const top = [...byVendor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    return { qtySum, lossSum, open, top }
  }, [monthRows])

  function add() {
    if (!supplier.trim()) return setError('先填供应商')
    if (!reason.trim()) return setError('填一下不良原因')
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'addIncomingDefect',
          input: {
            date,
            docNo: docNo.trim(),
            supplier: supplier.trim(),
            item: item.trim(),
            qty: Number(qty.trim()) || 0,
            reason: reason.trim(),
            handling: handling.trim(),
            lossCny: Number(loss.trim().replace(/[¥,，元\s]/g, '')) || 0,
          },
        })
        setDocNo('')
        setItem('')
        setQty('')
        setReason('')
        setHandling('')
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
    await mutate({ kind: 'updateIncomingDefect', defectId: id, patch: p })
    router.refresh()
  }

  function remove(id: string) {
    start(async () => {
      try {
        await mutate({ kind: 'deleteIncomingDefect', defectId: id })
        setArmDelete(null)
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '删不掉', 'warning')
      }
    })
  }

  const inp =
    'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'

  const exportHref = `/quality/export?v=incoming&m=${year}-${month}${
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
            value={docNo}
            onChange={(e) => setDocNo(e.target.value)}
            placeholder="单号"
            className={`mono ${inp} w-[118px]`}
          />
          <input
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            placeholder="供应商"
            list="incoming-suppliers"
            className={`${inp} w-[130px]`}
          />
          <datalist id="incoming-suppliers">
            {suppliers.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <input
            value={item}
            onChange={(e) => setItem(e.target.value)}
            placeholder="品名"
            className={`${inp} min-w-[120px] flex-1`}
          />
          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="数量"
            inputMode="numeric"
            className={`mono ${inp} w-[72px] text-right`}
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
            placeholder="处理方式 · 退货/换货/让步…"
            className={`${inp} min-w-[150px] flex-1`}
          />
          <input
            value={loss}
            onChange={(e) => setLoss(e.target.value)}
            placeholder="损失 ¥"
            inputMode="numeric"
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
          <p className="label mt-2.5">{Number(month)}月来料异常</p>
          <p className="mt-1 text-[12px] tabular-nums text-[var(--color-ink-3)]">
            不良 {stats.qtySum} 件
          </p>
        </div>
        <div>
          <p
            className={`text-[22px] font-semibold leading-none tracking-tight tabular-nums ${
              stats.lossSum > 0
                ? 'text-[var(--color-overdue)]'
                : 'text-[var(--color-ink-3)]'
            }`}
          >
            {formatCny(stats.lossSum)}
          </p>
          <p className="label mt-2.5">损失合计</p>
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
          <p className="label mt-2.5">待处理</p>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索 · 单号 / 供应商 / 品名"
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

      {/* 这个月谁赔得最多 —— 一行字, 但它是这张表存在的理由。 */}
      {stats.top.length > 0 && stats.lossSum > 0 && (
        <div className="mb-4 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[12.5px]">
          <span className="label text-[var(--color-ink-3)]">损失最大</span>
          {stats.top.map(([name, sum]) => (
            <span key={name} className="text-[var(--color-ink-2)]">
              {name}{' '}
              <span className="mono tabular-nums text-[var(--color-ink)]">
                {formatCny(sum)}
              </span>
            </span>
          ))}
        </div>
      )}

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
          <span className="label">单号</span>
          <span className="label">供应商</span>
          <span className="label">品名</span>
          <span className="label text-right">数量</span>
          <span className="label">不良原因</span>
          <span className="label">处理方式</span>
          <span className="label text-right">损失</span>
          <span className="label">记录人</span>
          <span />
        </div>

        {monthRows.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {q ? '没有匹配的记录' : '这个月没有来料异常'}
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
                canEdit={canEdit || !r.docNo}
                mono
                value={r.docNo}
                onSave={(v) => patch(r.id, { docNo: v })}
              />
              <Cell
                canEdit={canEdit || !r.supplier}
                strong
                value={r.supplier}
                onSave={(v) => patch(r.id, { supplier: v })}
              />
              <Cell
                canEdit={canEdit || !r.item}
                value={r.item}
                onSave={(v) => patch(r.id, { item: v })}
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
              <NumCell
                canEdit={canEdit || r.lossCny === 0}
                value={r.lossCny}
                money
                onSave={(v) => patch(r.id, { lossCny: v })}
              />
              {/* 记录人不给改 —— 落笔那一刻盖上的签名。 */}
              <span
                className="break-words text-[12.5px] text-[var(--color-ink-2)]"
                title={
                  r.createdAt ? `记于 ${r.createdAt.slice(0, 10)}` : undefined
                }
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
        料一进厂就不对的，记在这儿——先把单号、供应商、品名记下来，处理方式和
        损失定了再回来补。还空着的格谁都填得上，填过的要改找质量或于海伟。损失
        记的是钱，所以这个月哪家赔得最多，上面那一行直接给出来；谈价、索赔、换
        一家，靠的就是它。导出的就是屏幕上这一批。
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
  money?: boolean
  onSave: (v: number) => Promise<void>
}) {
  const shown = money ? (value > 0 ? formatCny(value) : '—') : String(value)
  if (!canEdit) {
    return (
      <span className="mono truncate text-right text-[12.5px] tabular-nums text-[var(--color-ink-2)]">
        {shown}
      </span>
    )
  }
  return (
    <EditableText
      mono
      align="right"
      value={value > 0 ? String(value) : ''}
      placeholder={money ? '—' : '0'}
      className="text-[12.5px] tabular-nums text-[var(--color-ink-2)]"
      onSave={async (next) => {
        const t = next.trim().replace(/[¥,，元\s]/g, '')
        const n = t === '' ? 0 : Number(t)
        if (!Number.isFinite(n) || n < 0) throw new Error('要填数字')
        await onSave(n)
      }}
    />
  )
}
