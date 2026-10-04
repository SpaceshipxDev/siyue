import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 来料异常登记 — 供应商送进来的料有问题, 由质量落笔。
 *
 * 质量模块的第五张表。前面四张管的都是厂里自己这一段, 这一张管的是**上游**:
 *
 *   质量异常 — 厂里自己检出来的 (检验 + 成品检), 从工单判定收拢而来。
 *   制程不良 — 生产过程中做坏的, 追到人和措施。
 *   客诉异常 — 客户反馈回来的, 带损失金额。
 *   改善建议 — 唯一不是记问题的那张。
 *   来料异常 — 料一进厂就不对: 哪一单、哪家供应商、什么品名、几个、为什么、
 *     怎么处理、损失多少。
 *
 * 为什么单独一张表而不是记进制程不良: 责任在厂外。制程不良追的是"谁做坏
 * 的", 来料异常追的是"哪家供应商", 两张表的第一列就不一样, 汇总的方向也不一
 * 样 —— 这张按供应商汇总损失, 是跟供应商谈价、索赔、换家的依据。
 *
 * 损失记成钱而不是一句话: 一句"影响交期"跟谁都算不清账, 一个数字才谈得上索
 * 赔。经过和细节写在处理方式里。
 *
 * Table-free, 跟 客诉 / 制程不良 / 人事 一个路子: 没有 migration 要人去应用。
 *
 * 两条路进来:
 *   手记   —— 质量在这一页上直接记一笔 (料一进门就看出不对)。
 *   检验转 —— 检验员判不良的时候选了「外协」(老板 2026-10-04): 外协回来的件
 *            做坏了, 是供应商的事, 不是厂里的制程不良。判定那一下就在这里落一
 *            笔, 带着它是哪张单、哪个零件、哪一道判出来的 (link), 同一个零件同
 *            一道只落一笔, 再判一次就更新那一笔; 改回「自制」就撤掉。责任人判
 *            的时候可以空着, 以后在这一页补。
 */

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const KEY = 'quality/incoming-defects.json'

export type IncomingDefect = {
  id: string
  date: string // 发生日期 YYYY-MM-DD
  docNo: string // 单号 — 来料单 / 送货单 / 采购单, 哪个都行, 能对上那一批就行
  supplier: string // 供应商
  item: string // 品名
  qty: number // 数量
  reason: string // 不良原因
  handling: string // 处理方式 — 退货 / 换货 / 让步接收 / 挑选使用…
  lossCny: number // 损失金额, 元
  owner?: string // 责任人 —— 检验转过来的常常是空的, 后补
  by?: string // 记录人
  createdAt: string
  /** 检验判不良转过来的 —— 哪张单、哪个零件、哪一道 (检验 / 质量)。手记的没有。 */
  link?: InspectionLink
}

export type InspectionLink = {
  jobId: string
  componentId: string
  stage: string
}

export function linkKey(l: InspectionLink): string {
  return `${l.jobId}|${l.componentId}|${l.stage}`
}

export type IncomingDefectPatch = {
  date?: string
  docNo?: string
  supplier?: string
  item?: string
  qty?: number
  reason?: string
  handling?: string
  lossCny?: number
  owner?: string
}

function count(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1_000_000, Math.floor(v)))
}

function money(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.max(0, Math.min(100_000_000, Math.round(v)))
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function normalize(raw: unknown): IncomingDefect[] {
  if (!Array.isArray(raw)) return []
  const out: IncomingDefect[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.id !== 'string') continue
    out.push({
      id: r.id,
      date: /^\d{4}-\d{2}-\d{2}$/.test(str(r.date)) ? str(r.date) : '',
      docNo: str(r.docNo),
      supplier: str(r.supplier),
      item: str(r.item),
      qty: count(r.qty),
      reason: str(r.reason),
      handling: str(r.handling),
      lossCny: money(r.lossCny),
      owner: str(r.owner) || undefined,
      by: str(r.by) || undefined,
      createdAt: str(r.createdAt),
      link: readLink(r.link),
    })
  }
  return out
}

function readLink(v: unknown): InspectionLink | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  if (typeof o.jobId !== 'string' || typeof o.componentId !== 'string' || typeof o.stage !== 'string')
    return undefined
  return { jobId: o.jobId, componentId: o.componentId, stage: o.stage }
}

async function read(): Promise<IncomingDefect[]> {
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

async function write(rows: IncomingDefect[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

// 新的在前 — 这张表读起来是"最近哪家送的料出了问题"。
export async function getIncomingDefects(): Promise<IncomingDefect[]> {
  return (await read()).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.createdAt < b.createdAt ? 1 : -1
  })
}

export type NewIncomingDefect = {
  date: string
  docNo: string
  supplier: string
  item: string
  qty: number
  reason: string
  handling: string
  lossCny: number
}

export async function addIncomingDefect(
  input: NewIncomingDefect,
  by: string,
  nowIso: string,
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    rows.push({
      id: crypto.randomUUID(),
      date: input.date,
      docNo: input.docNo.trim(),
      supplier: input.supplier.trim(),
      item: input.item.trim(),
      qty: count(input.qty),
      reason: input.reason.trim(),
      handling: input.handling.trim(),
      lossCny: money(input.lossCny),
      by,
      createdAt: nowIso,
    })
    await write(rows)
  })
}

// fillBlanksOnly — 见 lib/complaints 的同一段: 直报那一档只补空格, 改已经填
// 下去的东西是 工程 / 质量 / 商务于海伟 那一档 (lib/auth canEditQuality)。
export async function updateIncomingDefect(
  id: string,
  patch: IncomingDefectPatch,
  opts?: { fillBlanksOnly?: boolean },
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const row = rows.find((r) => r.id === id)
    if (!row) return
    if (opts?.fillBlanksOnly) {
      const filled = (k: keyof IncomingDefectPatch): boolean => {
        const v = row[k as keyof typeof row]
        return typeof v === 'number' ? v > 0 : !!v
      }
      for (const k of Object.keys(patch) as (keyof IncomingDefectPatch)[]) {
        if (patch[k] === undefined) continue
        if (filled(k)) throw new Error('这一格填过了 — 要改找质量或于海伟')
      }
    }
    if (patch.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(patch.date))
      row.date = patch.date
    if (patch.docNo !== undefined) row.docNo = patch.docNo.trim()
    if (patch.supplier !== undefined) row.supplier = patch.supplier.trim()
    if (patch.item !== undefined) row.item = patch.item.trim()
    if (patch.qty !== undefined) row.qty = count(patch.qty)
    if (patch.reason !== undefined) row.reason = patch.reason.trim()
    if (patch.handling !== undefined) row.handling = patch.handling.trim()
    if (patch.lossCny !== undefined) row.lossCny = money(patch.lossCny)
    if (patch.owner !== undefined) row.owner = patch.owner.trim() || undefined
    await write(rows)
  })
}

export async function deleteIncomingDefect(id: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    if (!rows.some((r) => r.id === id)) return
    await write(rows.filter((r) => r.id !== id))
  })
}

// === 检验转过来的那一笔 ===

/** 这张单上哪些零件的哪一道被判成了外协不良 (linkKey 的集合)。 */
export async function getInspectionLinks(jobId?: string): Promise<Set<string>> {
  const rows = await read()
  const out = new Set<string>()
  for (const r of rows) {
    if (!r.link) continue
    if (jobId && r.link.jobId !== jobId) continue
    out.add(linkKey(r.link))
  }
  return out
}

/**
 * 检验判外协不良 —— 同一个零件同一道只有一笔: 没有就落一笔, 有就把这回带过来
 * 的格子更新进去 (空着的不覆盖已经补上的)。
 */
export async function upsertInspectionIncoming(
  link: InspectionLink,
  input: {
    date: string
    docNo: string
    supplier: string
    item: string
    qty: number
    reason?: string
    handling: string
    owner?: string
  },
  by: string,
  nowIso: string,
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const key = linkKey(link)
    const row = rows.find((r) => r.link && linkKey(r.link) === key)
    if (row) {
      if (input.supplier.trim()) row.supplier = input.supplier.trim()
      if (input.reason?.trim()) row.reason = input.reason.trim()
      if (input.owner?.trim()) row.owner = input.owner.trim()
      if (!row.handling) row.handling = input.handling.trim()
    } else {
      rows.push({
        id: crypto.randomUUID(),
        date: input.date,
        docNo: input.docNo.trim(),
        supplier: input.supplier.trim(),
        item: input.item.trim(),
        qty: count(input.qty),
        reason: input.reason?.trim() ?? '',
        handling: input.handling.trim(),
        lossCny: 0,
        owner: input.owner?.trim() || undefined,
        by,
        createdAt: nowIso,
        link,
      })
    }
    await write(rows)
  })
}

/** 改回「自制」—— 检验转过来的那一笔撤掉。 */
export async function removeInspectionIncoming(link: InspectionLink): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const key = linkKey(link)
    const left = rows.filter((r) => !(r.link && linkKey(r.link) === key))
    if (left.length !== rows.length) await write(left)
  })
}
