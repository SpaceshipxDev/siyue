import 'server-only'
import { cache } from 'react'
import { redirect } from 'next/navigation'
import type { Stage } from './data'
import { getUserById } from './db'
import { readSession } from './session'

export type Role = 'commerce' | 'production'

export type AuthUser = {
  id: string
  name: string
  role: Role
  defaultStage?: Stage
}

// Wrapped in React `cache` so multiple component reads in the same render
// share one DB hit. The cookie is read inside, but the `cookies()` call is
// itself per-request so memoization is correct.
export const currentUser = cache(async (): Promise<AuthUser | null> => {
  const session = await readSession()
  if (!session) return null
  const user = await getUserById(session.sub)
  if (!user) return null
  if (!user.active) return null
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    defaultStage: user.defaultStage,
  }
})

export async function requireUser(): Promise<AuthUser> {
  const u = await currentUser()
  if (!u) redirect('/login')
  return u
}

// Page guard for commerce-only routes. Production users would have already
// been redirected away by the proxy; this is defense in depth for the case
// where a request slips past (matcher gap, deep link from cache, etc).
export async function requireCommerce(): Promise<AuthUser> {
  const u = await requireUser()
  if (u.role !== 'commerce') {
    redirect(landingPathFor(u))
  }
  return u
}

// Minimal scope shape for dto.ts and the proxy. Anything that needs to make
// a "what can this user see" decision should take Scope, not Role — because
// 出货 (shipping) station heads run as production but need commerce-flavored
// visibility into customer data so they can print 出货单.
export type Scope = Pick<AuthUser, 'role' | 'defaultStage'>

export function canSeeMoney(s: Scope): boolean {
  return s.role === 'commerce'
}

// Customer name, customerId, contractNo, batchNo — anything customer-facing
// that's needed to print 出货单 or look the order up by customer.
export function canSeeCustomerData(s: Scope): boolean {
  return s.role === 'commerce' || s.defaultStage === '出货'
}

// Outsource management — creating shipments, receiving parts back, printing
// 外协单. 商务 owns this end-to-end; 工程 head also runs it because in many
// shops the same person who plans the routing is the one who hands off
// parts to the vendor. Money on the page (block amounts, totals) follows
// canSeeMoney separately, so 工程 sees vendor + dates + members but not
// pricing unless the rest of the system grants it.
export function canManageOutsource(s: Scope): boolean {
  return s.role === 'commerce' || s.defaultStage === '工程'
}

// Vendor info, outsource block details — commerce + 工程 (the outsource
// managers). Production stations other than 工程 still get scrubbed vendor
// fields via dto.ts.
export function canSeeVendor(s: Scope): boolean {
  return canManageOutsource(s)
}

export function canEditJob(s: Scope): boolean {
  return s.role === 'commerce'
}

// Stage chips on import draft (商务) and job detail (工程) pages. 商务 owns
// the initial route; 工程 keeps editing rights post-import because they
// catch routing mistakes once the part actually hits the floor. Other
// production stations only see the chips read-only.
export function canEditPartRoute(s: Scope): boolean {
  return s.role === 'commerce' || s.defaultStage === '工程'
}

// 工程 sees the same holistic master view as 商务 minus customer/money,
// and edits the same non-commercial job/component fields commerce edits
// (product, jobNo, dueDate, qty, material, etc). Same scope as
// canEditPartRoute today; named separately so the UI/action gates read
// at the right level of intent.
export function canEditProductionFields(s: Scope): boolean {
  return canEditPartRoute(s)
}

// Server-action guard for setPartRouteAction. Mirrors requireCommerce —
// throws via redirect when a non-editor tries to save.
export async function requirePartRouteEditor(): Promise<AuthUser> {
  const u = await requireUser()
  if (canEditPartRoute(u)) return u
  redirect(landingPathFor(u))
}

// Page guard for routes that the 出货 station head also needs (e.g. printing
// the customer-facing 出货单). Production users at other stations get bounced.
export async function requireCommerceOrShipping(): Promise<AuthUser> {
  const u = await requireUser()
  if (u.role === 'commerce') return u
  if (u.defaultStage === '出货') return u
  redirect(landingPathFor(u))
}

// Page + action guard for the 外协 surface — 商务 and 工程 both qualify.
// Mirrors requireCommerce but allows the 工程 head, who in this shop runs
// the vendor handoff alongside commerce.
export async function requireOutsourceManager(): Promise<AuthUser> {
  const u = await requireUser()
  if (canManageOutsource(u)) return u
  redirect(landingPathFor(u))
}

// /pulse (现场) view — 商务 + 工程 both qualify. The 工程 head runs the
// floor and needs the same factory-wide pulse view commerce uses (where is
// work piling up? what just moved?). Money columns on the page itself
// still follow canSeeMoney separately, so 工程 sees jobs/parts counts and
// the activity feed but no ¥ values.
export function canSeeFactoryPulse(s: Scope): boolean {
  return s.role === 'commerce' || s.defaultStage === '工程'
}

export async function requirePulseViewer(): Promise<AuthUser> {
  const u = await requireUser()
  if (canSeeFactoryPulse(u)) return u
  redirect(landingPathFor(u))
}

export function landingPathFor(user: AuthUser): string {
  if (user.role === 'commerce') return '/'
  // 工程 head sees the same holistic master view as commerce by default —
  // no auto-applied station filter. They can still drill into ?stage=X
  // explicitly via the master grid headers.
  if (user.defaultStage === '工程') return '/'
  return user.defaultStage
    ? `/?stage=${encodeURIComponent(user.defaultStage)}`
    : '/'
}
