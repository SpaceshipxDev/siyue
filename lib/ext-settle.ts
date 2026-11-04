import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 系统外对账 (于海伟 2026-11-04) —— 财务把「财务 → 订单」导出去, 在系统外跟
 * 客户核对完, 在表上写「已对账 / 已回款」和应收单号, 再导回来。导回来的对账
 * 记在这里, 一张单一条。
 *
 * 订单账上: 系统里自己有对账 (应收单认过) 的照系统的; 没有的, 用这里的。只是
 * 一个标记, 不生成应收单, 不动对账单和收款提示。
 *
 * TABLE-FREE, 没有 migration:
 *   finance/ext-settle.json   { "<jobId>": ExtSettle }
 */

export type ExtSettle = {
  status: 'reconciled' | 'paid'
  /** 表上写的应收单号 / 对账单号, 可空。 */
  no?: string
  by: string
  at: string
}

const KEY = 'finance/ext-settle.json'

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

function normalize(raw: unknown): Record<string, ExtSettle> {
  const out: Record<string, ExtSettle> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (r.status !== 'reconciled' && r.status !== 'paid') continue
    out[id] = {
      status: r.status,
      no: typeof r.no === 'string' && r.no.trim() ? r.no.trim() : undefined,
      by: typeof r.by === 'string' ? r.by : '',
      at: typeof r.at === 'string' ? r.at : '',
    }
  }
  return out
}

async function read(): Promise<Record<string, ExtSettle>> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return {}
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return {}
  }
}

async function write(all: Record<string, ExtSettle>): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(all), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

export async function getExtSettles(): Promise<Record<string, ExtSettle>> {
  return read()
}

/** 一次写一批 —— 导入那一下。已回款不会被已对账降回去。 */
export async function setExtSettles(
  marks: { jobId: string; status: 'reconciled' | 'paid'; no?: string }[],
  by: string,
  nowIso: string,
): Promise<void> {
  if (marks.length === 0) return
  await withLock(async () => {
    const all = await read()
    for (const m of marks) {
      const cur = all[m.jobId]
      const status = cur?.status === 'paid' ? 'paid' : m.status
      all[m.jobId] = { status, no: m.no?.trim() || cur?.no, by, at: nowIso }
    }
    await write(all)
  })
}
