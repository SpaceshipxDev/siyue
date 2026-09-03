import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 住宿登记 — 谁住哪一间。
 *
 * 一张表, 一人一行: 姓名 · 部门 · 宿舍号 · 备注。宿舍是人事采购在管的, 所以
 * 写的人是她; 看的人是老板、财务和于海伟 —— 住宿是算在人身上的成本, 跟工资
 * 归同一档 (lib/auth canSeeDorm)。
 *
 * Table-free, 跟 人事 (lib/hr.ts) 和 工资 (lib/payroll-store.ts) 一样存一个
 * JSON: 没有 migration 要人去应用, 也不会因为库没升级就打不开页面。一个厂的
 * 宿舍就几十行, 一个文件绰绰有余。
 *
 * 写全部走一条进程内的锁链 (跟 lib/hr.ts 同一个理由): 两个人同一秒改, 不会
 * 互相把对方的行覆盖掉。
 */

let dormChain: Promise<unknown> = Promise.resolve()
function withDormLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = dormChain.then(fn, fn)
  dormChain = next.catch(() => undefined)
  return next
}

const DORM_KEY = 'hr/dorm.json'

export type DormEntry = {
  id: string
  name: string // 姓名
  dept: string // 部门
  room: string // 宿舍号
  note?: string // 备注
  by?: string // 登记人
  updatedAt: string
}

export type DormPatch = {
  name?: string
  dept?: string
  room?: string
  note?: string
}

function normalize(raw: unknown): DormEntry[] {
  if (!Array.isArray(raw)) return []
  const out: DormEntry[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.id !== 'string' || typeof r.name !== 'string') continue
    if (!r.name.trim()) continue
    out.push({
      id: r.id,
      name: r.name,
      dept: typeof r.dept === 'string' ? r.dept : '',
      room: typeof r.room === 'string' ? r.room : '',
      note: typeof r.note === 'string' && r.note.trim() ? r.note : undefined,
      by: typeof r.by === 'string' && r.by ? r.by : undefined,
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
    })
  }
  return out
}

async function read(): Promise<DormEntry[]> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(DORM_KEY)
  if (error || !data) return []
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return []
  }
}

async function write(rows: DormEntry[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(DORM_KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

// 按宿舍号排, 同一间的人挨在一起 —— 这张表最常被问的问题是"这间住了谁"。
// 还没填宿舍号的排最后, 因为那正是待办。
export async function getDormEntries(): Promise<DormEntry[]> {
  return (await read()).sort((a, b) => {
    const ar = a.room.trim()
    const br = b.room.trim()
    if (!ar !== !br) return ar ? -1 : 1
    if (ar !== br) return ar.localeCompare(br, 'zh', { numeric: true })
    return a.name.localeCompare(b.name, 'zh')
  })
}

export async function addDormEntry(
  input: { name: string; dept: string; room: string; note?: string },
  by: string,
  nowIso: string,
): Promise<void> {
  await withDormLock(async () => {
    const rows = await read()
    rows.push({
      id: crypto.randomUUID(),
      name: input.name.trim(),
      dept: input.dept.trim(),
      room: input.room.trim(),
      note: input.note?.trim() || undefined,
      by,
      updatedAt: nowIso,
    })
    await write(rows)
  })
}

export async function updateDormEntry(
  id: string,
  patch: DormPatch,
  by: string,
  nowIso: string,
): Promise<void> {
  await withDormLock(async () => {
    const rows = await read()
    const row = rows.find((r) => r.id === id)
    if (!row) return
    if (patch.name !== undefined && patch.name.trim()) row.name = patch.name.trim()
    if (patch.dept !== undefined) row.dept = patch.dept.trim()
    if (patch.room !== undefined) row.room = patch.room.trim()
    if (patch.note !== undefined) row.note = patch.note.trim() || undefined
    row.by = by
    row.updatedAt = nowIso
    await write(rows)
  })
}

export async function deleteDormEntry(id: string): Promise<void> {
  await withDormLock(async () => {
    const rows = await read()
    if (!rows.some((r) => r.id === id)) return
    await write(rows.filter((r) => r.id !== id))
  })
}
