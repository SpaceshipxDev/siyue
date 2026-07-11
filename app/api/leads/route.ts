import { supabase } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PUBLIC lead-capture endpoint for the siyue.ai marketing landing.
//
//   POST /api/leads   { phone, name?, company?, hp? }  → { ok: true }
//
// No session check — the landing page is unauthenticated. The landing usually
// reaches this same-origin via a Caddy proxy, but we send CORS headers scoped
// to https://siyue.ai as belt-and-braces for the cross-origin case, and answer
// the OPTIONS preflight.
//
// `hp` is a honeypot field the real form keeps hidden; a bot that fills it gets
// a cheerful {ok:true} and no row.

const ALLOW_ORIGIN = 'https://siyue.ai'

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders() })
}

// Mainland mobile (1[3-9]xxxxxxxxx) or a landline with area code (0xxxxxxxxx…) —
// some bosses hand out the office landline, so we accept both.
const MOBILE_RE = /^1[3-9]\d{9}$/
const LANDLINE_RE = /^0\d{9,11}$/

// Naive in-memory rate limit: ~5 posts per IP per hour. Best-effort only —
// prod runs a pm2 cluster of 4 workers, so each worker holds its own Map and
// the real ceiling is ~4x this. Good enough to blunt a dumb flood; real abuse
// protection would live at Caddy. No pruning cron — the Map is tiny and the
// process recycles on deploy.
const RATE_LIMIT = 5
const RATE_WINDOW_MS = 60 * 60 * 1000
const hits = new Map<string, number[]>()

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent)
    return true
  }
  recent.push(now)
  hits.set(ip, recent)
  return false
}

function clamp(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  return t.slice(0, 60)
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders() })
}

export async function POST(request: Request): Promise<Response> {
  const forwarded = request.headers.get('x-forwarded-for') ?? ''
  const ip = forwarded.split(',')[0]?.trim() || 'unknown'

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400)
  }

  // Honeypot: a filled hidden field means bot. Ack without inserting so the bot
  // sees success and moves on.
  const hp = body.hp
  if (typeof hp === 'string' && hp.trim() !== '') {
    return json({ ok: true })
  }

  const rawPhone = typeof body.phone === 'string' ? body.phone : ''
  const phone = rawPhone.replace(/[\s-]/g, '')
  if (!MOBILE_RE.test(phone) && !LANDLINE_RE.test(phone)) {
    return json({ ok: false, error: 'invalid_phone' }, 400)
  }

  if (rateLimited(ip)) {
    return json({ ok: false, error: 'rate_limited' }, 429)
  }

  const { error } = await supabase.from('leads').insert({
    phone,
    name: clamp(body.name),
    company: clamp(body.company),
    source: 'landing',
    user_agent: request.headers.get('user-agent'),
    referer: request.headers.get('referer'),
    ip,
  })

  if (error) {
    console.error('[leads] insert failed:', error)
    return json({ ok: false, error: 'server_error' }, 500)
  }

  return json({ ok: true })
}
