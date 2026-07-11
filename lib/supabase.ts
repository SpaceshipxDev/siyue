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

export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getClient()
    const value = Reflect.get(client, prop, client)
    return typeof value === 'function' ? value.bind(client) : value
  },
})

export const STORAGE_BUCKET = 'uploads'
