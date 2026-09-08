import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { canUploadDrawing, currentUser } from '@/lib/auth'
import { addDrawingFile } from '@/lib/drawing-file'
import { isAllowedDrawingName } from '@/lib/drawing'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 三维模型动辄十几兆, 合同那个 16MB 的上限在这里不够用; 但也不能敞开 —— 全
// 厂跑在一个 Node 进程上, 一份超大文件穿过它, 车间所有人的页面都要跟着卡。
// 40MB 装得下厂里见过的每一份 step / dwg, 再大的让客户压成压缩包发。
const MAX_BYTES = 40 * 1024 * 1024

// 零件图纸上传 —— 下图纸的人 (商务 / 工程) 传, 全厂都能下。故意不走"钱"那一
// 档: 编程员是生产账号, 按钱去挡他就又看不见图了, 而看不见图就等于没有编程
// 这个功能。
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user || !canUploadDrawing(user)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const form = await request.formData()
  const file = form.get('file')
  const jobId = form.get('jobId')
  const componentId = form.get('componentId')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: 'no file' }, { status: 400 })
  }
  if (typeof jobId !== 'string' || !jobId) {
    return Response.json({ ok: false, error: 'missing jobId' }, { status: 400 })
  }
  if (typeof componentId !== 'string' || !componentId) {
    return Response.json(
      { ok: false, error: 'missing componentId' },
      { status: 400 },
    )
  }
  if (!isAllowedDrawingName(file.name)) {
    return Response.json(
      { ok: false, error: '支持 PDF / DWG / DXF / STEP / IGS / X_T / STL / 压缩包 / 图片' },
      { status: 415 },
    )
  }
  if (file.size > MAX_BYTES) {
    return Response.json(
      { ok: false, error: '文件过大（上限 40MB）— 压成压缩包再传' },
      { status: 413 },
    )
  }

  let row
  try {
    row = await addDrawingFile({
      jobId,
      componentId,
      // Blob 直接转交 storage, 不在内存里再拷一份。
      body: file,
      fileName: file.name,
      contentType: file.type,
      uploadedBy: user.name,
      nowIso: new Date().toISOString(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }

  revalidatePath(`/jobs/${jobId}`)
  return Response.json({ ok: true, drawing: row })
}
