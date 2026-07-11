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
