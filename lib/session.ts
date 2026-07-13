import 'server-only'
import { cookies } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'

// Stateless session: a signed JWT in an httpOnly cookie. Payload carries
// role + defaultStage so the proxy can route requests at the edge without
// hitting Postgres. The DAL (lib/auth.ts currentUser) still re-hydrates the
// user row from the DB so a deactivated user is kicked out on the next
// request, and demotions take effect server-side immediately. The JWT copy
// is only ever used for proxy-level UX redirects.

// Env-driven so the /demo build can run its own session cookie
// (siyue_demo_session) side-by-side with production on the same host
// without the two clobbering each other. Defaults to the prod name.
export const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || 'siyue_session'
const TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days

// Read SESSION_SECRET lazily — Next.js evaluates this module during the
// build's "Collecting page data" pass before runtime env vars are bound,
// so a top-level throw breaks `next build` even though the secret is only
// needed at request time.
let cachedKey: Uint8Array | null = null
function getKey(): Uint8Array {
  if (cachedKey) return cachedKey
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    throw new Error('Missing SESSION_SECRET in environment.')
  }
  cachedKey = new TextEncoder().encode(secret)
  return cachedKey
}

export type SessionPayload = {
  sub: string
  role: 'commerce' | 'production'
  ds?: string
}

export async function encrypt(payload: SessionPayload): Promise<string> {
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(getKey())
}

export async function decrypt(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, getKey(), { algorithms: ['HS256'] })
    if (typeof payload.sub !== 'string') return null
    if (payload.role !== 'commerce' && payload.role !== 'production') return null
    const ds = typeof payload.ds === 'string' ? payload.ds : undefined
    return { sub: payload.sub, role: payload.role, ds }
  } catch {
    return null
  }
}

export async function createSession(input: SessionPayload): Promise<void> {
  const token = await encrypt(input)
  const jar = await cookies()
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: TTL_SECONDS,
  })
}

export async function readSession(): Promise<SessionPayload | null> {
  const jar = await cookies()
  return decrypt(jar.get(SESSION_COOKIE)?.value)
}

export async function deleteSession(): Promise<void> {
  const jar = await cookies()
  jar.delete(SESSION_COOKIE)
}
