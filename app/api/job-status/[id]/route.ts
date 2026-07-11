import { NextRequest } from 'next/server'
import { getJobStatus } from '@/lib/db'
import { currentUser } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Tiny status poll for /import/[id]. Returns {status, parseError, ok}.
// Replaces a full router.refresh() loop so the response stays small enough
// to survive cross-border HTTP/2 jitter for mainland users on the HK VM.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const { id } = await params
  const row = await getJobStatus(id)
  if (!row) {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  }
  return Response.json(
    { ok: true, status: row.status, parseError: row.parseError },
    { headers: { 'cache-control': 'no-store' } },
  )
}
