import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl, storageKeyFromUrl } from './storage-url'
import { getMasterRows } from './db'

/*
 * 工单分析沟通确认单 —— 工程跟客户一次次沟通的记录, 一个工号一张表。
 *
 * 表头照厂里原来那张 Excel: 序号 (第几次沟通) · 文件名/图号 · 图片 · 文件/图纸
 * 要求 (截图) · 不满足与问题说明 · 改善建议 · 缺失说明 · 客户确认结果 · 客户对
 * 接人, 再加一列记录人 (谁、哪天记的); 标题下面一个交期。按工号找, 能导入原来的 Excel, 也能按
 * 工号导出成同样的 Excel。
 *
 * 跟工单页上那张 (已取消的) 沟通单不是一回事, 那张按七个沟通项排。
 *
 * TABLE-FREE: comm-orders/sheets.json  { "<工号>": CommOrder }, 图片放在
 * comm-orders/img/ 下。没有 migration 要人去应用。
 */

export type CommImage = { id: string; url: string; name: string }

export type CommOrderRow = {
  id: string
  images: CommImage[] // 图片
  fileName?: string // 文件名/图号
  reqImages: CommImage[] // 文件/图纸要求 (截图)
  req?: string // 文件/图纸要求 —— 截图之外写的字
  problem?: string // 不满足与问题说明
  suggestion?: string // 改善建议
  missing?: string // 缺失说明 —— 图档 (2D/3D/丝印图/组装图)、配件、色板、适配件
  result?: string // 客户确认结果
  contact?: string // 客户对接人
  by: string // 记录人 —— 最后一个改这一行的人
  at: string // 记录时间
}

export type CommOrder = {
  jobNo: string
  /** 交期 YYYY-MM-DD —— 手填的; 没填就看系统里这个工号的工单交期 (jobDueDates)。 */
  dueDate?: string
  rows: CommOrderRow[]
  createdBy?: string
  createdAt: string
  updatedBy?: string
  updatedAt: string
}

/** 一行里能改的字。 */
export const COMM_ORDER_TEXT_FIELDS = [
  'fileName',
  'req',
  'problem',
  'suggestion',
  'missing',
  'result',
  'contact',
] as const
export type CommOrderTextField = (typeof COMM_ORDER_TEXT_FIELDS)[number]
export type CommOrderImageField = 'images' | 'reqImages'

export function isCommOrderTextField(v: unknown): v is CommOrderTextField {
  return typeof v === 'string' && (COMM_ORDER_TEXT_FIELDS as readonly string[]).includes(v)
}
export function isCommOrderImageField(v: unknown): v is CommOrderImageField {
  return v === 'images' || v === 'reqImages'
}

/** 「YN-26-123工单分析沟通确认单」—— 表的名字就是工号。 */
export function commOrderTitle(jobNo: string): string {
  return `${jobNo}工单分析沟通确认单`
}

const KEY = 'comm-orders/sheets.json'

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

function str(v: unknown, max = 4000): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

export function cleanJobNo(v: unknown): string {
  return str(v, 60).replace(/\s+/g, '')
}

function images(v: unknown): CommImage[] {
  if (!Array.isArray(v)) return []
  const out: CommImage[] = []
  for (const x of v as unknown[]) {
    if (typeof x !== 'object' || x === null) continue
    const r = x as Record<string, unknown>
    if (typeof r.id !== 'string' || typeof r.url !== 'string') continue
    out.push({ id: r.id, url: r.url, name: str(r.name, 200) || '图片' })
  }
  return out
}

function row(v: unknown): CommOrderRow | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const r = v as Record<string, unknown>
  if (typeof r.id !== 'string') return undefined
  const out: CommOrderRow = {
    id: r.id,
    images: images(r.images),
    reqImages: images(r.reqImages),
    by: str(r.by, 40),
    at: str(r.at, 40),
  }
  for (const f of COMM_ORDER_TEXT_FIELDS) {
    const t = str(r[f])
    if (t) out[f] = t
  }
  return out
}

function sheet(jobNo: string, v: unknown): CommOrder | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const r = v as Record<string, unknown>
  const rows = Array.isArray(r.rows)
    ? (r.rows as unknown[]).map(row).filter((x): x is CommOrderRow => !!x)
    : []
  const due = str(r.dueDate, 10)
  return {
    jobNo,
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : undefined,
    rows,
    createdBy: str(r.createdBy, 40) || undefined,
    createdAt: str(r.createdAt, 40),
    updatedBy: str(r.updatedBy, 40) || undefined,
    updatedAt: str(r.updatedAt, 40),
  }
}

async function read(): Promise<Record<string, CommOrder>> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return {}
  try {
    const raw = JSON.parse(await data.text()) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const out: Record<string, CommOrder> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const s = sheet(k, v)
      if (s) out[k] = s
    }
    return out
  } catch {
    return {}
  }
}

async function write(all: Record<string, CommOrder>): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(all), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

/** 工号大小写、空格不同也认成同一张。 */
function findKey(all: Record<string, CommOrder>, jobNo: string): string | undefined {
  const want = cleanJobNo(jobNo).toLowerCase()
  return Object.keys(all).find((k) => k.toLowerCase() === want)
}

/** 列表 —— 最近改过的在上面。 */
export async function listCommOrders(): Promise<CommOrder[]> {
  const all = await read()
  return Object.values(all).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function getCommOrder(jobNo: string): Promise<CommOrder | undefined> {
  const all = await read()
  const k = findKey(all, jobNo)
  return k ? all[k] : undefined
}

function uid(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 改一张表 —— 没有就新开一张; 改完一行都不剩、也没填交期的, 这张表也去掉。 */
async function edit(
  jobNo: string,
  by: string,
  fn: (s: CommOrder) => void,
): Promise<CommOrder | undefined> {
  const no = cleanJobNo(jobNo)
  if (!no) throw new Error('先填工单号')
  return withLock(async () => {
    const all = await read()
    const k = findKey(all, no) ?? no
    const now = new Date().toISOString()
    const s: CommOrder = all[k] ?? { jobNo: k, rows: [], createdBy: by, createdAt: now, updatedAt: now }
    fn(s)
    s.updatedBy = by
    s.updatedAt = now
    if (s.rows.length > 0 || s.dueDate) all[k] = s
    else delete all[k]
    await write(all)
    return all[k]
  })
}

export function blankRow(by: string): CommOrderRow {
  return { id: uid(), images: [], reqImages: [], by, at: new Date().toISOString() }
}

export async function addCommOrderRows(
  jobNo: string,
  rows: Omit<CommOrderRow, 'id' | 'by' | 'at'>[],
  by: string,
  dueDate?: string,
): Promise<CommOrder | undefined> {
  return edit(jobNo, by, (s) => {
    for (const r of rows) s.rows.push({ ...blankRow(by), ...r })
    if (dueDate && !s.dueDate) s.dueDate = dueDate
  })
}

/** 交期 —— 空的就是不手填了, 回到按工单。 */
export async function setCommOrderDueDate(
  jobNo: string,
  dueDate: string,
  by: string,
): Promise<CommOrder | undefined> {
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new Error('日期不对')
  return edit(jobNo, by, (s) => {
    s.dueDate = dueDate || undefined
  })
}

/** 系统里各工号的工单交期 (小写工号 → YYYY-MM-DD), 沟通单没手填交期时用它。 */
export async function jobDueDates(): Promise<Map<string, string>> {
  const rows = await getMasterRows()
  const out = new Map<string, string>()
  for (const r of rows) if (r.jobNo && r.dueDate) out.set(cleanJobNo(r.jobNo).toLowerCase(), r.dueDate)
  return out
}

/** 这张沟通单的交期 —— 手填的优先, 没有就按工单。 */
export function dueOf(jobNo: string, own: string | undefined, jobDue: Map<string, string>): string {
  return own || jobDue.get(cleanJobNo(jobNo).toLowerCase()) || ''
}

export async function updateCommOrderRow(
  jobNo: string,
  rowId: string,
  field: CommOrderTextField,
  text: string,
  by: string,
): Promise<CommOrder | undefined> {
  return edit(jobNo, by, (s) => {
    const r = s.rows.find((x) => x.id === rowId)
    if (!r) throw new Error('这一行已经不在了')
    const t = str(text)
    if (t) r[field] = t
    else delete r[field]
    r.by = by
    r.at = new Date().toISOString()
  })
}

export async function deleteCommOrderRow(
  jobNo: string,
  rowId: string,
  by: string,
): Promise<CommOrder | undefined> {
  return edit(jobNo, by, (s) => {
    s.rows = s.rows.filter((x) => x.id !== rowId)
  })
}

/** 图片本体进 storage, 返回挂到行上的那一条。 */
export async function uploadCommImage(
  jobNo: string,
  body: Blob | Buffer,
  fileName: string,
  contentType: string,
): Promise<CommImage> {
  const id = crypto.randomUUID()
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  const ext = m ? m[1] : 'png'
  const key = `comm-orders/img/${cleanJobNo(jobNo).replace(/[^a-zA-Z0-9._-]/g, '_')}-${id}.${ext}`
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(key, body, {
    contentType: contentType || 'application/octet-stream',
    upsert: false,
  })
  if (error) throw error
  return { id, url: proxiedKeyUrl(key), name: fileName || '图片' }
}

export async function addCommOrderImage(
  jobNo: string,
  rowId: string,
  field: CommOrderImageField,
  image: CommImage,
  by: string,
): Promise<CommOrder | undefined> {
  return edit(jobNo, by, (s) => {
    const r = s.rows.find((x) => x.id === rowId)
    if (!r) throw new Error('这一行已经不在了')
    r[field] = [...r[field], image]
    r.by = by
    r.at = new Date().toISOString()
  })
}

export async function deleteCommOrderImage(
  jobNo: string,
  rowId: string,
  field: CommOrderImageField,
  imageId: string,
  by: string,
): Promise<CommOrder | undefined> {
  let gone: CommImage | undefined
  const s = await edit(jobNo, by, (s) => {
    const r = s.rows.find((x) => x.id === rowId)
    if (!r) return
    gone = r[field].find((x) => x.id === imageId)
    r[field] = r[field].filter((x) => x.id !== imageId)
    r.by = by
    r.at = new Date().toISOString()
  })
  // 单是准, 文件是次 —— 删不掉的孤儿文件没人看得见, 无害。
  const key = gone ? storageKeyFromUrl(gone.url) : undefined
  if (key) {
    try {
      await supabase.storage.from(STORAGE_BUCKET).remove([key])
    } catch {
      // 见上
    }
  }
  return s
}
