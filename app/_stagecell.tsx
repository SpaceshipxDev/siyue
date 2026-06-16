import {
  blockActivityLabel,
  canStartStage,
  daysFromToday,
  effectiveStageState,
  type Component,
  type Stage,
} from '@/lib/data'
import { StageCell } from './_ui'
import { StageCellButton } from './_cell'
import { InspectionCell } from './_inspection_cell'

function fmtDate(d: string | undefined): string | undefined {
  if (!d) return undefined
  if (d.length === 10 && d[4] === '-') return d.slice(5)
  return d
}

export function EffectiveStageCell({
  jobId,
  component,
  stage,
  interactive = true,
}: {
  jobId: string
  component: Component
  stage: Stage
  interactive?: boolean
}) {
  const eff = effectiveStageState(component, stage)

  if (eff.kind === 'na') {
    return (
      <div
        className="relative h-full w-full"
        aria-label={`${stage} · 不适用`}
        title="此零件不经过该工段"
      >
        <svg
          className="absolute inset-0 h-full w-full"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line
            x1="0%"
            y1="100%"
            x2="100%"
            y2="0%"
            stroke="var(--color-ink-4)"
            strokeWidth="1"
            shapeRendering="crispEdges"
          />
        </svg>
      </div>
    )
  }

  if (eff.kind === 'outsourced') {
    const days = daysFromToday(eff.block.expectedReturn)
    const overdue = days < 0
    // Vendor name is intentionally NOT rendered here — it's already shown in
    // the ExternalBadge under the 零件 name and in the 外协 section below the
    // table. Repeating it inside this 90px-wide cell pushes the layout and
    // shows raw "v-…" ids when the vendor list isn't in scope.
    //
    // The top label is the activity name (外发氧化, 外发CNC, …) — that's the
    // boss's word for what's happening at this cell. Fallback to plain "外协"
    // for legacy blocks that never had an activity set.
    const label = blockActivityLabel(eff.block)
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-1 leading-none px-1 py-2"
        title={`${label} · 预计回厂 ${fmtDate(eff.block.expectedReturn) ?? '—'}`}
      >
        <span
          className={`text-[10px] font-semibold tracking-wider truncate max-w-full ${
            overdue ? 'text-[var(--color-overdue)]' : 'text-[var(--color-warning)]'
          }`}
        >
          {label}
        </span>
        <span
          className={`mono text-[10px] ${
            overdue ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink-2)]'
          }`}
        >
          回 {fmtDate(eff.block.expectedReturn)}
        </span>
      </div>
    )
  }

  // After the na guard above, the stage row exists for sure (effectiveStageState
  // only returns non-na kinds when component.stages[stage] is defined).
  const rawState = component.stages[stage]!

  // A closed (returned) outsource block no longer forces a dead vendor ✓ —
  // effectiveStageState reverts the stage to its in-house status, so the cell
  // falls through to the normal interactive StageCellButton below and the
  // worker can 报工 the remaining finishing work (手工 etc.). The cell is locked
  // (kind 'outsourced', handled above) only while the part is still at the
  // vendor.

  // 检验 swaps the ▶/⏸/✓ pair for the verdict cell (重做/返修/外修/OK +
  // 检验照片). Read-only viewers still get the cell — the modal opens in
  // view mode so any station can SEE the verdict and photos.
  if (stage === '检验') {
    return (
      <InspectionCell
        jobId={jobId}
        componentId={component.id}
        componentName={component.name}
        state={rawState}
        canStart={canStartStage(component, stage)}
        photos={component.inspectionPhotos}
        readOnly={!interactive}
      />
    )
  }

  if (!interactive) {
    return <StageCell state={rawState} qty={component.qty} />
  }

  return (
    <StageCellButton
      jobId={jobId}
      componentId={component.id}
      componentName={component.name}
      componentQty={component.qty}
      stage={stage}
      state={rawState}
      canStart={canStartStage(component, stage)}
    />
  )
}
