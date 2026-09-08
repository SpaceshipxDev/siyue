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
import {
  returnStep,
  RETURN_STEP_LABEL,
  RETURN_STEP_OWNER,
  type ReturnFlow,
} from '@/lib/return-flow'
import { ReturnComposer, type ReturnComposerComponent } from '@/app/_returns'
import { ReturnFlowPanel } from './_flow'

// 退货台 —— 一条退货是一条流水, 不是一个标记。
//
// 进行中那一栏里, 每一行摊开就是它的流转单: 商务开的单 → 工程的处理方案 →
// 质量的原因调查 → 下发返工 → 返工入库 → 再开一张出货单。行上只留一句话:
// 现在卡在哪一步、在等谁。谁打开这一页, 第一眼要看的就是这句话。

// 一条进行中的退货, 连零件明细和流转单一起。
export type ReturnDeskRow = {
  ret: JobReturn
  jobNo: string
  customer: string
  product: string
  parts: { componentId: string; name: string; qty: number; totalQty: number }[]
  flow?: ReturnFlow
}

// 可退货那一栏仍是"按工号找一张已出货的工单"。
export type ReturnsListJob = {
  id: string
  jobNo: string
  customer: string
  product: string
  shipDate: string
  daysSinceShip: number | null
  components?: ReturnComposerComponent[]
}

export type ReturnPerms = {
  plan: boolean
  cause: boolean
  rework: boolean
  ship: boolean
  /** 开新退货 — 商务/工程 */
  open: boolean
  /** 车间账号 (质量站) 看不到客户名 — 退货台不该成为它的旁门。 */
  showCustomer: boolean
}

type Tab = 'open' | 'candidates' | 'closed'

export function ReturnsView({
  openRows,
  candidates,
  closed,
  perms,
}: {
  openRows: ReturnDeskRow[]
  candidates: ReturnsListJob[]
  closed: ClosedReturnRow[]
  perms: ReturnPerms
}) {
  const [tab, setTab] = useState<Tab>(openRows.length > 0 ? 'open' : 'candidates')
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<ReturnsListJob | null>(null)
  const [expanded, setExpanded] = useState<string | null>(
    openRows.length === 1 ? openRows[0].ret.id : null,
  )
  const needle = q.trim().toLowerCase()

  const filteredOpen = useMemo(
    () =>
      openRows.filter((r) =>
        !needle
          ? true
          : `${r.jobNo} ${r.customer} ${r.product}`.toLowerCase().includes(needle),
      ),
    [openRows, needle],
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

  return (
    <div>
      <div className="mb-6 flex items-baseline justify-between gap-6">
        <div>
          <p className="label mb-1">退货总览</p>
          <h2 className="text-[28px] font-semibold tracking-tight text-[var(--color-ink)]">
            出货后回厂
          </h2>
          <p className="mt-1 text-[13px] text-[var(--color-ink-2)]">
            商务开单 · 工程出方案 · 质量查原因 · 下发返工 · 入库 · 再出货
          </p>
        </div>
        <div className="w-[320px] shrink-0">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              tab === 'candidates' ? '输工号开退货' : '搜索 · 工号 / 客户 / 产品'
            }
            autoFocus={tab === 'candidates'}
            className="w-full border-b border-[var(--color-border-strong)] bg-transparent py-2 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-ink)] focus:outline-none"
          />
        </div>
      </div>

      <div className="mb-4 flex items-stretch border-b border-[var(--color-border)]">
        <TabButton
          active={tab === 'open'}
          label="进行中"
          count={openRows.length}
          onClick={() => setTab('open')}
        />
        {perms.open && (
          <TabButton
            active={tab === 'candidates'}
            label="开退货"
            count={candidates.length}
            onClick={() => setTab('candidates')}
          />
        )}
        <TabButton
          active={tab === 'closed'}
          label="已完成"
          count={closed.length}
          onClick={() => setTab('closed')}
        />
      </div>

      {tab === 'open' && (
        <OpenList
          rows={filteredOpen}
          perms={perms}
          expanded={expanded}
          onToggle={(id) => setExpanded((cur) => (cur === id ? null : id))}
          emptyText={needle ? '没有匹配的退货' : '暂无进行中的退货'}
        />
      )}
      {tab === 'candidates' && perms.open && (
        <CandidateList
          rows={filteredCandidates}
          onPick={setPicked}
          emptyText={needle ? '没有匹配的已出货工单' : '暂无可退货工单'}
        />
      )}
      {tab === 'closed' && (
        <ClosedList
          rows={filteredClosed}
          showCustomer={perms.showCustomer}
          emptyText="暂无退货历史"
        />
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

// ── 进行中 ────────────────────────────────────────────────────────────────

function OpenList({
  rows,
  perms,
  expanded,
  onToggle,
  emptyText,
}: {
  rows: ReturnDeskRow[]
  perms: ReturnPerms
  expanded: string | null
  onToggle: (id: string) => void
  emptyText: string
}) {
  if (rows.length === 0) {
    return (
      <p className="border-b border-[var(--color-border)] py-6 text-[12px] text-[var(--color-ink-3)]">
        {emptyText}
      </p>
    )
  }
  return (
    <div className="border-y border-[var(--color-border)]">
      {rows.map((r) => {
        const open = expanded === r.ret.id
        const step = returnStep(r.flow)
        return (
          <div
            key={r.ret.id}
            className="border-b border-[var(--color-border)] last:border-b-0"
          >
            <div
              role="button"
              tabIndex={0}
              onClick={() => onToggle(r.ret.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onToggle(r.ret.id)
                }
              }}
              className={`flex cursor-pointer items-center gap-6 px-5 py-3.5 transition-colors ${
                open ? 'bg-[#f1eee4]' : 'hover:bg-[#f1eee4]'
              }`}
            >
              <span className="mono w-32 shrink-0 truncate text-[13px] font-medium text-[var(--color-ink)]">
                {r.jobNo}
              </span>
              <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-[13px] font-medium text-[var(--color-ink)]">
                  {perms.showCustomer ? r.customer || '—' : r.product || '—'}
                </span>
                {perms.showCustomer && (
                  <span className="mt-0.5 truncate text-[11px] text-[var(--color-ink-3)]">
                    {r.product}
                  </span>
                )}
              </div>
              <span className="w-28 shrink-0 truncate text-[12px] text-[var(--color-ink-2)]">
                {r.ret.reason}
              </span>
              <DueColumn dueDate={r.ret.dueDate} />
              {/* 这一行唯一要人读的一句话: 卡在哪一步, 在等谁。 */}
              <span className="w-32 shrink-0 text-right">
                <span className="block text-[13px] text-[var(--color-ink)]">
                  {RETURN_STEP_LABEL[step]}
                </span>
                <span className="label mt-0.5 block text-[var(--color-ink-3)]">
                  {step === 'done' ? '流程走完' : `等${RETURN_STEP_OWNER[step]}`}
                </span>
              </span>
              <Link
                href={`/jobs/${r.ret.jobId}`}
                onClick={(e) => e.stopPropagation()}
                className="label shrink-0 text-[var(--color-ink-3)] underline-offset-2 hover:text-[var(--color-ink)] hover:underline"
              >
                工单
              </Link>
            </div>
            {open && <ReturnFlowPanel row={r} perms={perms} />}
          </div>
        )
      })}
    </div>
  )
}

function DueColumn({ dueDate }: { dueDate: string }) {
  const ds: DueState = dueState(dueDate)
  const days = daysFromToday(dueDate)
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
    <div className="flex w-28 shrink-0 flex-col items-end leading-tight">
      <span className={`mono text-[13px] ${tone}`}>{dueDate}</span>
      <span className="label mt-0.5 text-[var(--color-ink-3)]">{sub}</span>
    </div>
  )
}

// ── 其余两栏 (维持原样) ────────────────────────────────────────────────────

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
          ? 'font-semibold text-[var(--color-ink)]'
          : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
      }`}
    >
      {label}
      <span className="mono ml-2 text-[11px] text-[var(--color-ink-3)]">
        {count}
      </span>
      {active && (
        <span className="absolute inset-x-0 -bottom-px h-[2px] bg-[var(--color-ink)]" />
      )}
    </button>
  )
}

function filterJobs(rows: ReturnsListJob[], needle: string): ReturnsListJob[] {
  if (!needle) return rows
  return rows.filter((j) =>
    `${j.jobNo} ${j.customer} ${j.product}`.toLowerCase().includes(needle),
  )
}

function filterClosed(rows: ClosedReturnRow[], needle: string): ClosedReturnRow[] {
  if (!needle) return rows
  return rows.filter((r) =>
    `${r.jobNo} ${r.customer} ${r.product}`.toLowerCase().includes(needle),
  )
}

// Candidates render greyed by design — every row here is a finished/shipped
// job, and the muting communicates "done; pick one to start a return".
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
      <p className="border-b border-[var(--color-border)] py-6 text-[12px] text-[var(--color-ink-3)]">
        {emptyText}
      </p>
    )
  }
  return (
    <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
      {rows.map((j) => (
        <li key={j.id}>
          <button
            type="button"
            onClick={() => onPick(j)}
            className="flex w-full items-center gap-6 px-5 py-3.5 text-left opacity-60 transition-[opacity,background-color] hover:bg-[#f1eee4] hover:opacity-100"
          >
            <span className="mono w-32 shrink-0 truncate text-[13px] font-medium text-[var(--color-ink-2)]">
              {j.jobNo}
            </span>
            <div className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-[13px] font-medium text-[var(--color-ink-2)]">
                {j.customer || '—'}
              </span>
              <span className="mt-0.5 truncate text-[11px] text-[var(--color-ink-3)]">
                {j.product}
              </span>
            </div>
            <ShipDateColumn ship={j.shipDate} days={j.daysSinceShip} muted />
            <Link
              href={`/jobs/${j.id}`}
              onClick={(e) => e.stopPropagation()}
              className="label text-[var(--color-ink-3)] underline-offset-2 hover:text-[var(--color-ink)] hover:underline"
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
    return <span className="label w-32 text-right text-[var(--color-ink-4)]">—</span>
  }
  return (
    <div className="flex w-32 shrink-0 flex-col items-end leading-tight">
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
  showCustomer,
  emptyText,
}: {
  rows: ClosedReturnRow[]
  showCustomer: boolean
  emptyText: string
}) {
  if (rows.length === 0) {
    return (
      <p className="border-b border-[var(--color-border)] py-6 text-[12px] text-[var(--color-ink-3)]">
        {emptyText}
      </p>
    )
  }
  return (
    <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
      {rows.map((r) => (
        <li key={r.ret.id}>
          <Link
            href={`/jobs/${r.ret.jobId}`}
            className="flex items-center gap-6 px-5 py-3.5 transition-colors hover:bg-[#f1eee4]"
          >
            <span className="mono w-32 shrink-0 truncate text-[13px] font-medium text-[var(--color-ink)]">
              {r.jobNo}
            </span>
            <div className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-[13px] font-medium text-[var(--color-ink)]">
                {showCustomer ? r.customer || '—' : r.product || '—'}
              </span>
              {showCustomer && (
                <span className="mt-0.5 truncate text-[11px] text-[var(--color-ink-3)]">
                  {r.product}
                </span>
              )}
            </div>
            <span className="w-28 shrink-0 truncate text-[12px] text-[var(--color-ink-2)]">
              {r.ret.reason}
              {r.ret.reasonText && (
                <span className="mt-0.5 block truncate text-[10px] text-[var(--color-ink-3)]">
                  {r.ret.reasonText}
                </span>
              )}
            </span>
            <span className="mono w-24 shrink-0 text-right text-[11px] text-[var(--color-ink-3)]">
              {(r.ret.closedAt ?? r.ret.createdAt).slice(0, 10)}
            </span>
            <span className="label text-[var(--color-ink-3)]">打开 →</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
