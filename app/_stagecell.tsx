import {
  canStartStage,
  daysFromToday,
  effectiveStageState,
  type Component,
  type Stage,
} from '@/lib/data'
import { StageCell } from './_ui'
import { StageCellButton } from './_cell'

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
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 leading-none px-1 py-2">
        <span
          className={`text-[10px] font-semibold tracking-wider ${
            overdue ? 'text-[var(--color-overdue)]' : 'text-[var(--color-warning)]'
          }`}
        >
          外协
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

  // Closed-block "done" — raw stage may still be pending; render static badge.
  // The cell is intentionally non-interactive: this stage was completed at a
  // vendor (closed outsource block), so there's no in-house state to undo
  // here. To re-open, the head must edit the outsource block in 外协 below
  // the table, not click this cell. We surface that explicitly via title /
  // aria-label so a head clicking on a "flat ✓" actually learns why it
  // didn't respond, instead of silently giving up.
  if (eff.kind === 'done' && rawState.status !== 'done') {
    const hint = eff.by
      ? `${stage} · 外协返回 (${eff.by}) · 在外协块中处理`
      : `${stage} · 外协返回 · 在外协块中处理`
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-0.5 leading-none px-1 py-2 cursor-help"
        title={hint}
        aria-label={hint}
      >
        <span className="text-[16px] leading-none font-semibold text-[var(--color-success)]">
          ✓
        </span>
        {eff.completedAt ? (
          <span className="mono text-[10px] text-[var(--color-ink-3)]">
            {fmtDate(eff.completedAt)}
          </span>
        ) : null}
      </div>
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
