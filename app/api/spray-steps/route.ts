import { currentUser } from '@/lib/auth'
import { getSpraySteps } from '@/lib/spray-steps'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 喷漆的底漆 / 面漆做到哪一步 —— 格子按工单一批批来要 (?jobs=a,b,c)。
export async function GET(request: Request): Promise<Response> {
  const user = await currentUser()
  if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const jobs = (new URL(request.url).searchParams.get('jobs') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 500)
  const steps = jobs.length > 0 ? await getSpraySteps(jobs) : {}
  return Response.json({ ok: true, steps }, { headers: { 'cache-control': 'no-store' } })
}
