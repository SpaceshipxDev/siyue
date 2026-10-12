import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { currentUser } from '@/lib/auth'
import { addQualityFile, addQualityFilePhoto } from '@/lib/quality-files'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 签过字的扫描件、PDF、Word/Excel、图纸 —— 三十兆封顶足够。
const MAX_BYTES = 32 * 1024 * 1024

const ALLOWED = /\.(pdf|docx?|xlsx?|csv|txt|pptx?|png|jpe?g|webp|gif|bmp|heic|tiff?|dwg|dxf|step|stp|igs|iges|zip|rar|7z)$/i

const IMAGE = /\.(png|jpe?g|webp|gif|bmp|heic)$/i

// 质量 · 文件管理 —— 跟质量其它几张表同一档权限: 有账号就能传。删和改填过
// 的是另一档 (见 /api/mutate 的 deleteQualityFile)。
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const form = await request.formData()
  const file = form.get('file')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: '先选一个文件' }, { status: 400 })
  }
  if (!ALLOWED.test(file.name) && !file.type.startsWith('image/')) {
    return Response.json({ ok: false, error: '这种文件传不了' }, { status: 415 })
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ ok: false, error: '文件过大（上限 32MB）' }, { status: 413 })
  }
  const text = (k: string) => {
    const v = form.get(k)
    return typeof v === 'string' ? v : ''
  }

  // 带 fileId = 往已有的那一份文件上挂一张图。
  const fileId = text('fileId')
  if (fileId) {
    if (!IMAGE.test(file.name) && !file.type.startsWith('image/')) {
      return Response.json({ ok: false, error: '这里只收图片' }, { status: 415 })
    }
    try {
      const photo = await addQualityFilePhoto({
        fileId,
        body: file,
        fileName: file.name,
        contentType: file.type,
        uploadedBy: user.name,
        nowIso: new Date().toISOString(),
      })
      revalidatePath('/quality')
      return Response.json({ ok: true, photo })
    } catch (e) {
      return Response.json(
        { ok: false, error: e instanceof Error ? e.message : '上传失败' },
        { status: 500 },
      )
    }
  }

  try {
    const row = await addQualityFile({
      body: file,
      fileName: file.name,
      contentType: file.type,
      date: text('date'),
      title: text('title'),
      drawing: text('drawing'),
      signer: text('signer'),
      by: user.name,
      nowIso: new Date().toISOString(),
    })
    revalidatePath('/quality')
    return Response.json({ ok: true, file: row })
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : '上传失败' },
      { status: 500 },
    )
  }
}
