// Image/source-file URLs are stored in the DB as full Supabase public URLs
// (legacy rows) or as proxied paths under /api/img/<key> (rows written after
// the China-latency fix). Both forms must end up routed through /api/img so
// the browser only ever talks to our own origin — see app/api/img/[...path].
//
// Idempotent on already-proxied inputs.

const SUPABASE_PUBLIC_PREFIX_RE =
  /^https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/public\/uploads\//

export function proxiedStorageUrl(url: string): string
export function proxiedStorageUrl(url: undefined): undefined
export function proxiedStorageUrl(url: string | undefined): string | undefined
export function proxiedStorageUrl(url: string | undefined): string | undefined {
  if (!url) return url
  if (url.startsWith('/api/img/')) return url
  const m = SUPABASE_PUBLIC_PREFIX_RE.exec(url)
  if (!m) return url
  return '/api/img/' + url.slice(m[0].length)
}

// Helper for upload-time call sites — given a Supabase storage key, returns
// the proxied URL with a cache-busting suffix.
export function proxiedKeyUrl(key: string, version: string | number = Date.now().toString(36)): string {
  const encoded = key.split('/').map(encodeURIComponent).join('/')
  return `/api/img/${encoded}?v=${version}`
}
