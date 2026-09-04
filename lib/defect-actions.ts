import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 质量异常的纠正预防措施。
 *
 * 质量异常那张表本身一条都不用录 —— 检验员在工单上按下判定的那一刻就有了
 * (lib/db getDefectRows)。但"以后怎么不再犯"不是检验员在工位上按得出来的,
 * 是事后开会定的; 定了要落在那条异常边上, 否则一张异常表只是账, 不是闭环。
 *
 * 所以措施单独存在这里, 按 零件+环节 挂回那条异常上。判定还是判定, 谁也不
 * 会因为补一句措施而改了车间看到的东西。
 *
 * Table-free, 跟 客诉 / 制程不良 一个路子: 没有 migration 要人去应用。
 */

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const KEY = 'quality/defect-actions.json'

type Entry = {
  action: string
  by?: string
  at?: string
}

/** 一条异常的身份 — 零件 + 环节 (检验 / 质量), 跟 part_stages 一一对应。 */
export function defectActionKey(partId: string, stage: string): string {
  return `${partId}::${stage}`
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function normalize(raw: unknown): Record<string, Entry> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, Entry> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    const action = str(r.action)
    if (!action) continue
    out[k] = { action, by: str(r.by) || undefined, at: str(r.at) || undefined }
  }
  return out
}

async function read(): Promise<Record<string, Entry>> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(KEY)
  if (error || !data) return {}
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return {}
  }
}

async function write(map: Record<string, Entry>): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(map), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

/** 渲染 / 导出只要文字 — 键是 defectActionKey()。 */
export async function getDefectActions(): Promise<Record<string, string>> {
  const map = await read()
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(map)) out[k] = v.action
  return out
}

// 空字符串 = 清掉这一条, 不留空壳。
//
// fillBlanksOnly — 直报那一档 (全厂账号): 还没定措施的可以填上去, 已经写下
// 的不给动 (lib/auth canEditQuality)。
export async function setDefectAction(
  partId: string,
  stage: string,
  action: string,
  by: string,
  nowIso: string,
  opts?: { fillBlanksOnly?: boolean },
): Promise<void> {
  await withLock(async () => {
    const map = await read()
    const key = defectActionKey(partId, stage)
    if (opts?.fillBlanksOnly && map[key]?.action)
      throw new Error('措施填过了 — 要改找工程或于海伟')
    const text = action.trim()
    if (!text) {
      if (!(key in map)) return
      delete map[key]
    } else {
      map[key] = { action: text, by, at: nowIso }
    }
    await write(map)
  })
}
