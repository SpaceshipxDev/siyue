import { canSeeFactoryPulse, currentUser } from '@/lib/auth'
import { getMachineDashboard, machineDashboardProxyMatches } from '@/lib/machines'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  if (!machineDashboardProxyMatches(request.headers)) {
    const user = await currentUser()
    if (!user) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
    }
    if (!canSeeFactoryPulse(user)) {
      return Response.json({ ok: false, error: 'forbidden' }, { status: 403 })
    }
  }

  try {
    const includeRaw = new URL(request.url).searchParams.get('raw') === '1'
    const dashboard = await getMachineDashboard({ includeRaw })
    return Response.json(
      { ok: true, ...dashboard },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
