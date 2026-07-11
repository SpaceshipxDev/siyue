import { currentUser } from '@/lib/auth'
import { getOrderShipmentsForMoney } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// One order's 出货单 + 开票/回款 state — feeds the board's click-to-fill 收款
// popover. Commerce-only (the money surface), like the 收款 light itself.
export async function GET(request: Request): Promise<Response> {
  const user = await currentUser()
  if (!user || user.role !== 'commerce') {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const jobId = new URL(request.url).searchParams.get('jobId')
  if (!jobId) {
    return Response.json({ ok: false, error: 'missing jobId' }, { status: 400 })
  }
  try {
    const shipments = await getOrderShipmentsForMoney(jobId)
    return Response.json(
      { ok: true, shipments },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
