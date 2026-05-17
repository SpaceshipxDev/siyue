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

const PUBLIC_PATHS = ['/login']

// Production users share the master board (/) and job detail (/jobs/<id>)
// with commerce — the page itself scrubs commercial fields. Admin-only
// surfaces (月结/外协/import/print/backend) stay locked. Employee management
// lives inline on /login (gated by ?admin=1 + a commerce session check in
// the page itself), so it does not need a forbidden-prefix entry here.
const PRODUCTION_FORBIDDEN_PREFIXES = [
  '/month',
  '/pulse',
  '/import',
  '/print',
  '/backend',
  '/station/outsource',
]

// 工程 head shares outsource duties with commerce, so they're allowed into
// the 外协 view and the printable 外协单. They also own imports — they upload
// 报价单 PDFs and confirm them into the master grid the same way commerce
// does — so /import/* and /api/ingest are explicitly allowed for them.
// Everything else on the forbidden list (月结/backend/non-outsource print)
// still blocks them.
const ENGINEERING_ALLOWED_PREFIXES = [
  '/station/outsource',
  '/print/outsource',
  '/import',
  '/api/ingest',
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
    // outsource, monthly close, import, print). The master board itself (/)
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
    // Skip _next, static assets, favicon. Everything else (including API
    // routes) flows through.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp|avif|ico)$).*)',
  ],
}
