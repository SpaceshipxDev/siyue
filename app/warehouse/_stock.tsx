'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import type { StockItem } from '@/lib/warehouse'

// 库存 — 仓库的正面。
//
// 这一页一个数都不用录: 每一行都是出入库记录加出来的 (入库合计 − 出库合计)。
// 所以它永远跟记录对得上, 也没有第二个地方要维护 —— 一个手填的库存, 从填错
// 的那天起就再也对不上, 而且没人知道是哪天开始错的。
//
// 入 / 出 两列摆在库存旁边, 不是凑数: 一个解释不清的库存数没人会信。负数不
// 藏 —— 那是"有人领了没记进货", 藏起来就永远不会有人去补。

export function StockBoard({ items }: { items: StockItem[] }) {
  const [q, setQ] = useState('')

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return items
    return items.filter((it) =>
      `${it.name} ${it.spec}`.toLowerCase().includes(needle),
    )
  }, [items, q])

  const negatives = useMemo(() => rows.filter((r) => r.qty < 0).length, [rows])

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <p className="text-[32px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">
            {rows.length}
          </p>
          <p className="label mt-2.5">物料种类</p>
        </div>
        {negatives > 0 && (
          <div>
            <p className="text-[22px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-overdue)]">
              {negatives}
            </p>
            <p className="label mt-2.5">库存为负</p>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2.5">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索 · 物料 / 规格"
            className="h-9 w-[210px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
          />
          <Link
            href="/warehouse/export"
            prefetch={false}
            className="rounded-[2px] border border-[var(--color-border)] px-3.5 py-2 text-[13px] font-medium text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)]"
          >
            导出
          </Link>
        </div>
      </div>

      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_88px_88px_96px_80px] items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid">
          <span className="label">物料名称</span>
          <span className="label">规格 / 型号</span>
          <span className="label text-right">累计入库</span>
          <span className="label text-right">累计出库</span>
          <span className="label text-right">库存数量</span>
          <span className="label text-right">最近变动</span>
        </div>

        {rows.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {q ? '没有匹配的物料' : '还没有出入库记录'}
          </p>
        ) : (
          rows.map((it) => (
            <Link
              key={`${it.name}|${it.spec}`}
              href={`/warehouse?v=log&q=${encodeURIComponent(it.name)}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-b border-[var(--color-border)] px-4 py-2.5 last:border-b-0 hover:bg-[#faf8f2] md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_88px_88px_96px_80px] md:px-5"
            >
              <span className="break-words text-[13.5px] font-medium tracking-tight text-[var(--color-ink)]">
                {it.name}
              </span>
              <span className="break-words text-[12.5px] text-[var(--color-ink-2)]">
                {it.spec || '—'}
              </span>
              <span className="mono hidden text-right text-[12.5px] tabular-nums text-[var(--color-ink-3)] md:block">
                {it.inQty}
              </span>
              <span className="mono hidden text-right text-[12.5px] tabular-nums text-[var(--color-ink-3)] md:block">
                {it.outQty}
              </span>
              <span
                className={`mono text-right text-[13.5px] font-semibold tabular-nums ${
                  it.qty < 0
                    ? 'text-[var(--color-overdue)]'
                    : 'text-[var(--color-ink)]'
                }`}
              >
                {it.qty}
              </span>
              <span className="mono hidden text-right text-[12px] tabular-nums text-[var(--color-ink-3)] md:block">
                {it.lastDate ? it.lastDate.slice(5) : '—'}
              </span>
            </Link>
          ))
        )}
      </div>

      <p className="mt-4 text-[12px] text-[var(--color-ink-3)]">
        库存是出入库记录加出来的，不用也不能手填——点任意一行看它的进出明细。
        红色的负数是「领了没记进货」，回记录里补一笔就正过来了。
      </p>
    </div>
  )
}
