// One-shot: insert a user row directly via the Supabase service-role key.
// Mirrors lib/db.ts::createUser — same id format, same bcrypt cost, same shape.
// Usage: node scripts/create-user.mjs <name> <role> <pin> [stage]

import { createClient } from '@supabase/supabase-js'
import bcrypt from 'bcryptjs'
import { readFileSync } from 'node:fs'

const envPath = new URL('../.env.local', import.meta.url)
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
  if (!m) continue
  const v = m[2].replace(/^["']|["']$/g, '')
  process.env[m[1]] ??= v
}

const [, , name, role, pin, stage] = process.argv
if (!name || !role || !pin) {
  console.error('usage: node scripts/create-user.mjs <name> <role> <pin> [stage]')
  process.exit(1)
}
if (role !== 'commerce' && role !== 'production') {
  throw new Error(`role must be commerce|production, got ${role}`)
}
if (!/^\d{4}$/.test(pin)) throw new Error('pin must be 4 digits')
if (role === 'production' && !stage) throw new Error('production users need a stage')
if (role === 'commerce' && stage) throw new Error('commerce users must not have a stage')

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) throw new Error('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  db: { schema: 'public' },
})

const id = `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const pin_hash = await bcrypt.hash(pin, 10)

const { error } = await sb.from('users').insert({
  id,
  name: name.trim(),
  pin_hash,
  role,
  default_stage: stage ?? null,
  active: true,
})
if (error) {
  console.error(error)
  process.exit(1)
}
console.log(`created: name=${name} role=${role}${stage ? ` stage=${stage}` : ''} id=${id} pin=${pin}`)
