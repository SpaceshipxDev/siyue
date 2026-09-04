import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 客诉异常 — 客户那边反馈回来的质量问题。
 *
 * 跟「不良记录」是两回事, 所以是两张表: 不良记录是厂里自己检出来的 (检验 /
 * 成品检), 一条都不用手录, 检验员按下判定就有了; 客诉是客户打电话过来的, 系
 * 统无从知道, 只能商务落笔。
 *
 * 一条客诉要回答七件事: 谁家的、坏了几个、为什么坏、怎么处理的、谁的责任、
 * 赔了多少钱、以后怎么不再犯。那个钱数是这张表存在的理由 —— 质量问题只有换
 * 算成钱, 才谈得上跟谁算账、值不值得改; 而措施定下来, 这条客诉才算完。
 *
 * Table-free, 跟 人事 / 工资 / 住宿 一个路子: 没有 migration 要人去应用。一
 * 个厂一年几十条客诉, 一个 JSON 绰绰有余。
 */

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const KEY = 'quality/complaints.json'

export type Complaint = {
  id: string
  date: string // 发生日期 YYYY-MM-DD
  customer: string // 客户
  jobNo?: string // 工号 — 有就填, 追溯用
  qty: number // 不良数量
  reason: string // 不良原因
  handling: string // 处理方式
  owner: string // 责任人
  action: string // 纠正预防措施
  lossCny: number // 损失金额
  by?: string // 记录人
  createdAt: string
}

export type ComplaintPatch = {
  date?: string
  customer?: string
  jobNo?: string
  qty?: number
  reason?: string
  handling?: string
  owner?: string
  action?: string
  lossCny?: number
}

function money(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.max(0, Math.min(10_000_000, Math.round(v * 100) / 100))
}

function count(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1_000_000, Math.floor(v)))
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function normalize(raw: unknown): Complaint[] {
  if (!Array.isArray(raw)) return []
  const out: Complaint[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.id !== 'string') continue
    out.push({
      id: r.id,
      date: /^\d{4}-\d{2}-\d{2}$/.test(str(r.date)) ? str(r.date) : '',
      customer: str(r.customer),
      jobNo: str(r.jobNo) || undefined,
      qty: count(r.qty),
      reason: str(r.reason),
      handling: str(r.handling),
      owner: str(r.owner),
      action: str(r.action),
      lossCny: money(r.lossCny),
      by: str(r.by) || undefined,
      createdAt: str(r.createdAt),
    })
  }
  return out
}

async function read(): Promise<Complaint[]> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(KEY)
  if (error || !data) return []
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return []
  }
}

async function write(rows: Complaint[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

// 新的在前 — 一张客诉表读起来是"最近出了什么事"。
export async function getComplaints(): Promise<Complaint[]> {
  return (await read()).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.createdAt < b.createdAt ? 1 : -1
  })
}

export type NewComplaint = {
  date: string
  customer: string
  jobNo?: string
  qty: number
  reason: string
  handling: string
  owner: string
  action: string
  lossCny: number
}

export async function addComplaint(
  input: NewComplaint,
  by: string,
  nowIso: string,
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    rows.push({
      id: crypto.randomUUID(),
      date: input.date,
      customer: input.customer.trim(),
      jobNo: input.jobNo?.trim() || undefined,
      qty: count(input.qty),
      reason: input.reason.trim(),
      handling: input.handling.trim(),
      owner: input.owner.trim(),
      action: input.action.trim(),
      lossCny: money(input.lossCny),
      by,
      createdAt: nowIso,
    })
    await write(rows)
  })
}

// fillBlanksOnly = 直报那一档 (全厂账号): 空着的格子可以补 —— 处理方式、责
// 任人、损失金额、措施本来就是几天后才定下来的; 已经填过的东西不给动, 那是
// 工程 / 商务于海伟 那一档的事 (lib/auth canEditQuality)。
export async function updateComplaint(
  id: string,
  patch: ComplaintPatch,
  opts?: { fillBlanksOnly?: boolean },
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const row = rows.find((r) => r.id === id)
    if (!row) return
    if (opts?.fillBlanksOnly) {
      const filled = (k: keyof ComplaintPatch): boolean => {
        const v = row[k as keyof typeof row]
        return typeof v === 'number' ? v > 0 : !!v
      }
      for (const k of Object.keys(patch) as (keyof ComplaintPatch)[]) {
        if (patch[k] === undefined) continue
        if (filled(k)) throw new Error('这一格填过了 — 要改找工程或于海伟')
      }
    }
    if (patch.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(patch.date))
      row.date = patch.date
    if (patch.customer !== undefined) row.customer = patch.customer.trim()
    if (patch.jobNo !== undefined) row.jobNo = patch.jobNo.trim() || undefined
    if (patch.qty !== undefined) row.qty = count(patch.qty)
    if (patch.reason !== undefined) row.reason = patch.reason.trim()
    if (patch.handling !== undefined) row.handling = patch.handling.trim()
    if (patch.owner !== undefined) row.owner = patch.owner.trim()
    if (patch.action !== undefined) row.action = patch.action.trim()
    if (patch.lossCny !== undefined) row.lossCny = money(patch.lossCny)
    await write(rows)
  })
}

export async function deleteComplaint(id: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    if (!rows.some((r) => r.id === id)) return
    await write(rows.filter((r) => r.id !== id))
  })
}
