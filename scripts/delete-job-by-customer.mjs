import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) throw new Error('missing supabase env')

const supabase = createClient(url, key, { auth: { persistSession: false } })

const needle = process.argv[2]
const apply = process.argv.includes('--apply')
if (!needle) throw new Error('usage: node scripts/delete-job-by-customer.mjs <customer substring> [--apply]')

const { data, error } = await supabase
  .from('jobs')
  .select('id, job_no, customer, product, status, amount_cny, due_date')
  .ilike('customer', `%${needle}%`)
if (error) throw error

console.log(`matches for "${needle}": ${data.length}`)
for (const j of data) {
  console.log(`  ${j.id}  ${j.job_no}  [${j.status}]  ${j.customer} · ${j.product}  ¥${j.amount_cny}  due ${j.due_date}`)
}

if (!apply) {
  console.log('\ndry run — pass --apply to actually delete')
  process.exit(0)
}

for (const j of data) {
  const { error: delErr } = await supabase.from('jobs').delete().eq('id', j.id)
  if (delErr) {
    console.error(`  failed ${j.id}: ${delErr.message}`)
  } else {
    console.log(`  deleted ${j.id}`)
  }
}
