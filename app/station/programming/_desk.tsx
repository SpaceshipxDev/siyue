'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { daysFromToday, dueState, type DueState, type StageStatus } from '@/lib/data'
import { mutate } from '@/lib/mutate'
import { drawingsByComponent, type DrawingFile } from '@/lib/drawing'
import type { NcProgram } from '@/lib/nc-program'
import { PartBlock } from '@/app/_programming'

// 编程台 —— 一行一个要编的件, 按交期排。
//
// 每一行只回答三件事, 从左到右:
//   编什么   工号 · 零件 · 材质数量
//   编得动吗 图纸有没有 (没图是编不动的, 所以它是红的)
//   编好了吗 程序号出了没有
//
// 点开一行, 下面摊开的是工单页上那同一块面板 (图纸 + 程序单), 不是另写一份 ——
// 编程员在哪儿看到的都得是同一个东西。
//
// 报完成就在这一行上: 出完程序点一下, 后面的操机站立刻就看得到活来了。

export type DeskRow = {
  jobId: string
  jobNo: string
  product: string
  dueDate: string
  status: StageStatus
  componentId: string
  name: string
  qty: number
  note?: string
  partNo?: string
  material?: string
  process?: string
  surfaceTreatment?: string
  imageUrl?: string
  programs: NcProgram[]
  reusable: NcProgram[]
}

type Lens = 'todo' | 'doing' | 'all'

export function ProgrammingDesk({
  rows,
  drawings,
  canUpload,
  canWrite,
  canReport,
}: {
  rows: DeskRow[]
  drawings: DrawingFile[]
  canUpload: boolean
  canWrite: boolean
  canReport: boolean
}) {
  const [lens, setLens] = useState<Lens>('all')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  // 图纸和程序在这一页上是活的 (传一份、加一条, 行上的字立刻变), 所以本地存
  // 一份, 不靠整页刷新。
  const [files, setFiles] = useState(drawings)
  const [programs, setPrograms] = useState<NcProgram[]>(() =>
    rows.flatMap((r) => r.programs),
  )
  const [doneIds, setDoneIds] = useState<Set<string>>(() => new Set())

  const dByPart = useMemo(() => drawingsByComponent(files), [files])
  const pByPart = useMemo(() => {
    const by = new Map<string, NcProgram[]>()
    for (const p of programs) {
      by.set(p.componentId, [...(by.get(p.componentId) ?? []), p])
    }
    return by
  }, [programs])

  const needle = q.trim().toLowerCase()
  const visible = useMemo(() => {
    return rows
      .filter((r) => !doneIds.has(r.componentId))
      .filter((r) =>
        lens === 'todo'
          ? r.status === 'pending'
          : lens === 'doing'
            ? r.status === 'in_progress'
            : true,
      )
      .filter((r) =>
        needle
          ? `${r.jobNo} ${r.name} ${r.partNo ?? ''} ${r.product}`
              .toLowerCase()
              .includes(needle)
          : true,
      )
      .sort(
        (a, b) =>
          a.dueDate.localeCompare(b.dueDate) || a.jobNo.localeCompare(b.jobNo),
      )
  }, [rows, doneIds, lens, needle])

  const live = rows.filter((r) => !doneIds.has(r.componentId))
  const noDrawing = live.filter(
    (r) => (dByPart.get(r.componentId) ?? []).length === 0,
  ).length
  const counts = {
    todo: live.filter((r) => r.status === 'pending').length,
    doing: live.filter((r) => r.status === 'in_progress').length,
    all: live.length,
  }

  return (
    <main className="w-full flex-1 px-4 py-6 md:px-10 md:py-8">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
        <div>
          <h2 className="text-[26px] font-semibold tracking-tight text-[var(--color-ink)]">
            编程
          </h2>
          <p className="mt-2 text-[13px] text-[var(--color-ink-2)]">
            {counts.all} 个件要编
            {noDrawing > 0 ? (
              <>
                <span className="mx-1.5 text-[var(--color-ink-4)]">·</span>
                <span className="text-[var(--color-overdue)]">
                  {noDrawing} 个还没有图纸
                </span>
              </>
            ) : counts.all > 0 ? (
              <>
                <span className="mx-1.5 text-[var(--color-ink-4)]">·</span>
                <span className="text-[var(--color-success)]">图纸都齐了</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="w-[280px]">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜 · 工号 / 零件 / 料号"
            className="w-full border-b border-[var(--color-border-strong)] bg-transparent py-2 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-ink)] focus:outline-none"
          />
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2">
        {(
          [
            ['all', '全部', counts.all],
            ['todo', '待编', counts.todo],
            ['doing', '在编', counts.doing],
          ] as [Lens, string, number][]
        ).map(([k, label, n]) => (
          <button
            key={k}
            type="button"
            onClick={() => setLens(k)}
            className={`text-[14px] tracking-tight transition-colors ${
              lens === k
                ? 'font-semibold text-[var(--color-ink)]'
                : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
            }`}
          >
            {label}
            <span className="mono ml-1.5 text-[11px] text-[var(--color-ink-3)]">
              {n}
            </span>
          </button>
        ))}
        <Link
          href="/?stage=编程"
          className="ml-auto text-[12px] text-[var(--color-ink-3)] underline underline-offset-2 hover:text-[var(--color-ink)]"
        >
          工段看板 →
        </Link>
      </div>

      <div className="mt-5 border-y border-[var(--color-border)]">
        {visible.length === 0 ? (
          <p className="py-16 text-center text-[13px] text-[var(--color-ink-3)]">
            {needle || lens !== 'all' ? '没有匹配的件' : '没有要编的件'}
          </p>
        ) : (
          visible.map((r) => {
            const parts = dByPart.get(r.componentId) ?? []
            const progs = pByPart.get(r.componentId) ?? []
            const expanded = open === r.componentId
            return (
              <div
                key={r.componentId}
                className="border-b border-[var(--color-border)] last:border-b-0"
              >
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() =>
                    setOpen((cur) => (cur === r.componentId ? null : r.componentId))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setOpen((cur) =>
                        cur === r.componentId ? null : r.componentId,
                      )
                    }
                  }}
                  className={`flex cursor-pointer items-center gap-5 px-3 py-3 transition-colors ${
                    expanded ? 'bg-[#f1eee4]' : 'hover:bg-[#f1eee4]'
                  }`}
                >
                  <span className="mono w-28 shrink-0 truncate text-[12.5px] text-[var(--color-ink-2)]">
                    {r.jobNo}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate text-[14px] font-medium text-[var(--color-ink)]">
                      {r.name}
                      {r.partNo && (
                        <span className="mono ml-2 text-[11.5px] font-normal text-[var(--color-ink-3)]">
                          {r.partNo}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 truncate text-[11.5px] text-[var(--color-ink-3)]">
                      {[r.material, `${r.qty} 件`, r.process]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>

                  {/* 图纸 —— 没图是编不动的, 所以这一格是红的 */}
                  <span className="w-20 shrink-0 text-[12.5px]">
                    {parts.length > 0 ? (
                      <span className="text-[var(--color-ink-2)]">
                        图纸 {parts.length}
                      </span>
                    ) : (
                      <span className="text-[var(--color-overdue)]">缺图纸</span>
                    )}
                  </span>

                  {/* 程序 —— 出了就把程序号摆出来, 操机认的就是这个 */}
                  <span className="mono w-40 shrink-0 truncate text-[12.5px]">
                    {progs.length > 0 ? (
                      <span className="text-[var(--color-ink)]">
                        {progs.map((p) => p.no).join(' · ')}
                      </span>
                    ) : (
                      <span className="text-[var(--color-ink-4)]">未出程序</span>
                    )}
                  </span>

                  <DueCol dueDate={r.dueDate} />

                  <span
                    className="w-[92px] shrink-0 text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {canReport && (
                      <ReportButton
                        row={r}
                        hasProgram={progs.length > 0}
                        onDone={() =>
                          setDoneIds((s) => new Set(s).add(r.componentId))
                        }
                      />
                    )}
                  </span>
                </div>

                {expanded && (
                  <div className="bg-[#faf8f3] px-3 pb-1">
                    {/* 工单页上那同一块面板 —— 一处改, 两处都对。 */}
                    <PartBlock
                      jobId={r.jobId}
                      part={{
                        componentId: r.componentId,
                        seq: '',
                        name: r.name,
                        qty: r.qty,
                        partNo: r.partNo,
                        material: r.material,
                        process: r.process,
                        surfaceTreatment: r.surfaceTreatment,
                        notes: r.note,
                        imageUrl: r.imageUrl,
                      }}
                      drawings={parts}
                      programs={progs}
                      reusable={progs.length === 0 ? r.reusable : []}
                      canUpload={canUpload}
                      canWrite={canWrite}
                      onDrawingAdded={(d) => setFiles((prev) => [d, ...prev])}
                      onDrawingRemoved={(id) =>
                        setFiles((prev) => prev.filter((x) => x.id !== id))
                      }
                      onProgramAdded={(p) => setPrograms((prev) => [...prev, p])}
                      onProgramRemoved={(id) =>
                        setPrograms((prev) => prev.filter((x) => x.id !== id))
                      }
                    />
                    <p className="pb-3 text-[12px]">
                      <Link
                        href={`/jobs/${r.jobId}`}
                        className="text-[var(--color-ink-3)] underline underline-offset-2 hover:text-[var(--color-ink)]"
                      >
                        打开整张工单 →
                      </Link>
                    </p>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </main>
  )
}

function DueCol({ dueDate }: { dueDate: string }) {
  const ds: DueState = dueState(dueDate)
  const days = daysFromToday(dueDate)
  const tone =
    ds === 'overdue'
      ? 'text-[var(--color-overdue)]'
      : ds === 'today'
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--color-ink)]'
  return (
    <div className="flex w-24 shrink-0 flex-col items-end leading-tight">
      <span className={`mono text-[12.5px] ${tone}`}>{dueDate || '—'}</span>
      {dueDate && (
        <span className="label mt-0.5 text-[var(--color-ink-3)]">
          {ds === 'overdue'
            ? `逾期 ${Math.abs(days)} 天`
            : ds === 'today'
              ? '今天'
              : `${days} 天`}
        </span>
      )}
    </div>
  )
}

// 开始 / 编好了 —— 跟工段看板上点的是同一个动作, 所以报工、看板、下游站台
// 立刻都对得上。没出程序就点完成会先问一句: 程序号没进系统, 操机还是得来问人。
function ReportButton({
  row,
  hasProgram,
  onDone,
}: {
  row: DeskRow
  hasProgram: boolean
  onDone: () => void
}) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const run = (kind: 'startStage' | 'finishStage') => {
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind,
          jobId: row.jobId,
          componentId: row.componentId,
          stage: '编程',
        })
        if (kind === 'finishStage') onDone()
      } catch (e) {
        setError(e instanceof Error ? e.message : '报工失败')
      }
    })
  }

  if (error)
    return (
      <span className="text-[11px] text-[var(--color-overdue)]">{error}</span>
    )

  if (row.status === 'pending')
    return (
      <button
        type="button"
        disabled={pending}
        onClick={() => run('startStage')}
        className="rounded-[2px] border border-[var(--color-border-strong)] px-2.5 py-1 text-[12px] text-[var(--color-ink-2)] transition-colors hover:text-[var(--color-ink)] disabled:opacity-40"
      >
        {pending ? '…' : '开始'}
      </button>
    )

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (
          !hasProgram &&
          !confirm('程序号还没进系统 — 操机在机台前还是得来问你。确定报完成?')
        )
          return
        run('finishStage')
      }}
      className="rounded-[2px] bg-[var(--color-ink)] px-2.5 py-1 text-[12px] text-[var(--color-surface)] transition-opacity hover:opacity-80 disabled:opacity-40"
    >
      {pending ? '…' : '编好了'}
    </button>
  )
}
