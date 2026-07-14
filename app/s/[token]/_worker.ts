import { cookies } from 'next/headers'
import { currentUser } from '@/lib/auth'

// One cookie, one year: the worker types their name once on first scan and
// every 报工 after that is attributed. Path-wide (all /s/*) — the same
// 王师傅 scans many different travellers. Lives outside _actions.ts because
// a 'use server' module may only export async functions.
export const WORKER_COOKIE = 'ym_worker'

export function decodeWorker(raw: string | undefined): string {
  if (!raw) return ''
  try {
    return decodeURIComponent(raw).trim()
  } catch {
    return raw.trim()
  }
}

// Who is reporting — ONE resolution shared by the /s page, the /p port and
// the scanReport action. A logged-in floor account is authoritative; the
// remembered public-scan name is the fallback for session-less phones. The
// page hides the name-picker whenever this resolves, so an action that
// consulted only the cookie would silently drop every report from a
// logged-in worker who never needed the picker.
export async function resolveActor(): Promise<string> {
  const [user, jar] = await Promise.all([currentUser(), cookies()])
  if (user?.role === 'production') return user.name
  return decodeWorker(jar.get(WORKER_COOKIE)?.value)
}
