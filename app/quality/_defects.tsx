'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { EditableTextArea } from '@/app/_editable'
import type { DefectRow } from '@/lib/db'
import { DefectDetail } from './_defect_detail'
import {
  DEFECT_COLS,
  DEFECT_COL_LABEL,
  defectCell,
  defectFilterParams,
  matchDefectFilters,
  type DefectCol,
  type DefectFilters,
} from '@/lib/defect-filter'

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
//
// 点一行打开这一条的详情 —— 全部信息加上判不良时拍的照片, 照片点开看大图。
//
// 检验时选了「外协」的不良不在这张表里: 那是供应商做坏的, 在「来料异常」。
//
// 表头每一列都能筛 (于海伟 2026-11-02, 原来是搜索框旁边三个下拉): 点列名旁
// 边的小箭头, 列出这个月这一列出现过的值和条数, 选一个只看那些; 几列叠着筛,
// 跟 Excel 一样 (lib/defect-filter)。导出跟着走。

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
  const [detail, setDetail] = useState<DefectRow | null>(null)
  // 表头筛选 —— 哪一列选了哪个值; 没有 = 全部。
  const [filters, setFilters] = useState<DefectFilters>({})

  // 这个月的 (不管下拉选了什么) —— 下拉里的选项从这里数。
  const inMonth = useMemo(() => {
    const ym = `${year}-${month}`
    return rows.filter((r) => (r.at ?? '').slice(0, 7) === ym)
  }, [rows, year, month])
  // 一列的选项: 按别的列已经筛过的那一批数 (跟 Excel 一样), 多的排前面。
  const optionsOf = (col: DefectCol): [string, number][] => {
    const m = new Map<string, number>()
    for (const r of inMonth) {
      if (!matchDefectFilters(r, filters, actions, col)) continue
      const v = defectCell(r, col, actions)
      m.set(v, (m.get(v) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) =>
      col === 'date' ? b[0].localeCompare(a[0]) : b[1] - a[1] || a[0].localeCompare(b[0], 'zh'),
    )
  }

  const monthRows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return inMonth
      .filter((r) => matchDefectFilters(r, filters, actions))
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
  }, [inMonth, actions, q, filters])

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
  }${defectFilterParams(filters)}`
  const filtered = DEFECT_COLS.some((c) => filters[c])
  const setCol = (col: DefectCol, v: string) =>
    setFilters((cur) => {
      const next = { ...cur }
      if (v) next[col] = v
      else delete next[col]
      return next
    })

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
        <div className="ml-auto flex flex-wrap items-center gap-2.5">
          {filtered && (
            <button
              type="button"
              onClick={() => setFilters({})}
              className="text-[12.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            >
              清除筛选
            </button>
          )}
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
            onClick={() => {
              // 换个月, 表头的选项跟着变 —— 选过的清掉, 免得筛成空的。
              setMonth(m)
              setFilters({})
            }}
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
        <div className="hidden grid-cols-[68px_108px_minmax(0,0.9fr)_56px_52px_minmax(0,1.1fr)_64px_minmax(0,1.2fr)_60px] items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid">
          {DEFECT_COLS.map((col) => (
            <ColHead
              key={col}
              col={col}
              value={filters[col]}
              options={optionsOf(col)}
              onPick={(v) => setCol(col, v)}
              right={col === 'by'}
            />
          ))}
        </div>

        {monthRows.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {q || filtered ? '没有匹配的记录' : '这个月没有质量异常'}
          </p>
        ) : (
          monthRows.map((r, i) => (
            <div
              key={`${r.partId}-${r.stage}-${i}`}
              role="button"
              tabIndex={0}
              onClick={() => setDetail(r)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setDetail(r)
              }}
              title="点开看不良照片和详情"
              className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-b border-[var(--color-border)] px-4 py-2.5 last:border-b-0 hover:bg-[#faf8f2] md:grid-cols-[68px_108px_minmax(0,0.9fr)_56px_52px_minmax(0,1.1fr)_64px_minmax(0,1.2fr)_60px] md:px-5"
            >
              <span className="mono hidden text-[12.5px] tabular-nums text-[var(--color-ink-2)] md:block">
                {(r.at ?? '').slice(5, 10) || '—'}
              </span>
              <Link
                href={`/jobs/${r.jobId}`}
                onClick={(e) => e.stopPropagation()}
                className="mono hidden truncate text-[12.5px] text-[var(--color-info)] hover:underline md:block"
              >
                {r.jobNo || '—'}
              </Link>
              <span className="break-words text-[13.5px] font-medium tracking-tight text-[var(--color-ink)]">
                {r.partName || '—'}
                {r.photos.length > 0 && (
                  <span className="ml-1.5 text-[11px] font-normal text-[var(--color-ink-4)]">
                    · 图{r.photos.length}
                  </span>
                )}
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
              <span className="hidden md:block" onClick={(e) => e.stopPropagation()}>
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

      {detail && (
        <DefectDetail
          title={detail.partName || '—'}
          subtitle={`${detail.jobNo}${detail.customer ? ` · ${detail.customer}` : ''}`}
          fields={[
            ['环节', detail.stage === '质量' ? '成品检' : '检验'],
            ['判定', detail.verdict],
            ['判定时间', detail.at ? `${detail.at.slice(0, 10)} ${detail.at.slice(11, 16)}` : undefined],
            ['判定人', detail.by],
            ['不良原因', detail.reason],
            ['责任人', detail.owner],
            ['纠正预防', actions[`${detail.partId}::${detail.stage}`]],
          ]}
          photos={detail.photos}
          jobHref={`/jobs/${detail.jobId}`}
          onClose={() => setDetail(null)}
        />
      )}

      <p className="mt-4 text-[12px] text-[var(--color-ink-3)]">
        点一行看不良照片和详情。判定和不良原因是检验员在工单上按下去的那一刻记的，这里只是汇总——改要回
        零件上改。检验时选了「外协」的不良不在这里，在「来料异常」。「成品检」是出货前的质量那一道。纠正预防措施是在这里填的，还
        空着的点一下就能写；写过的要改，找工程或于海伟。
      </p>
    </div>
  )
}

// 表头一格 —— 列名 + 小箭头; 点开列出这一列的值 (后面带条数), 点一个筛, 点
// 「全部」不筛。选了的列名变黑、下面一道蓝线。菜单用 fixed 摆, 不被表格裁掉。
function ColHead({
  col,
  value,
  options,
  onPick,
  right,
}: {
  col: DefectCol
  value?: string
  options: [string, number][]
  onPick: (v: string) => void
  right?: boolean
}) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!at) return
    const close = (e: Event) => {
      if (e.type === 'mousedown' && box.current?.contains(e.target as Node)) return
      if (e.type === 'mousedown' && btn.current?.contains(e.target as Node)) return
      setAt(null)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setAt(null)
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [at])
  const active = !!value
  return (
    <span className={`relative flex items-center gap-1 ${right ? 'justify-end' : ''}`}>
      <span className={`label ${active ? 'text-[var(--color-ink)]' : ''}`}>{DEFECT_COL_LABEL[col]}</span>
      <button
        ref={btn}
        type="button"
        onClick={() => {
          if (at) return setAt(null)
          const r = btn.current?.getBoundingClientRect()
          if (r) setAt({ left: Math.min(r.left, window.innerWidth - 240), top: r.bottom + 6 })
        }}
        aria-label={`按${DEFECT_COL_LABEL[col]}筛选`}
        className={`inline-flex h-4 w-4 items-center justify-center rounded-[2px] text-[10px] ${
          active ? 'text-[var(--color-info)]' : 'text-[var(--color-ink-4)] hover:text-[var(--color-ink-2)]'
        }`}
      >
        {active ? '●' : '▾'}
      </button>
      {active && (
        <span className="pointer-events-none absolute -bottom-[7px] left-0 right-0 h-[2px] rounded-[2px] bg-[var(--color-info)]" />
      )}
      {at && (
        <div
          ref={box}
          style={{ left: at.left, top: at.top }}
          className="fixed z-50 max-h-[320px] w-[230px] overflow-y-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] py-1 text-left shadow-[0_10px_34px_-12px_rgba(20,19,15,0.28)]"
        >
          {[['', options.reduce((n, [, c]) => n + c, 0)] as [string, number], ...options].map(([v, n]) => (
            <button
              key={v || '__all'}
              type="button"
              onClick={() => {
                onPick(v)
                setAt(null)
              }}
              className={`flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left text-[12.5px] hover:bg-[#f5f3ed] ${
                (value ?? '') === v ? 'font-semibold text-[var(--color-ink)]' : 'text-[var(--color-ink-2)]'
              }`}
            >
              <span className="min-w-0 truncate">{v || '全部'}</span>
              <span className="mono shrink-0 text-[11.5px] text-[var(--color-ink-4)]">{n}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
