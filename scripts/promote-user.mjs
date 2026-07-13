// Flip a user from production → commerce. Single UPDATE so the
// users_role_stage_check constraint sees both changes at once.
// Usage: node scripts/promote-user.mjs <id>

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '')
}

const id = process.argv[2]
if (!id) { console.error('usage: node scripts/promote-user.mjs <id>'); process.exit(1) }

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  db: { schema: 'public' },
})

const { data, error } = await sb
  .from('users')
  .update({ role: 'commerce', default_stage: null })
  .eq('id', id)
  .select('id, name, role, default_stage, active')
if (error) { console.error(error); process.exit(1) }
console.log(JSON.stringify(data, null, 2))
