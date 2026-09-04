'use client'

import { useCallback, useEffect, useState } from 'react'
import { withBase } from '@/lib/base-path'
import { SCHEMA_VERSION, type Stage } from '@/lib/data'
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
  // shippedFailed: the history gave up after retries. The board MUST say so:
  // silently reporting 已出货 0 next to a header claiming 1,459 工单 is how a
  // 商务 concludes an order that exists "isn't in the system" (2026-08-04).
  | {
      status: 'ready'
      rows: MasterRow[]
      pendingShipped: boolean
      shippedFailed: boolean
    }

// Non-retryable: the tab's JS bundle predates a stage-list change, so a
// reload (already queued by fetchRows) is the only cure — hammering the
// endpoint would just re-throw three times.
class VersionSkewError extends Error {}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

// The factory sits behind a lossy cross-border link, where a single dropped
// request used to cost the user 85% of the order book. Three tries with
// backoff turns the common transient blip into a hiccup nobody notices.
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof VersionSkewError) throw e
      lastErr = e
      if (i < attempts - 1) await sleep(400 * 2 ** i)
    }
  }
  throw lastErr
}

// 已出货 history in cursor pages rather than one 1.6MB response. Three wins
// over the old single fetch: each request is small enough to survive a bad
// link, a failure costs one page instead of all 1,243 rows, and the tab count
// climbs as pages land instead of sitting at … for the whole trip.
const SHIPPED_PAGE = 400
// Backstop against a server that returns a non-advancing cursor. 1,243 shipped
// rows today = 4 pages; 40 is unreachable without a bug.
const MAX_SHIPPED_PAGES = 40

// Later rows win — a job that shipped between two pages should land as its
// fresher shipped self, not its stale active one.
function mergeById(...groups: MasterRow[][]): MasterRow[] {
  const byId = new Map<string, MasterRow>()
  for (const g of groups) for (const r of g) byId.set(r.id, r)
  return [...byId.values()]
}

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
    const readRows = async (url: string) => {
      const r = await fetch(withBase(url), { cache: 'no-store' })
      const data = (await r.json()) as
        | {
            ok: true
            v?: number
            rows: CompactMasterRow[]
            nextCursor?: string
          }
        | { ok: false; error: string }
      if (!data.ok) throw new Error(data.error)
      // Wire cells are positional over STAGES — a tab whose JS bundle predates
      // a stage-list change would silently write every cell into the wrong
      // column. On version skew, hard-reload once to pick up the new bundle.
      if (data.v !== undefined && data.v !== SCHEMA_VERSION) {
        const KEY = 'wire-v-reloaded'
        if (!sessionStorage.getItem(KEY)) {
          sessionStorage.setItem(KEY, '1')
          window.location.reload()
        }
        throw new VersionSkewError('系统已更新 · 请刷新页面')
      }
      return {
        rows: expandMasterWireRows(data.rows),
        nextCursor: data.nextCursor,
      }
    }
    ;(async () => {
      const active = (await withRetry(() => readRows('/api/master/rows?scope=active')))
        .rows
      if (!alive) return
      setState({
        status: 'ready',
        rows: active,
        pendingShipped: true,
        shippedFailed: false,
      })

      // Fast path: all history in one request. Cheapest for the server (the
      // 收款 map is rebuilt per request, so N pages = N times that work) and
      // it's what a healthy link gets. One attempt only — if it drops, the
      // link can't carry 1.6MB and retrying the same giant request is futile.
      try {
        const all = await readRows('/api/master/rows?scope=shipped')
        if (!alive) return
        setState({
          status: 'ready',
          rows: mergeById(active, all.rows),
          pendingShipped: false,
          shippedFailed: false,
        })
        return
      } catch (e) {
        if (e instanceof VersionSkewError) throw e
        if (!alive) return
      }

      // The 1.6MB response didn't make it — this is the cross-border link the
      // factory is on. Re-fetch the same history as ~545KB pages: small enough
      // to survive, retried individually, and every page that lands stays on
      // the board instead of the old all-or-nothing wipe.
      const shipped: MasterRow[] = []
      let cursor: string | undefined
      let failed = false
      let finished = false
      for (let page = 0; page < MAX_SHIPPED_PAGES; page++) {
        let got: { rows: MasterRow[]; nextCursor?: string }
        const qs = new URLSearchParams({
          ship: 'shipped',
          limit: String(SHIPPED_PAGE),
        })
        if (cursor) qs.set('cursor', cursor)
        try {
          got = await withRetry(() => readRows(`/api/master/rows?${qs}`))
        } catch {
          failed = true
          break
        }
        if (!alive) return
        shipped.push(...got.rows)
        cursor = got.nextCursor
        finished = !got.nextCursor || got.rows.length === 0
        // Paint every page as it lands, so the 已出货 count climbs instead of
        // sitting at … until the last byte of history arrives.
        setState({
          status: 'ready',
          rows: mergeById(active, shipped),
          pendingShipped: !finished,
          shippedFailed: false,
        })
        if (finished) break
      }
      if (!alive) return
      // Ran out of page budget without reaching the end = still incomplete.
      // Never leave the tab spinning on … forever.
      if (failed || !finished) {
        // Whatever history did land stays on the board; the tab now reports
        // the gap (and offers 重试) instead of pretending 已出货 is empty.
        setState({
          status: 'ready',
          rows: mergeById(active, shipped),
          pendingShipped: false,
          shippedFailed: true,
        })
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
  /** 导出 — 名单制, 见 lib/auth canExportJobs。 */
  canExport?: boolean
}) {
  const { state, reload } = useMasterRows()
  if (state.status === 'loading') return <BoardSkeleton />
  if (state.status === 'error')
    return <BoardError message={state.message} onRetry={reload} />
  return (
    <MasterSheet
      rows={state.rows}
      pendingShipped={state.pendingShipped}
      shippedFailed={state.shippedFailed}
      onRetryShipped={reload}
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
