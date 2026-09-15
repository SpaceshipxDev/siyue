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
  by?: string // 记录人
  createdAt: string
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
      by: str(r.by) || undefined,
      createdAt: str(r.createdAt),
    })
  }
  return out
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
