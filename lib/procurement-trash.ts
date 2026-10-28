import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 采购 · 回收站 (于海伟 2026-10-28) —— 采购页上删掉的东西先放这儿, 删错了能
 * 拿回来。
 *
 *   请购 / 采购单 —— 不真删, 只是记一笔「进了回收站」, 采购页、台账、订单账
 *                    就都看不见它了 (lib/db getProcurements 滤掉)。恢复 = 把这
 *                    一笔划掉, 原样回到原来那一栏。回收站里再点「彻底删除」才
 *                    真删。
 *   需求 —— 删需求本来就是把零件路线上的采购那一道摘掉; 这里记下是哪个零件,
 *           恢复 = 把采购那一道重新点上, 需求自己就回来了。
 *
 * TABLE-FREE, 没有 migration:  procurement/trash.json  [TrashEntry, …]
 */

export type TrashEntry =
  | { kind: 'procurement'; id: string; by: string; at: string }
  | {
      kind: 'need'
      id: string // 零件行 id (partId)
      jobId: string
      jobNo: string
      part: string
      material?: string
      qty?: number
      by: string
      at: string
    }

const KEY = 'procurement/trash.json'

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function normalize(raw: unknown): TrashEntry[] {
  if (!Array.isArray(raw)) return []
  const out: TrashEntry[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (!str(r.id)) continue
    if (r.kind === 'procurement') out.push({ kind: 'procurement', id: str(r.id), by: str(r.by), at: str(r.at) })
    else if (r.kind === 'need' && str(r.jobId))
      out.push({
        kind: 'need',
        id: str(r.id),
        jobId: str(r.jobId),
        jobNo: str(r.jobNo),
        part: str(r.part),
        material: str(r.material) || undefined,
        qty: typeof r.qty === 'number' ? r.qty : undefined,
        by: str(r.by),
        at: str(r.at),
      })
  }
  return out
}

async function read(): Promise<TrashEntry[]> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return []
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return []
  }
}

async function write(rows: TrashEntry[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

/** 新进来的在前。 */
export async function getProcurementTrash(): Promise<TrashEntry[]> {
  return (await read()).sort((a, b) => b.at.localeCompare(a.at))
}

/** 进了回收站的采购单 id —— 采购页、台账都不再列它们。 */
export async function getTrashedProcurementIds(): Promise<Set<string>> {
  return new Set((await read()).filter((e) => e.kind === 'procurement').map((e) => e.id))
}

export async function putInTrash(entry: TrashEntry): Promise<void> {
  await withLock(async () => {
    const rows = (await read()).filter((e) => !(e.kind === entry.kind && e.id === entry.id))
    rows.push(entry)
    await write(rows)
  })
}

/** 从回收站里拿出来 (恢复或者彻底删掉之后都要划掉这一笔)。返回原来那一笔。 */
export async function takeFromTrash(kind: TrashEntry['kind'], id: string): Promise<TrashEntry | undefined> {
  return withLock(async () => {
    const rows = await read()
    const hit = rows.find((e) => e.kind === kind && e.id === id)
    if (!hit) return undefined
    await write(rows.filter((e) => e !== hit))
    return hit
  })
}
