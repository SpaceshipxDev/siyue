import {
  ingestMachineSnapshots,
  machineTokenFingerprint,
  machineTokenMatches,
  parseMachineIngest,
} from '@/lib/machines'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The first collector cycle can contain one complete NC program per machine.
// next.config.ts allows 50 MB through the proxy; retain a small margin here.
const MAX_BODY_BYTES = 45_000_000

export async function POST(request: Request): Promise<Response> {
  if (!machineTokenMatches(request)) {
    const tokenSha256 = machineTokenFingerprint(request)
    if (tokenSha256) console.warn('[machine-ingest] rejected token sha256', tokenSha256)
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const declared = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Response.json({ ok: false, error: 'payload too large' }, { status: 413 })
  }

  try {
    const raw = await request.text()
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      return Response.json({ ok: false, error: 'payload too large' }, { status: 413 })
    }
    const payload = parseMachineIngest(JSON.parse(raw))
    await ingestMachineSnapshots(payload)
    return Response.json(
      { ok: true, accepted: payload.machines.length, serverTime: new Date().toISOString() },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid payload'
    return Response.json({ ok: false, error: message }, { status: 400 })
  }
}
