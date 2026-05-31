// Single source of truth for "today" in the factory's local timezone.
// Asia/Shanghai because the factory runs on Beijing time; using the server
// clock directly (UTC on Vercel) drifts the date by 8 hours and rolls over
// at the wrong moment.
export function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
}

// Stage completedAt is stored as MM-DD (year is implicit / not surfaced in
// the UI). Helper so call sites don't slice() in five places.
export function todayMMDD(): string {
  return today().slice(5)
}

// === Local (Asia/Shanghai) reporting windows ===
//
// finished_at timestamps are stored as UTC ISO strings, but "what did this
// worker do today" is a question about the factory's *local* day. Shanghai
// is a fixed +08:00 offset year-round (no DST), so we can pin local
// midnight without a tz library: local 00:00 == UTC midnight − 8h.

export type Granularity = 'day' | 'week' | 'month'

const SH_OFFSET_MS = 8 * 60 * 60 * 1000

// UTC instant of Asia/Shanghai local midnight for the given Y/M/D. Month is
// 0-based (Date.UTC convention); over/underflow normalizes (d=0 → last day
// of prev month, m=12 → Jan next year), which the window math below relies on.
function shInstant(y: number, monthZeroBased: number, d: number): string {
  return new Date(Date.UTC(y, monthZeroBased, d) - SH_OFFSET_MS).toISOString()
}

// [from, to) UTC instants spanning the local day / ISO-week (Mon–Sun) /
// calendar month that contains `date` (a 'YYYY-MM-DD' string in Shanghai
// local time, e.g. from today()).
export function shanghaiWindow(
  date: string,
  gran: Granularity,
): { from: string; to: string } {
  const [y, m, d] = date.split('-').map(Number)
  const mz = m - 1
  if (gran === 'day') return { from: shInstant(y, mz, d), to: shInstant(y, mz, d + 1) }
  if (gran === 'month') return { from: shInstant(y, mz, 1), to: shInstant(y, mz + 1, 1) }
  // week: snap back to Monday. getUTCDay() is 0=Sun..6=Sat.
  const wd = new Date(Date.UTC(y, mz, d)).getUTCDay()
  const mondayOffset = (wd + 6) % 7
  return {
    from: shInstant(y, mz, d - mondayOffset),
    to: shInstant(y, mz, d - mondayOffset + 7),
  }
}

// Step the anchor date forward/back by one unit of the granularity. Returns a
// 'YYYY-MM-DD' string. Used by the 报功 page's ◂ ▸ period nav.
export function shiftDate(date: string, gran: Granularity, delta: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const next =
    gran === 'month'
      ? new Date(Date.UTC(y, m - 1 + delta, d))
      : new Date(Date.UTC(y, m - 1, d + delta * (gran === 'week' ? 7 : 1)))
  return next.toISOString().slice(0, 10)
}
