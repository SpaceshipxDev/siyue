import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { canEditHrArchive, canSeeHrArchive, canUploadHrArchive, currentUser } from '@/lib/auth'
import {
  addArchiveFile,
  deleteArchiveFile,
  getArchivePerson,
  isAllowedArchiveFileName,
  readArchiveFile,
} from '@/lib/hr-archive'
import { isArchiveKind } from '@/lib/hr-archive-shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 20 * 1024 * 1024

// 人事档案的文件 —— 看 (GET)、传 (POST)、删 (DELETE)。身份证、合同这种东西只
// 从这里出: 每次都查是不是人事 / 于海伟 / 老板, 不缓存。传: 人事也行
// (canUploadHrArchive); 删只有老板和于海伟 (canEditHrArchive)。

export async function GET(request: NextRequest) {
  const user = await currentUser()
  if (!user || !canSeeHrArchive(user)) return new Response('forbidden', { status: 403 })
  const sp = request.nextUrl.searchParams
  const p = sp.get('p')
  const f = sp.get('f')
  if (!p || !f) return new Response('bad request', { status: 400 })
  const got = await readArchiveFile(p, f)
  if (!got) return new Response('not found', { status: 404 })
  return new Response(got.data.stream(), {
    status: 200,
    headers: {
      'Content-Type': got.file.contentType || got.data.type || 'application/octet-stream',
      'Content-Length': String(got.data.size),
      // inline —— PDF 在浏览器里直接打开, 不是下载。
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(got.file.filename)}`,
      'Cache-Control': 'private, no-store',
    },
  })
}

export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  if (!canUploadHrArchive(user))
    return Response.json({ ok: false, error: '人事档案由人事、于海伟或老板来传' }, { status: 403 })
  const form = await request.formData()
  const file = form.get('file')
  const personId = form.get('personId')
  const kind = form.get('kind')
  if (!(file instanceof File) || typeof personId !== 'string' || !isArchiveKind(kind))
    return Response.json({ ok: false, error: 'bad request' }, { status: 400 })
  if (!(await getArchivePerson(personId)))
    return Response.json({ ok: false, error: '找不到这份档案' }, { status: 404 })
  if (!isAllowedArchiveFileName(file.name))
    return Response.json({ ok: false, error: '只能传图片或 PDF' }, { status: 415 })
  if (file.size > MAX_BYTES)
    return Response.json({ ok: false, error: '文件太大（上限 20MB）' }, { status: 413 })
  try {
    const row = await addArchiveFile({
      personId,
      kind,
      buf: await file.arrayBuffer(),
      fileName: file.name,
      contentType: file.type,
      by: user.name,
    })
    revalidatePath('/hr')
    return Response.json({ ok: true, file: row })
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const user = await currentUser()
  if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  if (!canEditHrArchive(user))
    return Response.json({ ok: false, error: '人事档案只有老板和于海伟能改' }, { status: 403 })
  const sp = request.nextUrl.searchParams
  const p = sp.get('p')
  const f = sp.get('f')
  if (!p || !f) return Response.json({ ok: false, error: 'bad request' }, { status: 400 })
  try {
    await deleteArchiveFile(p, f)
    revalidatePath('/hr')
    return Response.json({ ok: true })
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
