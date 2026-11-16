import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { OUTSOURCE_ACTIVITIES } from './data'

/*
 * 外协「做什么」—— 内置的那一串 (lib/data OUTSOURCE_ACTIVITIES) 之外, 开外协
 * 单时自己打进去的新工序 (翻砂…)。于海伟 2026-11-16: 外协工序要能自由添加。
 * 开单时用了一个新名字就记下来, 以后每张工单的下拉里都有它。一个小文件。
 */
const KEY = 'outsource/activities.json'

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

async function readList(): Promise<string[]> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return []
  try {
    const arr = JSON.parse(await data.text()) as unknown
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      : []
  } catch {
    return []
  }
}

export async function getCustomActivities(): Promise<string[]> {
  return readList()
}

export async function rememberActivity(name: string): Promise<void> {
  const a = name.trim().slice(0, 16)
  if (!a || (OUTSOURCE_ACTIVITIES as readonly string[]).includes(a)) return
  await withLock(async () => {
    const list = await readList()
    if (list.includes(a)) return
    list.push(a)
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(KEY, Buffer.from(JSON.stringify(list), 'utf8'), {
        contentType: 'application/json',
        upsert: true,
      })
    if (error) throw error
  })
}
