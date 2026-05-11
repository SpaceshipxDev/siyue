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
  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
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
