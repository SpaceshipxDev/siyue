import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { currentUser } from '@/lib/auth'
import { addContractFile, isAllowedContractName } from '@/lib/contract-file'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BYTES = 16 * 1024 * 1024

// 合同上传 — 财务 attaches the signed contract to an order. Commerce-gated
// (the money surface): production workers never see the 财务 tab. Stores the
// blob + a metadata row (contract_files); the response carries the new row so
// the client can append it without a full RSC refresh (GFW posture).
export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user || user.role !== 'commerce') {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const form = await request.formData()
  const file = form.get('file')
  const jobId = form.get('jobId')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: 'no file' }, { status: 400 })
  }
  if (typeof jobId !== 'string' || !jobId) {
    return Response.json({ ok: false, error: 'missing jobId' }, { status: 400 })
  }
  if (!isAllowedContractName(file.name)) {
    return Response.json(
      { ok: false, error: '仅支持 PDF / Word / Excel / 图片' },
      { status: 415 },
    )
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ ok: false, error: '文件过大（上限 16MB）' }, { status: 413 })
  }

  const buf = await file.arrayBuffer()
  let row
  try {
    row = await addContractFile({
      jobId,
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

  revalidatePath(`/jobs/${jobId}`)

  return Response.json({ ok: true, contract: row })
}
