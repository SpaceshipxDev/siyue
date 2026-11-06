import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 待确认 (于海伟 2026-11-06) —— 跟待提货一个样子 (lib/pickup)。
 *
 * 订单状态那个小菜单里点「待确认」, 这张单就从在产挪进看板上的「待确认」一
 * 栏; 再点一次撤掉, 回在产。出货报完了照样归已出货。
 *
 * TABLE-FREE, 没有 migration:
 *   jobs/pending-confirm.json   { "<jobId>": { at, by } }
 */

export type ConfirmMark = { at: string; by: string }

const KEY = 'jobs/pending-confirm.json'
const TTL_MS = 30_000

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

let cache: { at: number; all: Record<string, ConfirmMark> } | null = null

function normalize(raw: unknown): Record<string, ConfirmMark> {
  const out: Record<string, ConfirmMark> = {}
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

async function read(): Promise<Record<string, ConfirmMark>> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return {}
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return {}
  }
}

async function write(all: Record<string, ConfirmMark>): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(all), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
  cache = { at: Date.now(), all }
}

/** 标了待确认的工单。半分钟读一次 —— 看板每次都要问。 */
export async function getConfirmJobIds(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return new Set(Object.keys(cache.all))
  const all = await read()
  cache = { at: Date.now(), all }
  return new Set(Object.keys(all))
}

export async function setJobConfirm(jobId: string, on: boolean, by: string): Promise<void> {
  await withLock(async () => {
    const all = await read()
    if (on) all[jobId] = { at: new Date().toISOString(), by }
    else if (all[jobId]) delete all[jobId]
    else return
    await write(all)
  })
}
