import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 制程返工工单 —— 厂里自己做坏了、要返工的那几件, 开成一张单独的工单 (于海伟
 * 2026-10-24)。
 *
 * 它只为两件事存在: 车间照常在上面报工, 员工的返工产值按这里定的「返工报工
 * 单价」算 (每件多少钱, 每道工序一样, 跟正常件按售价 5% 算是同一个口径的
 * 「经手金额」)。它不是卖给客户的东西: 不带订单金额、不走出货, 不进对账、
 * 订单账、应收、收款提示。
 *
 * TABLE-FREE, 没有 migration:
 *   jobs/rework-jobs.json   { "<jobId>": ReworkJob }
 *
 * 金额是在 lib/part-family 读报工记录时换上的 (跟拆件 · 加刀同一处), 不动库
 * 里任何一行。
 */

export type ReworkJob = {
  /** 从哪张工单开出来的 */
  sourceJobId?: string
  sourceJobNo?: string
  /** 返工报工单价 —— 零件行 id (worker_stage_events.part_id) → 每件多少钱 */
  rates: Record<string, number>
  note?: string
  by: string
  at: string
}

const KEY = 'jobs/rework-jobs.json'
const TTL_MS = 30_000

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

let cache: { at: number; all: Record<string, ReworkJob> } | null = null

function normalize(raw: unknown): Record<string, ReworkJob> {
  const out: Record<string, ReworkJob> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    const rates: Record<string, number> = {}
    if (typeof r.rates === 'object' && r.rates !== null)
      for (const [k, n] of Object.entries(r.rates as Record<string, unknown>))
        if (typeof n === 'number' && Number.isFinite(n) && n >= 0) rates[k] = Math.round(n * 100) / 100
    out[id] = {
      sourceJobId: typeof r.sourceJobId === 'string' ? r.sourceJobId : undefined,
      sourceJobNo: typeof r.sourceJobNo === 'string' ? r.sourceJobNo : undefined,
      rates,
      note: typeof r.note === 'string' && r.note.trim() ? r.note.trim() : undefined,
      by: typeof r.by === 'string' ? r.by : '',
      at: typeof r.at === 'string' ? r.at : '',
    }
  }
  return out
}

async function read(): Promise<Record<string, ReworkJob>> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return {}
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return {}
  }
}

async function write(all: Record<string, ReworkJob>): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(all), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
  cache = { at: Date.now(), all }
}

/** 全部制程返工单 (jobId → 记录)。半分钟读一次 —— 报工统计每次都要问。 */
export async function getReworkJobs(): Promise<Record<string, ReworkJob>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.all
  const all = await read()
  cache = { at: Date.now(), all }
  return all
}

export async function getReworkJobIds(): Promise<Set<string>> {
  return new Set(Object.keys(await getReworkJobs()))
}

export async function saveReworkJob(jobId: string, rec: ReworkJob): Promise<void> {
  await withLock(async () => {
    const all = await read()
    all[jobId] = rec
    await write(all)
  })
}

/** 改一个零件的返工报工单价。 */
export async function setReworkRate(jobId: string, partId: string, rate: number): Promise<void> {
  await withLock(async () => {
    const all = await read()
    const rec = all[jobId]
    if (!rec) throw new Error('这张不是制程返工单')
    rec.rates[partId] = Math.round(Math.max(0, rate) * 100) / 100
    await write(all)
  })
}
