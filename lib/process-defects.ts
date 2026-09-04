import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 制程不良记录 — 生产过程中出的不良, 由质量落笔。
 *
 * 质量模块的第三张表, 跟另外两张各管一段:
 *   质量异常 — 检验员在工单上按下判定就有了, 一条都不用录 (lib/db)。
 *   制程不良 — 判定之外还要交代的那几件事: 谁直接做坏的、谁间接有责任、
 *     纠正预防措施是什么。工单上装不下, 也不该让检验员在工位上写。
 *   客诉异常 — 客户反馈回来的, 带损失金额 (lib/complaints)。
 *
 * 一条记录回答七件事: 哪张工单 · 坏了几个 · 为什么 · 怎么处理的 · 直接责任
 * 人 · 间接责任人 · 以后怎么不再犯。最后一件是这张表存在的理由 —— 不良记下
 * 来只是账, 措施定下来才算闭环, 所以没填措施的会被数出来。
 *
 * Table-free, 跟 客诉 / 人事 / 住宿 一个路子: 没有 migration 要人去应用。
 */

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const KEY = 'quality/process-defects.json'

export type ProcessDefect = {
  id: string
  date: string // 发生日期 YYYY-MM-DD
  jobNo: string // 工单号
  qty: number // 不良数量
  reason: string // 不良原因
  handling: string // 处理方式
  owner: string // 直接责任人
  coOwner: string // 间接责任人
  action: string // 纠正预防措施
  by?: string // 记录人
  createdAt: string
}

export type ProcessDefectPatch = {
  date?: string
  jobNo?: string
  qty?: number
  reason?: string
  handling?: string
  owner?: string
  coOwner?: string
  action?: string
}

function count(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1_000_000, Math.floor(v)))
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function normalize(raw: unknown): ProcessDefect[] {
  if (!Array.isArray(raw)) return []
  const out: ProcessDefect[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.id !== 'string') continue
    out.push({
      id: r.id,
      date: /^\d{4}-\d{2}-\d{2}$/.test(str(r.date)) ? str(r.date) : '',
      jobNo: str(r.jobNo),
      qty: count(r.qty),
      reason: str(r.reason),
      handling: str(r.handling),
      owner: str(r.owner),
      coOwner: str(r.coOwner),
      action: str(r.action),
      by: str(r.by) || undefined,
      createdAt: str(r.createdAt),
    })
  }
  return out
}

async function read(): Promise<ProcessDefect[]> {
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

async function write(rows: ProcessDefect[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

// 新的在前 — 这张表读起来是"最近厂里出了什么事"。
export async function getProcessDefects(): Promise<ProcessDefect[]> {
  return (await read()).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.createdAt < b.createdAt ? 1 : -1
  })
}

export type NewProcessDefect = {
  date: string
  jobNo: string
  qty: number
  reason: string
  handling: string
  owner: string
  coOwner: string
  action: string
}

export async function addProcessDefect(
  input: NewProcessDefect,
  by: string,
  nowIso: string,
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    rows.push({
      id: crypto.randomUUID(),
      date: input.date,
      jobNo: input.jobNo.trim(),
      qty: count(input.qty),
      reason: input.reason.trim(),
      handling: input.handling.trim(),
      owner: input.owner.trim(),
      coOwner: input.coOwner.trim(),
      action: input.action.trim(),
      by,
      createdAt: nowIso,
    })
    await write(rows)
  })
}

// fillBlanksOnly — 见 lib/complaints 的同一段: 直报那一档只补空格, 改已经填
// 下去的东西是 工程 / 商务于海伟 那一档 (lib/auth canEditQuality)。
export async function updateProcessDefect(
  id: string,
  patch: ProcessDefectPatch,
  opts?: { fillBlanksOnly?: boolean },
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const row = rows.find((r) => r.id === id)
    if (!row) return
    if (opts?.fillBlanksOnly) {
      const filled = (k: keyof ProcessDefectPatch): boolean => {
        const v = row[k as keyof typeof row]
        return typeof v === 'number' ? v > 0 : !!v
      }
      for (const k of Object.keys(patch) as (keyof ProcessDefectPatch)[]) {
        if (patch[k] === undefined) continue
        if (filled(k)) throw new Error('这一格填过了 — 要改找工程或于海伟')
      }
    }
    if (patch.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(patch.date))
      row.date = patch.date
    if (patch.jobNo !== undefined) row.jobNo = patch.jobNo.trim()
    if (patch.qty !== undefined) row.qty = count(patch.qty)
    if (patch.reason !== undefined) row.reason = patch.reason.trim()
    if (patch.handling !== undefined) row.handling = patch.handling.trim()
    if (patch.owner !== undefined) row.owner = patch.owner.trim()
    if (patch.coOwner !== undefined) row.coOwner = patch.coOwner.trim()
    if (patch.action !== undefined) row.action = patch.action.trim()
    await write(rows)
  })
}

export async function deleteProcessDefect(id: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    if (!rows.some((r) => r.id === id)) return
    await write(rows.filter((r) => r.id !== id))
  })
}
