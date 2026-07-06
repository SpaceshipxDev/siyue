// Image/source-file URLs are stored in the DB as full Supabase public URLs
// (legacy rows) or as proxied paths under /api/img/<key> (rows written after
// the China-latency fix). Both forms must end up routed through /api/img so
// the browser only ever talks to our own origin — see app/api/img/[...path].
//
// Idempotent on already-proxied inputs.

import { withBase } from './base-path'

const SUPABASE_PUBLIC_PREFIX_RE =
  /^https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/public\/uploads\//

// This is the render-time transform: its output is only ever used as a
// browser-facing <img src> / <a href download>, so /api/img/ paths get
// the build's basePath prepended here. That centrally fixes every image
// call site under /demo. The DB write path (proxiedKeyUrl below) stays
// unprefixed so the canonical stored value is basePath-agnostic, and
// server-side key recovery (storageKeyFromUrl) reads those raw stored
// values, never this output. Under prod (basePath '') withBase is an
// identity, so this is unchanged. Idempotent-safe: an already-prefixed
// value ('/demo/api/img/…') no longer matches the '/api/img/' guard.
export function proxiedStorageUrl(url: string): string
export function proxiedStorageUrl(url: undefined): undefined
export function proxiedStorageUrl(url: string | undefined): string | undefined
export function proxiedStorageUrl(url: string | undefined): string | undefined {
  if (!url) return url
  if (url.startsWith('/api/img/')) return withBase(url)
  const m = SUPABASE_PUBLIC_PREFIX_RE.exec(url)
  if (!m) return url
  return withBase('/api/img/' + url.slice(m[0].length))
}

// Helper for upload-time call sites — given a Supabase storage key, returns
// the proxied URL with a cache-busting suffix.
export function proxiedKeyUrl(key: string, version: string | number = Date.now().toString(36)): string {
  const encoded = key.split('/').map(encodeURIComponent).join('/')
  return `/api/img/${encoded}?v=${version}`
}

// Inverse of the URL builders above: recover the Supabase storage key from a
// stored URL, whichever form it takes. Stored values are either proxied paths
// (`/api/img/<enc-key>?v=…`, written by proxiedKeyUrl) or legacy full Supabase
// public URLs (`https://<ref>.supabase.co/storage/v1/object/public/uploads/<key>`).
//
// This exists because server-side code must NOT `fetch()` the proxied path —
// it is relative, and Node's fetch rejects relative URLs ("Failed to parse
// URL from /api/img/…"). The key lets callers go straight to Supabase storage
// (supabase.storage.from(bucket).download(key)) instead.
export function storageKeyFromUrl(url: string): string | undefined {
  if (!url) return undefined
  // Proxied form: strip the /api/img/ prefix and the ?v= cache-buster, then
  // URL-decode each path segment (proxiedKeyUrl encodes them individually).
  if (url.startsWith('/api/img/')) {
    const noQuery = url.slice('/api/img/'.length).split('?')[0]
    return noQuery.split('/').map(decodeURIComponent).join('/')
  }
  const m = SUPABASE_PUBLIC_PREFIX_RE.exec(url)
  if (m) {
    return decodeURIComponent(url.slice(m[0].length).split('?')[0])
  }
  return undefined
}
