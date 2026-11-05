import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import type { Stage } from './data'

/*
 * 转外协 (于海伟 2026-11-05) —— 工程 / 商务 / 程江华点好工单后, 某个零件要
 * 外发: 零件那一行点「转外协」。这个零件还没开工的 编程 / 操机 / 车铣 关掉,
 * 这张单进看板上的「待外协」; 商务给这个零件开了外协单 (外协操作照旧), 这条
 * 就自己消掉。点错了取消 (把关掉的工序还回去) 只有于海伟和老板。
 *
 * TABLE-FREE, 没有 migration:
 *   jobs/outsource-transfer.json   { "<componentId>": { jobId, removed, at, by } }
 */

export type TransferMark = {
  jobId: string
  /** 转的时候关掉的那几道 —— 取消时原样还回去。 */
  removed: Stage[]
  at: string
  by: string
}

const KEY = 'jobs/outsource-transfer.json'
const TTL_MS = 30_000

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

let cache: { at: number; all: Record<string, TransferMark> } | null = null

function normalize(raw: unknown): Record<string, TransferMark> {
  const out: Record<string, TransferMark> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.jobId !== 'string' || !r.jobId) continue
    out[id] = {
      jobId: r.jobId,
      removed: Array.isArray(r.removed)
        ? (r.removed as unknown[]).filter((s): s is Stage => typeof s === 'string')
        : [],
      at: typeof r.at === 'string' ? r.at : '',
      by: typeof r.by === 'string' ? r.by : '',
    }
  }
  return out
}

async function read(): Promise<Record<string, TransferMark>> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return {}
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return {}
  }
}

async function write(all: Record<string, TransferMark>): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(all), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
  cache = { at: Date.now(), all }
}

/** 全部还在等商务外发的零件。半分钟读一次 —— 看板每次都要问。 */
export async function getTransfers(): Promise<Record<string, TransferMark>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.all
  const all = await read()
  cache = { at: Date.now(), all }
  return all
}

/** 有零件转了外协、还没开外协单的工单。 */
export async function getTransferJobIds(): Promise<Set<string>> {
  return new Set(Object.values(await getTransfers()).map((m) => m.jobId))
}

/** 这张单上转了外协的零件。 */
export async function getJobTransfers(jobId: string): Promise<Record<string, TransferMark>> {
  const all = await getTransfers()
  const out: Record<string, TransferMark> = {}
  for (const [id, m] of Object.entries(all)) if (m.jobId === jobId) out[id] = m
  return out
}

export async function getTransfer(componentId: string): Promise<TransferMark | undefined> {
  return (await read())[componentId]
}

export async function setTransfer(componentId: string, mark: TransferMark): Promise<void> {
  await withLock(async () => {
    const all = await read()
    all[componentId] = mark
    await write(all)
  })
}

/**
 * 去掉几条 (外协单开了 / 取消转外协)。返回去掉之后这几张单上还剩几条 ——
 * 还有别的零件等着外发, 待外协就不能跟着消。
 */
export async function clearTransfers(componentIds: string[]): Promise<Map<string, number>> {
  return withLock(async () => {
    const all = await read()
    const jobs = new Set<string>()
    let changed = false
    for (const id of componentIds) {
      const m = all[id]
      if (!m) continue
      jobs.add(m.jobId)
      delete all[id]
      changed = true
    }
    const left = new Map<string, number>()
    if (!changed) return left
    await write(all)
    for (const j of jobs) left.set(j, Object.values(all).filter((m) => m.jobId === j).length)
    return left
  })
}
