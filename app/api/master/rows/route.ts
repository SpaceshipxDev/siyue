import { currentUser } from '@/lib/auth'
import { getMasterRows } from '@/lib/db'
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

export async function GET(): Promise<Response> {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  try {
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
