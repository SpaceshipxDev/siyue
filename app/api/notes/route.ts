import { canUseNotes, currentUser } from '@/lib/auth'
import { getNotes } from '@/lib/db'
import { parseNoteBody } from '@/lib/data'
import { today } from '@/lib/today'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 名字旁边那个「待办 N」的读口 —— 自己笔记里还没勾完成的几项, 其中几项已经
// 过了需完成日期。每页顶栏读一次。
export async function GET(): Promise<Response> {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  if (!canUseNotes(user)) {
    return Response.json({ ok: true, open: 0, overdue: 0 })
  }
  const t = today()
  let open = 0
  let overdue = 0
  for (const n of await getNotes(user.id)) {
    const f = parseNoteBody(n.body)
    if (f.doneAt || !f.text.trim()) continue
    open++
    if (f.due && f.due < t) overdue++
  }
  return Response.json(
    { ok: true, open, overdue },
    { headers: { 'cache-control': 'no-store' } },
  )
}
