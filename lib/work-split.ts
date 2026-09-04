import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 报工分工 — 一个零件的一道工序, 是两个人以上做的。
 *
 * 系统本来一道工序只认一个人: 谁按下那个 ✓, 这道工序的件数和金额就全记在谁
 * 头上。可车间里常常是 200 件里张三做了 120、李四做了 80 —— 一个人替两个人
 * 按了 ✓, 报工统计就把两个人的活全算给了一个人。
 *
 * 车间还有一半的账号是共用的 (打磨喷漆、批量组…), 所以"谁做的"没法从账号推
 * 出来, 只能落笔: 姓名 + 件数。
 *
 * 记在这里, 不动 part_stages —— 判定、完成时间、经手人都还是原来那一套, 板
 * 子和工单页看到的东西一个字没变; 只有报工统计在算人头的时候, 把这一条按件
 * 数拆开 (lib/pulse)。没分工的照旧, 全记给按 ✓ 的那个人。
 *
 * 键 = 零件 + 工序, 跟 worker_stage_events 的 part_id / stage 对得上。
 *
 * Table-free, 跟 客诉 / 仓库 一个路子: 没有 migration 要人去应用。
 */

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const KEY = 'report/work-splits.json'

export type WorkShare = {
  name: string // 姓名 — 车间共用账号, 所以是落笔的名字, 不是账号
  qty: number // 报工数量
}

type Entry = {
  shares: WorkShare[]
  by?: string // 谁记的分工
  at?: string
}

export function workSplitKey(partId: string, stage: string): string {
  return `${partId}::${stage}`
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function qtyOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1_000_000, Math.round(v * 100) / 100))
}

export function normalizeShares(raw: unknown): WorkShare[] {
  if (!Array.isArray(raw)) return []
  const out: WorkShare[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    const name = str(r.name)
    const qty = qtyOf(r.qty)
    if (!name || qty <= 0) continue
    // 同一个人写两行就并成一行 — 报工统计里一个人只该出现一次。
    const hit = out.find((o) => o.name === name)
    if (hit) hit.qty = Math.round((hit.qty + qty) * 100) / 100
    else out.push({ name, qty })
  }
  return out
}

function normalize(raw: unknown): Record<string, Entry> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, Entry> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    const shares = normalizeShares(r.shares)
    if (shares.length === 0) continue
    out[k] = { shares, by: str(r.by) || undefined, at: str(r.at) || undefined }
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

/** 全部分工 — 键是 workSplitKey()。报工统计一次读一整份 (一个厂几百条)。 */
export async function getWorkSplits(): Promise<Record<string, WorkShare[]>> {
  const map = await read()
  const out: Record<string, WorkShare[]> = {}
  for (const [k, v] of Object.entries(map)) out[k] = v.shares
  return out
}

/** 一条 — 分工对话框打开时读它自己那一条。 */
export async function getWorkSplit(
  partId: string,
  stage: string,
): Promise<WorkShare[]> {
  const map = await read()
  return map[workSplitKey(partId, stage)]?.shares ?? []
}

// 空列表 = 取消分工, 这道工序回到"全记给按 ✓ 的那个人"。
export async function setWorkSplit(
  partId: string,
  stage: string,
  shares: WorkShare[],
  by: string,
  nowIso: string,
): Promise<void> {
  await withLock(async () => {
    const map = await read()
    const key = workSplitKey(partId, stage)
    const clean = normalizeShares(shares)
    if (clean.length === 0) {
      if (!(key in map)) return
      delete map[key]
    } else {
      map[key] = { shares: clean, by, at: nowIso }
    }
    await write(map)
  })
}
