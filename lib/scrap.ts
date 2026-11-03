import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { linkKey, type InspectionLink } from './incoming-defects'

/*
 * 报废登记 — 做坏了、不能再用的件, 由质量落笔。
 *
 * 跟制程不良是两回事: 制程不良是"出了问题", 有的返修就救回来了; 报废是那几
 * 件彻底没了, 料和工时都得重来。所以单独一张, 一眼数得出这个月扔了多少。
 *
 * 一条记录回答: 哪张工单 · 报废几件 · 为什么 · 哪里做坏的 (自制加工 / 外协加
 * 工 / 客退) · 哪个部门、谁的责任 · 以后怎么不再犯 · 谁填的。来源分三种,
 * 因为责任在不在厂里, 要不要找外协、找客户, 是第一件要分清的事。
 *
 * 自制件检验判「重做」(于海伟 2026-11-03) —— 确认的那一刻自动记一条, 带着
 * 它是哪张单、哪个零件、哪一道判出来的 (link)。同一个零件同一道只一条, 再判
 * 就更新; 改判别的、改成外协, 这一条跟着撤掉。手记的没有 link。
 *
 * Table-free, 跟 客诉 / 制程不良 一个路子: 没有 migration 要人去应用。
 */

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const KEY = 'quality/scrap.json'

export const SCRAP_SOURCES = ['自制加工', '外协加工', '客退'] as const
export type ScrapSource = (typeof SCRAP_SOURCES)[number]

export type ScrapRecord = {
  id: string
  date: string // 报废日期 YYYY-MM-DD
  jobNo: string // 工单号
  qty: number // 报废数量
  reason: string // 报废原因
  source: ScrapSource | '' // 自制加工 / 外协加工 / 客退
  dept: string // 责任部门
  owner: string // 责任人
  action: string // 纠正预防措施
  by?: string // 填写人员 — 落笔那一刻的账号
  createdAt: string
  /** 检验判重做自动记的 —— 哪张单、哪个零件、哪一道。手记的没有。 */
  link?: InspectionLink
}

export type ScrapPatch = {
  date?: string
  jobNo?: string
  qty?: number
  reason?: string
  source?: string
  dept?: string
  owner?: string
  action?: string
}

function count(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1_000_000, Math.floor(v)))
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function source(v: unknown): ScrapSource | '' {
  const s = str(v)
  return (SCRAP_SOURCES as readonly string[]).includes(s) ? (s as ScrapSource) : ''
}

function readLink(v: unknown): InspectionLink | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  if (typeof o.jobId !== 'string' || typeof o.componentId !== 'string' || typeof o.stage !== 'string')
    return undefined
  return { jobId: o.jobId, componentId: o.componentId, stage: o.stage }
}

function normalize(raw: unknown): ScrapRecord[] {
  if (!Array.isArray(raw)) return []
  const out: ScrapRecord[] = []
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
      source: source(r.source),
      dept: str(r.dept),
      owner: str(r.owner),
      action: str(r.action),
      by: str(r.by) || undefined,
      createdAt: str(r.createdAt),
      link: readLink(r.link),
    })
  }
  return out
}

async function read(): Promise<ScrapRecord[]> {
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

async function write(rows: ScrapRecord[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

// 新的在前。
export async function getScrapRecords(): Promise<ScrapRecord[]> {
  return (await read()).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.createdAt < b.createdAt ? 1 : -1
  })
}

export type NewScrapRecord = {
  date: string
  jobNo: string
  qty: number
  reason: string
  source: string
  dept: string
  owner: string
  action: string
}

export async function addScrapRecord(
  input: NewScrapRecord,
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
      source: source(input.source),
      dept: input.dept.trim(),
      owner: input.owner.trim(),
      action: input.action.trim(),
      by,
      createdAt: nowIso,
    })
    await write(rows)
  })
}

// fillBlanksOnly — 跟制程不良同一个规矩: 有账号的只补空格, 改已经填下去的
// 是 工程 / 商务于海伟 那一档 (lib/auth canEditQuality)。
export async function updateScrapRecord(
  id: string,
  patch: ScrapPatch,
  opts?: { fillBlanksOnly?: boolean },
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const row = rows.find((r) => r.id === id)
    if (!row) return
    if (opts?.fillBlanksOnly) {
      for (const k of Object.keys(patch) as (keyof ScrapPatch)[]) {
        if (patch[k] === undefined) continue
        const v = row[k as keyof ScrapRecord]
        const filled = typeof v === 'number' ? v > 0 : !!v
        if (filled) throw new Error('这一格填过了 — 要改找工程或于海伟')
      }
    }
    if (patch.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(patch.date))
      row.date = patch.date
    if (patch.jobNo !== undefined) row.jobNo = patch.jobNo.trim()
    if (patch.qty !== undefined) row.qty = count(patch.qty)
    if (patch.reason !== undefined) row.reason = patch.reason.trim()
    if (patch.source !== undefined) row.source = source(patch.source)
    if (patch.dept !== undefined) row.dept = patch.dept.trim()
    if (patch.owner !== undefined) row.owner = patch.owner.trim()
    if (patch.action !== undefined) row.action = patch.action.trim()
    await write(rows)
  })
}

// 原因前面带上零件名 —— 报废登记只有工单号一格, 不写零件就分不清是哪一件。
function inspectionReason(item: string, reason?: string): string {
  return [item.trim(), reason?.trim() ?? ''].filter(Boolean).join(' · ')
}

/** 检验判重做 (自制) —— 记一条报废; 同一个零件同一道已经有了就更新原因、责任人。 */
export async function upsertInspectionScrap(
  link: InspectionLink,
  input: { date: string; jobNo: string; item: string; qty: number; reason?: string; owner?: string },
  by: string,
  nowIso: string,
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const key = linkKey(link)
    const row = rows.find((r) => r.link && linkKey(r.link) === key)
    if (row) {
      if (input.reason?.trim()) row.reason = inspectionReason(input.item, input.reason)
      if (input.owner?.trim()) row.owner = input.owner.trim()
    } else {
      rows.push({
        id: crypto.randomUUID(),
        date: input.date,
        jobNo: input.jobNo.trim(),
        qty: count(input.qty),
        reason: inspectionReason(input.item, input.reason),
        source: '自制加工',
        dept: '',
        owner: input.owner?.trim() ?? '',
        action: '',
        by,
        createdAt: nowIso,
        link,
      })
    }
    await write(rows)
  })
}

/** 撤掉检验判重做自动记的那一条 (改判了 / 改成外协)。没有就什么都不做。 */
export async function removeInspectionScrap(link: InspectionLink): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const key = linkKey(link)
    const left = rows.filter((r) => !(r.link && linkKey(r.link) === key))
    if (left.length !== rows.length) await write(left)
  })
}

export async function deleteScrapRecord(id: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    if (!rows.some((r) => r.id === id)) return
    await write(rows.filter((r) => r.id !== id))
  })
}
