import { currentUser } from '@/lib/auth'
import { getSemiStock } from '@/lib/semi-stock'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 半成品库存的读口 —— 看板切到「半成品库存」那一栏时读一次。写在
// /api/mutate#addSemiStock / updateSemiStock / deleteSemiStock。
export async function GET(): Promise<Response> {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  return Response.json(
    { ok: true, items: await getSemiStock() },
    { headers: { 'cache-control': 'no-store' } },
  )
}
