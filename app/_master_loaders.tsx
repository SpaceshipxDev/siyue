'use client'

import { useCallback, useEffect, useState } from 'react'
import { withBase } from '@/lib/base-path'
import type { Stage } from '@/lib/data'
import type { MasterRow } from '@/lib/master'
import { expandMasterWireRows, type CompactMasterRow } from '@/lib/master_wire'
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
  // pendingShipped: the active orders are on screen but 已出货 history is
  // still streaming in — the shipped tab shows a loading state, not "empty".
  | { status: 'ready'; rows: MasterRow[]; pendingShipped: boolean }

// Two-phase load. 84% of the order book is shipped history (1,197 of 1,420
// rows at time of writing) that nobody looks at on landing — but the old
// single fetch made every board visit pay for all of it: ~2.2s of server
// compute + a 1.8MB (330KB gzipped) payload over a lossy cross-border path.
// Phase 1 fetches only active (non-shipped) orders so the default 在产 view
// paints in a fraction of the time; phase 2 streams the shipped rows behind
// it and merges. MasterSheet/StationWorkbench both re-sort client-side, so
// append order is irrelevant.
function useMasterRows(): { state: RowsState; reload: () => void } {
  const [state, setState] = useState<RowsState>({ status: 'loading' })
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => {
    setState({ status: 'loading' })
    setNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    let alive = true
    const fetchRows = async (scope: 'active' | 'shipped') => {
      const r = await fetch(withBase(`/api/master/rows?scope=${scope}`), {
        cache: 'no-store',
      })
      const data = (await r.json()) as
        | { ok: true; rows: CompactMasterRow[] }
        | { ok: false; error: string }
      if (!data.ok) throw new Error(data.error)
      return expandMasterWireRows(data.rows)
    }
    ;(async () => {
      const active = await fetchRows('active')
      if (!alive) return
      setState({ status: 'ready', rows: active, pendingShipped: true })
      try {
        const shipped = await fetchRows('shipped')
        if (!alive) return
        // A job that shipped between the two calls appears in both — the
        // phase-2 (shipped) version is fresher, so it wins the dedupe.
        const shippedIds = new Set(shipped.map((r) => r.id))
        setState({
          status: 'ready',
          rows: [...active.filter((r) => !shippedIds.has(r.id)), ...shipped],
          pendingShipped: false,
        })
      } catch {
        if (!alive) return
        // Shipped history failed to land: the active board is still fully
        // usable. Clear the pending flag so the 已出货 tab stops implying
        // more is coming; a reload (or next visit) retries.
        setState({ status: 'ready', rows: active, pendingShipped: false })
      }
    })().catch((e: unknown) => {
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
}) {
  const { state, reload } = useMasterRows()
  if (state.status === 'loading') return <BoardSkeleton />
  if (state.status === 'error')
    return <BoardError message={state.message} onRetry={reload} />
  return (
    <MasterSheet
      rows={state.rows}
      pendingShipped={state.pendingShipped}
      {...props}
    />
  )
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
