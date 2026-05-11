'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import {
  daysFromToday,
  dueState,
  type DueState,
  type JobReturn,
} from '@/lib/data'
import type { ClosedReturnRow } from '@/lib/db'
import { ReturnChip, ReturnComposer, type ReturnComposerComponent } from '@/app/_returns'

export type ReturnsListJob = {
  id: string
  jobNo: string
  customer: string
  product: string
  shipDate: string
  daysSinceShip: number | null
  activeReturn?: JobReturn
  // Present on candidate rows so the inline 开退货 dialog can drive the part
  // picker without a round-trip to /jobs/[id].
  components?: ReturnComposerComponent[]
}

type Tab = 'open' | 'candidates' | 'closed'

export function ReturnsView({
  openJobs,
  candidates,
  closed,
}: {
  openJobs: ReturnsListJob[]
  candidates: ReturnsListJob[]
  closed: ClosedReturnRow[]
}) {
  const [tab, setTab] = useState<Tab>(openJobs.length > 0 ? 'open' : 'candidates')
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<ReturnsListJob | null>(null)
  const needle = q.trim().toLowerCase()

  const filteredOpen = useMemo(
    () => filterJobs(openJobs, needle).sort(byActiveDue),
    [openJobs, needle],
  )
  const filteredCandidates = useMemo(
    () =>
      filterJobs(candidates, needle).sort((a, b) =>
        (b.shipDate ?? '').localeCompare(a.shipDate ?? ''),
      ),
    [candidates, needle],
  )
  const filteredClosed = useMemo(
    () => filterClosed(closed, needle),
    [closed, needle],
  )

  const counts = {
    open: openJobs.length,
    candidates: candidates.length,
    closed: closed.length,
  }

  return (
    <div>
      <div className="mb-6 flex items-baseline justify-between gap-6">
        <div>
          <p className="label mb-1">退货总览</p>
          <h2 className="text-[28px] font-semibold tracking-tight text-[var(--color-ink)]">
            出货后回厂
          </h2>
          <p className="mt-1 text-[13px] text-[var(--color-ink-2)]">
            进行中按内部交期排序 · 可退货搜索任意已出货工单 · 点行直接开退货
          </p>
        </div>
        <div className="w-[320px] shrink-0">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              tab === 'candidates'
                ? '搜索任意已出货工单 · 工号 / 客户 / 产品'
                : '搜索 · 工号 / 客户 / 产品'
            }
            autoFocus={tab === 'candidates'}
            className="w-full bg-transparent border-b border-[var(--color-border-strong)] py-2 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] focus:outline-none focus:border-[var(--color-ink)]"
          />
        </div>
      </div>

      <div className="mb-4 flex items-stretch border-b border-[var(--color-border)]">
        <TabButton
          active={tab === 'open'}
          label="进行中"
          count={counts.open}
          onClick={() => setTab('open')}
        />
        <TabButton
          active={tab === 'candidates'}
          label="可退货"
          count={counts.candidates}
          onClick={() => setTab('candidates')}
        />
        <TabButton
          active={tab === 'closed'}
          label="已完成"
          count={counts.closed}
          onClick={() => setTab('closed')}
        />
      </div>

      {tab === 'open' && (
        <JobList rows={filteredOpen} mode="open" emptyText="暂无进行中的退货" />
      )}
      {tab === 'candidates' && (
        <CandidateList
          rows={filteredCandidates}
          onPick={setPicked}
          emptyText={
            needle ? '没有匹配的已出货工单' : '暂无可退货工单'
          }
        />
      )}
      {tab === 'closed' && (
        <ClosedList rows={filteredClosed} emptyText="暂无退货历史" />
      )}

      {picked && picked.components && (
        <ReturnComposer
          jobId={picked.id}
          jobNo={picked.jobNo}
          components={picked.components}
          onClose={() => setPicked(null)}
        />
      )}
    </div>
  )
}

function TabButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative px-5 py-3 text-[13px] tracking-wider transition-colors ${
        active
          ? 'text-[var(--color-ink)] font-semibold'
          : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
      }`}
    >
      {label}
      <span className="ml-2 mono text-[11px] text-[var(--color-ink-3)]">
        {count}
      </span>
      {active && (
        <span className="absolute inset-x-0 -bottom-px h-[2px] bg-[var(--color-ink)]" />
      )}
    </button>
  )
}

function byActiveDue(a: ReturnsListJob, b: ReturnsListJob): number {
  // open tab only — every row has activeReturn. Sort by internal due date so
  // overdue rework climbs to the top.
  const ad = a.activeReturn?.dueDate ?? ''
  const bd = b.activeReturn?.dueDate ?? ''
  return ad.localeCompare(bd)
}

function filterJobs(rows: ReturnsListJob[], needle: string): ReturnsListJob[] {
  if (!needle) return rows
  return rows.filter((j) => {
    const hay = `${j.jobNo} ${j.customer} ${j.product}`.toLowerCase()
    return hay.includes(needle)
  })
}

function filterClosed(rows: ClosedReturnRow[], needle: string): ClosedReturnRow[] {
  if (!needle) return rows
  return rows.filter((r) => {
    const hay = `${r.jobNo} ${r.customer} ${r.product}`.toLowerCase()
    return hay.includes(needle)
  })
}

function JobList({
  rows,
  mode,
  emptyText,
}: {
  rows: ReturnsListJob[]
  mode: 'open'
  emptyText: string
}) {
  if (rows.length === 0) {
    return (
      <p className="text-[12px] text-[var(--color-ink-3)] py-6 border-b border-[var(--color-border)]">
        {emptyText}
      </p>
    )
  }
  return (
    <ul className="border-y border-[var(--color-border)] divide-y divide-[var(--color-border)]">
      {rows.map((j) => (
        <li key={j.id}>
          <Link
            href={`/jobs/${j.id}`}
            className="flex items-center gap-6 px-5 py-3.5 hover:bg-[#f1eee4] transition-colors"
          >
            <span className="mono text-[13px] font-medium text-[var(--color-ink)] w-32 shrink-0 truncate">
              {j.jobNo}
            </span>
            <div className="flex-1 min-w-0 flex flex-col leading-tight">
              <span className="text-[13px] font-medium text-[var(--color-ink)] truncate">
                {j.customer || '—'}
              </span>
              <span className="label normal-case tracking-normal text-[11px] text-[var(--color-ink-3)] mt-0.5 truncate">
                {j.product}
              </span>
            </div>
            {mode === 'open' && j.activeReturn ? (
              <ActiveReturnInline ret={j.activeReturn} />
            ) : (
              <ShipDateColumn ship={j.shipDate} days={j.daysSinceShip} />
            )}
            <span className="label text-[var(--color-ink-3)]">打开 →</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

// Candidates render greyed by design — every row here is a finished/shipped
// job, and the muting communicates "done; pick one to start a return". The
// row is a button (not a link): clicking opens the inline 退货 composer
// instead of bouncing through /jobs/[id] just to find the same affordance.
function CandidateList({
  rows,
  onPick,
  emptyText,
}: {
  rows: ReturnsListJob[]
  onPick: (j: ReturnsListJob) => void
  emptyText: string
}) {
  if (rows.length === 0) {
    return (
      <p className="text-[12px] text-[var(--color-ink-3)] py-6 border-b border-[var(--color-border)]">
        {emptyText}
      </p>
    )
  }
  return (
    <ul className="border-y border-[var(--color-border)] divide-y divide-[var(--color-border)]">
      {rows.map((j) => (
        <li key={j.id}>
          <button
            type="button"
            onClick={() => onPick(j)}
            className="w-full text-left flex items-center gap-6 px-5 py-3.5 opacity-60 hover:opacity-100 hover:bg-[#f1eee4] transition-[opacity,background-color]"
          >
            <span className="mono text-[13px] font-medium text-[var(--color-ink-2)] w-32 shrink-0 truncate">
              {j.jobNo}
            </span>
            <div className="flex-1 min-w-0 flex flex-col leading-tight">
              <span className="text-[13px] font-medium text-[var(--color-ink-2)] truncate">
                {j.customer || '—'}
              </span>
              <span className="label normal-case tracking-normal text-[11px] text-[var(--color-ink-3)] mt-0.5 truncate">
                {j.product}
              </span>
            </div>
            <ShipDateColumn ship={j.shipDate} days={j.daysSinceShip} muted />
            <Link
              href={`/jobs/${j.id}`}
              onClick={(e) => e.stopPropagation()}
              className="label text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:underline underline-offset-2"
            >
              查看工单
            </Link>
            <span className="label text-[var(--color-ink-3)]">开退货 →</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function ActiveReturnInline({ ret }: { ret: JobReturn }) {
  const ds: DueState = dueState(ret.dueDate)
  const days = daysFromToday(ret.dueDate)
  const tone =
    ds === 'overdue'
      ? 'text-[var(--color-overdue)]'
      : ds === 'today'
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--color-ink)]'
  const sub =
    ds === 'overdue'
      ? `逾期 ${Math.abs(days)} 天`
      : ds === 'today'
        ? '今日'
        : `${days} 天后`
  return (
    <div className="flex items-center gap-3">
      <ReturnChip ret={ret} />
      <div className="flex flex-col items-end leading-tight">
        <span className={`mono text-[13px] ${tone}`}>{ret.dueDate}</span>
        <span className="label mt-0.5 text-[var(--color-ink-3)]">{sub}</span>
      </div>
      <span className="text-[12px] text-[var(--color-ink-2)] w-24 shrink-0 text-right truncate">
        {ret.reason}
      </span>
    </div>
  )
}

function ShipDateColumn({
  ship,
  days,
  muted,
}: {
  ship: string
  days: number | null
  muted?: boolean
}) {
  if (!ship) {
    return <span className="label text-[var(--color-ink-4)] w-32 text-right">—</span>
  }
  return (
    <div className="flex flex-col items-end leading-tight w-32 shrink-0">
      <span
        className={`mono text-[12px] ${muted ? 'text-[var(--color-ink-2)]' : 'text-[var(--color-ink)]'}`}
      >
        出 {ship}
      </span>
      {typeof days === 'number' && (
        <span className="label mt-0.5 text-[var(--color-ink-3)]">
          {days} 天前
        </span>
      )}
    </div>
  )
}

function ClosedList({
  rows,
  emptyText,
}: {
  rows: ClosedReturnRow[]
  emptyText: string
}) {
  if (rows.length === 0) {
    return (
      <p className="text-[12px] text-[var(--color-ink-3)] py-6 border-b border-[var(--color-border)]">
        {emptyText}
      </p>
    )
  }
  return (
    <ul className="border-y border-[var(--color-border)] divide-y divide-[var(--color-border)]">
      {rows.map((r) => (
        <li key={r.ret.id}>
          <Link
            href={`/jobs/${r.ret.jobId}`}
            className="flex items-center gap-6 px-5 py-3.5 hover:bg-[#f1eee4] transition-colors"
          >
            <span className="mono text-[13px] font-medium text-[var(--color-ink)] w-32 shrink-0 truncate">
              {r.jobNo}
            </span>
            <div className="flex-1 min-w-0 flex flex-col leading-tight">
              <span className="text-[13px] font-medium text-[var(--color-ink)] truncate">
                {r.customer || '—'}
              </span>
              <span className="label normal-case tracking-normal text-[11px] text-[var(--color-ink-3)] mt-0.5 truncate">
                {r.product}
              </span>
            </div>
            <span className="text-[12px] text-[var(--color-ink-2)] w-28 shrink-0 truncate">
              {r.ret.reason}
              {r.ret.reasonText && (
                <span className="block label normal-case text-[10px] text-[var(--color-ink-3)] mt-0.5 truncate">
                  {r.ret.reasonText}
                </span>
              )}
            </span>
            <span className="mono text-[11px] text-[var(--color-ink-3)] w-24 text-right shrink-0">
              {(r.ret.closedAt ?? r.ret.createdAt).slice(0, 10)}
            </span>
            <span className="label text-[var(--color-ink-3)]">打开 →</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
