'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { STAGES, type Stage } from '@/lib/data'

// 制程返工单 (于海伟 2026-10-27) —— 厂里自己做坏了要返工的那几件, 开成一张单
// 独的工单。只为车间报工和个人产值: 每件按「返工报工单价」算经手金额; 不带
// 金额、不走出货, 不进对账和财务 (lib/rework-job)。
//
//   原工单上: 「制程返工」按钮 → 勾零件、填件数、点要重做的工序、填单价 → 开单
//   返工单上: 一条说明 + 每个零件的返工报工单价, 能改

// 返工能重做的工序 —— 出货不算 (返工单不发货), 工程 / 采购不是车间的活。
const REWORK_STAGES: Stage[] = STAGES.filter((s) => !['工程', '采购', '出货'].includes(s))

type Part = { id: string; name: string; qty: number; stages: Stage[] }

function num(s: string): number | undefined {
  const t = s.trim().replace(/[¥,，元\s]/g, '')
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

export function OpenReworkButton({
  jobId,
  jobNo,
  dueDate,
  parts,
}: {
  jobId: string
  jobNo: string
  dueDate: string
  parts: Part[]
}) {
  const [open, setOpen] = useState(false)
  // 从看板「制程返工」那一栏选了这张单过来的 (?rework=1) —— 直接打开。
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('rework') === '1') setOpen(true)
  }, [])
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-[12px] tracking-wider border border-[var(--color-border-strong)] text-[var(--color-ink-2)] rounded-[2px] hover:bg-[#f1eee4] hover:text-[var(--color-ink)] transition-colors"
      >
        制程返工
      </button>
      {open && (
        <ReworkComposer
          jobId={jobId}
          jobNo={jobNo}
          dueDate={dueDate}
          parts={parts}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

type Draft = { on: boolean; qty: string; stages: Stage[]; rate: string }

function ReworkComposer({
  jobId,
  jobNo,
  dueDate,
  parts,
  onClose,
}: {
  jobId: string
  jobNo: string
  dueDate: string
  parts: Part[]
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [due, setDue] = useState(dueDate)
  const [note, setNote] = useState('')
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(parts.map((p) => [p.id, { on: false, qty: String(p.qty), stages: [], rate: '' }])),
  )
  const patch = (id: string, d: Partial<Draft>) =>
    setDrafts((cur) => ({ ...cur, [id]: { ...cur[id], ...d } }))
  const picked = parts.filter((p) => drafts[p.id].on)

  function submit() {
    if (picked.length === 0) return setError('先勾要返工的零件')
    for (const p of picked) {
      const d = drafts[p.id]
      if (!(num(d.qty)! > 0)) return setError(`「${p.name}」返工件数要填一个正数`)
      if (d.stages.length === 0) return setError(`「${p.name}」至少点一道要返工的工序`)
      if (d.rate.trim() && num(d.rate) === undefined) return setError(`「${p.name}」单价要填数字`)
    }
    setError(null)
    start(async () => {
      try {
        const r = await mutate<{ id: string; jobNo: string }>({
          kind: 'createReworkJob',
          sourceJobId: jobId,
          dueDate: due,
          note,
          parts: picked.map((p) => ({
            componentId: p.id,
            qty: num(drafts[p.id].qty),
            stages: drafts[p.id].stages,
            rate: num(drafts[p.id].rate),
          })),
        })
        showToast(`已开制程返工单 ${r.data.jobNo}`, 'success')
        router.push(`/jobs/${r.data.id}`)
      } catch (e) {
        setError(e instanceof Error ? e.message : '开不出来')
      }
    })
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`制程返工 · ${jobNo}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !pending && onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-[720px] flex-col rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-xl"
      >
        <header className="border-b border-[var(--color-border)] px-6 py-5">
          <p className="label mb-1 text-[var(--color-ink-3)]">制程返工 · {jobNo}</p>
          <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-ink)]">
            选择返工零件
          </h2>
          <p className="mt-1 text-[12px] text-[var(--color-ink-3)]">
            开出来是一张单独的工单，车间照常报工，个人产值按返工报工单价算；不带金额、不出货，不进对账和财务。
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
          {parts.map((p) => {
            const d = drafts[p.id]
            return (
              <div key={p.id} className="border-b border-[var(--color-border)] py-3 last:border-b-0">
                <label className="flex cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={d.on}
                    onChange={() =>
                      patch(p.id, {
                        on: !d.on,
                        // 第一次勾上, 先帮他点上原来走的那几道 (出货除外), 多的再点掉。
                        stages: !d.on && d.stages.length === 0
                          ? p.stages.filter((s) => REWORK_STAGES.includes(s))
                          : d.stages,
                      })
                    }
                    className="h-4 w-4 accent-[var(--color-ink)]"
                  />
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[var(--color-ink)]">
                    {p.name}
                  </span>
                  <span className="text-[12px] text-[var(--color-ink-3)]">原 {p.qty} 件</span>
                </label>
                {d.on && (
                  <div className="mt-2.5 space-y-2 pl-7">
                    <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-[var(--color-ink-2)]">
                      <label className="flex items-baseline gap-1.5">
                        返工
                        <input
                          value={d.qty}
                          onChange={(e) => patch(p.id, { qty: e.target.value })}
                          inputMode="decimal"
                          className="mono h-8 w-[64px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-right text-[13px] outline-none"
                        />
                        件
                      </label>
                      <label className="flex items-baseline gap-1.5">
                        返工报工单价 ¥
                        <input
                          value={d.rate}
                          onChange={(e) => patch(p.id, { rate: e.target.value })}
                          inputMode="decimal"
                          placeholder="每件"
                          className="mono h-8 w-[80px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-right text-[13px] outline-none"
                        />
                        / 件
                      </label>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {REWORK_STAGES.map((s) => {
                        const on = d.stages.includes(s)
                        return (
                          <button
                            key={s}
                            type="button"
                            onClick={() =>
                              patch(p.id, {
                                stages: on
                                  ? d.stages.filter((x) => x !== s)
                                  : STAGES.filter((x) => x === s || d.stages.includes(x)),
                              })
                            }
                            className={`rounded-[2px] border px-2.5 py-1 text-[12px] ${
                              on
                                ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-surface)]'
                                : 'border-[var(--color-border-strong)] text-[var(--color-ink-3)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]'
                            }`}
                          >
                            {s}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <footer className="flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] px-6 py-4">
          <label className="flex items-baseline gap-1.5 text-[12.5px] text-[var(--color-ink-2)]">
            交期
            <input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              className="mono h-8 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[12.5px] outline-none"
            />
          </label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="返工原因 · 可空"
            className="h-8 min-w-[160px] flex-1 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[12.5px] outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="text-[12.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="h-9 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
          >
            {pending ? '开单中…' : `开返工单${picked.length > 0 ? ` · ${picked.length} 个零件` : ''}`}
          </button>
          {error && <p className="w-full text-[12px] text-[var(--color-overdue)]">{error}</p>}
        </footer>
      </div>
    </div>
  )
}

// 返工单页头上那一条: 它是什么、从哪来, 每个零件的返工报工单价 (能改的人点着改)。
export function ReworkBanner({
  jobId,
  sourceJobId,
  sourceJobNo,
  parts,
  rates,
  canEdit,
}: {
  jobId: string
  sourceJobId?: string
  sourceJobNo?: string
  parts: { id: string; name: string; qty: number }[]
  /** componentId → 每件单价 */
  rates: Record<string, number>
  canEdit: boolean
}) {
  return (
    <div className="mb-6 rounded-[2px] border border-[var(--color-warning)] bg-[color-mix(in_srgb,var(--color-warning)_6%,transparent)] px-4 py-3">
      <p className="text-[13px] text-[var(--color-ink)]">
        <b className="font-semibold">制程返工单</b>
        {sourceJobNo && (
          <>
            {' '}
            · 来自{' '}
            {sourceJobId ? (
              <Link href={`/jobs/${sourceJobId}`} className="mono underline underline-offset-2">
                {sourceJobNo}
              </Link>
            ) : (
              <span className="mono">{sourceJobNo}</span>
            )}
          </>
        )}
        <span className="text-[var(--color-ink-3)]"> · 只算报工和个人产值，不进对账和财务</span>
      </p>
      <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1.5">
        {parts.map((p) => (
          <RateLine
            key={p.id}
            jobId={jobId}
            part={p}
            rate={rates[p.id]}
            canEdit={canEdit}
          />
        ))}
      </div>
    </div>
  )
}

function RateLine({
  jobId,
  part,
  rate,
  canEdit,
}: {
  jobId: string
  part: { id: string; name: string; qty: number }
  rate?: number
  canEdit: boolean
}) {
  const router = useRouter()
  const [v, setV] = useState(rate !== undefined ? String(rate) : '')
  const [pending, start] = useTransition()
  const save = () => {
    const n = num(v)
    if (n === undefined || n === rate) return
    start(async () => {
      try {
        await mutate({ kind: 'setReworkRate', jobId, componentId: part.id, rate: n })
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '存不上', 'warning')
      }
    })
  }
  return (
    <span className="flex items-baseline gap-1.5 text-[12.5px] text-[var(--color-ink-2)]">
      <span className="max-w-[160px] truncate text-[var(--color-ink)]">{part.name}</span>
      返工报工单价 ¥
      {canEdit ? (
        <input
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          disabled={pending}
          placeholder="未定"
          inputMode="decimal"
          className={`mono w-[64px] border-b bg-transparent text-right text-[13px] outline-none ${
            rate === undefined
              ? 'border-[var(--color-overdue)] placeholder:text-[var(--color-overdue)]'
              : 'border-[var(--color-border-strong)]'
          }`}
        />
      ) : (
        <span className="mono text-[var(--color-ink)]">{rate !== undefined ? rate : '未定'}</span>
      )}
      / 件 × {part.qty}
    </span>
  )
}

// 看板「制程返工」那一栏顶上的入口 —— 输工号挑原单, 到那张单上直接弹出选零件
// 的框 (于海伟 2026-10-27: 入口在工单页里, 看板上找不到)。
export function ReworkStarter({ jobs }: { jobs: { id: string; jobNo: string; product: string }[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const hits = useMemo(
    () =>
      needle
        ? jobs.filter((j) => j.jobNo.toLowerCase().includes(needle) || j.product.toLowerCase().includes(needle)).slice(0, 8)
        : [],
    [jobs, needle],
  )
  const go = (id: string) => router.push(`/jobs/${id}?rework=1`)
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-9 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85"
      >
        ＋ 开制程返工单
      </button>
    )
  return (
    <span className="relative inline-flex items-center gap-2">
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hits[0]) go(hits[0].id)
          if (e.key === 'Escape') setOpen(false)
        }}
        placeholder="输原单工号"
        className="mono h-9 w-[240px] rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-[13px] outline-none focus:border-[var(--color-ink)]"
      />
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-[12.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
      >
        取消
      </button>
      {hits.length > 0 && (
        <span className="absolute left-0 top-full z-30 mt-1 flex w-[360px] flex-col rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] py-1 shadow-[0_6px_20px_rgba(0,0,0,0.12)]">
          {hits.map((j) => (
            <button
              key={j.id}
              type="button"
              onClick={() => go(j.id)}
              className="flex items-baseline gap-3 px-3 py-1.5 text-left hover:bg-[#f5f3ed]"
            >
              <span className="mono text-[13px] text-[var(--color-ink)]">{j.jobNo}</span>
              <span className="truncate text-[12px] text-[var(--color-ink-3)]">{j.product}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  )
}
