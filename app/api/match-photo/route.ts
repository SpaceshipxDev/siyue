import { matchPhoto, sweepRegistrations } from '@/lib/matcher'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Public — this is the floor's entry point, phones with no session. The only
// thing a caller can learn is which open part a photographed sheet belongs
// to, and only by already holding that physical sheet; the response's token
// leads to the same /s surface the printed QR exposes.

const WINDOW_MS = 60_000
// /p sends one explicitly confirmed still photo per attempt.
const MAX_PER_WINDOW = 30
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
    return Response.json({ decision: 'no_match', error: 'rate limited' }, { status: 429 })
  }

  let file: File | null = null
  try {
    const fd = await req.formData()
    const f = fd.get('image')
    if (f instanceof File) file = f
  } catch {
    /* fall through */
  }
  if (!file || file.size === 0 || file.size > 8 * 1024 * 1024) {
    return Response.json({ decision: 'no_match', error: 'bad image' }, { status: 400 })
  }

  // Opportunistic self-heal: re-push any reference pages the matcher missed
  // (e.g. it was down during ingestion). Not awaited — never adds latency.
  void sweepRegistrations(5).catch(() => {})

  const bytes = new Uint8Array(await file.arrayBuffer())
  const result = await matchPhoto(bytes, file.type || 'image/jpeg')

  if (result.decision === 'match') {
    return Response.json({
      decision: 'match',
      token: result.token,
      via: result.via,
      latencyMs: result.latencyMs,
      part: {
        name: result.part.name,
        partNo: result.part.partNo,
        qty: result.part.qty,
      },
    })
  }
  if (result.decision === 'ambiguous') {
    return Response.json({
      decision: 'ambiguous',
      via: result.via,
      latencyMs: result.latencyMs,
      candidates: result.candidates
        .filter((c) => c.token)
        .map((c) => ({
          token: c.token,
          name: c.name,
          partNo: c.partNo,
          drawingNo: c.drawingNo,
          qty: c.qty,
          dueDate: c.dueDate,
          customer: c.customer,
        })),
    })
  }
  return Response.json({
    decision: 'no_match',
    via: result.via,
    latencyMs: result.latencyMs,
  })
}
