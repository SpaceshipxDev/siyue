'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import { withBase } from '@/lib/base-path'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { EditableText, EditableTextArea } from '@/app/_editable'
import type { SemiStockItem } from '@/lib/semi-stock'

// 半成品库存 (于海伟 2026-11-04) —— 看板上「半成品库存」那一栏。做了一半先放
// 着的件: 工单号 · 品名 · 数量 · 状态 · 备注。顶上一行录, 下面每一格点着就能
// 改, 拿走了就删掉那一行。谁都能录 (lib/semi-stock)。

const COLS = 'grid-cols-[120px_minmax(0,1.2fr)_64px_minmax(0,0.8fr)_minmax(0,1.2fr)_64px_28px]'

const inp =
  'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'

export function SemiStockPanel() {
  const [items, setItems] = useState<SemiStockItem[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [q, setQ] = useState('')
  const [jobNo, setJobNo] = useState('')
  const [name, setName] = useState('')
  const [qty, setQty] = useState('')
  const [status, setStatus] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [armDelete, setArmDelete] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const load = useCallback(async () => {
    try {
      const r = await fetch(withBase('/api/semi-stock'), { cache: 'no-store' })
      const j = (await r.json()) as { ok: boolean; items?: SemiStockItem[] }
      if (!j.ok) throw new Error()
      setItems(j.items ?? [])
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!items) return []
    if (!t) return items
    return items.filter((r) =>
      [r.jobNo, r.name, r.status, r.note].some((v) => v.toLowerCase().includes(t)),
    )
  }, [items, q])

  const total = useMemo(() => shown.reduce((s, r) => s + r.qty, 0), [shown])

  const add = () => {
    setError('')
    if (!jobNo.trim()) return setError('先填工单号')
    const n = qty.trim() === '' ? 0 : Number(qty.trim())
    if (!Number.isFinite(n) || n < 0) return setError('数量要填数字')
    start(async () => {
      try {
        await mutate({
          kind: 'addSemiStock',
          input: { jobNo, name, qty: n, status, note },
        })
        setJobNo('')
        setName('')
        setQty('')
        setStatus('')
        setNote('')
        await load()
      } catch (e) {
        setError(e instanceof Error ? e.message : '没记上，再试一次')
      }
    })
  }

  const patch = async (id: string, input: Partial<Omit<SemiStockItem, 'id'>>) => {
    await mutate({ kind: 'updateSemiStock', itemId: id, input })
    setItems((prev) => prev?.map((r) => (r.id === id ? { ...r, ...input } : r)) ?? prev)
  }

  const remove = (id: string) => {
    start(async () => {
      try {
        await mutate({ kind: 'deleteSemiStock', itemId: id })
        setItems((prev) => prev?.filter((r) => r.id !== id) ?? prev)
      } catch (e) {
        showToast(e instanceof Error ? e.message : '删不了', 'warning')
      } finally {
        setArmDelete(null)
      }
    })
  }

  return (
    <div>
      <div className="mb-5 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 md:px-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            value={jobNo}
            onChange={(e) => setJobNo(e.target.value)}
            placeholder="工单号"
            className={`mono ${inp} w-[120px]`}
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="品名"
            className={`${inp} min-w-[140px] flex-1`}
          />
          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="数量"
            inputMode="decimal"
            className={`mono ${inp} w-[68px] text-right`}
          />
          <input
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            placeholder="状态 · 如 待喷漆"
            className={`${inp} w-[128px]`}
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="备注"
            onKeyDown={(e) => e.key === 'Enter' && add()}
            className={`${inp} min-w-[140px] flex-1`}
          />
          <button
            type="button"
            onClick={add}
            disabled={pending}
            className="h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
          >
            录入
          </button>
        </div>
        {error && <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>}
      </div>

      <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索 · 工单号 / 品名 / 状态 / 备注"
          className={`${inp} w-[260px]`}
        />
        <span className="ml-auto label text-[var(--color-ink-3)]">
          <span className="mono mr-1 text-[12px] text-[var(--color-ink)] font-medium">{shown.length}</span>
          项 ·
          <span className="mono mx-1 text-[12px] text-[var(--color-ink)] font-medium">{total}</span>
          件
        </span>
      </div>

      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div
          className={`hidden ${COLS} items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid`}
        >
          <span className="label">工单号</span>
          <span className="label">品名</span>
          <span className="label text-right">数量</span>
          <span className="label">状态</span>
          <span className="label">备注</span>
          <span className="label">录入</span>
          <span />
        </div>

        {items === null ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {failed ? (
              <button type="button" onClick={() => void load()} className="hover:underline">
                没读到，点这里重试
              </button>
            ) : (
              <span className="animate-pulse">加载中…</span>
            )}
          </p>
        ) : shown.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {q.trim() ? '没有匹配的记录' : '还没有半成品库存'}
          </p>
        ) : (
          shown.map((r) => (
            <div
              key={r.id}
              className={`grid ${COLS} items-start gap-3 border-b border-[var(--color-border)] px-4 py-2.5 last:border-b-0 hover:bg-[#faf8f2] md:px-5`}
            >
              <EditableText
                mono
                value={r.jobNo}
                placeholder="—"
                className="text-[12.5px] font-medium tracking-tight text-[var(--color-ink)]"
                onSave={(v) => patch(r.id, { jobNo: v.trim() })}
              />
              <EditableTextArea
                value={r.name}
                placeholder="—"
                className="text-[12.5px] text-[var(--color-ink-2)]"
                onSave={(v) => patch(r.id, { name: v.trim() })}
              />
              <EditableText
                mono
                align="right"
                value={r.qty === 0 ? '' : String(r.qty)}
                placeholder="0"
                className="text-[12.5px] tabular-nums"
                onSave={async (next) => {
                  const t = next.trim()
                  const n = t === '' ? 0 : Number(t)
                  if (!Number.isFinite(n) || n < 0) throw new Error('要填数字')
                  await patch(r.id, { qty: n })
                }}
              />
              <EditableTextArea
                value={r.status}
                placeholder="—"
                className="text-[12.5px] text-[var(--color-ink-2)]"
                onSave={(v) => patch(r.id, { status: v.trim() })}
              />
              <EditableTextArea
                value={r.note}
                placeholder="—"
                className="text-[12.5px] text-[var(--color-ink-2)]"
                onSave={(v) => patch(r.id, { note: v.trim() })}
              />
              <span
                className="break-words text-[12.5px] text-[var(--color-ink-3)]"
                title={r.createdAt ? `录于 ${r.createdAt.slice(0, 10)}` : undefined}
              >
                {r.by || '—'}
              </span>
              <span className="text-right">
                {armDelete === r.id ? (
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
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
