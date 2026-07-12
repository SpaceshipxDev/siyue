'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import type { ComponentBoardRow, BoardStageChip } from '@/lib/packets'

// The PMC's board — every live component as one row, read left to right the
// way a part physically flows: 编程 → CNC OPs → 后处理 → 出货. The 进度
// column answers her one question ("这个单子现在在哪、做了多少、谁在做")
// without walking the floor.

function mdCn(ymd?: string): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return ymd ?? '—'
  const [, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return `${m}/${d}`
}

function relTime(iso?: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000))
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins}分钟前`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}小时前`
  return `${Math.floor(hrs / 24)}天前`
}

function dueTone(ymd: string | undefined, shipped: boolean): string {
  if (shipped || !ymd) return 'text-[var(--color-ink-2)]'
  const today = new Date()
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  if (ymd < iso) return 'text-[var(--color-overdue)] font-semibold'
  if (ymd === iso) return 'text-[var(--color-warning)] font-semibold'
  return 'text-[var(--color-ink)]'
}

function Chip({ chip, qty }: { chip: BoardStageChip; qty: number }) {
  if (chip.status === 'done') {
    return (
      <span
        title={chip.by ? `${chip.label} · ${chip.by}` : chip.label}
        className="inline-flex items-center gap-1 h-6 px-2 rounded-[3px] text-[11px] font-medium bg-[var(--color-success-soft)] text-[var(--color-success)] border border-[var(--color-success)]"
      >
        {chip.label} ✓
      </span>
    )
  }
  if (chip.status === 'in_progress') {
    return (
      <span
        title={chip.by ? `${chip.label} · ${chip.by}` : chip.label}
        className="inline-flex items-center gap-1 h-6 px-2 rounded-[3px] text-[11px] font-semibold bg-[color-mix(in_srgb,var(--color-warning)_14%,transparent)] text-[var(--color-warning)] border border-[var(--color-warning)]"
      >
        {chip.label} {chip.doneQty}/{qty}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center h-6 px-2 rounded-[3px] text-[11px] text-[var(--color-ink-3)] border border-[var(--color-border)]">
      {chip.label}
    </span>
  )
}

type Seg = 'active' | 'shipped' | 'all'

export function ComponentSheet({ rows }: { rows: ComponentBoardRow[] }) {
  const [q, setQ] = useState('')
  const [seg, setSeg] = useState<Seg>('active')
  const [customer, setCustomer] = useState('')

  const customers = useMemo(
    () => [...new Set(rows.map((r) => r.customer).filter(Boolean))].sort(),
    [rows],
  )

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (seg === 'active' && r.shipped) return false
      if (seg === 'shipped' && !r.shipped) return false
      if (customer && r.customer !== customer) return false
      if (!needle) return true
      return [r.partNo, r.drawingNo, r.name, r.customer, r.jobNo]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle))
    })
  }, [rows, q, seg, customer])

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜 货号 / 图纸号 / 名称 / 客户"
          className="h-9 px-3 w-64 max-w-full text-[13px] border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] outline-none focus:border-[var(--color-ink)]"
        />
        <select
          value={customer}
          onChange={(e) => setCustomer(e.target.value)}
          className="h-9 px-2 text-[13px] border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)]"
        >
          <option value="">全部客户</option>
          {customers.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <div className="flex border border-[var(--color-border-strong)] rounded-[3px] overflow-hidden">
          {(
            [
              ['active', '在产'],
              ['shipped', '已出货'],
              ['all', '全部'],
            ] as [Seg, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSeg(key)}
              className={`h-9 px-3 text-[12px] font-medium ${
                seg === key
                  ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
                  : 'bg-[var(--color-surface)] text-[var(--color-ink-2)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-[12px] text-[var(--color-ink-3)] ml-auto">
          {filtered.length} 个零件
        </span>
      </div>

      <div className="overflow-x-auto border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)]">
        <table className="w-full min-w-[1080px] border-collapse">
          <thead>
            <tr className="border-b border-[var(--color-border-strong)] text-left">
              {['客户', '货号', '描述', '图纸号', '数量', '交期', '工序', '最近报工'].map(
                (h) => (
                  <th
                    key={h}
                    className="px-3 py-2.5 text-[11px] font-semibold tracking-[0.08em] text-[var(--color-ink-3)] whitespace-nowrap"
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={r.partId}
                className="border-b border-[var(--color-border)] last:border-b-0 hover:bg-[var(--color-bg)]"
              >
                <td className="px-3 py-2.5 text-[12px] text-[var(--color-ink-2)] whitespace-nowrap">
                  {r.customer || '—'}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <Link
                    href={`/jobs/${r.jobId}`}
                    className="font-mono text-[12px] font-semibold text-[var(--color-ink)] underline-offset-2 hover:underline"
                  >
                    {r.partNo || r.jobNo}
                  </Link>
                </td>
                <td className="px-3 py-2.5 text-[13px] font-medium whitespace-nowrap">
                  <Link href={`/jobs/${r.jobId}`} className="hover:underline underline-offset-2">
                    {r.name}
                  </Link>
                </td>
                <td className="px-3 py-2.5 font-mono text-[11px] text-[var(--color-ink-2)] max-w-[220px] truncate">
                  {r.drawingNo || '—'}
                </td>
                <td className="px-3 py-2.5 text-[13px] font-semibold font-mono">{r.qty}</td>
                <td className={`px-3 py-2.5 text-[12px] font-mono whitespace-nowrap ${dueTone(r.dueDate, r.shipped)}`}>
                  {mdCn(r.dueDate)}
                </td>
                <td className="px-3 py-2.5">
                  {/* The whole route in one read: 编程 → OPs → 后处理 → 出货.
                      Exactly the stages this part carries, nothing else. */}
                  <div className="flex items-center gap-1.5 flex-nowrap">
                    <span
                      title={r.programmedBy ? `编程 · ${r.programmedBy}` : '等编程拍照录入'}
                      className={`inline-flex items-center h-6 px-2 rounded-[3px] text-[11px] font-medium border ${
                        r.programmed
                          ? 'bg-[var(--color-success-soft)] text-[var(--color-success)] border-[var(--color-success)]'
                          : 'text-[var(--color-ink-3)] border-[var(--color-border)]'
                      }`}
                    >
                      编程{r.programmed ? ' ✓' : ''}
                    </span>
                    {r.ops.map((c) => (
                      <Chip key={c.stage} chip={c} qty={r.qty} />
                    ))}
                    {r.post ? <Chip chip={{ ...r.post, label: '后处理' }} qty={r.qty} /> : null}
                    {r.shipped ? (
                      <span className="inline-flex items-center h-6 px-2 rounded-[3px] text-[11px] font-medium bg-[var(--color-success-soft)] text-[var(--color-success)] border border-[var(--color-success)]">
                        出货 ✓
                      </span>
                    ) : r.ship && r.ship.doneQty > 0 ? (
                      <span className="inline-flex items-center h-6 px-2 rounded-[3px] text-[11px] font-semibold text-[var(--color-warning)] border border-[var(--color-warning)]">
                        出货 {r.ship.doneQty}/{r.qty}
                      </span>
                    ) : (
                      <span className="inline-flex items-center h-6 px-2 rounded-[3px] text-[11px] text-[var(--color-ink-3)] border border-[var(--color-border)]">
                        出货
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-[11px] text-[var(--color-ink-2)] whitespace-nowrap">
                  {r.lastReport ? (
                    <>
                      <span className="font-medium text-[var(--color-ink)]">
                        {r.lastReport.actor}
                      </span>{' '}
                      {r.lastReport.stage} +{r.lastReport.qty} ·{' '}
                      {relTime(r.lastReport.at)}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-[13px] text-[var(--color-ink-3)]">
                  没有匹配的零件 — 编程拍照录入后会自动出现在这里
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}
