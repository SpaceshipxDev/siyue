'use client'

import { useEffect, useState } from 'react'
import type { Stage } from '@/lib/data'
import { withBase } from '@/lib/base-path'
import { mutate } from '@/lib/mutate'
import { showToast } from './_toast'

// 分工 — 这道工序是两个人以上做的。
//
// 系统一道工序只认一个人: 谁按下 ✓, 件数和金额就全记在谁头上。车间里 200 件
// 常常是张三 120、李四 80, 而且半数账号是共用的 (打磨喷漆、批量组…), 所以
// "谁做的"没法从账号推出来 —— 只能在这里落笔: 姓名 + 件数。
//
// 记完之后只有报工统计变: 那一条按件数拆到各人头上 (lib/pulse)。判定、完成
// 时间、板子上的 ✓ 一个字都不动。
//
// 留空 = 取消分工, 回到"全记给按 ✓ 的那个人"。

type Row = { name: string; qty: string }

export function SplitEditor({
  jobId,
  componentId,
  componentName,
  componentQty,
  stage,
  onClose,
}: {
  jobId: string
  componentId: string
  componentName: string
  componentQty: number
  stage: Stage
  onClose: () => void
}) {
  const [rows, setRows] = useState<Row[]>([{ name: '', qty: '' }])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let alive = true
    const url = `/api/work-split?jobId=${encodeURIComponent(jobId)}&componentId=${encodeURIComponent(componentId)}&stage=${encodeURIComponent(stage)}`
    fetch(withBase(url), { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { ok?: boolean; shares?: { name: string; qty: number }[] }) => {
        if (!alive) return
        const shares = d.ok && d.shares ? d.shares : []
        setRows(
          shares.length > 0
            ? shares.map((s) => ({ name: s.name, qty: String(s.qty) }))
            : [{ name: '', qty: '' }],
        )
        setLoading(false)
      })
      .catch(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [jobId, componentId, stage])

  const filled = rows.filter((r) => r.name.trim() && Number(r.qty) > 0)
  const sum =
    Math.round(filled.reduce((s, r) => s + Number(r.qty), 0) * 100) / 100

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r, j) => (i === j ? { ...r, ...patch } : r)))

  const save = () => {
    if (saving) return
    setError(null)
    setSaving(true)
    void (async () => {
      try {
        await mutate({
          kind: 'setWorkSplit',
          jobId,
          componentId,
          stage,
          shares: filled.map((r) => ({
            name: r.name.trim(),
            qty: Number(r.qty),
          })),
        })
        showToast(
          filled.length > 0 ? `分工已记下 · ${filled.length} 人` : '分工已取消',
          'success',
        )
        onClose()
      } catch (e) {
        setError(e instanceof Error ? e.message : '记不上')
        setSaving(false)
      }
    })()
  }

  const inp =
    'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${stage} · 分工`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[380px] max-w-[92vw] rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-surface)] p-6 shadow-xl"
      >
        <p className="label mb-1 text-[var(--color-ink-3)]">{stage} · 分工</p>
        <h3 className="mb-1 truncate text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
          {componentName}
        </h3>
        <p className="label mb-5 text-[var(--color-ink-3)]">
          共 {componentQty} 件
        </p>

        {loading ? (
          <p className="py-6 text-center text-[13px] text-[var(--color-ink-3)]">
            读取中…
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={r.name}
                  onChange={(e) => setRow(i, { name: e.target.value })}
                  placeholder="姓名"
                  className={`${inp} flex-1`}
                />
                <input
                  value={r.qty}
                  onChange={(e) => setRow(i, { qty: e.target.value })}
                  placeholder="件数"
                  inputMode="decimal"
                  onKeyDown={(e) => e.key === 'Enter' && save()}
                  className={`mono ${inp} w-[84px] text-right`}
                />
                <button
                  type="button"
                  onClick={() =>
                    setRows((prev) =>
                      prev.length > 1
                        ? prev.filter((_, j) => j !== i)
                        : [{ name: '', qty: '' }],
                    )
                  }
                  aria-label="去掉这一行"
                  className="w-5 shrink-0 text-[12px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setRows((prev) => [...prev, { name: '', qty: '' }])}
              className="self-start text-[12.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            >
              ＋ 再加一个人
            </button>
          </div>
        )}

        <p className="mt-4 text-[12px] text-[var(--color-ink-3)]">
          {filled.length === 0
            ? '空着保存 = 不分工，全记给报工的人。'
            : `合计 ${sum} 件${
                sum !== componentQty ? ` · 和总数 ${componentQty} 对不上` : ''
              }`}
        </p>
        {error && (
          <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>
        )}

        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-[2px] border border-[var(--color-border)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-ink-2)] hover:bg-[#f1eee4] disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || loading}
            className="rounded-[2px] bg-[var(--color-ink)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-surface)] hover:opacity-80 disabled:opacity-40"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
