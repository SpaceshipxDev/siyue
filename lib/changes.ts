import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl } from './storage-url'

/*
 * 变更管理 — 客户把要求改了。
 *
 * 质量模块的第六张表。前五张记的是"做出来的东西不对"，这一张记的是"要求本身
 * 变了"：图纸改了、尺寸改了、颜色改了、数量改了。
 *
 * 为什么它属于质量而不是商务：一次没传到车间的变更，下一道工序做出来的就全
 * 是不良品，而那批料、那些工时已经花掉了。厂里最贵的质量事故有一半是这么来
 * 的 —— 不是做错了，是照着旧图做对了。
 *
 * 所以这张表只回答五件事：哪个客户 · 哪天变的 · 变了什么 · 谁发起的 · 图。
 * 图是这里最要紧的一项：变更十有八九是"看这张新图"，一句话说不清，所以图能
 * 传多张，点开能放大到满屏。
 *
 * Table-free, 跟 客诉 / 来料异常 / 人事 一个路子: 没有 migration 要人去应用。
 */

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const KEY = 'quality/changes.json'

export type ChangePhoto = {
  id: string
  url: string
  filename: string
  uploadedBy?: string
  createdAt: string
}

export type ChangeRecord = {
  id: string
  date: string // 变更日期 YYYY-MM-DD
  customer: string // 客户
  dept: string // 发起部门
  jobNo: string // 工号 — 有就填, 变更多半挂在某张单上
  content: string // 变更内容
  photos: ChangePhoto[] // 图片 / 图纸
  by?: string // 记录人
  createdAt: string
}

export type ChangeRecordPatch = {
  date?: string
  customer?: string
  dept?: string
  jobNo?: string
  content?: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function normalizePhotos(raw: unknown): ChangePhoto[] {
  if (!Array.isArray(raw)) return []
  const out: ChangePhoto[] = []
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

function normalize(raw: unknown): ChangeRecord[] {
  if (!Array.isArray(raw)) return []
  const out: ChangeRecord[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.id !== 'string') continue
    out.push({
      id: r.id,
      date: /^\d{4}-\d{2}-\d{2}$/.test(str(r.date)) ? str(r.date) : '',
      customer: str(r.customer),
      dept: str(r.dept),
      jobNo: str(r.jobNo),
      content: str(r.content),
      photos: normalizePhotos(r.photos),
      by: str(r.by) || undefined,
      createdAt: str(r.createdAt),
    })
  }
  return out
}

async function read(): Promise<ChangeRecord[]> {
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

async function write(rows: ChangeRecord[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

// 新的在前 — 这张表读起来是"最近客户改了什么"。
export async function getChangeRecords(): Promise<ChangeRecord[]> {
  return (await read()).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.createdAt < b.createdAt ? 1 : -1
  })
}

export type NewChangeRecord = {
  date: string
  customer: string
  dept: string
  jobNo: string
  content: string
}

export async function addChangeRecord(
  input: NewChangeRecord,
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
      dept: input.dept.trim(),
      jobNo: input.jobNo.trim(),
      content: input.content.trim(),
      photos: [],
      by,
      createdAt: nowIso,
    })
    await write(rows)
  })
  return id
}

// fillBlanksOnly — 见 lib/complaints 的同一段: 直报那一档只补空格, 改已经填
// 下去的东西是 工程 / 质量 / 商务于海伟 那一档 (lib/auth canEditQuality)。
export async function updateChangeRecord(
  id: string,
  patch: ChangeRecordPatch,
  opts?: { fillBlanksOnly?: boolean },
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const row = rows.find((r) => r.id === id)
    if (!row) return
    if (opts?.fillBlanksOnly) {
      for (const k of Object.keys(patch) as (keyof ChangeRecordPatch)[]) {
        if (patch[k] === undefined) continue
        if (row[k]) throw new Error('这一格填过了 — 要改找质量或于海伟')
      }
    }
    if (patch.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(patch.date))
      row.date = patch.date
    if (patch.customer !== undefined) row.customer = patch.customer.trim()
    if (patch.dept !== undefined) row.dept = patch.dept.trim()
    if (patch.jobNo !== undefined) row.jobNo = patch.jobNo.trim()
    if (patch.content !== undefined) row.content = patch.content.trim()
    await write(rows)
  })
}

export async function deleteChangeRecord(id: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    if (!rows.some((r) => r.id === id)) return
    await write(rows.filter((r) => r.id !== id))
  })
}

/**
 * 往一条变更上挂一张图 —— 变更十有八九是"看这张新图", 一句话说不清。
 *
 * 图直接转交 storage (Blob 不在内存里再拷一份), 存的是代理过的地址, 跟沟通
 * 确认单上的配图一个路子。
 */
export async function addChangePhoto(input: {
  changeId: string
  body: Blob
  fileName: string
  contentType: string
  uploadedBy?: string
  nowIso: string
}): Promise<ChangePhoto> {
  const id = crypto.randomUUID()
  const m = input.fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  const ext = m ? m[1] : 'png'
  const key = `quality/changes/${input.changeId}-${id}.${ext}`
  const upR = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, input.body, {
      contentType: input.contentType || 'application/octet-stream',
      upsert: false,
    })
  if (upR.error) throw upR.error

  const photo: ChangePhoto = {
    id,
    url: proxiedKeyUrl(key),
    filename: input.fileName,
    uploadedBy: input.uploadedBy,
    createdAt: input.nowIso,
  }
  await withLock(async () => {
    const rows = await read()
    const row = rows.find((r) => r.id === input.changeId)
    if (!row) throw new Error('这条变更找不到了')
    row.photos = [...row.photos, photo]
    await write(rows)
  })
  return photo
}

export async function deleteChangePhoto(
  changeId: string,
  photoId: string,
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const row = rows.find((r) => r.id === changeId)
    if (!row) return
    row.photos = row.photos.filter((p) => p.id !== photoId)
    await write(rows)
  })
}
