import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 报工金额手改 (于海伟 2026-11-05) —— 一条完成的经手金额算得不对 (单价没定、
 * 这一道活本来就不值这个数…), 在报表明细里直接改成一个数。改了之后统计、明
 * 细、导出、首页今日经手都按这个数 (lib/part-family applyFamilyValues 那一道
 * 套上去)。清空 = 回到系统算的。只开商务于海伟 (lib/auth canFixReport)。
 *
 * 键跟分工一样是 零件::工序 —— 一道工序一条完成, 改的是这一条的整条金额。
 *
 * TABLE-FREE, 没有 migration:
 *   jobs/report-value.json   { "<partId>::<stage>": { valueCny, by, at } }
 */

export type ValueEdit = { valueCny: number; by: string; at: string }

const KEY = 'jobs/report-value.json'
const TTL_MS = 30_000

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

let cache: { at: number; all: Record<string, ValueEdit> } | null = null

function normalize(raw: unknown): Record<string, ValueEdit> {
  const out: Record<string, ValueEdit> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.valueCny !== 'number' || !Number.isFinite(r.valueCny)) continue
    out[k] = {
      valueCny: r.valueCny,
      by: typeof r.by === 'string' ? r.by : '',
      at: typeof r.at === 'string' ? r.at : '',
    }
  }
  return out
}

async function read(): Promise<Record<string, ValueEdit>> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return {}
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return {}
  }
}

async function write(all: Record<string, ValueEdit>): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(all), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
  cache = { at: Date.now(), all }
}

/** 全部手改过的金额。半分钟读一次 —— 报工统计每次都要问。读不到就当没改过。 */
export async function getValueEdits(): Promise<Record<string, ValueEdit>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.all
  try {
    const all = await read()
    cache = { at: Date.now(), all }
    return all
  } catch {
    return cache?.all ?? {}
  }
}

/** 改成 valueCny; null = 回到系统算的。 */
export async function setValueEdit(key: string, valueCny: number | null, by: string): Promise<void> {
  await withLock(async () => {
    const all = await read()
    if (valueCny === null) {
      if (!all[key]) return
      delete all[key]
    } else {
      all[key] = { valueCny: Math.round(valueCny * 100) / 100, by, at: new Date().toISOString() }
    }
    await write(all)
  })
}
