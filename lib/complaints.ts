import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl } from './storage-url'

/*
 * 客诉异常 — 客户那边反馈回来的质量问题。
 *
 * 跟「不良记录」是两回事, 所以是两张表: 不良记录是厂里自己检出来的 (检验 /
 * 成品检), 一条都不用手录, 检验员按下判定就有了; 客诉是客户打电话过来的, 系
 * 统无从知道, 只能商务落笔。
 *
 * 一条客诉要回答八件事: 谁家的、坏了几个、为什么坏、为什么没拦住、怎么处理
 * 的、谁的责任、赔了多少钱、以后怎么不再犯。那个钱数是这张表存在的理由 ——
 * 质量问题只有换算成钱, 才谈得上跟谁算账、值不值得改; 而措施定下来, 这条客
 * 诉才算完。
 *
 * 「为什么坏」和「为什么没拦住」是两个问题, 所以是两栏。不良原因说的是这批
 * 件怎么做坏的 (刀补打错了), 流出原因说的是它怎么走出厂门的 (首件没检、全
 * 检漏了、包装时没对图号)。只改前一个, 下次换个做坏的花样照样流出去 —— 拦
 * 不住才是客诉之所以成为客诉的原因。
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

// 不良图片 —— 客户发过来的照片, 一句"表面划伤"说不清伤在哪、伤成什么样。
export type ComplaintPhoto = {
  id: string
  url: string
  filename: string
  uploadedBy?: string
  createdAt: string
}

export type Complaint = {
  id: string
  date: string // 发生日期 YYYY-MM-DD
  customer: string // 客户
  jobNo?: string // 工号 — 有就填, 追溯用
  qty: number // 不良数量
  reason: string // 不良原因 — 怎么做坏的
  outflowReason: string // 流出原因 — 怎么没拦住、流到客户手上的
  handling: string // 处理方式
  owner: string // 责任人
  action: string // 纠正预防措施
  lossCny: number // 损失金额
  photos: ComplaintPhoto[] // 不良图片
  by?: string // 记录人
  createdAt: string
}

export type ComplaintPatch = {
  date?: string
  customer?: string
  jobNo?: string
  qty?: number
  reason?: string
  outflowReason?: string
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

function normalizePhotos(raw: unknown): ComplaintPhoto[] {
  if (!Array.isArray(raw)) return []
  const out: ComplaintPhoto[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const p = v as Record<string, unknown>
    if (typeof p.id !== 'string' || typeof p.url !== 'string') continue
    out.push({
      id: p.id,
      url: p.url,
      filename: str(p.filename) || '图',
      uploadedBy: str(p.uploadedBy) || undefined,
      createdAt: str(p.createdAt),
    })
  }
  return out
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
      // 2026-09-21 加的栏 —— 那之前记的客诉读出来是空的, 空格谁都能补。
      outflowReason: str(r.outflowReason),
      handling: str(r.handling),
      owner: str(r.owner),
      action: str(r.action),
      lossCny: money(r.lossCny),
      photos: normalizePhotos(r.photos),
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
  outflowReason: string
  handling: string
  owner: string
  action: string
  lossCny: number
}

export async function addComplaint(
  input: NewComplaint,
  by: string,
  nowIso: string,
): Promise<string> {
  const id = crypto.randomUUID()
  await withLock(async () => {
    const rows = await read()
    rows.push({
      id,
      date: input.date,
      customer: input.customer.trim(),
      jobNo: input.jobNo?.trim() || undefined,
      qty: count(input.qty),
      reason: input.reason.trim(),
      outflowReason: input.outflowReason.trim(),
      handling: input.handling.trim(),
      owner: input.owner.trim(),
      action: input.action.trim(),
      lossCny: money(input.lossCny),
      photos: [],
      by,
      createdAt: nowIso,
    })
    await write(rows)
  })
  // 录入时一起选的图, 页面拿这个 id 接着传。
  return id
}

// fillBlanksOnly = 直报那一档 (全厂账号): 空着的格子可以补 —— 处理方式、责
// 任人、损失金额、措施本来就是几天后才定下来的; 已经填过的东西不给动, 那是
// 工程 / 商务于海伟 那一档的事 (lib/auth canEditQuality)。
//
// 只有一个例外: 不良原因, 记这条的人自己能改 (editor === 记录人) —— 那是他
// 听客户原话写下的, 写错了、问清楚了, 他最知道该怎么改。
export async function updateComplaint(
  id: string,
  patch: ComplaintPatch,
  opts?: { fillBlanksOnly?: boolean; editor?: string },
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
        if (k === 'reason' && opts.editor && row.by === opts.editor) continue
        if (filled(k)) throw new Error('这一格填过了 — 要改找工程或于海伟')
      }
    }
    if (patch.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(patch.date))
      row.date = patch.date
    if (patch.customer !== undefined) row.customer = patch.customer.trim()
    if (patch.jobNo !== undefined) row.jobNo = patch.jobNo.trim() || undefined
    if (patch.qty !== undefined) row.qty = count(patch.qty)
    if (patch.reason !== undefined) row.reason = patch.reason.trim()
    if (patch.outflowReason !== undefined)
      row.outflowReason = patch.outflowReason.trim()
    if (patch.handling !== undefined) row.handling = patch.handling.trim()
    if (patch.owner !== undefined) row.owner = patch.owner.trim()
    if (patch.action !== undefined) row.action = patch.action.trim()
    if (patch.lossCny !== undefined) row.lossCny = money(patch.lossCny)
    await write(rows)
  })
}

/**
 * 往一条客诉上挂一张不良图片 —— 跟变更管理的配图一个路子 (lib/changes):
 * 图直接转交 storage, 存的是代理过的地址。
 */
export async function addComplaintPhoto(input: {
  complaintId: string
  body: Blob
  fileName: string
  contentType: string
  uploadedBy?: string
  nowIso: string
}): Promise<ComplaintPhoto> {
  const id = crypto.randomUUID()
  const m = input.fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  const ext = m ? m[1] : 'png'
  const key = `quality/complaints/${input.complaintId}-${id}.${ext}`
  const upR = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, input.body, {
      contentType: input.contentType || 'application/octet-stream',
      upsert: false,
    })
  if (upR.error) throw upR.error

  const photo: ComplaintPhoto = {
    id,
    url: proxiedKeyUrl(key),
    filename: input.fileName,
    uploadedBy: input.uploadedBy,
    createdAt: input.nowIso,
  }
  await withLock(async () => {
    const rows = await read()
    const row = rows.find((r) => r.id === input.complaintId)
    if (!row) throw new Error('这条客诉找不到了')
    row.photos = [...row.photos, photo]
    await write(rows)
  })
  return photo
}

export async function deleteComplaintPhoto(
  complaintId: string,
  photoId: string,
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const row = rows.find((r) => r.id === complaintId)
    if (!row) return
    row.photos = row.photos.filter((p) => p.id !== photoId)
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
