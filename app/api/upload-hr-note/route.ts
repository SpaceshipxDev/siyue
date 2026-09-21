import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { canSeeAllHr, currentUser, hrDeptOf } from '@/lib/auth'
import { getHrMonth } from '@/lib/hr'
import { addHrNote, isAllowedHrNoteName } from '@/lib/hr-note-file'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 16 * 1024 * 1024

// 请假条上传 —— 收到假条的那个人当场拍一张挂上去。
//
// 门跟「记一笔」同一档: 有账号就能传。假条是当场递到手上的一张纸, 让填的人
// 等一个有权限的人来代传, 就是让这张纸最后回到抽屉里 (人事那几档的道理见
// lib/auth 的 人事 那一段)。删是另一档, 走 /api/mutate 的 deleteHrNote。
//
// 但看得见谁的, 就只能传给谁: 工段长只读得到自己部门的线, 也就只能往自己部
// 门的线上传 —— 跟页面的口径是同一条, 不在这儿开一个后门。
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const form = await request.formData()
  const file = form.get('file')
  const month = form.get('month')
  const recordId = form.get('recordId')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: 'no file' }, { status: 400 })
  }
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    return Response.json({ ok: false, error: 'bad month' }, { status: 400 })
  }
  if (typeof recordId !== 'string' || !recordId) {
    return Response.json({ ok: false, error: 'bad recordId' }, { status: 400 })
  }
  if (!isAllowedHrNoteName(file.name)) {
    return Response.json(
      { ok: false, error: '仅支持图片或 PDF' },
      { status: 415 },
    )
  }
  if (file.size > MAX_BYTES) {
    return Response.json(
      { ok: false, error: '文件过大（上限 16MB）' },
      { status: 413 },
    )
  }

  // 这条记录真在那个月里吗, 而且是这个人看得到的部门吗。
  const rows = await getHrMonth(month)
  const rec = rows.find((r) => r.id === recordId)
  if (!rec) {
    return Response.json({ ok: false, error: '找不到这条记录' }, { status: 404 })
  }
  if (!canSeeAllHr(user) && (rec.dept ?? '商务') !== hrDeptOf(user)) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 })
  }

  const buf = await file.arrayBuffer()
  let row
  try {
    row = await addHrNote({
      month,
      recordId,
      buf,
      fileName: file.name,
      contentType: file.type,
      uploadedBy: user.name,
      nowIso: new Date().toISOString(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }

  revalidatePath('/hr')
  return Response.json({ ok: true, note: row })
}
