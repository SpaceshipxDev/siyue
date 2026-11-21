import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 加急费用 —— 为了赶交期多花的钱 (外协加急费、加急快递、加班赶工…), 由质量落
 * 笔 (于海伟 2026-11-21)。
 *
 * 一条记录回答: 哪张工单 · 几件 · 花了多少 · 为什么要加急 · 哪个部门、谁的责
 * 任 · 是什么造成的加急 (排产晚了、做坏重做、来料晚到、客户改图…) · 谁填的。
 * 加急的钱是质量成本的一部分 —— 不是做坏了, 是没按时做出来, 所以跟报废登记
 * 放在一起, 按月看、按责任算账。
 *
 * Table-free, 跟报废登记一个路子: 没有 migration 要人去应用。
 */

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const KEY = 'quality/rush.json'

export type RushRecord = {
  id: string
  date: string // 日期 YYYY-MM-DD
  jobNo: string // 订单号 (工单号)
  qty: number // 数量
  amount: number // 加急费用, 元
  reason: string // 加急原因 —— 加急的是什么、为什么非加急不可
  dept: string // 责任部门
  owner: string // 责任人
  cause: string // 造成加急的原因 —— 责任方哪里出了问题
  note: string // 备注 —— 增加的成本花在哪: 外协加急费 300 + 顺丰加急 80…
  by?: string // 填写人员 — 落笔那一刻的账号
  createdAt: string
}

export type RushPatch = {
  date?: string
  jobNo?: string
  qty?: number
  amount?: number
  reason?: string
  dept?: string
  owner?: string
  cause?: string
  note?: string
}

function count(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1_000_000, Math.floor(v)))
}

function money(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.max(0, Math.min(10_000_000, Math.round(v * 100) / 100))
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function normalize(raw: unknown): RushRecord[] {
  if (!Array.isArray(raw)) return []
  const out: RushRecord[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.id !== 'string') continue
    out.push({
      id: r.id,
      date: /^\d{4}-\d{2}-\d{2}$/.test(str(r.date)) ? str(r.date) : '',
      jobNo: str(r.jobNo),
      qty: count(r.qty),
      amount: money(r.amount),
      reason: str(r.reason),
      dept: str(r.dept),
      owner: str(r.owner),
      cause: str(r.cause),
      note: str(r.note),
      by: str(r.by) || undefined,
      createdAt: str(r.createdAt),
    })
  }
  return out
}

async function read(): Promise<RushRecord[]> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return []
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return []
  }
}

async function write(rows: RushRecord[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

// 新的在前。
export async function getRushRecords(): Promise<RushRecord[]> {
  return (await read()).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.createdAt < b.createdAt ? 1 : -1
  })
}

export type NewRushRecord = Omit<RushRecord, 'id' | 'by' | 'createdAt'>

export async function addRushRecord(input: NewRushRecord, by: string, nowIso: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    rows.push({
      id: crypto.randomUUID(),
      date: input.date,
      jobNo: input.jobNo.trim(),
      qty: count(input.qty),
      amount: money(input.amount),
      reason: input.reason.trim(),
      dept: input.dept.trim(),
      owner: input.owner.trim(),
      cause: input.cause.trim(),
      note: input.note.trim(),
      by,
      createdAt: nowIso,
    })
    await write(rows)
  })
}

// fillBlanksOnly — 跟报废登记同一个规矩: 有账号的只补空格, 改已经填下去的
// 是 工程 / 商务于海伟 那一档 (lib/auth canEditQuality)。
export async function updateRushRecord(
  id: string,
  patch: RushPatch,
  opts?: { fillBlanksOnly?: boolean },
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const row = rows.find((r) => r.id === id)
    if (!row) return
    if (opts?.fillBlanksOnly) {
      for (const k of Object.keys(patch) as (keyof RushPatch)[]) {
        if (patch[k] === undefined) continue
        const v = row[k as keyof RushRecord]
        const filled = typeof v === 'number' ? v > 0 : !!v
        if (filled) throw new Error('这一格填过了 — 要改找工程或于海伟')
      }
    }
    if (patch.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(patch.date)) row.date = patch.date
    if (patch.jobNo !== undefined) row.jobNo = patch.jobNo.trim()
    if (patch.qty !== undefined) row.qty = count(patch.qty)
    if (patch.amount !== undefined) row.amount = money(patch.amount)
    if (patch.reason !== undefined) row.reason = patch.reason.trim()
    if (patch.dept !== undefined) row.dept = patch.dept.trim()
    if (patch.owner !== undefined) row.owner = patch.owner.trim()
    if (patch.cause !== undefined) row.cause = patch.cause.trim()
    if (patch.note !== undefined) row.note = patch.note.trim()
    await write(rows)
  })
}

export async function deleteRushRecord(id: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    if (!rows.some((r) => r.id === id)) return
    await write(rows.filter((r) => r.id !== id))
  })
}
