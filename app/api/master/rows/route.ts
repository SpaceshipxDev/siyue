import { currentUser } from '@/lib/auth'
import { getMasterRows, getMasterRowsPage } from '@/lib/db'
import { toMasterWireRows } from '@/lib/master_wire'

// Compact rows feed for the master board. The dashboard page (app/page.tsx)
// renders only the shell + pills now; the grid (MasterSheet / StationWorkbench)
// fetches its rows from here on mount. This removes the ~2.4s server-side
// SSR + Flight-serialization of the 660-row tree from the page render and
// stops it blocking the single Node event loop (see ecosystem.config.js).
//
// no-store: the board must reflect live floor state, and under pm2 cluster
// Next's data cache / revalidatePath only invalidate one worker, so we don't
// rely on it — every fetch re-reads Supabase (fast; Phase 2 materializes it).
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function parseIntParam(v: string | null, fallback: number): number {
  if (!v) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? Math.floor(n) : fallback
}

export async function GET(request: Request): Promise<Response> {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  try {
    const url = new URL(request.url)
    const limitParam = url.searchParams.get('limit')
    if (limitParam) {
      const limit = parseIntParam(limitParam, 100)
      const ship = url.searchParams.get('ship')
      const sort = url.searchParams.get('sort')
      const page = await getMasterRowsPage({
        limit,
        cursor: url.searchParams.get('cursor') ?? undefined,
        q: url.searchParams.get('q') ?? undefined,
        jobNoOnlySearch: user.role === 'production' && user.defaultStage !== '出货',
        ship:
          ship === 'live' || ship === 'paused' || ship === 'shipped'
            ? ship
            : undefined,
        sort: sort === 'jobNo' ? 'jobNo' : 'due',
        dateStart: url.searchParams.get('dateStart') ?? undefined,
        dateEnd: url.searchParams.get('dateEnd') ?? undefined,
      })
      return Response.json(
        {
          ok: true,
          rows: toMasterWireRows(page.rows, user),
          nextCursor: page.nextCursor,
          total: page.total,
        },
        { headers: { 'cache-control': 'no-store' } },
      )
    }
    const rows = await getMasterRows()
    return Response.json(
      { ok: true, rows: toMasterWireRows(rows, user) },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[api/master/rows]', message)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
