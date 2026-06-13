'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Stage } from '@/lib/data'
import type { MasterRow } from '@/lib/master'
import { MasterSheet } from './_master_filter'
import { StationWorkbench } from './_workbench'

type Role = 'commerce' | 'production'

// ── Why these wrappers exist ────────────────────────────────────────────
// The dashboard used to hand the entire ~660-row MasterRow[] to the client
// grid as RSC props, so the server SSR-rendered + Flight-serialized the whole
// tree on one thread (~2.4s, the measured bottleneck; it also blocked the
// event loop so concurrent loads queued to 6–7s).
//
// These thin loaders fetch the rows from /api/master/rows AFTER hydration and
// render the (unchanged) MasterSheet / StationWorkbench once the data lands.
// The page render is now O(1) shell. Freshness is preserved: the grid already
// updates optimistically in-session (no router.refresh anywhere — see
// _inspection_cell.tsx), and a fetch on every mount/navigation matches the
// old force-dynamic "fresh on each load" behavior.

type RowsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; rows: MasterRow[] }

function useMasterRows(): { state: RowsState; reload: () => void } {
  const [state, setState] = useState<RowsState>({ status: 'loading' })
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    let alive = true
    setState((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }))
    fetch('/api/master/rows', { cache: 'no-store' })
      .then(async (r) => {
        const data = (await r.json()) as
          | { ok: true; rows: MasterRow[] }
          | { ok: false; error: string }
        if (!alive) return
        if (data.ok) setState({ status: 'ready', rows: data.rows })
        else setState({ status: 'error', message: data.error })
      })
      .catch((e: unknown) => {
        if (!alive) return
        setState({
          status: 'error',
          message: e instanceof Error ? e.message : '网络中断',
        })
      })
    return () => {
      alive = false
    }
  }, [nonce])

  return { state, reload }
}

function BoardSkeleton() {
  return (
    <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="h-[44px] border-b border-[var(--color-border)] bg-[var(--color-active-bg)]" />
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="h-[78px] animate-pulse border-b border-[var(--color-border)]"
          style={{ opacity: 1 - i * 0.08 }}
        >
          <div className="mx-4 mt-7 h-[10px] w-1/3 rounded-[2px] bg-[var(--color-active-bg)]" />
        </div>
      ))}
    </div>
  )
}

function BoardError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] py-12 text-center">
      <p className="text-[13px] text-[var(--color-ink-2)]">加载失败 · {message}</p>
      <button
        onClick={onRetry}
        className="mt-3 rounded-[2px] border border-[var(--color-border)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-ink-2)] transition-colors hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink)]"
      >
        重试
      </button>
    </div>
  )
}

export function MasterSheetLoader(props: {
  role: Role
  defaultStage?: Stage
  stageFilter?: Stage
  actionableHighlight?: boolean
}) {
  const { state, reload } = useMasterRows()
  if (state.status === 'loading') return <BoardSkeleton />
  if (state.status === 'error')
    return <BoardError message={state.message} onRetry={reload} />
  return <MasterSheet rows={state.rows} {...props} />
}

export function StationWorkbenchLoader(props: {
  stage: Stage
  role: Role
  defaultStage?: Stage
}) {
  const { state, reload } = useMasterRows()
  if (state.status === 'loading') return <BoardSkeleton />
  if (state.status === 'error')
    return <BoardError message={state.message} onRetry={reload} />
  return <StationWorkbench rows={state.rows} {...props} />
}
