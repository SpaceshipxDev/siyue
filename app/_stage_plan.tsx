'use client'

import { useState, useTransition } from 'react'
import { DatePop } from '@/app/_datepop'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import {
  fmtPlanLabel,
  stagePlanState,
  type RollupKind,
  type Stage,
  type StagePlanTone,
} from '@/lib/data'

// 计划交期 (排产) — a planned finish date (optionally an hour) per 工段, holistic
// for the whole job. Display/planning only: it NEVER feeds the contract 交期's
// color, sort, urgency, or the station queue order. Set here in one clean band;
// each station later reads its OWN date in its queue (本工段…). Deliberately NOT
// inside the parts grid — that bloated the columns and clipped the picker.

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

// One 工段's planned-date control. Editable → the DatePop (calendar + optional
// hour); read-only → a static date. Empty reads as a quiet '—', consistent with
// every other empty field in the app. Writes only this stage (atomic server
// merge), so sibling stages are never touched.
function StagePlanDate({
  jobId,
  stage,
  value,
  rollupKind,
  canEdit,
}: {
  jobId: string
  stage: Stage
  value?: string
  rollupKind: RollupKind
  canEdit: boolean
}) {
  const [local, setLocal] = useState(value ?? '')
  const [, start] = useTransition()
  const st = stagePlanState(local || undefined, rollupKind)
  const toneClass = planToneClass(st?.tone)

  const commit = (next: string) => {
    if (next === local) return
    const prev = local
    setLocal(next)
    start(async () => {
      try {
        await mutate({ kind: 'setStagePlan', jobId, stage, value: next || null })
      } catch (e) {
        setLocal(prev)
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
        className={`mono text-[14px] font-medium tabular-nums ${local ? toneClass : 'text-[var(--color-ink-3)]'}`}
      >
        {local ? fmtPlanLabel(local) : '—'}
      </span>
    )
  }

  return (
    <DatePop
      value={local}
      onChange={commit}
      withTime
      clearable
      hideIcon
      placeholder="—"
      formatLabel={fmtPlanLabel}
      triggerClass="text-[14px] font-medium"
      tone={local ? toneClass : 'text-[var(--color-ink-3)]'}
    />
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
  stagePlan: Partial<Record<Stage, string>>
  stages: { stage: Stage; kind: RollupKind }[]
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
