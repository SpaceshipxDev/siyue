'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import type { DefectRow } from '@/lib/db'

// 不良记录 — 全厂判成 重做 / 返修 / 外修 的零件, 检验 (过程检) 和 质量 (出货
// 前的成品检) 两道一起。
//
// 一条都不是在这里录的: 检验员按下判定、写下不良原因的那一刻就记在零件上了,
// 这页只是把它们从几百张工单里收拢起来。所以它永远和车间看到的一致, 也没有
// 第二个地方要维护。
//
// 按月看, 因为质量是按月复盘的; 上面四个数回答"这个月坏了多少、坏在哪一道"。
// 导出的就是屏幕上这一批。

const MONTHS = [
  '01', '02', '03', '04', '05', '06',
  '07', '08', '09', '10', '11', '12',
]

export function DefectsBoard({
  rows,
  todayStr,
}: {
  rows: DefectRow[]
  todayStr: string
}) {
  const year = todayStr.slice(0, 4)
  const [month, setMonth] = useState<string>(todayStr.slice(5, 7))
  const [q, setQ] = useState('')

  const monthRows = useMemo(() => {
    const ym = `${year}-${month}`
    const needle = q.trim().toLowerCase()
    return rows
      .filter((r) => (r.at ?? '').slice(0, 7) === ym)
      .filter((r) =>
        !needle
          ? true
          : [r.jobNo, r.customer, r.partName, r.reason, r.owner, r.by]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(needle),
      )
  }, [rows, year, month, q])

  const stats = useMemo(() => {
    let check = 0
    let quality = 0
    const kinds = new Map<string, number>()
    for (const r of monthRows) {
      if (r.stage === '质量') quality += 1
      else check += 1
      kinds.set(r.verdict, (kinds.get(r.verdict) ?? 0) + 1)
    }
    return { check, quality, kinds: [...kinds.entries()] }
  }, [monthRows])

  const exportHref = `/report/defects/export?m=${year}-${month}${
    q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''
  }`

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <p className="text-[32px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">
            {monthRows.length}
          </p>
          <p className="label mt-2.5">
            {Number(month)}月不良
          </p>
          <p className="mt-1 text-[12px] tabular-nums text-[var(--color-ink-3)]">
            检验 {stats.check} · 成品检 {stats.quality}
          </p>
        </div>
        {stats.kinds.map(([k, n]) => (
          <div key={k}>
            <p className="text-[18px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-overdue)]">
              {n}
            </p>
            <p className="label mt-2.5">{k}</p>
          </div>
        ))}
        <div className="ml-auto flex items-center gap-2.5">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索 · 工号 / 零件 / 原因 / 责任人"
            className="h-9 w-[210px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
          />
          <Link
            href={exportHref}
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
        <div className="hidden grid-cols-[80px_92px_minmax(0,1fr)_64px_56px_minmax(0,1.3fr)_80px_72px] items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid">
          <span className="label">日期</span>
          <span className="label">工号</span>
          <span className="label">零件</span>
          <span className="label">环节</span>
          <span className="label">判定</span>
          <span className="label">不良原因</span>
          <span className="label">责任人</span>
          <span className="label text-right">判定人</span>
        </div>

        {monthRows.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {q ? '没有匹配的记录' : '这个月没有不良记录'}
          </p>
        ) : (
          monthRows.map((r, i) => (
            <div
              key={`${r.partId}-${r.stage}-${i}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-[var(--color-border)] px-4 py-2.5 last:border-b-0 hover:bg-[#faf8f2] md:grid-cols-[80px_92px_minmax(0,1fr)_64px_56px_minmax(0,1.3fr)_80px_72px] md:px-5"
            >
              <span className="mono hidden text-[12.5px] tabular-nums text-[var(--color-ink-2)] md:block">
                {(r.at ?? '').slice(5, 10) || '—'}
              </span>
              <Link
                href={`/jobs/${r.jobId}`}
                className="mono hidden truncate text-[12.5px] text-[var(--color-info)] hover:underline md:block"
              >
                {r.jobNo || '—'}
              </Link>
              <span className="truncate text-[13.5px] font-medium tracking-tight text-[var(--color-ink)]">
                {r.partName || '—'}
                <span className="mono ml-2 text-[11.5px] font-normal text-[var(--color-ink-4)] md:hidden">
                  {r.jobNo}
                </span>
              </span>
              <span className="mono hidden text-[12px] text-[var(--color-ink-3)] md:block">
                {r.stage === '质量' ? '成品检' : '检验'}
              </span>
              <span className="shrink-0 text-[12.5px] font-medium text-[var(--color-overdue)]">
                {r.verdict}
              </span>
              <span className="hidden truncate text-[12.5px] text-[var(--color-ink-2)] md:block">
                {r.reason || '—'}
              </span>
              <span className="hidden truncate text-[12.5px] text-[var(--color-ink-2)] md:block">
                {r.owner || '—'}
              </span>
              <span className="hidden truncate text-right text-[12px] text-[var(--color-ink-3)] md:block">
                {r.by || '—'}
              </span>
            </div>
          ))
        )}
      </div>

      <p className="mt-4 text-[12px] text-[var(--color-ink-3)]">
        判定和不良原因是检验员在工单上按下去的那一刻记的，这里只是汇总——改要回
        零件上改。「成品检」是出货前的质量那一道。
      </p>
    </div>
  )
}
