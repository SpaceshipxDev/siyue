'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { formatCny, STAGES, type Stage } from '@/lib/data'
import { proxiedStorageUrl } from '@/lib/storage-url'

// 报工 — the whole page, client-driven. Switching station / period and
// expanding a person are all local + tiny fetches (no full-page navigation),
// so it feels instant. People (who affected this stage) is the hero; 停留超期
// sits quietly at the bottom; 导出报表 serializes the aggregate so a month
// export is always complete.

const NUM = new Intl.NumberFormat('zh-CN')
type Gran = 'day' | 'week' | 'month'

type Person = {
  actorName: string
  finishes: number
  starts: number
  pieces: number
  valueCny: number
  unpriced: number
  lastActiveTs?: string
}
type StuckPart = {
  partId: string
  partName: string
  partNo?: string
  jobId: string
  jobNo: string
  customer: string
  qty: number
  doneQty?: number
  daysHere: number
  imageUrl?: string
}
type DrillComponent = {
  ts: string
  stage: Stage
  partName: string
  qty: number
  valueCny: number
  unpriced: boolean
  imageUrl?: string
}
type DrillJob = {
  jobId: string
  jobNo: string
  customer: string
  finishes: number
  pieces: number
  valueCny: number
  components: DrillComponent[]
}

export function ReportClient({
  initialStage,
  initialGran,
  initialAnchor,
  todayStr,
  showMoney,
}: {
  initialStage: Stage | null
  initialGran: Gran
  initialAnchor: string
  todayStr: string
  showMoney: boolean
}) {
  const [stage, setStage] = useState<Stage | null>(initialStage)
  const [gran, setGran] = useState<Gran>(initialGran)
  const [anchor, setAnchor] = useState<string>(initialAnchor)

  const { from, to } = rangeOf(anchor, gran)

  const [people, setPeople] = useState<Person[]>([])
  const [stuck, setStuck] = useState<StuckPart[]>([])
  const [stuckDays, setStuckDays] = useState(5)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Per-worker drill cache, cleared whenever the window/station changes.
  const [open, setOpen] = useState<string | null>(null)
  const [drills, setDrills] = useState<Record<string, DrillJob[]>>({})
  const drillReq = useRef(0)

  // Keep the URL in sync (shareable / refresh-stable) without a navigation.
  useEffect(() => {
    const q = new URLSearchParams()
    if (stage) q.set('stage', stage)
    if (gran !== 'day') q.set('g', gran)
    if (anchor !== todayStr) q.set('d', anchor)
    const s = q.toString()
    window.history.replaceState(null, '', s ? `/report?${s}` : '/report')
  }, [stage, gran, anchor, todayStr])

  // Fetch the summary whenever station / period changes. Stale responses are
  // dropped so fast clicking never flashes the wrong data.
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    setOpen(null)
    setDrills({})
    const q = new URLSearchParams({ from, to })
    if (stage) q.set('stage', stage)
    fetch(`/api/report?${q.toString()}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return
        if (!d.ok) throw new Error(d.error || '加载失败')
        setPeople(d.people ?? [])
        setStuck(d.stuck ?? [])
        setStuckDays(d.stuckDays ?? 5)
      })
      .catch((e) => alive && setError(String(e.message || e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [stage, from, to])

  const toggleWorker = useCallback(
    (name: string) => {
      if (open === name) {
        setOpen(null)
        return
      }
      setOpen(name)
      if (drills[name]) return // cached
      const req = ++drillReq.current
      const q = new URLSearchParams({ from, to, w: name })
      if (stage) q.set('stage', stage)
      fetch(`/api/report?${q.toString()}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => {
          if (req !== drillReq.current) return
          if (d.ok) setDrills((prev) => ({ ...prev, [name]: d.jobs ?? [] }))
        })
        .catch(() => {})
    },
    [open, drills, from, to, stage],
  )

  const totals = people.reduce(
    (a, p) => {
      a.finishes += p.finishes
      a.pieces += p.pieces
      a.valueCny += p.valueCny
      return a
    },
    { finishes: 0, pieces: 0, valueCny: 0 },
  )

  const nextDisabled = to >= todayStr

  return (
    <div className="flex flex-col gap-8">
      {/* period + totals + export */}
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex items-baseline gap-8">
          <Totaled label="完成零件" value={NUM.format(totals.finishes)} sub={`${NUM.format(totals.pieces)} 件`} />
          {showMoney && <Totaled label="经手金额" value={formatCny(totals.valueCny)} />}
        </div>
        <div className="flex items-center gap-3">
          <PeriodBar
            gran={gran}
            readout={readout(anchor, gran)}
            nextDisabled={nextDisabled}
            containsToday={from <= todayStr && todayStr <= to}
            onGran={(g) => setGran(g)}
            onStep={(dir) => setAnchor((a) => shift(a, gran, dir))}
            onToday={() => setAnchor(todayStr)}
          />
          <ExportButton
            stage={stage}
            from={from}
            to={to}
            showMoney={showMoney}
            hasData={people.length > 0}
            stuck={stuck}
          />
        </div>
      </div>

      {/* station chips */}
      <StationChips current={stage} onSelect={setStage} />

      {/* ① people — the hero */}
      <PeopleList
        loading={loading}
        error={error}
        people={people}
        showMoney={showMoney}
        open={open}
        drills={drills}
        onToggle={toggleWorker}
      />

      {/* ② 停留超期 — quiet, at the bottom, only when a station is selected */}
      {stage && stuck.length > 0 && <StuckBlock stage={stage} stuck={stuck} stuckDays={stuckDays} />}
    </div>
  )
}

// --- people ------------------------------------------------------------------

function PeopleList({
  loading,
  error,
  people,
  showMoney,
  open,
  drills,
  onToggle,
}: {
  loading: boolean
  error: string | null
  people: Person[]
  showMoney: boolean
  open: string | null
  drills: Record<string, DrillJob[]>
  onToggle: (name: string) => void
}) {
  const cols = showMoney ? 'grid-cols-[1fr_120px_72px_120px_110px]' : 'grid-cols-[1fr_120px_72px_110px]'

  if (error) {
    return <p className="py-16 text-center text-[13px] text-[var(--color-overdue)]">加载失败：{error}</p>
  }
  if (loading && people.length === 0) {
    return <p className="py-16 text-center text-[13px] text-[var(--color-ink-3)]">加载中…</p>
  }
  if (!loading && people.length === 0) {
    return <p className="py-16 text-center text-[13px] text-[var(--color-ink-3)]">此周期暂无产出</p>
  }

  return (
    <div className={`rounded-[2px] border border-[var(--color-border)] overflow-hidden ${loading ? 'opacity-60' : ''}`}>
      <div className={`grid ${cols} gap-x-6 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2`}>
        <span className="label">姓名</span>
        <span className="label text-right">完成零件</span>
        <span className="label text-right">开始</span>
        {showMoney && <span className="label text-right">经手金额</span>}
        <span className="label text-right">最后活动</span>
      </div>
      <ul>
        {people.map((p) => {
          const active = open === p.actorName
          return (
            <li key={p.actorName} className="border-b border-[var(--color-border)] last:border-0">
              <button
                type="button"
                onClick={() => onToggle(p.actorName)}
                aria-expanded={active}
                className={`grid ${cols} w-full gap-x-6 items-baseline px-3 py-3.5 text-left transition-colors ${
                  active ? 'bg-[var(--color-active-bg)]' : 'hover:bg-[var(--color-surface)]'
                }`}
              >
                <span className="flex items-baseline gap-2 min-w-0">
                  <Caret open={active} />
                  <span className="truncate text-[15px] text-[var(--color-ink)]">{p.actorName}</span>
                  {showMoney && p.unpriced > 0 && (
                    <span className="shrink-0 text-[10px] tabular-nums tracking-wide text-[var(--color-warning)]">
                      {p.unpriced} 未定价
                    </span>
                  )}
                </span>
                <span className="text-right tabular-nums">
                  <span className="text-[16px] font-semibold text-[var(--color-ink)]">{NUM.format(p.finishes)}</span>
                  <span className="ml-1.5 text-[11px] text-[var(--color-ink-3)]">· {NUM.format(p.pieces)} 件</span>
                </span>
                <span className="text-right text-[14px] tabular-nums text-[var(--color-ink-2)]">{NUM.format(p.starts)}</span>
                {showMoney && (
                  <span className="text-right text-[14px] tabular-nums text-[var(--color-ink-2)]">{formatCny(p.valueCny)}</span>
                )}
                <span className="text-right label tabular-nums text-[var(--color-ink-3)]">
                  {p.lastActiveTs ? fmtTs(p.lastActiveTs) : '—'}
                </span>
              </button>
              {active && <Drill jobs={drills[p.actorName]} showMoney={showMoney} />}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Drill({ jobs, showMoney }: { jobs?: DrillJob[]; showMoney: boolean }) {
  return (
    <div className="bg-[var(--color-surface)] px-3 md:px-5 py-4 border-t border-[var(--color-border)]">
      {jobs === undefined ? (
        <p className="py-2 text-[12px] text-[var(--color-ink-3)]">加载中…</p>
      ) : jobs.length === 0 ? (
        <p className="py-2 text-[12px] text-[var(--color-ink-3)]">此周期无完成记录</p>
      ) : (
        <div className="flex flex-col gap-4">
          {jobs.map((j) => (
            <div key={j.jobId}>
              <div className="flex items-baseline justify-between gap-4 mb-1.5">
                <Link href={`/jobs/${j.jobId}`} className="text-[13px] group">
                  <span className="tabular-nums text-[var(--color-ink)] group-hover:underline">{j.jobNo || '—'}</span>
                  <span className="mx-1.5 text-[var(--color-ink-4)]">·</span>
                  <span className="text-[var(--color-ink-3)]">{j.customer}</span>
                </Link>
                <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-ink-3)]">
                  {NUM.format(j.finishes)} 件零件{showMoney && j.valueCny > 0 ? ` · ${formatCny(j.valueCny)}` : ''}
                </span>
              </div>
              <ul className="flex flex-col gap-0.5 pl-1">
                {j.components.map((c, i) => (
                  <li key={`${c.partName}-${c.ts}-${i}`} className="flex items-center gap-2.5 text-[12.5px] text-[var(--color-ink-2)]">
                    <Thumb src={c.imageUrl} size={20} />
                    <span className="text-[var(--color-success)]">完成{c.stage}</span>
                    <span className="text-[var(--color-ink)]">{c.partName}</span>
                    <span className="tabular-nums text-[var(--color-ink-3)]">×{c.qty}</span>
                    <span className="ml-auto tabular-nums text-[var(--color-ink-4)]">{fmtTs(c.ts)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// --- ② 停留超期 (bottom) ------------------------------------------------------

function StuckBlock({ stage, stuck, stuckDays }: { stage: Stage; stuck: StuckPart[]; stuckDays: number }) {
  return (
    <section className="mt-4 pt-8 border-t border-[var(--color-border)]">
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-[13px] font-medium tracking-tight text-[var(--color-ink-2)]">停留超期</h2>
        <span className="label text-[var(--color-ink-3)]">
          {stage} · 超过 {stuckDays} 天 · {stuck.length}
        </span>
      </div>
      <ul className="rounded-[2px] border border-[var(--color-border)] overflow-hidden">
        {stuck.map((p) => (
          <li key={p.partId} className="grid grid-cols-[1fr_auto] items-center gap-x-6 border-b border-[var(--color-border)] px-3 py-2.5 last:border-0">
            <div className="flex items-center gap-3 min-w-0">
              <Thumb src={p.imageUrl} size={32} />
              <div className="min-w-0">
                <p className="truncate text-[13px] text-[var(--color-ink)]">
                  {p.partName}
                  {p.partNo && <span className="ml-2 mono text-[11px] text-[var(--color-ink-3)]">{p.partNo}</span>}
                </p>
                <p className="truncate text-[11px] text-[var(--color-ink-3)]">
                  <Link href={`/jobs/${p.jobId}`} className="tabular-nums hover:text-[var(--color-ink)]">
                    {p.jobNo || '—'}
                  </Link>
                  <span className="mx-1.5 text-[var(--color-ink-4)]">·</span>
                  {p.customer}
                </p>
              </div>
            </div>
            <div className="text-right whitespace-nowrap">
              <span className="text-[13px] font-medium tabular-nums text-[var(--color-overdue)]">在此 {p.daysHere} 天</span>
              <span className="ml-3 text-[11px] tabular-nums text-[var(--color-ink-3)]">
                {p.doneQty != null ? `${p.doneQty}/${p.qty}` : `${p.qty} 件`}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

// --- controls ----------------------------------------------------------------

function StationChips({ current, onSelect }: { current: Stage | null; onSelect: (s: Stage | null) => void }) {
  const chips: { label: string; stage: Stage | null }[] = [
    { label: '全部', stage: null },
    ...STAGES.map((s) => ({ label: s, stage: s })),
  ]
  return (
    <div className="flex flex-wrap items-center gap-1">
      {chips.map(({ label, stage }) => {
        const active = stage === current
        return (
          <button
            key={label}
            type="button"
            onClick={() => onSelect(stage)}
            aria-current={active ? 'true' : undefined}
            className={`whitespace-nowrap rounded-[2px] px-3 py-1.5 text-[13px] transition-colors ${
              active
                ? 'bg-[var(--color-active-bg)] font-medium text-[var(--color-ink)]'
                : 'text-[var(--color-ink-3)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]'
            }`}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

function PeriodBar({
  gran,
  readout,
  nextDisabled,
  containsToday,
  onGran,
  onStep,
  onToday,
}: {
  gran: Gran
  readout: string
  nextDisabled: boolean
  containsToday: boolean
  onGran: (g: Gran) => void
  onStep: (dir: number) => void
  onToday: () => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="inline-flex rounded-[2px] border border-[var(--color-border)] overflow-hidden">
        {(['day', 'week', 'month'] as Gran[]).map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => onGran(g)}
            className={`px-2.5 py-1 text-[12px] transition-colors ${
              gran === g
                ? 'bg-[var(--color-active-bg)] font-medium text-[var(--color-ink)]'
                : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
            }`}
          >
            {g === 'day' ? '日' : g === 'week' ? '周' : '月'}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-0.5">
        <Step dir={-1} onClick={() => onStep(-1)} />
        <span className="min-w-[120px] text-center text-[13px] font-medium tabular-nums text-[var(--color-ink)]">{readout}</span>
        <Step dir={1} onClick={() => onStep(1)} disabled={nextDisabled} />
      </div>
      {!containsToday && (
        <button
          type="button"
          onClick={onToday}
          className="px-2 py-1 rounded-[2px] text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface)] transition-colors"
        >
          今天
        </button>
      )}
    </div>
  )
}

function Step({ dir, onClick, disabled }: { dir: number; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir < 0 ? '上一周期' : '下一周期'}
      className="inline-flex h-7 w-7 items-center justify-center rounded-[2px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface)] disabled:text-[var(--color-ink-4)] disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className={dir > 0 ? 'rotate-180' : ''}>
        <path d="M8.5 3.5 L5 7 L8.5 10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

// --- 导出报表 ----------------------------------------------------------------

type ExportOrder = {
  jobId: string
  jobNo: string
  customer: string
  amountCny: number
  finishes: number
  pieces: number
  valueCny: number
  components: {
    ts: string
    stage: Stage
    actorName: string
    partName: string
    partNo?: string
    qty: number
    valueCny: number
    unpriced: boolean
  }[]
}

function ExportButton({
  stage,
  from,
  to,
  showMoney,
  hasData,
  stuck,
}: {
  stage: Stage | null
  from: string
  to: string
  showMoney: boolean
  hasData: boolean
  stuck: StuckPart[]
}) {
  const [busy, setBusy] = useState(false)
  const disabled = busy || !hasData

  const onExport = async () => {
    if (disabled) return
    setBusy(true)
    try {
      // Fetch the full 工单→component detail (paginated server-side) so a month
      // export is complete, not the flat per-person count.
      const q = new URLSearchParams({ from, to, mode: 'export' })
      if (stage) q.set('stage', stage)
      const res = await fetch(`/api/report?${q.toString()}`, { cache: 'no-store' }).then((r) => r.json())
      const orders: ExportOrder[] = res?.ok ? res.orders ?? [] : []

      const XLSX = await import('xlsx')
      const wb = XLSX.utils.book_new()

      // ── 汇总 — the month-end stats PMC reads first. Derived from the same
      // detail so the numbers always reconcile with 报工明细. ────────────────
      const byStage = new Map<Stage, { finishes: number; pieces: number; jobs: Set<string>; workers: Set<string>; valueCny: number }>()
      const byWorker = new Map<string, { finishes: number; pieces: number; valueCny: number }>()
      for (const o of orders) {
        for (const c of o.components) {
          let s = byStage.get(c.stage)
          if (!s) { s = { finishes: 0, pieces: 0, jobs: new Set(), workers: new Set(), valueCny: 0 }; byStage.set(c.stage, s) }
          s.finishes += 1; s.pieces += c.qty; s.jobs.add(o.jobId); s.workers.add(c.actorName); s.valueCny += c.valueCny
          let w = byWorker.get(c.actorName)
          if (!w) { w = { finishes: 0, pieces: 0, valueCny: 0 }; byWorker.set(c.actorName, w) }
          w.finishes += 1; w.pieces += c.qty; w.valueCny += c.valueCny
        }
      }

      // 工段汇总 — per-station monthly output (the cross-tab for 全部; one row for
      // a single station). 完成零件 / 件数 / 工单数 / 人数 / ¥.
      const stageHead = ['工段', '完成零件', '件数', '工单数', '人数', ...(showMoney ? ['经手金额'] : [])]
      const stageRows: (string | number)[][] = STAGES.filter((s) => byStage.has(s)).map((s) => {
        const v = byStage.get(s)!
        return [s, v.finishes, v.pieces, v.jobs.size, v.workers.size, ...(showMoney ? [Math.round(v.valueCny)] : [])]
      })
      const stageTot = stageRows.reduce(
        (a, r) => ({ f: a.f + Number(r[1]), p: a.p + Number(r[2]), v: a.v + (showMoney ? Number(r[5]) : 0) }),
        { f: 0, p: 0, v: 0 },
      )
      stageRows.push(['合计', stageTot.f, stageTot.p, '', '', ...(showMoney ? [stageTot.v] : [])])
      const wsStage = XLSX.utils.aoa_to_sheet([stageHead, ...stageRows])
      wsStage['!cols'] = stageHead.map(() => ({ wch: 10 }))
      XLSX.utils.book_append_sheet(wb, wsStage, '工段汇总')

      // 人员汇总 — per-person output (产量 / 计件基数), most productive first.
      const workerRows = [...byWorker.entries()].sort((a, b) => b[1].finishes - a[1].finishes)
      const wHead = ['姓名', '完成零件', '件数', ...(showMoney ? ['经手金额'] : [])]
      const wBody: (string | number)[][] = workerRows.map(([name, v]) => [name, v.finishes, v.pieces, ...(showMoney ? [Math.round(v.valueCny)] : [])])
      const wTot = workerRows.reduce((a, [, v]) => ({ f: a.f + v.finishes, p: a.p + v.pieces, v: a.v + v.valueCny }), { f: 0, p: 0, v: 0 })
      wBody.push(['合计', wTot.f, wTot.p, ...(showMoney ? [Math.round(wTot.v)] : [])])
      const wsWorker = XLSX.utils.aoa_to_sheet([wHead, ...wBody])
      wsWorker['!cols'] = wHead.map((h) => ({ wch: h === '姓名' ? 16 : 10 }))
      XLSX.utils.book_append_sheet(wb, wsWorker, '人员汇总')

      // 工单汇总 — per-order money + output: 订单金额 alongside 完成零件 / 件数.
      const ojHead = ['工号', '客户', ...(showMoney ? ['订单金额'] : []), '完成零件', '件数', ...(showMoney ? ['经手金额'] : [])]
      const ojBody: (string | number)[][] = orders.map((o) => [
        o.jobNo,
        o.customer,
        ...(showMoney ? [Math.round(o.amountCny)] : []),
        o.finishes,
        o.pieces,
        ...(showMoney ? [Math.round(o.valueCny)] : []),
      ])
      const ojTot = orders.reduce(
        (a, o) => ({ amt: a.amt + o.amountCny, f: a.f + o.finishes, p: a.p + o.pieces, v: a.v + o.valueCny }),
        { amt: 0, f: 0, p: 0, v: 0 },
      )
      ojBody.push(['合计', '', ...(showMoney ? [Math.round(ojTot.amt)] : []), ojTot.f, ojTot.p, ...(showMoney ? [Math.round(ojTot.v)] : [])])
      const wsOrder = XLSX.utils.aoa_to_sheet([ojHead, ...ojBody])
      wsOrder['!cols'] = ojHead.map((h) => ({ wch: h === '客户' ? 22 : h === '工号' ? 16 : 10 }))
      XLSX.utils.book_append_sheet(wb, wsOrder, '工单汇总')

      // ── 报工明细 — 工单 foremost, its components spanning underneath. 工号/客户
      // sit on the order's first row; blank on the rest so each order reads as a
      // header with its 零件 listed below it. A blank row separates orders.
      const head = ['工号', '客户', '零件', '料号', '数量', '工段', '经手人', '完成时间', ...(showMoney ? ['经手金额'] : [])]
      const body: (string | number)[][] = []
      orders.forEach((o, oi) => {
        if (oi > 0) body.push([]) // spacer between orders
        o.components.forEach((c, ci) => {
          body.push([
            ci === 0 ? o.jobNo : '',
            ci === 0 ? o.customer : '',
            c.partName,
            c.partNo ?? '',
            c.qty,
            c.stage,
            c.actorName,
            fmtTs(c.ts),
            ...(showMoney ? [c.unpriced ? '未定价' : Math.round(c.valueCny)] : []),
          ])
        })
      })
      const ws = XLSX.utils.aoa_to_sheet([head, ...body])
      ws['!cols'] = head.map((h) =>
        h === '客户' || h === '零件' ? { wch: 22 } : h === '工号' ? { wch: 16 } : h === '完成时间' ? { wch: 14 } : { wch: 10 },
      )
      XLSX.utils.book_append_sheet(wb, ws, '报工明细')

      if (stage && stuck.length > 0) {
        const sHead = ['工号', '客户', '零件', '料号', '数量', '已完成', '在此天数']
        const sBody = stuck.map((p) => [p.jobNo, p.customer, p.partName, p.partNo ?? '', p.qty, p.doneQty ?? '', p.daysHere])
        const sWs = XLSX.utils.aoa_to_sheet([sHead, ...sBody])
        sWs['!cols'] = sHead.map((h) => ({ wch: h === '客户' || h === '零件' ? 20 : 10 }))
        XLSX.utils.book_append_sheet(wb, sWs, '停留超期')
      }

      const span = from === to ? from : `${from}_${to}`
      XLSX.writeFile(wb, `报工_${stage ?? '全部'}_${span}.xlsx`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={onExport}
      disabled={disabled}
      title="导出本周期报表为 Excel（按工单）"
      className={`inline-flex items-baseline gap-1.5 rounded-[2px] border px-2.5 py-[5px] text-[10px] tracking-[0.14em] uppercase transition-colors ${
        disabled
          ? 'border-[var(--color-border)] text-[var(--color-ink-4)] cursor-default'
          : 'border-[var(--color-border)] text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-ink)]'
      }`}
    >
      <span className="translate-y-[1px]"><DownloadIcon /></span>
      <span>{busy ? '导出中…' : '导出'}</span>
    </button>
  )
}

// --- small chrome ------------------------------------------------------------

function Totaled({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-[24px] md:text-[28px] font-semibold tracking-tight tabular-nums leading-none text-[var(--color-ink)]">
        {value}
        {sub && <span className="ml-2 text-[13px] font-normal text-[var(--color-ink-3)]">{sub}</span>}
      </p>
      <p className="label mt-1.5">{label}</p>
    </div>
  )
}

function Thumb({ src, size = 32 }: { src?: string; size?: number }) {
  const url = proxiedStorageUrl(src)
  return (
    <div
      className="shrink-0 overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]"
      style={{ height: size, width: size }}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" loading="lazy" decoding="async" className="h-full w-full object-contain" />
      ) : null}
    </div>
  )
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true" className={`shrink-0 text-[var(--color-ink-4)] transition-transform ${open ? 'rotate-90' : ''}`}>
      <path d="M4.5 2.5 L8 6 L4.5 9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M6 1.5 V7.5 M3.5 5.5 L6 8 L8.5 5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M1.5 9.5 V10.5 H10.5 V9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// --- pure date helpers (YYYY-MM-DD string math, Date.UTC = no tz drift) ------

function pad(n: number) {
  return String(n).padStart(2, '0')
}
function ymd(y: number, mZero: number, d: number): string {
  return new Date(Date.UTC(y, mZero, d)).toISOString().slice(0, 10)
}
function parse(s: string): [number, number, number] {
  const [y, m, d] = s.split('-').map(Number)
  return [y, m, d]
}
function rangeOf(anchor: string, gran: Gran): { from: string; to: string } {
  const [y, m, d] = parse(anchor)
  if (gran === 'day') return { from: anchor, to: anchor }
  if (gran === 'month') return { from: ymd(y, m - 1, 1), to: ymd(y, m, 0) }
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=Sun..6=Sat
  const mondayOffset = (wd + 6) % 7
  return { from: ymd(y, m - 1, d - mondayOffset), to: ymd(y, m - 1, d - mondayOffset + 6) }
}
function shift(anchor: string, gran: Gran, delta: number): string {
  const [y, m, d] = parse(anchor)
  if (gran === 'month') return ymd(y, m - 1 + delta, d)
  return ymd(y, m - 1, d + delta * (gran === 'week' ? 7 : 1))
}
function readout(anchor: string, gran: Gran): string {
  const [y, m, d] = parse(anchor)
  if (gran === 'month') return `${y}年${m}月`
  if (gran === 'day') {
    const wd = new Date(`${anchor}T12:00:00+08:00`).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short' })
    return `${m}月${d}日 ${wd}`
  }
  const { from, to } = rangeOf(anchor, 'week')
  const [, fm, fd] = parse(from)
  const [, tm, td] = parse(to)
  return `${fm}月${fd}日 – ${tm}月${td}日`
}
function fmtTs(ts: string): string {
  const t = new Date(ts).getTime()
  if (Number.isNaN(t)) return ''
  // Render in factory time (Asia/Shanghai, fixed +08:00 — no DST), not the
  // viewer's browser timezone: shift the instant by +8h and read UTC fields.
  const dt = new Date(t + 8 * 60 * 60 * 1000)
  return `${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`
}
