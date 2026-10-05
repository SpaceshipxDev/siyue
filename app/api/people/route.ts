import { currentUser } from '@/lib/auth'
import { getActiveUsers } from '@/lib/db'
import { getHrRoster } from '@/lib/hr'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 厂里的人名 —— 报工时「谁做的」那一排名字从这里来: 有账号的人, 加上人事记过
// 的名字 (半个车间没有自己的登录, 照样干活、照样要算产出)。
export async function GET(): Promise<Response> {
  const user = await currentUser()
  if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const [users, extra] = await Promise.all([getActiveUsers(), getHrRoster()])
  const names = [...new Set([...users.map((u) => u.name), ...extra])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'zh'))
  return Response.json({ ok: true, names }, { headers: { 'cache-control': 'no-store' } })
}
