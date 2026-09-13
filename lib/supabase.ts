import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Construct lazily — Next.js evaluates this module during the build's
// "Collecting page data" pass before runtime env vars are bound. A top-level
// throw on missing env breaks `next build` even though the client is only
// touched at request time.
let cached: SupabaseClient | null = null
function getClient(): SupabaseClient {
  if (cached) return cached
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.',
    )
  }
  // Schema is env-driven so a de-identified DEMO build can run against an
  // isolated `demo` schema IN THE SAME project — every table/function/trigger
  // mirrored there, the real `public` data untouched. Production sets nothing
  // → 'public', byte-for-byte as before.
  const schema = process.env.SUPABASE_DB_SCHEMA || 'public'
  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    // The client's schema generic is pinned to 'public' at the type level; the
    // cast lets a demo build target an alternate schema at runtime (supabase-js
    // just sends it as the Accept-Profile header) without widening every call.
    db: { schema: schema as 'public' },
  })
  return cached
}

// Storage reads of *.json go around the Supabase Smart CDN. Every 改一下-built
// ledger (人事/宿舍/工资/质量/仓库/退货/沟通单…) is a JSON file in Storage that
// is read-modified-written per entry. The CDN serves object downloads with
// `public, max-age=3600` and its invalidation on upsert is not reliable:
// measured 2026-09-13, prod read a 23-hour-old hr/2026-09.json (cf-cache-status
// HIT) right after a write landed — so entries "didn't show" until the TTL ran
// out. `cacheNonce` becomes ?cacheNonce=<ts> on the download URL, which the CDN
// keys on (verified MISS), so JSON reads always come from origin. Images and
// other binaries keep the CDN.
type DownloadOpts = { transform?: unknown; cacheNonce?: string | number }
function freshJsonStorage(client: SupabaseClient): SupabaseClient['storage'] {
  const storage = client.storage
  return new Proxy(storage, {
    get(target, prop) {
      if (prop === 'from') {
        return (bucket: string) => {
          const api = target.from(bucket)
          const orig = api.download.bind(api) as (
            path: string,
            options?: DownloadOpts,
            parameters?: unknown,
          ) => ReturnType<typeof api.download>
          ;(api as unknown as { download: unknown }).download = (
            path: string,
            options?: DownloadOpts,
            parameters?: unknown,
          ) =>
            orig(
              path,
              /\.json$/i.test(path)
                ? { ...(options ?? {}), cacheNonce: Date.now() }
                : options,
              parameters,
            )
          return api
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getClient()
    if (prop === 'storage') return freshJsonStorage(client)
    const value = Reflect.get(client, prop, client)
    return typeof value === 'function' ? value.bind(client) : value
  },
})

export const STORAGE_BUCKET = 'uploads'
