'use client'

// 出货 column on the job detail sheet. 出货 is terminal and job-level: one
// tick means "this order left the building" — the same finishJobStage write
// the master board's 出货 cell issues, which sweeps every part (pending
// included), cascades all prior stations closed, and settles open vendor
// lines. All rows in the column therefore act as ONE control: they share
// this provider's optimistic state so a tick on any row flips the whole
// column instantly, and router.refresh() pulls the server truth (dates,
// 经手) in behind it.

import { createContext, useContext, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { StageState } from '@/lib/data'
import { mutate } from '@/lib/mutate'
import { stageTimeHint } from './_ui'

type ShipCtx = {
  optimistic: 'shipped' | 'unshipped' | null
  pending: boolean
  error: boolean
  canTick: boolean
  ship: () => void
  unship: () => void
}

const Ctx = createContext<ShipCtx | null>(null)

export function ShipProvider({
  jobId,
  shipped,
  canTick,
  children,
}: {
  jobId: string
  shipped: boolean
  canTick: boolean
  children: React.ReactNode
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [optimistic, setOptimistic] = useState<
    'shipped' | 'unshipped' | null
  >(null)
  const [error, setError] = useState(false)

  // Server truth caught up with the optimistic tick — drop the override.
  // Render-time prev-prop sentinel, same pattern as StageCellButton.
  const [seenShipped, setSeenShipped] = useState(shipped)
  if (seenShipped !== shipped) {
    setSeenShipped(shipped)
    setOptimistic(null)
  }

  const run = (
    kind: 'finishJobStage' | 'undoJobStage',
    glyph: 'shipped' | 'unshipped',
  ) => {
    setError(false)
    setOptimistic(glyph)
    start(async () => {
      try {
        await mutate({ kind, jobId, stage: '出货' })
        router.refresh()
      } catch {
        setOptimistic(null)
        setError(true)
      }
    })
  }

  return (
    <Ctx.Provider
      value={{
        optimistic,
        pending,
        error,
        canTick,
        ship: () => run('finishJobStage', 'shipped'),
        unship: () => run('undoJobStage', 'unshipped'),
      }}
    >
      {children}
    </Ctx.Provider>
  )
}

export function ShipCell({ state }: { state?: StageState }) {
  const ctx = useContext(Ctx)
  if (!ctx) return null

  // Route without 出货 — shouldn't happen (出货 is always present), n/a dash.
  if (!state) {
    return (
      <div
        className="flex h-full w-full items-center justify-center"
        aria-label="出货 · 不适用"
      >
        <span className="mono text-[13px] text-[var(--color-ink-4)]">—</span>
      </div>
    )
  }

  const { optimistic, pending, error, canTick, ship, unship } = ctx
  const done = optimistic ? optimistic === 'shipped' : state.status === 'done'

  if (done) {
    const inner = (
      <>
        <span className="text-[16px] leading-none font-semibold text-[var(--color-success)]">
          ✓
        </span>
        {state.status === 'done' && state.completedAt ? (
          <span className="mono text-[10px] text-[var(--color-ink-3)]">
            {state.completedAt}
          </span>
        ) : null}
      </>
    )
    if (!canTick) {
      return (
        <div
          className="flex h-full w-full flex-col items-center justify-center gap-0.5 py-2"
          aria-label="出货 · 已出货"
        >
          {inner}
        </div>
      )
    }
    const attribution = state.by
      ? `经手 ${state.by}${stageTimeHint(state.finishedAt)}`
      : undefined
    return (
      <button
        type="button"
        disabled={pending}
        onClick={unship}
        title={attribution ?? '点击撤销 · 整单退回'}
        aria-label="出货 · 撤销整单出货"
        className="flex h-full w-full flex-col items-center justify-center gap-0.5 py-2 hover:bg-[#f1eee4] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] disabled:opacity-60"
      >
        {inner}
      </button>
    )
  }

  if (!canTick) {
    return (
      <div
        className="flex h-full w-full items-center justify-center py-2"
        aria-label="出货 · 未出货"
      >
        <span className="h-[15px] w-[15px] rounded-[2px] border border-[var(--color-border-strong)]" />
      </div>
    )
  }

  return (
    <button
      type="button"
      disabled={pending}
      onClick={ship}
      title="勾选 = 整单出货 · 所有零件一键完成"
      aria-label={`出货 · ${error ? '失败 · 重试' : '整单出货'}`}
      className={`group flex h-full w-full items-center justify-center py-2 transition-colors ${
        error ? 'bg-[var(--color-overdue-soft)]' : 'hover:bg-[#f1eee4]'
      } focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] disabled:opacity-60`}
    >
      {error ? (
        <span className="mono text-[11px] font-medium text-[var(--color-overdue)]">
          失败
        </span>
      ) : (
        <span className="h-[15px] w-[15px] rounded-[2px] border border-[var(--color-ink-4)] transition-colors group-hover:border-[var(--color-ink-2)]" />
      )}
    </button>
  )
}
