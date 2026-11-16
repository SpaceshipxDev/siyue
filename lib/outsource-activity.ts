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

async function writeList(list: string[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(list), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

const isBuiltIn = (a: string) => (OUTSOURCE_ACTIVITIES as readonly string[]).includes(a)

export async function rememberActivity(name: string): Promise<void> {
  const a = name.trim().slice(0, 16)
  if (!a || isBuiltIn(a)) return
  await withLock(async () => {
    const list = await readList()
    if (list.includes(a)) return
    list.push(a)
    await writeList(list)
  })
}

// 改名 / 删 —— 只动自己加的那几个; 已经开出去的外协单上写的字不变 (那是凭据)。
// 改成一个已有的名字 = 并成一个。
export async function renameActivity(from: string, to: string): Promise<void> {
  const next = to.trim().slice(0, 16)
  if (!next) throw new Error('工序名不能空')
  await withLock(async () => {
    const list = await readList()
    const i = list.indexOf(from)
    if (i === -1) return
    if (isBuiltIn(next) || list.includes(next)) list.splice(i, 1)
    else list[i] = next
    await writeList(list)
  })
}

export async function removeActivity(name: string): Promise<void> {
  await withLock(async () => {
    const list = await readList()
    if (!list.includes(name)) return
    await writeList(list.filter((a) => a !== name))
  })
}
