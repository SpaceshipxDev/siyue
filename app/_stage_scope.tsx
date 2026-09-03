'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import type { Stage } from '@/lib/data'

// 报工工段范围, server-computed (lib/auth stageScopeFor) and mounted by the
// pages that render stage cells (master board / station workbench / job
// sheet). Cells stay visible and tappable-looking everywhere — visibility is
// the product — but a tap outside the viewer's scope opens the denial dialog
// instead of firing the mutation. /api/mutate re-checks the same map
// server-side, so this layer is UX, not the security boundary.

type StageScopeValue = 'all' | readonly Stage[]

type Ctx = {
  scope: StageScopeValue
  deny: (stage: Stage) => void
  /** 能不能把一道「已完成」退回去 — 名单制, 见 lib/auth canUndoFinishedStage。 */
  canUndoDone: boolean
}

// Default is fail-open ('all'): a cell rendered outside any provider behaves
// exactly as before this feature — the server still rejects out-of-scope
// writes, they just surface as the generic 失败 cell state.
const StageScopeContext = createContext<Ctx>({
  scope: 'all',
  deny: () => {},
  canUndoDone: true,
})

/** 撤销「已完成」的权限 — 服务端会再查一次, 这层只是别让人白点。 */
export function useCanUndoDone(): boolean {
  return useContext(StageScopeContext).canUndoDone
}

/** Pure read — used by the workbench to keep foreign stations read-only. */
export function useCanClickStage(stage: Stage): boolean {
  const { scope } = useContext(StageScopeContext)
  return scope === 'all' || scope.includes(stage)
}

/**
 * Pre-flight guard for a stage write. `check()` returns true when the tap
 * may proceed; otherwise it opens the denial dialog and returns false.
 * `denyIfScopeError(e)` is the belt-and-braces path: when the server (the
 * real boundary) rejected with a 无权 message, show the same dialog instead
 * of the generic 失败 cell — returns true when it handled the error.
 */
export function useStageGuard(stage: Stage): {
  check: () => boolean
  denyIfScopeError: (e: unknown) => boolean
} {
  const { scope, deny } = useContext(StageScopeContext)
  const check = useCallback(() => {
    if (scope === 'all' || scope.includes(stage)) return true
    deny(stage)
    return false
  }, [scope, stage, deny])
  const denyIfScopeError = useCallback(
    (e: unknown) => {
      if (e instanceof Error && e.message.includes('无权')) {
        deny(stage)
        return true
      }
      return false
    },
    [stage, deny],
  )
  return { check, denyIfScopeError }
}

export function StageScopeProvider({
  scope,
  canUndoDone = true,
  children,
}: {
  scope: StageScopeValue
  /** 撤销「已完成」 — 默认放行, 服务端才是真的边界。 */
  canUndoDone?: boolean
  children: ReactNode
}) {
  const [denied, setDenied] = useState<Stage | null>(null)
  const deny = useCallback((s: Stage) => setDenied(s), [])
  const value = useMemo(
    () => ({ scope, deny, canUndoDone }),
    [scope, deny, canUndoDone],
  )
  return (
    <StageScopeContext.Provider value={value}>
      {children}
      {denied ? (
        <StageDeniedDialog stage={denied} onClose={() => setDenied(null)} />
      ) : null}
    </StageScopeContext.Provider>
  )
}

function StageDeniedDialog({
  stage,
  onClose,
}: {
  stage: Stage
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={`无法报工 · ${stage}`}
      onClick={onClose}
      className="fixed inset-0 z-[120] flex items-center justify-center p-6"
    >
      <div className="absolute inset-0 bg-black/25" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-[300px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-6 pt-6 pb-5 text-center shadow-[0_16px_48px_rgba(0,0,0,0.18)] animate-stage-denied"
      >
        <p className="mono text-[11px] tracking-[0.25em] text-[var(--color-ink-3)]">
          无法报工
        </p>
        <p className="mt-3 text-[18px] font-semibold tracking-tight text-[var(--color-ink)]">
          {stage} 不是你的工段
        </p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-ink-2)]">
          这一格由 {stage} 的人报工
        </p>
        <button
          type="button"
          autoFocus
          onClick={onClose}
          className="mt-5 w-full rounded-[2px] bg-[var(--color-ink)] py-2 text-[13px] font-medium text-[var(--color-surface)] transition-opacity hover:opacity-85 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)]"
        >
          知道了
        </button>
      </div>
    </div>
  )
}
