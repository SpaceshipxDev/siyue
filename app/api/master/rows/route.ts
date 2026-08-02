import { currentUser } from '@/lib/auth'
import {
  getMasterRows,
  getMasterRowsByShipped,
  getMasterRowsPage,
  getOrderMoneyLightByJob,
  type OrderMoneyLite,
} from '@/lib/db'
import type { MasterRow } from '@/lib/master'
import { toMasterWireRows } from '@/lib/master_wire'

// Stamp each row with its 收款 money light from the per-job aggregation.
// Confirmed orders with no 出货单 aren't in the map → 在产 (blank cell, no money
// due yet). Only meaningful for commerce; the wire scrubs it for everyone else,
// so we skip the query entirely for the floor.
function applyMoney(
  rows: MasterRow[],
  money: Map<string, OrderMoneyLite> | null,
): MasterRow[] {
  if (!money) return rows
  for (const r of rows) {
    const m = money.get(r.id)
    if (m) {
      r.moneyStatus = m.status
      r.outstandingCny = m.outstandingCny
      r.overdueDays = m.overdueDays
    } else {
      // No 出货单 / finance row. Two notions of "shipped" diverge: the board's
      // 已出货 (出货 stage ticked done) vs money's (a 出货单 exists to invoice
      // against). An order ticked through 出货 but with no 出货单 would read as a
      // confusing blank on the 已出货 tab — so if the board calls it shipped, it's
      // still 待开票 (delivered, nothing billed), not 在产. Only genuinely
      // in-production orders stay blank.
      r.moneyStatus = r.isShipped ? 'uninvoiced' : 'in_production'
      r.outstandingCny = 0
    }
  }
  return rows
}

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
  // 收款 light is commerce-only (the wire scrubs it otherwise), so the floor
  // never pays for the shipments + shipment_finance read.
  const moneyPromise =
    user.role === 'commerce' ? getOrderMoneyLightByJob() : Promise.resolve(null)
  try {
    const url = new URL(request.url)
    const limitParam = url.searchParams.get('limit')
    if (limitParam) {
      const limit = parseIntParam(limitParam, 100)
      const ship = url.searchParams.get('ship')
      const sort = url.searchParams.get('sort')
      const [page, money] = await Promise.all([
        getMasterRowsPage({
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
        }),
        moneyPromise,
      ])
      return Response.json(
        {
          ok: true,
          rows: toMasterWireRows(applyMoney(page.rows, money), user),
          nextCursor: page.nextCursor,
          total: page.total,
        },
        { headers: { 'cache-control': 'no-store' } },
      )
    }
    // ?scope=active|shipped — the board's two-phase load. Active orders are
    // ~1/6 of the book, so the first paint ships a fraction of the bytes and
    // server time of the full feed; shipped history streams in behind it.
    const scopeParam = url.searchParams.get('scope')
    const rowsPromise =
      scopeParam === 'active'
        ? getMasterRowsByShipped(false)
        : scopeParam === 'shipped'
          ? getMasterRowsByShipped(true)
          : getMasterRows()
    const [rows, money] = await Promise.all([rowsPromise, moneyPromise])
    return Response.json(
      { ok: true, rows: toMasterWireRows(applyMoney(rows, money), user) },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[api/master/rows]', message)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
