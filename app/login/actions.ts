'use server'

import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { getUserById, isAdminUser, verifyUserPin } from '@/lib/db'
import { createSession, deleteSession } from '@/lib/session'
import { landingPathFor } from '@/lib/auth'
import { WORKER_COOKIE } from '@/app/s/[token]/_worker'

async function rememberWorker(name: string): Promise<void> {
  const jar = await cookies()
  jar.set(WORKER_COOKIE, encodeURIComponent(name), {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  })
}

// In-process brute-force counter. Five wrong PINs in five minutes locks the
// user id out for five minutes from this serverless instance. Cross-instance
// races are MVP-acceptable — same trade-off as withWriteLock in lib/db.ts.
type Attempt = { failures: number; firstAt: number; lockedUntil?: number }
const attempts = new Map<string, Attempt>()
const WINDOW_MS = 5 * 60 * 1000
const MAX_FAILURES = 5
const LOCKOUT_MS = 5 * 60 * 1000

function checkLockout(userId: string): { locked: boolean; secondsLeft: number } {
  const a = attempts.get(userId)
  if (!a?.lockedUntil) return { locked: false, secondsLeft: 0 }
  const left = a.lockedUntil - Date.now()
  if (left <= 0) {
    attempts.delete(userId)
    return { locked: false, secondsLeft: 0 }
  }
  return { locked: true, secondsLeft: Math.ceil(left / 1000) }
}

function recordFailure(userId: string): void {
  const now = Date.now()
  const cur = attempts.get(userId)
  if (!cur || now - cur.firstAt > WINDOW_MS) {
    attempts.set(userId, { failures: 1, firstAt: now })
    return
  }
  cur.failures += 1
  if (cur.failures >= MAX_FAILURES) cur.lockedUntil = now + LOCKOUT_MS
}

export type LoginResult =
  | { ok: true; redirectTo: string }
  | { ok: false; error: string }

export async function loginAction(
  userId: string,
  pin: string,
): Promise<LoginResult> {
  if (!userId || !pin) return { ok: false, error: '请输入 PIN' }
  if (!/^\d{4}$/.test(pin)) return { ok: false, error: 'PIN 必须为 4 位数字' }

  const lock = checkLockout(userId)
  if (lock.locked) {
    return { ok: false, error: `账号已锁定 · ${lock.secondsLeft} 秒后重试` }
  }

  const user = await verifyUserPin(userId, pin)
  if (!user) {
    recordFailure(userId)
    return { ok: false, error: 'PIN 错误' }
  }
  attempts.delete(userId)

  await createSession({
    sub: user.id,
    role: user.role,
    ds: user.defaultStage,
  })
  if (user.role === 'production') await rememberWorker(user.name)

  const redirectTo = landingPathFor({
    id: user.id,
    name: user.name,
    role: user.role,
    employeeRole: user.employeeRole,
    defaultStage: user.defaultStage,
    isFinance: user.isFinance,
  })
  return { ok: true, redirectTo }
}

// Pilot-phase gate removal: with OPEN_LOGIN=1, tapping a name IS the login —
// no PIN. Deployment friction matters more than security while the factory
// is being onboarded; unset the env var and the PIN keypad is back. The
// 管理员工 admin surface keeps its PIN either way.
export async function loginOpenAction(userId: string): Promise<LoginResult> {
  if (process.env.OPEN_LOGIN !== '1') return { ok: false, error: '请输入 PIN' }
  const user = await getUserById(userId)
  if (!user) return { ok: false, error: '账号不存在' }

  await createSession({
    sub: user.id,
    role: user.role,
    ds: user.defaultStage,
  })
  if (user.role === 'production') await rememberWorker(user.name)

  const redirectTo = landingPathFor({
    id: user.id,
    name: user.name,
    role: user.role,
    employeeRole: user.employeeRole,
    defaultStage: user.defaultStage,
    isFinance: user.isFinance,
  })
  return { ok: true, redirectTo }
}

export async function logoutAction(): Promise<void> {
  await deleteSession()
  redirect('/login')
}

// Admin entry from /login → 管理员工. Authenticates an account with 老板-level
// authority by id (isAdminUser — the bootstrap 老板 or a promoted owner like
// Harry); any other user is rejected even if they share commerce role. On
// success the cookie is set and we land back on /login?admin=1 — the admin
// stays on the login screen until they hit 完成 (logoutAction).
export async function loginAdminAction(
  userId: string,
  pin: string,
): Promise<LoginResult> {
  if (!isAdminUser(userId)) return { ok: false, error: '仅老板可管理员工' }
  if (!pin) return { ok: false, error: '请输入 PIN' }
  if (!/^\d{4}$/.test(pin)) return { ok: false, error: 'PIN 必须为 4 位数字' }

  const lock = checkLockout(userId)
  if (lock.locked) {
    return { ok: false, error: `账号已锁定 · ${lock.secondsLeft} 秒后重试` }
  }

  const user = await verifyUserPin(userId, pin)
  if (!user || user.role !== 'commerce') {
    recordFailure(userId)
    return { ok: false, error: 'PIN 错误' }
  }
  attempts.delete(userId)

  await createSession({
    sub: user.id,
    role: user.role,
    ds: user.defaultStage,
  })

  return { ok: true, redirectTo: '/login?admin=1' }
}
