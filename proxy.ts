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
// '/w' is the vendor portal (外协厂商门户) — one unguessable token per vendor
// IS the auth (verified server-side by getVendorByPortalToken on every page
// render, action, and image fetch), so the path itself must stay open.
// '/x/demo' is the public sandbox of the /x sheet — pure localStorage, no DB
// reads or writes, shareable with prospect factories. The real /x stays
// session-gated (it is NOT in this list; prefix matching is exact-or-slash).
// '/api/leads' is the lead-capture POST from the public siyue.ai landing —
// it does its own validation/honeypot/rate-limit; a session gate here would
// 307 every prospect's form submit to /login.
// '/s' is the 随工单 scan surface (traveller QR) — the unguessable per-part
// token printed on the paper IS the auth (verified server-side by
// getPartScanView on every render and write), so the path stays open the
// same way the '/w' vendor portal does. It exposes one part's route/progress
// and accepts one narrow write (report qty at the current OP) — no prices,
// no other parts, no dashboard.
// '/p' + '/api/match-photo' are the photo-报工 loop — public for the same
// reason '/s' is: the worker's credential is the physical sheet in their
// hand, and a successful match only resolves to the same narrow /s surface
// the printed QR opens (rate-limited inside the route).
// '/api/unmatched-report' is the no-match valve — same trust model as
// /api/match-photo (rate-limited inside the route; writes only an unresolved
// review row for the PMC, never the part state machine).
const PUBLIC_PATHS = ['/login', '/join', '/w', '/s', '/p', '/api/match-photo', '/api/unmatched-report', '/x/demo', '/api/leads']

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
  '/matcher-lab',
  '/api/matcher-lab',
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
  // 随工单 — at Yingma the 编程/工程 head confirms the OP route and prints
  // the traveller, so the print surface opens to them like /print/outsource.
  '/print/traveller',
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
  const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(request.nextUrl.hostname)
  const isLocalMachineKit =
    isLocalHost &&
    (pathname === '/machine-kit' ||
      pathname.startsWith('/machine-kit/') ||
      pathname === '/api/lynuc' ||
      pathname.startsWith('/api/lynuc/'))
  const isPublic = isLocalMachineKit || PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  )

  const token = request.cookies.get(SESSION_COOKIE)?.value
  const session = await decrypt(token)

  if (!session) {
    // Demo auto-login (the /demo sales build). With DEMO_MODE=1 and a
    // seeded DEMO_USER_ID, mint a commerce session on the fly so a
    // prospect lands straight in the app with no PIN. We set the cookie on
    // BOTH the request (so this same render's DB-backed currentUser()
    // already sees it — no login bounce on first hit) and the response (so
    // the browser keeps it). /login stays exempt so the real login form is
    // still reachable inside the demo. This whole branch is inert in prod:
    // DEMO_MODE is unset, so the original redirect path below runs.
    const demoUserId = process.env.DEMO_USER_ID
    if (process.env.DEMO_MODE === '1' && demoUserId && pathname !== '/login') {
      const demoToken = await encrypt({
        sub: demoUserId,
        role: 'commerce',
        ds: undefined,
      })
      request.cookies.set(SESSION_COOKIE, demoToken)
      const res = NextResponse.next({ request: { headers: request.headers } })
      res.cookies.set(SESSION_COOKIE, demoToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
      })
      return res
    }
    if (isPublic) return NextResponse.next()
    const url = request.nextUrl.clone()
    // A session-less phone opening the bare domain is a WORKER (the QR on
    // the machine, the link pinned in the factory 群) — land them straight
    // in the camera port. PMC/boss phones carry a session and fall through
    // to the board; a worker who somehow needs /login can still reach it.
    if (pathname === '/' && /Mobile|Android|iPhone/i.test(request.headers.get('user-agent') ?? '')) {
      url.pathname = '/p'
      url.search = ''
      return NextResponse.redirect(url)
    }
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
    // Bare '/' listed explicitly: under a basePath build (the /demo sales
    // demo), the broad regex below compiles to `^/demo(?:/(...))…` whose
    // path group REQUIRES a slash after the basePath — so `/demo` itself
    // (the exact URL a prospect opens) would bypass the proxy and never get
    // the demo auto-login. In prod (no basePath) this entry is a harmless
    // duplicate of the broad pattern.
    '/',
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
