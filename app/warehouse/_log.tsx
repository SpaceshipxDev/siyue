'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { EditableText, EditableTextArea } from '@/app/_editable'
import { ImportPanel } from './_import'
import type { StockMove, StockMoveKind } from '@/lib/warehouse'

// 出入库记录 — 仓库的背面, 也是唯一在录的东西。
//
// 一笔回答五件事: 哪一天 · 什么物料 · 什么规格 · 进还是出 · 多少。库存那一页
// 是这张表加出来的, 所以这里记准了, 那边就永远是对的。
//
// 记一笔对全厂的账号开着 —— 东西是当场进出的。改已经记下的、删一笔是工程和
// 商务于海伟那一档: 悄悄改一笔数, 库存就跟着错, 还看不出是哪天错的。

const MONTHS = [
  '01', '02', '03', '04', '05', '06',
  '07', '08', '09', '10', '11', '12',
]

const COLS =
  'grid-cols-[64px_minmax(0,1.1fr)_minmax(0,0.9fr)_52px_80px_minmax(0,1fr)_72px_28px]'

export function LogBoard({
  rows,
  todayStr,
  names,
  specByName,
  initialQ,
  canEdit,
}: {
  rows: StockMove[]
  todayStr: string
  /** 已经进出过的物料名 — 输入时的建议, 免得同一样东西写出三种写法。 */
  names: string[]
  /** 物料名 → 上一次用的规格, 选了名字自动带出来。 */
  specByName: Record<string, string>
  /** 从库存那一页点过来时带的物料名。 */
  initialQ: string
  /**
   * 改已经记下的东西 / 删一笔 — 工程 + 商务于海伟。
   * 记一笔、补一句还空着的备注, 有账号的人都可以, 不看这个。
   */
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [month, setMonth] = useState(todayStr.slice(5, 7))
  const [q, setQ] = useState(initialQ)
  const [armDelete, setArmDelete] = useState<string | null>(null)
  // 原始台账导入 — 一份已经存在的账一次搬进来, 跟"记一笔"是同一件事的批量版。
  const [importing, setImporting] = useState(false)
  const year = todayStr.slice(0, 4)

  // 记一笔
  const [date, setDate] = useState(todayStr)
  const [name, setName] = useState('')
  const [spec, setSpec] = useState('')
  const [kind, setKind] = useState<StockMoveKind>('in')
  const [qty, setQty] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const monthRows = useMemo(() => {
    const ym = `${year}-${month}`
    const needle = q.trim().toLowerCase()
    return rows
      .filter((r) => r.date.slice(0, 7) === ym)
      .filter((r) =>
        !needle
          ? true
          : [r.name, r.spec, r.note, r.by]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(needle),
      )
  }, [rows, year, month, q])

  const stats = useMemo(() => {
    let inQty = 0
    let outQty = 0
    for (const r of monthRows) {
      if (r.kind === 'in') inQty += r.qty
      else outQty += r.qty
    }
    return {
      inQty: Math.round(inQty * 100) / 100,
      outQty: Math.round(outQty * 100) / 100,
    }
  }, [monthRows])

  function add() {
    if (!name.trim()) return setError('先填物料名称')
    const n = Number(qty.trim())
    if (!Number.isFinite(n) || n <= 0) return setError('数量要填一个大于 0 的数')
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'addStockMove',
          input: {
            date,
            name: name.trim(),
            spec: spec.trim(),
            moveKind: kind,
            qty: n,
            note: note.trim(),
          },
        })
        setName('')
        setSpec('')
        setQty('')
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
    await mutate({ kind: 'updateStockMove', moveId: id, patch: p })
    router.refresh()
  }

  function remove(id: string) {
    start(async () => {
      try {
        await mutate({ kind: 'deleteStockMove', moveId: id })
        setArmDelete(null)
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '删不掉', 'warning')
      }
    })
  }

  const inp =
    'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'

  const exportHref = `/warehouse/export?v=log&m=${year}-${month}${
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
            value={name}
            onChange={(e) => {
              const v = e.target.value
              setName(v)
              // 选了一个记过的物料就把上次的规格带出来 — 同一样东西不该每次
              // 重打一遍规格, 打一遍就多一种写法。
              const known = specByName[v.trim()]
              if (known && !spec.trim()) setSpec(known)
            }}
            placeholder="物料名称"
            list="warehouse-names"
            className={`${inp} min-w-[160px] flex-1`}
          />
          <datalist id="warehouse-names">
            {names.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <input
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            placeholder="规格 / 型号"
            className={`${inp} min-w-[140px] flex-1`}
          />
          {/* 入 / 出 — 一个两格的开关, 不是下拉: 仓库只有这两个方向。 */}
          <div className="inline-flex h-9 shrink-0 overflow-hidden rounded-[2px] border border-[var(--color-border)]">
            {(['in', 'out'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`px-3.5 text-[13px] font-medium transition-colors ${
                  kind === k
                    ? k === 'in'
                      ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
                      : 'bg-[var(--color-overdue)] text-white'
                    : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
                }`}
              >
                {k === 'in' ? '入库' : '出库'}
              </button>
            ))}
          </div>
          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="数量"
            inputMode="decimal"
            className={`mono ${inp} w-[88px] text-right`}
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="备注 · 领用到哪 / 谁供的货"
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
          <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>
        )}
      </div>

      {importing && (
        <ImportPanel
          existing={rows}
          todayStr={todayStr}
          onClose={() => setImporting(false)}
          onDone={(m, n) => {
            setImporting(false)
            setMonth(m)
            showToast(`导入 ${n} 条`, 'success')
            router.refresh()
          }}
        />
      )}

      <div className="mb-6 flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <p className="text-[32px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">
            {monthRows.length}
          </p>
          <p className="label mt-2.5">{Number(month)}月出入库</p>
        </div>
        <div>
          <p className="text-[22px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink-2)]">
            {stats.inQty}
          </p>
          <p className="label mt-2.5">入库合计</p>
        </div>
        <div>
          <p className="text-[22px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-overdue)]">
            {stats.outQty}
          </p>
          <p className="label mt-2.5">出库合计</p>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索 · 物料 / 规格 / 备注"
            className="h-9 w-[210px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
          />
          {canEdit && (
            <button
              type="button"
              onClick={() => setImporting((v) => !v)}
              className="rounded-[2px] border border-[var(--color-border)] px-3.5 py-2 text-[13px] font-medium text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)]"
            >
              导入
            </button>
          )}
          <Link
            href={exportHref}
            prefetch={false}
            className="rounded-[2px] border border-[var(--color-border)] px-3.5 py-2 text-[13px] font-medium text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)]"
          >
            导出
          </Link>
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
          <span className="label">物料名称</span>
          <span className="label">规格 / 型号</span>
          <span className="label">进出</span>
          <span className="label text-right">数量</span>
          <span className="label">备注</span>
          <span className="label">记录人</span>
          <span />
        </div>

        {monthRows.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {q ? '没有匹配的记录' : '这个月没有出入库'}
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
                canEdit={canEdit}
                value={r.name}
                strong
                onSave={(v) => patch(r.id, { name: v })}
              />
              <Cell
                canEdit={canEdit || !r.spec}
                value={r.spec}
                placeholder="—"
                onSave={(v) => patch(r.id, { spec: v })}
              />
              {/* 进出 — 记错方向是仓库最常见的一笔错, 所以它跟数量一样改得动
                  (同一档权限)。 */}
              {canEdit ? (
                <button
                  type="button"
                  onClick={() =>
                    patch(r.id, { kind: r.kind === 'in' ? 'out' : 'in' })
                  }
                  className={`justify-self-start rounded-[2px] px-1.5 text-[12.5px] font-medium hover:bg-black/[0.04] ${
                    r.kind === 'in'
                      ? 'text-[var(--color-ink)]'
                      : 'text-[var(--color-overdue)]'
                  }`}
                  title="点一下换方向"
                >
                  {r.kind === 'in' ? '入库' : '出库'}
                </button>
              ) : (
                <span
                  className={`text-[12.5px] font-medium ${
                    r.kind === 'in'
                      ? 'text-[var(--color-ink)]'
                      : 'text-[var(--color-overdue)]'
                  }`}
                >
                  {r.kind === 'in' ? '入库' : '出库'}
                </span>
              )}
              <NumCell
                canEdit={canEdit}
                value={r.qty}
                out={r.kind === 'out'}
                onSave={(v) => patch(r.id, { qty: v })}
              />
              <Cell
                canEdit={canEdit || !r.note}
                value={r.note}
                placeholder="—"
                onSave={(v) => patch(r.id, { note: v })}
              />
              <span className="break-words text-[12px] text-[var(--color-ink-3)]">
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
        东西一进一出当场记一笔，库存那一页自己会算——谁都能记，记过的要改或删，
        找工程或于海伟。导出的就是屏幕上这一批。
      </p>
    </div>
  )
}

function Cell({
  canEdit,
  value,
  onSave,
  strong,
  placeholder = '—',
}: {
  canEdit: boolean
  value?: string
  onSave: (v: string) => Promise<void>
  strong?: boolean
  placeholder?: string
}) {
  const cls = strong
    ? 'text-[13px] font-medium tracking-tight text-[var(--color-ink)]'
    : 'text-[12.5px] text-[var(--color-ink-2)]'
  if (!canEdit) {
    return <span className={`block break-words ${cls}`}>{value || placeholder}</span>
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
  out,
  onSave,
}: {
  canEdit: boolean
  value: number
  out: boolean
  onSave: (v: number) => Promise<void>
}) {
  const cls = `text-[12.5px] tabular-nums font-medium ${
    out ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink)]'
  }`
  if (!canEdit) {
    return (
      <span className={`mono block text-right ${cls}`}>{value}</span>
    )
  }
  return (
    <EditableText
      mono
      align="right"
      value={String(value)}
      placeholder="0"
      className={cls}
      onSave={async (next) => {
        const n = Number(next.trim())
        if (!Number.isFinite(n) || n <= 0) throw new Error('数量要大于 0')
        await onSave(n)
      }}
    />
  )
}
