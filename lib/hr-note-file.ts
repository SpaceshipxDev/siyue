import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl, storageKeyFromUrl } from './storage-url'
import type { HrNoteFile } from './data'

/*
 * 请假条 — 员工递上来的那张纸的照片, 挂在一条人事记录上。
 *
 * 为什么要留这张纸: 屏幕上那行「事假 8h」是人敲进去的, 月底跟工资对不上的时
 * 候, 谁也说不清当时批的是几个小时、批没批。纸上有他的字、有批的人的字。以
 * 前这些纸夹在办公室的文件夹里, 要翻就得翻一整年。
 *
 * 跟 凭证 (lib/voucher-file.ts) 一个路子, TABLE-FREE —— 没有 migration 要人
 * 去应用, 坏了也只坏这一处。
 *
 * 按月分片, 跟 lib/hr.ts 的记录同一个口径 (那边一个月一个 JSON, 这边一个月
 * 一份清单):
 *   hr/notes/<YYYY-MM>.json                     { recordId: [file, …], … }
 *   hr/notes/<YYYY-MM>/<recordId>/<uuid>.<ext>  那张纸本身
 *
 * 分片就是查询: 月度视图读一个文件, 年度读十二个 —— 跟记录本身走的是同一趟。
 * 记录的日期改到别的月份时, 它名下的假条条目跟着搬到那个月的清单里
 * (moveHrNotes)。那张纸本身不用挪: 条目里存的是完整地址, 放在哪个文件夹
 * 下面都一样打得开、删得掉。
 */

// 假条是手机拍的, 偶尔是扫描件或者微信里存下来的 PDF。heic 是 iPhone 直传。
const ALLOWED_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'heic', 'pdf'] as const
type NoteExt = (typeof ALLOWED_EXTS)[number]

function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function safeMonth(raw: string): string {
  return raw.replace(/[^0-9-]/g, '')
}

export function isAllowedHrNoteName(fileName: string): boolean {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  return !!m && (ALLOWED_EXTS as readonly string[]).includes(m[1])
}

function extFor(fileName: string, contentType: string): NoteExt {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  const fromName = m ? m[1] : ''
  if ((ALLOWED_EXTS as readonly string[]).includes(fromName)) {
    return fromName as NoteExt
  }
  if (contentType === 'application/pdf') return 'pdf'
  if (contentType === 'image/png') return 'png'
  if (contentType === 'image/webp') return 'webp'
  if (contentType === 'image/heic') return 'heic'
  return 'jpg'
}

export type HrNoteMap = Record<string, HrNoteFile[]>

function manifestKey(month: string): string {
  return `hr/notes/${safeMonth(month)}.json`
}

// 缺文件 = 这个月一张假条都没传过, 读作空 —— 永远不抛, 页面总渲染得出来。
async function readManifest(month: string): Promise<HrNoteMap> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(manifestKey(month))
  if (error || !data) return {}
  try {
    const obj = JSON.parse(await data.text())
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return {}
    const out: HrNoteMap = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue
      const rows = (v as HrNoteFile[]).filter(
        (r) => r && typeof r.id === 'string' && typeof r.url === 'string',
      )
      if (rows.length > 0) out[k] = rows
    }
    return out
  } catch {
    return {}
  }
}

async function writeManifest(month: string, map: HrNoteMap): Promise<void> {
  const body = Buffer.from(JSON.stringify(map), 'utf8')
  const upR = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(manifestKey(month), body, {
      contentType: 'application/json',
      upsert: true,
    })
  if (upR.error) throw upR.error
}

// 写清单是 读-改-写, 两个人同一秒各传一张假条不能互相盖掉 —— 跟 lib/hr.ts
// 的 withHrLock 同一个保证 (生产是单个 pm2 进程)。
let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

/** 一个月的全部假条, 按记录 id 分好。月度视图一次读这一个文件。 */
export async function getHrNotesForMonth(month: string): Promise<HrNoteMap> {
  return readManifest(month)
}

/** 一年的 —— 十二个分片并行读, 合成一张表。跟 getHrYear 同一个形状。 */
export async function getHrNotesForYear(year: string): Promise<HrNoteMap> {
  const months = Array.from(
    { length: 12 },
    (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`,
  )
  const maps = await Promise.all(months.map((m) => readManifest(m)))
  const out: HrNoteMap = {}
  for (const m of maps) Object.assign(out, m)
  return out
}

/** 传一张假条上去, 返回新的那一行。 */
export async function addHrNote(input: {
  month: string
  recordId: string
  buf: ArrayBuffer
  fileName: string
  contentType: string
  uploadedBy?: string
  nowIso: string
}): Promise<HrNoteFile> {
  const ext = extFor(input.fileName, input.contentType)
  const id = crypto.randomUUID()
  const key = `hr/notes/${safeMonth(input.month)}/${safeId(input.recordId)}/${id}.${ext}`
  const upR = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, Buffer.from(input.buf), {
      contentType: input.contentType || 'application/octet-stream',
      upsert: false,
    })
  if (upR.error) throw upR.error

  const row: HrNoteFile = {
    id,
    url: proxiedKeyUrl(key),
    filename: input.fileName,
    filesize: input.buf.byteLength,
    contentType: input.contentType || undefined,
    uploadedBy: input.uploadedBy,
    createdAt: input.nowIso,
  }
  await withLock(async () => {
    const map = await readManifest(input.month)
    map[input.recordId] = [...(map[input.recordId] ?? []), row]
    await writeManifest(input.month, map)
  })
  return row
}

// 删一张: 先从清单里拿掉, 再尽力删文件。清单是准的, 桶里留个孤儿无害。
export async function deleteHrNote(
  month: string,
  recordId: string,
  noteId: string,
): Promise<void> {
  let target: HrNoteFile | undefined
  await withLock(async () => {
    const map = await readManifest(month)
    const rows = map[recordId] ?? []
    target = rows.find((r) => r.id === noteId)
    if (!target) return
    const left = rows.filter((r) => r.id !== noteId)
    if (left.length > 0) map[recordId] = left
    else delete map[recordId]
    await writeManifest(month, map)
  })
  await removeBlobs(target ? [target] : [])
}

// 记录的日期改到了别的月份 —— 它的假条条目跟着搬过去, 不然新月份里这条线
// 上就是空的, 旧月份里还挂着一份没有主人的清单。
export async function moveHrNotes(
  fromMonth: string,
  toMonth: string,
  recordId: string,
): Promise<void> {
  if (fromMonth === toMonth) return
  await withLock(async () => {
    const from = await readManifest(fromMonth)
    const rows = from[recordId]
    if (!rows || rows.length === 0) return
    const to = await readManifest(toMonth)
    to[recordId] = [...(to[recordId] ?? []), ...rows]
    await writeManifest(toMonth, to)
    delete from[recordId]
    await writeManifest(fromMonth, from)
  })
}

// 记录本身被删掉的时候, 挂在它上面的假条跟着走 —— 留着也没人找得到了。
export async function deleteHrNotesForRecord(
  month: string,
  recordId: string,
): Promise<void> {
  let gone: HrNoteFile[] = []
  await withLock(async () => {
    const map = await readManifest(month)
    gone = map[recordId] ?? []
    if (gone.length === 0) return
    delete map[recordId]
    await writeManifest(month, map)
  })
  await removeBlobs(gone)
}

async function removeBlobs(rows: HrNoteFile[]): Promise<void> {
  const keys = rows
    .map((r) => storageKeyFromUrl(r.url))
    .filter((k): k is string => !!k)
  if (keys.length === 0) return
  try {
    await supabase.storage.from(STORAGE_BUCKET).remove(keys)
  } catch {
    // 孤儿文件 — 无害。
  }
}
