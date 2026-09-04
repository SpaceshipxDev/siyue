import { currentUser } from '@/lib/auth'
import { STAGES, type Stage } from '@/lib/data'
import { resolvePartId } from '@/lib/db'
import { getWorkSplit } from '@/lib/work-split'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 报工分工的读口 — 分工对话框打开时读它自己那一条。
//
// 只有一条数据, 所以走一个瘦 GET, 而不是把全厂的分工塞进每一张工单页的
// RSC payload (每个工序格子一条, 几百个格子)。写在 /api/mutate#setWorkSplit。
export async function GET(request: Request): Promise<Response> {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const sp = new URL(request.url).searchParams
  const jobId = sp.get('jobId') ?? ''
  const componentId = sp.get('componentId') ?? ''
  const stage = sp.get('stage') ?? ''
  if (!jobId || !componentId || !(STAGES as readonly string[]).includes(stage)) {
    return Response.json({ ok: false, error: 'bad args' }, { status: 400 })
  }
  const partId = await resolvePartId(jobId, componentId)
  if (!partId) return Response.json({ ok: true, shares: [] })
  const shares = await getWorkSplit(partId, stage as Stage)
  return Response.json(
    { ok: true, shares },
    { headers: { 'cache-control': 'no-store' } },
  )
}
