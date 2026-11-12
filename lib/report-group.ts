import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 组员 —— 共用的工位账号 (金属操机001高发祥…) 是一个组, 组里的人报工记在各
 * 自的名字下。今日产出那张卡要的是整个组的数, 光靠「从这个账号上报的」认不全
 * (有人在别的机器、别的账号上报) —— 于海伟 2026-11-11: 杨炫增在高发祥这个组,
 * 他报的那一单组里没有。所以组员可以直接写下来: 一个账号一份名单。
 *
 * 一个小文件, 键是账号 id。
 */
const GROUPS_KEY = 'report/groups.json'

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

async function readGroups(): Promise<Record<string, string[]>> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(GROUPS_KEY)
  if (error || !data) return {}
  try {
    const o = JSON.parse(await data.text()) as unknown
    if (typeof o !== 'object' || o === null) return {}
    const out: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (Array.isArray(v))
        out[k] = v.filter((n): n is string => typeof n === 'string' && n.trim() !== '')
    }
    return out
  } catch {
    return {}
  }
}

// 首页每次刷新都要读 —— 放在内存里, 改了就换掉, 不必每次去下载那个文件。
let cache: { at: number; groups: Record<string, string[]> } | null = null
const CACHE_MS = 5 * 60 * 1000

export async function getGroupMembers(userId: string): Promise<string[]> {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    cache = { at: Date.now(), groups: await readGroups() }
  }
  return cache.groups[userId] ?? []
}

export async function setGroupMembers(userId: string, members: string[]): Promise<void> {
  const clean = [...new Set(members.map((n) => n.trim().slice(0, 24)).filter(Boolean))].slice(0, 30)
  await withLock(async () => {
    const all = await readGroups()
    if (clean.length) all[userId] = clean
    else delete all[userId]
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(GROUPS_KEY, Buffer.from(JSON.stringify(all), 'utf8'), {
        contentType: 'application/json',
        upsert: true,
      })
    if (error) throw error
    cache = { at: Date.now(), groups: all }
  })
}
