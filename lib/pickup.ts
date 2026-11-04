import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 待提货 (于海伟 2026-11-04) —— 货做好了, 等客户自己来拿。
 *
 * 订单状态那个小菜单里点「待提货」, 这张单就从在产挪进看板上的「待提货」一
 * 栏; 出货报完了自然归已出货。再点一次撤掉, 回在产。
 *
 * TABLE-FREE, 没有 migration:
 *   jobs/pickup.json   { "<jobId>": { at, by } }
 */

export type PickupMark = { at: string; by: string }

const KEY = 'jobs/pickup.json'
const TTL_MS = 30_000

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

let cache: { at: number; all: Record<string, PickupMark> } | null = null

function normalize(raw: unknown): Record<string, PickupMark> {
  const out: Record<string, PickupMark> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    out[id] = {
      at: typeof r.at === 'string' ? r.at : '',
      by: typeof r.by === 'string' ? r.by : '',
    }
  }
  return out
}

async function read(): Promise<Record<string, PickupMark>> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return {}
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return {}
  }
}

async function write(all: Record<string, PickupMark>): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(all), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
  cache = { at: Date.now(), all }
}

/** 标了待提货的工单。半分钟读一次 —— 看板每次都要问。 */
export async function getPickupJobIds(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return new Set(Object.keys(cache.all))
  const all = await read()
  cache = { at: Date.now(), all }
  return new Set(Object.keys(all))
}

export async function setJobPickup(jobId: string, on: boolean, by: string): Promise<void> {
  await withLock(async () => {
    const all = await read()
    if (on) all[jobId] = { at: new Date().toISOString(), by }
    else if (all[jobId]) delete all[jobId]
    else return
    await write(all)
  })
}
