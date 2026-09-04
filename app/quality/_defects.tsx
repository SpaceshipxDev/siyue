'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { EditableTextArea } from '@/app/_editable'
import type { DefectRow } from '@/lib/db'

// 质量异常 — 全厂判成 重做 / 返修 / 外修 的零件, 检验 (过程检) 和 质量 (出货
// 前的成品检) 两道一起。厂里自己检出来的那一半。
//
// 一条都不是在这里录的: 检验员按下判定、写下不良原因的那一刻就记在零件上了,
// 这页只是把它们从几百张工单里收拢起来。所以它永远和车间看到的一致, 也没有
// 第二个地方要维护。
//
// 只有最后一列是在这里写的: 纠正预防措施。"以后怎么不再犯"不是检验员在工位
// 上按得出来的, 是事后开会定的 —— 判定还是判定, 措施单独存 (lib/defect-
// actions)。还没定的那一格谁都填得上, 改已经写下的是工程和商务于海伟那一档。
// 所以顶上还数着"待定措施": 记下来只是账, 措施定下来才算闭环。
//
// 按月看, 因为质量是按月复盘的; 上面几个数回答"这个月坏了多少、坏在哪一道、
// 还有几条没定措施"。导出的就是屏幕上这一批。

const MONTHS = [
  '01', '02', '03', '04', '05', '06',
  '07', '08', '09', '10', '11', '12',
]

export function DefectsBoard({
  rows,
  actions,
  todayStr,
  canEdit,
}: {
  rows: DefectRow[]
  /** 纠正预防措施 — 按 零件::环节 挂回那条异常上。 */
  actions: Record<string, string>
  todayStr: string
  /** 改已经写下的措施 — 工程 + 商务于海伟。还空着的, 有账号就填得上。 */
  canEdit: boolean
}) {
  const router = useRouter()
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
          : [
              r.jobNo,
              r.customer,
              r.partName,
              r.reason,
              r.owner,
              r.by,
              actions[`${r.partId}::${r.stage}`],
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(needle),
      )
  }, [rows, actions, year, month, q])

  const stats = useMemo(() => {
    let check = 0
    let quality = 0
    let open = 0
    const kinds = new Map<string, number>()
    for (const r of monthRows) {
      if (r.stage === '质量') quality += 1
      else check += 1
      if (!actions[`${r.partId}::${r.stage}`]) open += 1
      kinds.set(r.verdict, (kinds.get(r.verdict) ?? 0) + 1)
    }
    return { check, quality, open, kinds: [...kinds.entries()] }
  }, [monthRows, actions])

  async function saveAction(r: DefectRow, v: string) {
    await mutate({
      kind: 'setDefectAction',
      partId: r.partId,
      stage: r.stage,
      action: v,
    })
    router.refresh()
  }

  const exportHref = `/quality/export?m=${year}-${month}${
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
            {Number(month)}月异常
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
        <div>
          <p
            className={`text-[18px] font-semibold leading-none tracking-tight tabular-nums ${
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
            placeholder="搜索 · 工号 / 零件 / 原因 / 措施"
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
        <div className="hidden grid-cols-[68px_84px_minmax(0,0.9fr)_56px_52px_minmax(0,1.1fr)_64px_minmax(0,1.2fr)_60px] items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid">
          <span className="label">日期</span>
          <span className="label">工号</span>
          <span className="label">零件</span>
          <span className="label">环节</span>
          <span className="label">判定</span>
          <span className="label">不良原因</span>
          <span className="label">责任人</span>
          <span className="label">纠正预防措施</span>
          <span className="label text-right">判定人</span>
        </div>

        {monthRows.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {q ? '没有匹配的记录' : '这个月没有质量异常'}
          </p>
        ) : (
          monthRows.map((r, i) => (
            <div
              key={`${r.partId}-${r.stage}-${i}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-b border-[var(--color-border)] px-4 py-2.5 last:border-b-0 hover:bg-[#faf8f2] md:grid-cols-[68px_84px_minmax(0,0.9fr)_56px_52px_minmax(0,1.1fr)_64px_minmax(0,1.2fr)_60px] md:px-5"
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
              <span className="break-words text-[13.5px] font-medium tracking-tight text-[var(--color-ink)]">
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
              <span className="hidden break-words text-[12.5px] text-[var(--color-ink-2)] md:block">
                {r.reason || '—'}
              </span>
              <span className="hidden break-words text-[12.5px] text-[var(--color-ink-2)] md:block">
                {r.owner || '—'}
              </span>
              <span className="hidden md:block">
                {canEdit || !actions[`${r.partId}::${r.stage}`] ? (
                  <EditableTextArea
                    value={actions[`${r.partId}::${r.stage}`]}
                    placeholder="待定措施…"
                    className="text-[12.5px] text-[var(--color-ink-2)]"
                    onSave={(v) => saveAction(r, v)}
                  />
                ) : (
                  <span className="block break-words text-[12.5px] text-[var(--color-ink-2)]">
                    {actions[`${r.partId}::${r.stage}`]}
                  </span>
                )}
              </span>
              <span className="hidden break-words text-right text-[12px] text-[var(--color-ink-3)] md:block">
                {r.by || '—'}
              </span>
            </div>
          ))
        )}
      </div>

      <p className="mt-4 text-[12px] text-[var(--color-ink-3)]">
        判定和不良原因是检验员在工单上按下去的那一刻记的，这里只是汇总——改要回
        零件上改。「成品检」是出货前的质量那一道。纠正预防措施是在这里填的，还
        空着的点一下就能写；写过的要改，找工程或于海伟。
      </p>
    </div>
  )
}
