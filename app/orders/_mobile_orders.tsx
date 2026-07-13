'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import type { ComponentBoardRow } from '@/lib/packets'

type Filter = 'active' | 'done'

function dateLabel(value?: string) {
  if (!value) return '无交期'
  const [, month, day] = value.slice(0, 10).split('-')
  return `${Number(month)}月${Number(day)}日`
}

export function MobileOrders({ rows }: { rows: ComponentBoardRow[] }) {
  const [filter, setFilter] = useState<Filter>('active')
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((row) => {
      if (filter === 'active' ? row.shipped : !row.shipped) return false
      if (!q) return true
      return [row.name, row.partNo, row.drawingNo, row.jobNo]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q))
    })
  }, [filter, query, rows])

  return (
    <div className="mx-auto max-w-md px-4 py-4">
      <div className="grid grid-cols-2 rounded-[6px] bg-[var(--color-muted-bg)] p-1">
        {([['active', '进行中'], ['done', '已完成']] as const).map(([key, label]) => (
          <button key={key} type="button" onClick={() => setFilter(key)}
            className={`h-10 rounded-[4px] text-[13px] font-semibold ${filter === key ? 'bg-[var(--color-surface)] shadow-sm' : 'text-[var(--color-ink-3)]'}`}>
            {label}
          </button>
        ))}
      </div>
      <input value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索货号、图纸号或名称"
        className="mt-3 h-12 w-full rounded-[6px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 text-[16px] outline-none focus:border-[var(--color-ink)]" />

      <div className="mt-3 space-y-2">
        {filtered.map((row) => (
          <Link key={row.partId} href={`/jobs/${row.jobId}`}
            className="block rounded-[6px] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 active:bg-[var(--color-muted-bg)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[16px] font-semibold">{row.name || row.partNo || row.jobNo}</p>
                <p className="mt-1 truncate font-mono text-[11px] text-[var(--color-ink-3)]">{row.partNo || row.drawingNo || row.jobNo}</p>
              </div>
              <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${row.shipped ? 'bg-[var(--color-success-soft)] text-[var(--color-success)]' : 'bg-[var(--color-warning-soft)] text-[var(--color-warning)]'}`}>
                {row.shipped ? '已完成' : row.current?.label || '待处理'}
              </span>
            </div>
            <div className="mt-3 flex items-center justify-between text-[12px] text-[var(--color-ink-2)]">
              <span><b className="font-mono text-[var(--color-ink)]">{row.qty}</b> 件</span>
              <span>交期 {dateLabel(row.dueDate)}</span>
            </div>
          </Link>
        ))}
        {filtered.length === 0 ? (
          <div className="py-16 text-center text-[13px] text-[var(--color-ink-3)]">
            {query ? '没有找到工单' : filter === 'active' ? '暂无进行中的工单' : '暂无已完成的工单'}
          </div>
        ) : null}
      </div>
    </div>
  )
}
