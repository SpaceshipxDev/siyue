import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_')
}

// Supabase Storage's remove API accepts object keys, not folder prefixes.
// Walk the small per-job tree (part images, source workbook, inspection
// photos, contracts) so deleting a job does not leave private source material
// orphaned in the bucket. Packet intake photos live under packets/<packetId>,
// so their keys are supplied separately from packet_pages before the DB
// cascade removes those rows.
async function listObjectKeys(prefix: string): Promise<string[]> {
  const keys: string[] = []
  let offset = 0
  const limit = 1000

  while (true) {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .list(prefix, { limit, offset })
    if (error) throw error
    const items = data ?? []
    for (const item of items) {
      const key = `${prefix}/${item.name}`
      if (item.id) keys.push(key)
      else keys.push(...(await listObjectKeys(key)))
    }
    if (items.length < limit) break
    offset += limit
  }
  return keys
}

export async function removeJobStorage(
  jobId: string,
  packetPageKeys: string[],
): Promise<void> {
  const jobKeys = await listObjectKeys(safeId(jobId))
  const keys = [...new Set([...jobKeys, ...packetPageKeys])]
  for (let i = 0; i < keys.length; i += 100) {
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .remove(keys.slice(i, i + 100))
    if (error) throw error
  }
}
