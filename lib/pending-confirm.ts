import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 待确认 (于海伟 2026-11-06) —— 跟待提货一个样子 (lib/pickup)。
 *
 * 订单状态那个小菜单里点「待确认」, 这张单就从在产挪进看板上的「待确认」一
 * 栏; 再点一次撤掉, 回在产。出货报完了照样归已出货。
 *
 * 一张单一份 (于海伟 2026-11-07) —— 线上几个进程前后脚各写各的, 全厂一份
 * json 会被后写的盖掉 (转外协就吃过这个亏, lib/outsource-transfer)。
 *
 * TABLE-FREE, 没有 migration:
 *   jobs/pending-confirm/<jobId>.json   { at, by }
 *   jobs/pending-confirm.json   早先那一份, 只读 + 清, 不再往里写。
 */

export type ConfirmMark = { at: string; by: string }

const DIR = 'jobs/pending-confirm'
const LEGACY_KEY = 'jobs/pending-confirm.json'
const TTL_MS = 5_000

let cache: { at: number; ids: Set<string> } | null = null

let legacyLock: Promise<unknown> = Promise.resolve()
function withLegacyLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = legacyLock.then(fn, fn)
  legacyLock = next.catch(() => undefined)
  return next
}

async function readLegacy(): Promise<Record<string, ConfirmMark>> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(LEGACY_KEY)
  if (error || !data) return {}
  try {
    const raw = JSON.parse(await data.text())
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, ConfirmMark>)
      : {}
  } catch {
    return {}
  }
}

async function listIds(): Promise<string[]> {
  const out: string[] = []
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .list(DIR, { limit: 1000, offset })
    if (error || !data) break
    for (const f of data) if (f.name.endsWith('.json')) out.push(f.name.slice(0, -'.json'.length))
    if (data.length < 1000) break
  }
  return out
}

/** 标了待确认的工单。几秒读一次 —— 看板每次都要问。 */
export async function getConfirmJobIds(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.ids
  const [fresh, legacy] = await Promise.all([listIds(), readLegacy()])
  const ids = new Set([...fresh, ...Object.keys(legacy)])
  cache = { at: Date.now(), ids }
  return ids
}

export async function setJobConfirm(jobId: string, on: boolean, by: string): Promise<void> {
  if (on) {
    const mark: ConfirmMark = { at: new Date().toISOString(), by }
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(`${DIR}/${jobId}.json`, Buffer.from(JSON.stringify(mark), 'utf8'), {
        contentType: 'application/json',
        upsert: true,
      })
    if (error) throw error
  } else {
    const { error } = await supabase.storage.from(STORAGE_BUCKET).remove([`${DIR}/${jobId}.json`])
    if (error) throw error
    await withLegacyLock(async () => {
      const all = await readLegacy()
      if (!all[jobId]) return
      delete all[jobId]
      const { error: e2 } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(LEGACY_KEY, Buffer.from(JSON.stringify(all), 'utf8'), {
          contentType: 'application/json',
          upsert: true,
        })
      if (e2) throw e2
    })
  }
  cache = null
}
