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
