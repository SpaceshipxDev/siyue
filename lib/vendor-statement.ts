import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { cleanStatement, type PayStatement } from './pay-request-shared'

/*
 * 外协的手工对账单 (于海伟 2026-11-27) —— 供应商自己做的那张对账单 (Excel),
 * 导进来原样摆在外协对账页上, 跟系统排出来的那张对着看。一家一个月一张, 再
 * 导一次就换掉。只是摆着看: 不参与勾选、合计、确认, 也不进付款。
 *
 * TABLE-FREE, 没有 migration:
 *   duizhang/vendor-statements.json  { "<供应商>|<YYYY-MM>": { statement, by, at } }
 */

export type VendorStatement = PayStatement & { by: string; at: string }

const KEY = 'duizhang/vendor-statements.json'

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const keyOf = (vendor: string, month: string) => `${vendor.trim()}|${month}`

async function read(): Promise<Record<string, VendorStatement>> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return {}
  try {
    const raw = JSON.parse(await data.text()) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const out: Record<string, VendorStatement> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null) continue
      const r = v as Record<string, unknown>
      const s = cleanStatement(r.rows, r.filename)
      if (!s) continue
      out[k] = {
        ...s,
        by: typeof r.by === 'string' ? r.by : '',
        at: typeof r.at === 'string' ? r.at : '',
      }
    }
    return out
  } catch {
    return {}
  }
}

export async function getVendorStatement(
  vendor: string,
  month: string,
): Promise<VendorStatement | undefined> {
  return (await read())[keyOf(vendor, month)]
}

/** 存一张 (换掉原来的); statement 为空 = 去掉。 */
export async function setVendorStatement(
  vendor: string,
  month: string,
  statement: PayStatement | undefined,
  by: string,
): Promise<void> {
  await withLock(async () => {
    const all = await read()
    const k = keyOf(vendor, month)
    if (statement) all[k] = { ...statement, by, at: new Date().toISOString() }
    else if (k in all) delete all[k]
    else return
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(KEY, Buffer.from(JSON.stringify(all), 'utf8'), {
        contentType: 'application/json',
        upsert: true,
      })
    if (error) throw error
  })
}
