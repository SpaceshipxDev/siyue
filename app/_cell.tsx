'use client'

import { useState, useTransition } from 'react'
import type { Stage, StageState } from '@/lib/data'
import { STAGES } from '@/lib/data'
import { Pause, stageTimeHint } from './_ui'
import { mutate } from '@/lib/mutate'
import { RowTimer } from './_row_timer'
import { QtyEditor } from './_qty_editor'

// Stage button writes go through /api/mutate (~30-byte JSON) instead of
// server actions. Server-action responses inline the current page's RSC,
// which the GFW shreds for mainland users on the HK VM.

// "Done ✓" cells used to be clickable only for 60 seconds after the same
// React instance clicked finish — outside that window the cell rendered as a
// plain <div> with no handler. The head couldn't re-open a finished stage
// after refreshing or after a teammate finished it, and worse, on the master
// board such cells were wrapped in a <Link> to /jobs/[id], so a click flashed
// brown then navigated, looking like "the click did nothing." Done cells in
// the head's own stage column are now always undoable.

export function StageCellButton({
  jobId,
  componentId,
  componentName,
  componentQty,
  stage,
  state,
  size = 'md',
  canStart = true,
}: {
  jobId: string
  componentId: string
  componentName: string
  componentQty: number
  stage: Stage
  state: StageState
  size?: 'md' | 'lg'
  canStart?: boolean
}) {
  const [pending, start] = useTransition()
  const [optimistic, setOptimistic] = useState<StageState | null>(null)
  const [error, setError] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)

  // Hold the optimistic value until the server-pushed `state` prop actually
  // catches up. Without this, after the action resolves the optimistic clears
  // for one render cycle before the new RSC payload arrives — that one frame
  // is what shows the "▶ then ⏸" flicker the user is reporting. Driven by a
  // prev-prop sentinel so the clear happens during render, not in an effect.
  const [seenStatus, setSeenStatus] = useState(state.status)
  if (seenStatus !== state.status) {
    setSeenStatus(state.status)
    if (optimistic && state.status === optimistic.status) {
      setOptimistic(null)
    }
  }

  const display = optimistic ?? state
  const padding = size === 'lg' ? 'py-3' : 'py-2'

  const onStart = () => {
    setError(false)
    setOptimistic({ status: 'in_progress' })
    start(async () => {
      try {
        await mutate({ kind: 'startStage', jobId, componentId, stage })
      } catch {
        setOptimistic(null)
        setError(true)
      }
    })
  }

  const onFinish = () => {
    setError(false)
    setOptimistic({ status: 'done', completedAt: 'now' })
    start(async () => {
      try {
        await mutate({ kind: 'finishStage', jobId, componentId, stage })
      } catch {
        setOptimistic(null)
        setError(true)
      }
    })
  }

  const onUndo = () => {
    setError(false)
    setOptimistic({ status: 'in_progress' })
    start(async () => {
      try {
        await mutate({ kind: 'undoStage', jobId, componentId, stage })
      } catch {
        setOptimistic(null)
        setError(true)
      }
    })
  }

  const onSubmitQty = (qty: number) => {
    setError(false)
    const willFinish = qty >= componentQty
    setEditorOpen(false)
    if (willFinish) {
      setOptimistic({ status: 'done', completedAt: 'now' })
    } else {
      setOptimistic({ status: 'in_progress', doneQty: qty > 0 ? qty : undefined })
    }
    start(async () => {
      try {
        await mutate({
          kind: 'setStageDoneQty',
          jobId,
          componentId,
          stage,
          qty,
        })
      } catch {
        setOptimistic(null)
        setError(true)
      }
    })
  }

  // Tracks whether the multi-qty partial-edit affordance applies. qty<=1 has
  // nothing to partial — a single click already finishes the only piece.
  const supportsPartial = componentQty > 1

  if (display.status === 'pending') {
    if (!canStart) {
      return (
        <div
          className={`flex h-full w-full items-center justify-center ${padding}`}
          aria-label={`${stage} · 待前序工段完成`}
        >
          <span className="mono text-[13px] text-[var(--color-ink-4)]">—</span>
        </div>
      )
    }
    return (
      <button
        type="button"
        disabled={pending}
        onClick={onStart}
        className={`group flex h-full w-full items-center justify-center ${padding} transition-colors ${error ? 'bg-[var(--color-overdue-soft)]' : 'hover:bg-[#f1eee4]'} focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] disabled:opacity-60`}
        aria-label={`${stage} · ${error ? '失败 · 重试' : '开始'}`}
      >
        {error ? (
          <span className="mono text-[11px] font-medium text-[var(--color-overdue)]">
            失败
          </span>
        ) : (
          <span className="text-[14px] text-[var(--color-ink-4)] group-hover:text-[var(--color-ink-2)]">
            ▶
          </span>
        )}
      </button>
    )
  }

  if (display.status === 'in_progress') {
    const doneSoFar = display.doneQty ?? 0
    return (
      <div
        className={`relative flex h-full w-full flex-col ${
          error ? 'bg-[var(--color-overdue-soft)]' : 'bg-[var(--color-warning-soft)]'
        } ${pending ? 'opacity-60' : ''}`}
      >
        <button
          type="button"
          disabled={pending}
          onClick={onFinish}
          className={`flex w-full flex-1 items-center justify-center ${
            supportsPartial ? 'pt-2 pb-1' : padding
          } transition-colors hover:brightness-95 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] disabled:cursor-not-allowed`}
          aria-label={`${stage} · ${error ? '失败 · 重试' : `完成全部 ${componentQty}`}`}
        >
          {error ? (
            <span className="mono text-[11px] font-medium text-[var(--color-overdue)]">
              失败
            </span>
          ) : (
            <Pause size={12} className="text-[var(--color-warning)]" />
          )}
        </button>
        {supportsPartial && !error ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => setEditorOpen(true)}
            aria-label={`${stage} · 编辑完成数量`}
            title="编辑完成数量"
            className="flex w-full items-center justify-center pb-1.5 mono text-[10px] tracking-wider text-[var(--color-warning)]/80 hover:text-[var(--color-warning)] hover:underline underline-offset-[3px] decoration-dotted focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] disabled:cursor-not-allowed"
          >
            {doneSoFar}/{componentQty}
          </button>
        ) : null}
        {editorOpen ? (
          <QtyEditor
            stage={stage}
            componentName={componentName}
            totalQty={componentQty}
            currentDone={doneSoFar}
            onCancel={() => setEditorOpen(false)}
            onSubmit={onSubmitQty}
            pending={pending}
          />
        ) : null}
      </div>
    )
  }

  const doneInner = error ? (
    <span className="mono text-[11px] font-medium text-[var(--color-overdue)]">
      失败
    </span>
  ) : (
    <>
      <span className="text-[16px] leading-none font-semibold text-[var(--color-success)]">
        ✓
      </span>
      {state.completedAt ? (
        <span className="mono text-[10px] text-[var(--color-ink-3)]">
          {state.completedAt}
        </span>
      ) : null}
    </>
  )
  // 报工 attribution surfaces on hover via the native title — a styled popover
  // gets clipped by the cell/row overflow in every grid this renders in, so the
  // title is the only thing that actually shows. `state.by` is server truth
  // (optimistic finishes don't carry it yet); it fills in on the server echo.
  const attribution = state.by
    ? `经手 ${state.by}${stageTimeHint(state.finishedAt)}`
    : undefined
  return (
    <button
      type="button"
      disabled={pending}
      onClick={onUndo}
      title={attribution ?? '点击撤销 · 退回到进行中'}
      aria-label={`${stage} · ${error ? '失败 · 重试' : '撤销完成'}${attribution ? ` · ${attribution}` : ''}`}
      className={`flex h-full w-full flex-col items-center justify-center gap-0.5 ${padding} ${optimistic?.status === 'done' ? 'animate-cell-done' : ''} ${error ? 'bg-[var(--color-overdue-soft)]' : 'hover:bg-[#f1eee4]'} focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] disabled:opacity-60`}
    >
      {doneInner}
    </button>
  )
}

type RowStatus = 'pending' | 'in_progress' | 'done'

type StageCounts = { inProgress: number; pending: number; done: number }

export function JobStageActionButton({
  jobId,
  stage,
  inProgress,
  pending: pendingCount,
  done,
  latestBy,
  latestDate,
  timer,
  subdued = false,
}: {
  jobId: string
  stage: Stage
  inProgress: number
  pending: number
  done: number
  /** 经手 — most recent finisher at this stage, for the done-cell hover hint. */
  latestBy?: string
  /** MM-DD of that finish, appended to the hover hint when present. */
  latestDate?: string
  /** When provided, render the live elapsed-time chip beneath the action label.
   * Used on the station master board to give the head a one-glance read of
   * "how long has this been waiting / running on me." */
  timer?: { since: string; tone: 'pending' | 'in_progress' } | null
  /** Suppress hover color shifts. The station master board passes true so the
   * highlighted-column row stays calm; the job detail keeps the default
   * hover brown to signal clickability. */
  subdued?: boolean
}) {
  const [transition, start] = useTransition()
  const [optimistic, setOptimistic] = useState<RowStatus | null>(null)
  const [error, setError] = useState(false)
  // Fresh counts echoed by /api/mutate after each job-stage write. The master
  // board fetches its rows ONCE per navigation (_master_loaders.tsx), so the
  // count props go stale the moment we write. Before this echo existed, the
  // in_progress branch below kept reading the mount-time `inProgress: 0` and
  // decided ▶-then-⏸ should START again instead of finish — the second tap
  // silently re-issued startJobStage forever until a full page reload.
  const [live, setLive] = useState<StageCounts | null>(null)

  // Server pushed genuinely new props (fresh fetch / remount) — drop the
  // local echo, props are newer. Render-time clear via a prev-prop sentinel,
  // same pattern as StageCellButton above.
  const propsKey = `${inProgress}|${pendingCount}|${done}`
  const [seenPropsKey, setSeenPropsKey] = useState(propsKey)
  if (seenPropsKey !== propsKey) {
    setSeenPropsKey(propsKey)
    setLive(null)
    setOptimistic(null)
  }

  const counts = live ?? { inProgress, pending: pendingCount, done }
  const total = counts.inProgress + counts.pending + counts.done
  // A job counts as "started" the moment ANY of its parts is in-flight or
  // already done at this stage — so a 1-done / 4-pending row shows yellow
  // "in_progress" on the workbench rather than reading as untouched.
  const allDone = counts.pending === 0 && counts.inProgress === 0 && counts.done > 0
  const nothingStarted = counts.inProgress === 0 && counts.done === 0
  const aggregate: RowStatus = allDone ? 'done' : nothingStarted ? 'pending' : 'in_progress'
  const display = optimistic ?? aggregate

  // Runs a job-stage write: optimistic glyph immediately, then adopt the
  // server's echoed counts as local truth (fallback = the transition we
  // expected, for old servers / echo read hiccups). Clearing optimistic only
  // once counts land avoids the one-frame flicker back to the pre-click
  // state on slow networks (Supabase round-trip).
  const run = (
    kind: 'startJobStage' | 'finishJobStage' | 'undoJobStage',
    glyph: RowStatus,
    fallback: StageCounts,
  ) => {
    setError(false)
    setOptimistic(glyph)
    start(async () => {
      try {
        const r = await mutate<{ counts: StageCounts }>({ kind, jobId, stage })
        setLive('data' in r && r.data ? r.data.counts : fallback)
        setOptimistic(null)
      } catch {
        setOptimistic(null)
        setError(true)
      }
    })
  }

  const onStart = () =>
    run('startJobStage', 'in_progress', {
      inProgress: counts.inProgress + counts.pending,
      pending: 0,
      done: counts.done,
    })

  const onFinish = () =>
    run('finishJobStage', 'done', {
      inProgress: 0,
      // 出货 sweeps pending parts too; other stages finish only in-flight.
      pending: stage === '出货' ? 0 : counts.pending,
      done: counts.done + counts.inProgress + (stage === '出货' ? counts.pending : 0),
    })

  const onUndo = () =>
    run('undoJobStage', 'in_progress', {
      inProgress: counts.inProgress + counts.done,
      pending: counts.pending,
      done: 0,
    })

  if (display === 'pending') {
    const startable = counts.pending > 0
    const hover = subdued ? '' : 'hover:bg-[#f1eee4]'
    const errorBg = error ? 'bg-[var(--color-overdue-soft)]' : ''
    return (
      <button
        type="button"
        disabled={transition || !startable}
        onClick={onStart}
        className={`group flex h-full w-full items-center justify-center px-3 py-3 transition-colors ${error ? errorBg : hover} focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] disabled:opacity-60 disabled:cursor-not-allowed`}
        aria-label={`${stage} · ${error ? '失败 · 重试' : '开始整单'}`}
      >
        <span className="flex flex-col items-center gap-1.5 leading-none">
          {error ? (
            <span className="mono text-[12px] font-medium text-[var(--color-overdue)]">
              失败
            </span>
          ) : (
            <span className="text-[18px] text-[var(--color-ink-3)] group-hover:text-[var(--color-ink)]">
              ▶
            </span>
          )}
          {error ? (
            <span className="mono text-[10px] text-[var(--color-ink-3)]">点击重试</span>
          ) : timer ? (
            <RowTimer
              since={timer.since}
              tone={timer.tone}
              className="mono text-[10px] text-[var(--color-ink-4)]"
            />
          ) : null}
        </span>
      </button>
    )
  }

  if (display === 'in_progress') {
    // Show progress as done/total (matches the master board's RollupCell).
    // Right after the user clicks ▶ on an all-pending job the fraction reads
    // 0/a — "0 finished out of a parts" — which is what the user expects.
    //
    // Click semantics: if there are in-progress parts, finish them. If the
    // job is yellow only because some parts are already done (with the rest
    // still pending and none in flight), clicking starts those remaining
    // pending parts instead — otherwise finishJobStage would no-op. Either
    // way the GLYPH is always ⏸: any part done or in flight means this stage
    // is underway — a triangle on a 3/4-done stage reads as "not started",
    // which is a lie.
    //
    // 出货 is the exception to the start-remaining detour: it's terminal, and
    // finishJobStage sweeps pending parts (+ cascades all prior stations,
    // 外协 included) for 出货 — so one tap always means "this order shipped".
    const hasInFlight = counts.inProgress > 0
    const finishes = hasInFlight || stage === '出货'
    const onAdvance = finishes ? onFinish : onStart
    const advanceLabel = finishes ? '完成整单' : '开始剩余零件'
    const hover = subdued ? '' : 'hover:brightness-95'
    const bg = error
      ? 'bg-[var(--color-overdue-soft)]'
      : 'bg-[var(--color-warning-soft)]'
    return (
      <button
        type="button"
        disabled={transition}
        onClick={onAdvance}
        className={`group flex h-full w-full items-center justify-center px-3 py-3 ${bg} transition-colors ${hover} focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] disabled:opacity-60`}
        aria-label={`${stage} · ${error ? '失败 · 重试' : advanceLabel}`}
      >
        <span className="flex flex-col items-center gap-1.5 leading-none">
          {error ? (
            <span className="mono text-[12px] font-medium text-[var(--color-overdue)]">
              失败
            </span>
          ) : (
            <Pause size={13} className="text-[var(--color-warning)]" />
          )}
          <span
            className={`inline-flex items-baseline gap-1.5 mono text-[11px] ${
              error ? 'text-[var(--color-overdue)]' : 'text-[var(--color-warning)]'
            }`}
          >
            <span>{error ? '点击重试' : `${counts.done}/${total}`}</span>
            {timer && !error ? (
              <>
                <span aria-hidden className="opacity-50">·</span>
                <RowTimer
                  since={timer.since}
                  tone={timer.tone}
                  className="opacity-70"
                />
              </>
            ) : null}
          </span>
        </span>
      </button>
    )
  }

  const doneInner = error ? (
    <span className="mono text-[12px] font-medium text-[var(--color-overdue)]">
      失败
    </span>
  ) : (
    <>
      <span className="text-[18px] leading-none font-semibold text-[var(--color-success)]">
        ✓
      </span>
      <span className="mono text-[10px] text-[var(--color-ink-3)]">{total} 件</span>
    </>
  )
  const hover = subdued ? '' : 'hover:bg-[#f1eee4]'
  const attribution = latestBy
    ? `最近经手 ${latestBy}${latestDate ? ` · ${latestDate}` : ''}`
    : undefined
  return (
    <button
      type="button"
      disabled={transition}
      onClick={onUndo}
      title={attribution ?? '点击撤销 · 退回到进行中'}
      aria-label={`${stage} · ${error ? '失败 · 重试' : '撤销整单完成'}${attribution ? ` · ${attribution}` : ''}`}
      className={`flex h-full w-full flex-col items-center justify-center gap-0.5 px-3 py-3 ${optimistic === 'done' ? 'animate-cell-done' : ''} ${error ? 'bg-[var(--color-overdue-soft)]' : hover} focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] disabled:opacity-60`}
    >
      {doneInner}
    </button>
  )
}

export function JobAssignSelect({
  jobId,
  fromStage,
}: {
  jobId: string
  fromStage: Stage
}) {
  const [pending, start] = useTransition()
  const others = STAGES.filter((s) => s !== fromStage)
  return (
    <select
      disabled={pending}
      defaultValue=""
      onChange={(e) => {
        const to = e.currentTarget.value as Stage
        if (!to) return
        start(async () => {
          await mutate({
            kind: 'assignJobToStage',
            jobId,
            fromStage,
            toStage: to,
          })
        })
        e.currentTarget.value = ''
      }}
      className="text-[12px] tracking-wider text-[var(--color-ink-2)] bg-transparent border border-[var(--color-border)] rounded-[2px] px-2 py-1 hover:border-[var(--color-ink-3)] focus:outline-none focus:border-[var(--color-ink)] cursor-pointer disabled:opacity-40"
      title="移交整单至其他工段"
    >
      <option value="">移交至 →</option>
      {others.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  )
}

export function AssignSelect({
  jobId,
  componentId,
  fromStage,
}: {
  jobId: string
  componentId: string
  fromStage: Stage
}) {
  const [pending, start] = useTransition()
  const others = STAGES.filter((s) => s !== fromStage)
  return (
    <select
      disabled={pending}
      defaultValue=""
      onChange={(e) => {
        const to = e.currentTarget.value as Stage
        if (!to) return
        start(async () => {
          await mutate({
            kind: 'assignToStage',
            jobId,
            componentId,
            fromStage,
            toStage: to,
          })
        })
        e.currentTarget.value = ''
      }}
      className="text-[12px] tracking-wider text-[var(--color-ink-2)] bg-transparent border border-[var(--color-border)] rounded-[2px] px-2 py-1 hover:border-[var(--color-ink-3)] focus:outline-none focus:border-[var(--color-ink)] cursor-pointer disabled:opacity-40"
      title="移交至其他工段"
    >
      <option value="">移交至 →</option>
      {others.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  )
}
