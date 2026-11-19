import { currentUser, stageScopeFor } from '@/lib/auth'
import { getActiveUsers } from '@/lib/db'
import { getHrRoster } from '@/lib/hr'
import { applyPickerEdits, getPickerEdits } from '@/lib/people-picker'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 厂里的人名 —— 报工时「谁做的」那一排名字从这里来: 有账号的人, 加上人事记过
// 的名字 (半个车间没有自己的登录, 照样干活、照样要算产出), 再照「改名单」改过
// 一遍 (lib/people-picker)。canEdit —— 商务和工程全厂号能改这张名单。
export async function GET(): Promise<Response> {
  const user = await currentUser()
  if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const [users, extra, edits] = await Promise.all([
    getActiveUsers(),
    getHrRoster(),
    getPickerEdits().catch(() => ({ hidden: [], added: [] })),
  ])
  const names = applyPickerEdits([...users.map((u) => u.name), ...extra], edits)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'zh'))
  const canEdit = user.role === 'commerce' || stageScopeFor(user) === 'all'
  return Response.json(
    { ok: true, names, canEdit },
    { headers: { 'cache-control': 'no-store' } },
  )
}
