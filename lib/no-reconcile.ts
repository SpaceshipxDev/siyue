import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 无需对账 —— 有的单不用跟客户对 (样品、现结、走别的账…)。财务在对账单上把它
 * 标掉, 它就不再出现在客户对账单和名单的数里; 标错了随时恢复。
 *
 * 按工单号记 (对账单上一组就是一个工单号)。不动出货单、不动金额。
 *
 * TABLE-FREE, 跟应收 / 应付一个路子:
 *   finance/no-reconcile.json    { [jobNo]: { by, at } }
 */

const KEY = 'finance/no-reconcile.json'

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

export type NoReconcileMark = { by: string; at: string }

async function read(): Promise<Record<string, NoReconcileMark>> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return {}
  try {
    const raw = JSON.parse(await data.text()) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const out: Record<string, NoReconcileMark> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!k || typeof v !== 'object' || v === null) continue
      const o = v as Record<string, unknown>
      out[k] = {
        by: typeof o.by === 'string' ? o.by : '',
        at: typeof o.at === 'string' ? o.at : '',
      }
    }
    return out
  } catch {
    return {}
  }
}

async function write(map: Record<string, NoReconcileMark>): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(map), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

/**
 * 单独一行不对账 (拆件之类没价、也不该算钱的零件) —— 跟工单号放在同一份里,
 * 键前面带 line: 。行的键就是对账单上那一行的 key (出货单 + 零件)。
 */
export const LINE_MARK = 'line:'

/** 标了无需对账的工单号 (和 line: 开头的单独几行)。 */
export async function getNoReconcile(): Promise<Record<string, NoReconcileMark>> {
  return read()
}

export async function setNoReconcile(
  jobNos: string[],
  on: boolean,
  by: string,
  nowIso: string,
): Promise<void> {
  await withLock(async () => {
    const map = await read()
    for (const no of jobNos) {
      if (on) map[no] = { by, at: nowIso }
      else delete map[no]
    }
    await write(map)
  })
}
