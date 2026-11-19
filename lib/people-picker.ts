import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 「谁做的」那张名单的改动 —— 名单本身是账号名 + 人事记过的名字拼的 (app/api/
 * people), 里面混着「商务002」「工程003」这种账号名、「车工李元发」这种带工位
 * 的名字。于海伟 2026-11-19: 名字要能改。改的只是这张选人名单: 去掉的不再出现,
 * 改名 = 去掉旧的、加上新的。登录账号、人事记录、以前的报工一概不动。
 */
const KEY = 'people/picker.json'

export type PickerEdits = { hidden: string[]; added: string[] }

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []

export async function getPickerEdits(): Promise<PickerEdits> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return { hidden: [], added: [] }
  try {
    const o = JSON.parse(await data.text()) as Record<string, unknown>
    return { hidden: strs(o.hidden), added: strs(o.added) }
  } catch {
    return { hidden: [], added: [] }
  }
}

async function save(e: PickerEdits): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(e), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

/** 名单上的名字照这份改动过一遍。 */
export function applyPickerEdits(names: string[], e: PickerEdits): string[] {
  return [...new Set([...names, ...e.added])].filter((n) => !e.hidden.includes(n))
}

export async function hidePickerName(name: string): Promise<void> {
  await withLock(async () => {
    const e = await getPickerEdits()
    await save({
      hidden: [...new Set([...e.hidden, name])],
      added: e.added.filter((n) => n !== name),
    })
  })
}

export async function renamePickerName(from: string, to: string): Promise<void> {
  const next = to.trim().slice(0, 24)
  if (!next) throw new Error('名字不能空')
  if (next === from) return
  await withLock(async () => {
    const e = await getPickerEdits()
    await save({
      hidden: [...new Set([...e.hidden.filter((n) => n !== next), from])],
      added: [...new Set([...e.added.filter((n) => n !== from), next])],
    })
  })
}
