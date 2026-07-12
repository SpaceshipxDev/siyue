import { NextResponse } from 'next/server'
import {
  createPendingReport,
  pendingPhotoKey,
  uploadPacketPageImage,
  upsertWorker,
} from '@/lib/packets'
import { WORKER_COOKIE } from '@/app/s/[token]/_worker'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// The no-match valve — public like /api/match-photo (the floor has no
// sessions). A worker whose photo matched nothing posts the photo + claimed
// stage + count; it lands in the PMC's 待归档 queue instead of stopping the
// worker. Writes only an unresolved review row — nothing touches the
// part/stage state machine until the PMC attaches it.

const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 10
const hits = new Map<string, number[]>()

function limited(ip: string): boolean {
  const now = Date.now()
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)
  arr.push(now)
  hits.set(ip, arr)
  if (hits.size > 2000) hits.clear()
  return arr.length > MAX_PER_WINDOW
}

export async function POST(req: Request): Promise<Response> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
  if (limited(ip)) {
    return Response.json({ ok: false, error: 'rate limited' }, { status: 429 })
  }

  let file: File | null = null
  let stage = ''
  let qty = 0
  let name = ''
  try {
    const fd = await req.formData()
    const f = fd.get('image')
    if (f instanceof File) file = f
    stage = String(fd.get('stage') ?? '').trim().slice(0, 12)
    qty = Number.parseInt(String(fd.get('qty') ?? ''), 10)
    name = String(fd.get('name') ?? '').trim().slice(0, 20)
  } catch {
    /* fall through */
  }
  if (!file || file.size === 0 || file.size > 8 * 1024 * 1024) {
    return Response.json({ ok: false, error: 'bad image' }, { status: 400 })
  }
  if (!Number.isFinite(qty) || qty <= 0 || qty > 99_999) {
    return Response.json({ ok: false, error: 'bad qty' }, { status: 400 })
  }
  if (!name) {
    return Response.json({ ok: false, error: 'name required' }, { status: 400 })
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20)
  const photoKey = pendingPhotoKey(id)
  await uploadPacketPageImage(photoKey, bytes, file.type || 'image/jpeg')
  await createPendingReport({ photoKey, claimedStage: stage || undefined, qty, actor: name })
  await upsertWorker(name).catch(() => {})

  // Remember the name for the whole floor loop (same cookie /s sets).
  // NextResponse.cookies.set URL-encodes the value itself (unlike the
  // server-action cookies() jar) — pass the raw name or it double-encodes
  // and decodeWorker returns garbage.
  const res = NextResponse.json({ ok: true })
  res.cookies.set(WORKER_COOKIE, name, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  })
  return res
}
