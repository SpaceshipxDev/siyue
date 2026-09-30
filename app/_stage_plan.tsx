'use client'

import { useEffect, useState, useTransition } from 'react'
import { DatePop } from '@/app/_datepop'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import {
  fmtPlanLabel,
  linkedPlanKeys,
  SHARED_PLAN_STAGES,
  stagePlanState,
  type PlanKey,
  type RollupKind,
  type StagePlanTone,
} from '@/lib/data'

// 计划交期 (排产) — a planned finish date (optionally an hour) per 工段, holistic
// for the whole job. Display/planning only: it NEVER feeds the contract 交期's
// color, sort, urgency, or the station queue order. Each station later reads its
// OWN date in its queue (本工段…).
//
// Two surfaces render the same StagePlanDate control:
//   - The job detail page embeds StagePlanDate directly in a pinned "plan row"
//     inside the 零件进度 table — the plan date is a property of the stage column,
//     so it lives optically aligned over the cells it governs.
//   - The import review page still mounts StagePlanBand (the standalone
//     horizontal band below) — no parts grid to embed into there.

// Calm, confident palette: a planned date is always strong full-ink — it should
// read as a real commitment, not a faint suggestion. Red is the ONLY accent, and
// only when a stage is actually late (past its plan, not yet done). No amber
// middle state — one signal, no flutter.
export function planToneClass(tone: StagePlanTone | undefined): string {
  switch (tone) {
    case 'slipping':
      return 'text-[var(--color-overdue)]'
    case 'done':
      return 'text-[var(--color-ink-3)]'
    default:
      // onTrack / due / soon — all strong ink.
      return 'text-[var(--color-ink)]'
  }
}

// 操机~丝印 共用一个节点: 改一格, 同一张单上另外四格当场跟着变, 不用等页面
// 刷新 —— 广播一下, 兄弟格子听到就换成同一个日子。
const SHARED_EVENT = 'yn:stage-plan-shared'
type SharedDetail = { jobId: string; keys: PlanKey[]; value: string; from: PlanKey }

// One 工段's planned-date control. Editable → the DatePop (calendar + optional
// hour); read-only → a static date. Empty reads as a quiet '—', consistent with
// every other empty field in the app. Writes only this stage (atomic server
// merge), so sibling stages are never touched.
export function StagePlanDate({
  jobId,
  stage,
  value,
  rollupKind,
  canEdit,
  triggerClass = 'text-[14px] font-medium',
}: {
  jobId: string
  stage: PlanKey
  value?: string
  rollupKind: RollupKind
  canEdit: boolean
  /** Size/weight classes for the date label. Defaults to the band's 14px; the
   *  job page's dense plan row passes a smaller 12.5px. */
  triggerClass?: string
}) {
  const [local, setLocal] = useState(value ?? '')
  const [, start] = useTransition()
  // 服务端送来新值 (刷新之后) —— 以它为准。
  const [seen, setSeen] = useState(value ?? '')
  if ((value ?? '') !== seen) {
    setSeen(value ?? '')
    setLocal(value ?? '')
  }
  const shared = (SHARED_PLAN_STAGES as PlanKey[]).includes(stage)

  useEffect(() => {
    if (!shared) return
    const on = (e: Event) => {
      const d = (e as CustomEvent<SharedDetail>).detail
      if (d.jobId !== jobId || d.from === stage || !d.keys.includes(stage)) return
      setLocal(d.value)
    }
    window.addEventListener(SHARED_EVENT, on)
    return () => window.removeEventListener(SHARED_EVENT, on)
  }, [jobId, stage, shared])
  const st = stagePlanState(local || undefined, rollupKind)
  const toneClass = planToneClass(st?.tone)

  const commit = (next: string) => {
    if (next === local) return
    const prev = local
    setLocal(next)
    if (shared) {
      window.dispatchEvent(
        new CustomEvent<SharedDetail>(SHARED_EVENT, {
          detail: { jobId, keys: linkedPlanKeys(stage), value: next, from: stage },
        }),
      )
    }
    start(async () => {
      try {
        await mutate({ kind: 'setStagePlan', jobId, stage, value: next || null })
      } catch (e) {
        setLocal(prev)
        if (shared) {
          window.dispatchEvent(
            new CustomEvent<SharedDetail>(SHARED_EVENT, {
              detail: { jobId, keys: linkedPlanKeys(stage), value: prev, from: stage },
            }),
          )
        }
        showToast(
          `保存失败 · ${e instanceof Error ? e.message : '网络中断'}`,
          'warning',
        )
      }
    })
  }

  if (!canEdit) {
    return (
      <span
        className={`mono tabular-nums ${triggerClass} ${local ? toneClass : 'text-[var(--color-ink-3)]'}`}
      >
        {local ? fmtPlanLabel(local) : '—'}
      </span>
    )
  }

  return (
    <span title={shared ? '操机 · 手工 · 打磨 · 喷漆 · 丝印 共用这一个日子，改一格五格一起改' : undefined}>
    <DatePop
      value={local}
      onChange={commit}
      withTime
      clearable
      hideIcon
      placeholder="—"
      formatLabel={fmtPlanLabel}
      triggerClass={triggerClass}
      tone={local ? toneClass : 'text-[var(--color-ink-3)]'}
      // Portal the panel: the plan row lives inside the 零件进度 table's
      // horizontal-scroll wrapper, which clips an absolutely-positioned panel
      // to a sliver. Harmless for the import band, essential in the table.
      portal
    />
    </span>
  )
}

// 排产 · 计划交期 — the job's per-工段 schedule as ONE clean horizontal band. Every
// cell is uniform (工段 name over its planned date), evenly distributed, aligned.
// Lives outside the parts grid so it never bloats the columns and the picker
// opens into open space. `stages` are the plannable 工段 this job runs through
// (na stages are dropped upstream), each with its rollup for slip-tinting.
export function StagePlanBand({
  jobId,
  stagePlan,
  stages,
  canEdit,
}: {
  jobId: string
  stagePlan: Partial<Record<PlanKey, string>>
  stages: { stage: PlanKey; kind: RollupKind }[]
  canEdit: boolean
}) {
  if (!stages.length) return null
  return (
    <div className="flex rounded-[2px] border border-[var(--color-border)] divide-x divide-[var(--color-border)] bg-[var(--color-surface)]">
      {stages.map(({ stage, kind }) => (
        <div
          key={stage}
          className="flex flex-1 flex-col items-center gap-2 px-2 py-3.5"
        >
          <span className="text-[12px] font-medium tracking-wide text-[var(--color-ink-2)]">
            {stage}
          </span>
          <StagePlanDate
            jobId={jobId}
            stage={stage}
            value={stagePlan[stage]}
            rollupKind={kind}
            canEdit={canEdit}
          />
        </div>
      ))}
    </div>
  )
}
