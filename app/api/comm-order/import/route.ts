import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { canWriteCommSheet, currentUser } from '@/lib/auth'
import { addCommOrderRows, cleanJobNo, uploadCommImage, type CommImage } from '@/lib/comm-order'
import { parseCommOrderWorkbook } from '@/lib/comm-order-xlsx'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_BYTES = 30 * 1024 * 1024

// 导入原来那张 Excel 沟通确认单 —— 工号认标题 (「YN-123工单分析沟通确认单」),
// 认不出就用文件名; 在某一张表里点导入的, 就进那一张。导进来的行接在后面,
// 记录人是导入的人。
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user || !canWriteCommSheet(user)) {
    return Response.json({ ok: false, error: '沟通确认单由工程或商务填' }, { status: 401 })
  }
  const form = await request.formData()
  const file = form.get('file')
  const forced = form.get('jobNo')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: '没有收到文件' }, { status: 400 })
  }
  if (!/\.xlsx$/i.test(file.name)) {
    return Response.json({ ok: false, error: '只能导入 .xlsx（WPS 里另存为 Excel 格式就行）' }, { status: 415 })
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ ok: false, error: '文件过大（上限 30MB）' }, { status: 413 })
  }
  try {
    const parsed = await parseCommOrderWorkbook(await file.arrayBuffer())
    const fromName = cleanJobNo(
      file.name.replace(/\.xlsx$/i, '').replace(/(工单分析)?沟通确认单.*$/, ''),
    )
    const jobNo =
      (typeof forced === 'string' && cleanJobNo(forced)) || parsed.jobNo || fromName
    if (!jobNo) {
      return Response.json({ ok: false, error: '认不出工号 —— 标题写成「工号+工单分析沟通确认单」再导' }, { status: 400 })
    }
    if (parsed.rows.length === 0) {
      return Response.json({ ok: false, error: '表里没有填过的沟通记录' }, { status: 400 })
    }
    const up = async (list: { data: Buffer; ext: string }[]): Promise<CommImage[]> => {
      const out: CommImage[] = []
      for (const [i, p] of list.entries()) {
        const ext = p.ext === 'jpeg' ? 'jpg' : p.ext
        out.push(
          await uploadCommImage(jobNo, p.data, `导入图片${i + 1}.${ext}`, ext === 'png' ? 'image/png' : `image/${p.ext}`),
        )
      }
      return out
    }
    const rows = []
    for (const r of parsed.rows) {
      rows.push({ ...r, images: await up(r.images), reqImages: await up(r.reqImages) })
    }
    const sheet = await addCommOrderRows(jobNo, rows, user.name, parsed.dueDate)
    revalidatePath('/comm')
    return Response.json({ ok: true, jobNo: sheet?.jobNo ?? jobNo, count: rows.length })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: `导入失败 · ${message}` }, { status: 500 })
  }
}
