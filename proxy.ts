import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { decrypt, encrypt, SESSION_COOKIE } from '@/lib/session'
import { getUserById } from '@/lib/db'

// Next 16 proxy (formerly middleware.ts). Runs at Node runtime before route
// rendering. We do an *optimistic* gate here using the JWT — page-level
// requireUser/requireCommerce + server-action guards in app/actions.ts are
// the actual security wall. This layer is for UX (deep links land in the
// right place; production users don't accidentally see commerce screens).
//
// JWT roles can go stale when 老板 promotes/demotes a user — the cookie was
// minted at login and lives for 30 days. So before bouncing a "production"
// session from a commerce-only route we re-check the DB; if the user has
// actually been promoted to 商务 we re-issue the cookie and let them through
// instead of locking them out until they log out manually.

// /join is the public "Afterlight" creator waitlist landing — no session
// required, and its server action (joinWaitlist) POSTs back to /join, so the
// path must stay open to unauthenticated visitors.
// '/caiwu-lab' is a temporary, DB-free finance-redesign preview (mock data
// only, no writes to real tables). Public so it opens without login while we
// pick a winner — REMOVE this entry when the chosen design is promoted into
// /finance. See app/caiwu-lab/.
// '/w' is the vendor portal (外协厂商门户) — one unguessable token per vendor
// IS the auth (verified server-side by getVendorByPortalToken on every page
// render, action, and image fetch), so the path itself must stay open.
const PUBLIC_PATHS = ['/login', '/join', '/caiwu-lab', '/w']

// Production users share the master board (/) and job detail (/jobs/<id>)
// with commerce — the page itself scrubs commercial fields. Admin-only
// surfaces (外协/import/print/backend) stay locked. Employee management
// lives inline on /login (gated by ?admin=1 + a commerce session check in
// the page itself), so it does not need a forbidden-prefix entry here.
const PRODUCTION_FORBIDDEN_PREFIXES = [
  '/finance',
  '/pulse',
  '/report',
  '/handover',
  '/import',
  '/print',
  '/backend',
  '/station/outsource',
]

// 工程 head shares outsource duties with commerce, so they're allowed into
// the 外协 view and the printable 外协单. They also own imports — they upload
// 报价单 PDFs and confirm them into the master grid the same way commerce
// does — so /import/* and /api/ingest are explicitly allowed for them.
// /pulse (现场) is also open to them — they run the floor and need the
// factory-wide pulse view; the page itself hides ¥ columns from them via
// canSeeMoney. Everything else on the forbidden list (backend/non-
// outsource print) still blocks them.
const ENGINEERING_ALLOWED_PREFIXES = [
  '/station/outsource',
  '/print/outsource',
  '/import',
  '/api/ingest',
  '/pulse',
  // 报工 (worker output) — the 工程 head runs the floor, so they get the
  // same person-axis read commerce does; the page hides ¥ from them via
  // canSeeMoney, exactly like /pulse.
  '/report',
  // 工作交接单 — the 工程 head runs the floor and needs the unified handover
  // board (same gate as /pulse: commerce + 工程 head only).
  '/handover',
]

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  )

  const token = request.cookies.get(SESSION_COOKIE)?.value
  const session = await decrypt(token)

  if (!session) {
    if (isPublic) return NextResponse.next()
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    return NextResponse.redirect(url)
  }

  // Logged-in users visiting /login are bounced to their landing page by the
  // /login server component itself (via currentUser → landingPathFor). We do
  // NOT short-circuit it here, because the proxy only verifies the JWT — it
  // can't tell if the user row was deleted/deactivated. Letting /login render
  // means the DB-aware page check decides, so a stale cookie shows the form
  // instead of bouncing forever between / and /login.

  if (session.role === 'production') {
    // Forbidden = admin surfaces production users shouldn't see (money,
    // outsource, import, print). The master board itself (/)
    // is now shared, so it's NOT in the forbidden list.
    // 工程 head's holistic view lives at bare /, same as commerce — don't
     // pin them to ?stage=工程 when bouncing from a forbidden page.
    const homeSearch =
      session.ds && session.ds !== '工程'
        ? `?stage=${encodeURIComponent(session.ds)}`
        : ''

    const forbidden = PRODUCTION_FORBIDDEN_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
    )
    const engineeringAllowed =
      session.ds === '工程' &&
      ENGINEERING_ALLOWED_PREFIXES.some(
        (p) => pathname === p || pathname.startsWith(`${p}/`),
      )
    if (forbidden && !engineeringAllowed) {
      // Heal stale JWT before bouncing. If the user has actually been
      // promoted to commerce since their cookie was minted, refresh it
      // in place and let the request proceed.
      const fresh = await getUserById(session.sub)
      if (fresh?.active && fresh.role === 'commerce') {
        const refreshed = await encrypt({
          sub: fresh.id,
          role: 'commerce',
          ds: undefined,
        })
        const res = NextResponse.next()
        res.cookies.set(SESSION_COOKIE, refreshed, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/',
          maxAge: 60 * 60 * 24 * 30,
        })
        return res
      }
      const url = request.nextUrl.clone()
      url.pathname = '/'
      url.search = homeSearch
      return NextResponse.redirect(url)
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    // Skip _next, static assets, favicon, and the client-side STEP engine.
    // The OpenCascade WASM engine + its worker (occt.worker.js /
    // occt-import-js.js / .wasm) are static /public assets fetched by a Web
    // Worker. They carry no data and must never be auth-gated — otherwise a
    // missing/expired cookie makes the worker fetch the /login HTML instead of
    // the WASM, and STEP parsing dies. Everything else (including API routes)
    // flows through.
    '/((?!_next/static|_next/image|favicon\\.ico|occt\\.worker\\.js|occt-import-js\\.(?:js|wasm)|.*\\.(?:png|jpg|jpeg|svg|gif|webp|avif|ico)$).*)',
  ],
}
