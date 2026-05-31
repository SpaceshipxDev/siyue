'use client'

import { useState, useTransition } from 'react'
import { STAGES, partRoute, type Component, type Stage } from '@/lib/data'
import { mutate } from '@/lib/mutate'
import type { SetPartRouteResult } from '@/lib/db'

// 出货 is always in the route — every part eventually ships, so the chip is
// shown lit and non-interactive. Outsource-covered chips are also locked
// (the block owns those stages, the chip widget can't take them out).
const ALWAYS_ON: ReadonlySet<Stage> = new Set<Stage>(['出货'])

type ConflictDialogState = {
  desired: Stage[]
  removing: { stage: Stage; status: 'in_progress' | 'done' }[]
}

// Editorial typography-only routing strip. No pills, no fills — active stages
// are ink, inactive are dimmed with a strike, outsource locks lift to warning.
// Matches the rest of the sheet aesthetic (everything else here is letters
// and lines, not colored tags).
export function StageChips({
  jobId,
  component,
  readOnly = false,
}: {
  jobId: string
  component: Component
  readOnly?: boolean
}) {
  const [pending, start] = useTransition()
  const [optimistic, setOptimistic] = useState<Set<Stage> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<ConflictDialogState | null>(
    null,
  )

  const lockedByOutsource = new Set<Stage>()
  for (const b of component.outsourceBlocks ?? []) {
    for (const s of b.stages) lockedByOutsource.add(s)
  }

  const currentRoute = optimistic ?? new Set<Stage>(partRoute(component))

  const apply = async (next: Set<Stage>, force: boolean) => {
    setError(null)
    setOptimistic(next)
    const stages = STAGES.filter((s) => next.has(s))
    return new Promise<void>((resolve) => {
      start(async () => {
        try {
          const r = await mutate<SetPartRouteResult>({
            kind: 'setPartRoute',
            jobId,
            componentId: component.id,
            stages,
            force,
          })
          const result = r.data
          if (result.ok) {
            setConfirmState(null)
            resolve()
            return
          }
          setOptimistic(null)
          if (result.reason === 'needs_confirm') {
            setConfirmState({ desired: stages, removing: result.conflicts })
          } else if (result.reason === 'outsourced_locked') {
            setError(`已外协 · ${result.stages.join('、')} 不能取消`)
          } else if (result.reason === 'not_found') {
            // Component id couldn't be resolved against the DB snapshot — the
            // part was deleted in another tab, or the page is showing a stale
            // pre-import state. Either way, refresh recovers.
            setError('零件未找到 · 请刷新页面')
          } else {
            setError('保存失败 · 请重试')
          }
          resolve()
        } catch (err) {
          setOptimistic(null)
          // Surface the real reason when the action threw — likely an auth
          // redirect (lost session) or a supabase write error. The 10px
          // mono "保存失败" the user used to see was easy to miss; this
          // longer message is paired with a red wash on the row below.
          const msg = err instanceof Error ? err.message : ''
          setError(
            msg.includes('NEXT_REDIRECT')
              ? '会话已过期 · 请刷新登录'
              : '保存失败 · 请重试',
          )
          resolve()
        }
      })
    })
  }

  const onToggle = (stage: Stage) => {
    if (readOnly) return
    if (ALWAYS_ON.has(stage)) return
    if (lockedByOutsource.has(stage)) return
    const next = new Set(currentRoute)
    if (next.has(stage)) next.delete(stage)
    else next.add(stage)
    void apply(next, false)
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-x-1 gap-y-0.5 leading-none -ml-1">
      {STAGES.map((stage) => {
        const inRoute = currentRoute.has(stage)
        const isOutsource = lockedByOutsource.has(stage)
        const isAlwaysOn = ALWAYS_ON.has(stage)
        const isLocked = isAlwaysOn || isOutsource

        // Two states only — the cells above already carry status color/icon.
        // The chip widget's job is purely "do we touch this stage in-house?":
        //   filled black  = yes (in route AND not outsourced, OR 出货)
        //   hollow        = no  (skipped OR vendor handles it)
        const handledInHouse = inRoute && !isOutsource
        const boxCls = handledInHouse
          ? 'bg-[var(--color-ink)] border-[var(--color-ink)]'
          : 'bg-transparent border-[var(--color-ink-4)]'
        const textCls = handledInHouse
          ? 'text-[var(--color-ink)] font-medium'
          : 'text-[var(--color-ink-3)]'

        const interactive = !readOnly && !pending && !isLocked
        const hoverCls = interactive
          ? 'hover:bg-[#f1eee4] cursor-pointer'
          : 'cursor-default'

        const title = isAlwaysOn
          ? `${stage} · 必经`
          : isOutsource
            ? `${stage} · 已外协`
            : readOnly
              ? inRoute
                ? `${stage} · 经过`
                : `${stage} · 不经过`
              : !inRoute
                ? `${stage} · 不经过 · 点击启用`
                : `${stage} · 经过 · 点击跳过`

        if (readOnly) {
          return (
            <span
              key={stage}
              title={title}
              aria-pressed={handledInHouse}
              className="inline-flex items-center gap-1 rounded-[2px] px-1.5 py-0.5"
            >
              <span
                aria-hidden="true"
                className={`block h-[7px] w-[7px] rounded-[2px] border ${boxCls}`}
              />
              <span className={`text-[11px] tracking-wider ${textCls}`}>
                {stage}
              </span>
            </span>
          )
        }

        return (
          <button
            key={stage}
            type="button"
            disabled={pending || isLocked}
            onClick={() => onToggle(stage)}
            title={title}
            aria-pressed={handledInHouse}
            className={`inline-flex items-center gap-1 rounded-[2px] px-1.5 py-0.5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] ${hoverCls}`}
          >
            <span
              aria-hidden="true"
              className={`block h-[7px] w-[7px] rounded-[2px] border transition-colors ${boxCls}`}
            />
            <span className={`text-[11px] tracking-wider transition-colors ${textCls}`}>
              {stage}
            </span>
          </button>
        )
      })}
      {error ? (
        <span
          role="alert"
          className="ml-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[2px] bg-[var(--color-overdue-soft)] text-[12px] font-medium text-[var(--color-overdue)] tracking-wide"
        >
          <span aria-hidden="true">!</span>
          {error}
        </span>
      ) : null}
      {confirmState ? (
        <ConfirmDialog
          conflicts={confirmState.removing}
          onConfirm={async () => {
            const next = new Set<Stage>(confirmState.desired)
            await apply(next, true)
          }}
          onCancel={() => setConfirmState(null)}
          pending={pending}
        />
      ) : null}
    </span>
  )
}

function ConfirmDialog({
  conflicts,
  onConfirm,
  onCancel,
  pending,
}: {
  conflicts: { stage: Stage; status: 'in_progress' | 'done' }[]
  onConfirm: () => void
  onCancel: () => void
  pending: boolean
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[400px] max-w-[92vw] bg-[var(--color-surface)] border border-[var(--color-ink)] rounded-[2px] p-6 shadow-xl"
      >
        <p className="label text-[var(--color-warning)] mb-2">确认关闭工段</p>
        <h3 className="text-[16px] font-semibold tracking-tight text-[var(--color-ink)] mb-3">
          以下工段已开始或完成，关闭将丢失工时记录
        </h3>
        <ul className="text-[13px] text-[var(--color-ink-2)] mb-6 space-y-1 leading-relaxed">
          {conflicts.map((c) => (
            <li key={c.stage} className="flex items-baseline gap-3">
              <span className="mono font-medium text-[var(--color-ink)] w-12">
                {c.stage}
              </span>
              <span className="label text-[var(--color-ink-3)]">
                {c.status === 'in_progress' ? '进行中' : '已完成'}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="px-3 py-1.5 text-[12px] tracking-wider border border-[var(--color-border)] text-[var(--color-ink-2)] hover:bg-[#f1eee4] rounded-[2px] disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="px-3 py-1.5 text-[12px] tracking-wider bg-[var(--color-overdue)] text-[var(--color-surface)] rounded-[2px] hover:opacity-80 disabled:opacity-60"
          >
            确认关闭
          </button>
        </div>
      </div>
    </div>
  )
}
