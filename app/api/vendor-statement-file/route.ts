import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { canConfirmDuizhang, currentUser } from '@/lib/auth'
import { isMonth } from '@/lib/duizhang'
import { isAllowedStatementFile, setVendorStatementFiles } from '@/lib/vendor-statement'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_BYTES = 16 * 1024 * 1024

// 外协手工对账单的照片 / PDF (lib/vendor-statement) —— 一次可以好几页, 整份换
// 掉原来那份。跟确认外协对账同一档人能传。
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user || !canConfirmDuizhang(user)) {
    return Response.json({ ok: false, error: '手工对账单由商务或财务来导' }, { status: 403 })
  }
  const form = await request.formData()
  const vendor = form.get('vendor')
  const period = form.get('period')
  const fs = form.getAll('file').filter((f): f is File => f instanceof File)
  if (typeof vendor !== 'string' || !vendor.trim() || typeof period !== 'string' || !isMonth(period)) {
    return Response.json({ ok: false, error: 'bad request' }, { status: 400 })
  }
  if (fs.length === 0) return Response.json({ ok: false, error: '没有收到文件' }, { status: 400 })
  if (fs.some((f) => !isAllowedStatementFile(f.name))) {
    return Response.json({ ok: false, error: '只能传 Excel、照片或 PDF' }, { status: 415 })
  }
  if (fs.some((f) => f.size > MAX_BYTES)) {
    return Response.json({ ok: false, error: '文件太大（一张上限 16MB）' }, { status: 413 })
  }
  try {
    await setVendorStatementFiles(
      vendor,
      period,
      await Promise.all(
        fs.map(async (f) => ({ buf: await f.arrayBuffer(), fileName: f.name, contentType: f.type })),
      ),
      user.name,
    )
    revalidatePath('/duizhang')
    return Response.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
