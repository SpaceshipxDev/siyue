import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 半成品库存 (于海伟 2026-11-04) —— 做了一半、先放着的件: 哪张工单 · 品名 ·
 * 几件 · 现在什么状态 · 备注。看板上「半成品库存」那一栏, 谁都能录、能改。
 *
 * 跟仓库 (lib/warehouse) 是两回事: 仓库管物料进出, 这里只是一张手记的清单,
 * 一行就是一堆放着的件。
 *
 * Table-free, 跟 客诉 / 仓库 一个路子: 没有 migration 要人去应用。
 */

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const KEY = 'warehouse/semi-stock.json'

export type SemiStockItem = {
  id: string
  jobNo: string // 工单号
  name: string // 品名
  qty: number // 数量
  status: string // 状态 —— 手写, 如 待喷漆 / 待外协
  note: string // 备注
  by?: string // 谁录的
  createdAt: string
}

export type SemiStockInput = {
  jobNo?: string
  name?: string
  qty?: number
  status?: string
  note?: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function qtyOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.max(0, Math.min(10_000_000, Math.round(v * 100) / 100))
}

function normalize(raw: unknown): SemiStockItem[] {
  if (!Array.isArray(raw)) return []
  const out: SemiStockItem[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.id !== 'string') continue
    out.push({
      id: r.id,
      jobNo: str(r.jobNo),
      name: str(r.name),
      qty: qtyOf(r.qty),
      status: str(r.status),
      note: str(r.note),
      by: str(r.by) || undefined,
      createdAt: str(r.createdAt),
    })
  }
  return out
}

async function read(): Promise<SemiStockItem[]> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return []
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return []
  }
}

async function write(rows: SemiStockItem[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

// 新录的在前。
export async function getSemiStock(): Promise<SemiStockItem[]> {
  return (await read()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export async function addSemiStock(input: SemiStockInput, by: string, nowIso: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    rows.push({
      id: crypto.randomUUID(),
      jobNo: str(input.jobNo),
      name: str(input.name),
      qty: qtyOf(input.qty),
      status: str(input.status),
      note: str(input.note),
      by,
      createdAt: nowIso,
    })
    await write(rows)
  })
}

export async function updateSemiStock(id: string, patch: SemiStockInput): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const row = rows.find((r) => r.id === id)
    if (!row) return
    if (patch.jobNo !== undefined) row.jobNo = str(patch.jobNo)
    if (patch.name !== undefined) row.name = str(patch.name)
    if (patch.qty !== undefined) row.qty = qtyOf(patch.qty)
    if (patch.status !== undefined) row.status = str(patch.status)
    if (patch.note !== undefined) row.note = str(patch.note)
    await write(rows)
  })
}

export async function deleteSemiStock(id: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    if (!rows.some((r) => r.id === id)) return
    await write(rows.filter((r) => r.id !== id))
  })
}
