import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl } from './storage-url'

/*
 * 文件管理 — 质量的受控文件: 检验标准、作业指导书、签过字的报告、图纸……
 *
 * 一份文件回答四件事: 叫什么 · 对应哪张图 · 谁签的字 · 文件本身 (多半就是签
 * 过字的那张扫描件)。找文件的人手里通常只有一个图名, 所以图名单列一格、能搜。
 *
 * 跟质量其它几张表同一档权限: 有账号就能传、能补空格; 改填过的、删一份是
 * 工程和商务于海伟。
 *
 * Table-free, 跟 变更管理 一个路子: 文件进 storage, 清单是一份 JSON。
 */

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const KEY = 'quality/files.json'

export type QualityFilePhoto = {
  id: string
  url: string
  filename: string
  uploadedBy?: string
  createdAt: string
}

export type QualityFile = {
  id: string
  date: string // 日期 YYYY-MM-DD
  title: string // 文件名称
  drawing: string // 对应图名
  signer: string // 签字人
  url: string
  filename: string // 传上来时的文件名 — 下载时用它
  photos: QualityFilePhoto[] // 图片 — 签字页、实物照片, 点开放大
  by?: string // 上传人
  createdAt: string
}

export type QualityFilePatch = {
  date?: string
  title?: string
  drawing?: string
  signer?: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function normalize(raw: unknown): QualityFile[] {
  if (!Array.isArray(raw)) return []
  const out: QualityFile[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.id !== 'string' || !str(r.url)) continue
    out.push({
      id: r.id,
      date: /^\d{4}-\d{2}-\d{2}$/.test(str(r.date)) ? str(r.date) : '',
      title: str(r.title),
      drawing: str(r.drawing),
      signer: str(r.signer),
      url: str(r.url),
      filename: str(r.filename),
      photos: Array.isArray(r.photos)
        ? (r.photos as unknown[]).flatMap((x) => {
            if (typeof x !== 'object' || x === null) return []
            const ph = x as Record<string, unknown>
            if (typeof ph.id !== 'string' || !str(ph.url)) return []
            return [
              {
                id: ph.id,
                url: str(ph.url),
                filename: str(ph.filename),
                uploadedBy: str(ph.uploadedBy) || undefined,
                createdAt: str(ph.createdAt),
              },
            ]
          })
        : [],
      by: str(r.by) || undefined,
      createdAt: str(r.createdAt),
    })
  }
  return out
}

async function read(): Promise<QualityFile[]> {
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

async function write(rows: QualityFile[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

// 新的在前。
export async function getQualityFiles(): Promise<QualityFile[]> {
  return (await read()).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.createdAt < b.createdAt ? 1 : -1
  })
}

/** 传一份 —— 文件直接转交 storage, 清单里记一条。 */
export async function addQualityFile(input: {
  body: Blob
  fileName: string
  contentType: string
  date: string
  title: string
  drawing: string
  signer: string
  by: string
  nowIso: string
}): Promise<QualityFile> {
  const id = crypto.randomUUID()
  const m = input.fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  const ext = m ? m[1] : 'bin'
  const key = `quality/files/${id}.${ext}`
  const upR = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, input.body, {
      contentType: input.contentType || 'application/octet-stream',
      upsert: false,
    })
  if (upR.error) throw upR.error

  const row: QualityFile = {
    id,
    date: /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : input.nowIso.slice(0, 10),
    // 没填文件名称就用文件自己的名字 (去掉后缀)。
    title: input.title.trim() || input.fileName.replace(/\.[^.]+$/, ''),
    drawing: input.drawing.trim(),
    signer: input.signer.trim(),
    url: proxiedKeyUrl(key),
    filename: input.fileName,
    photos: [],
    by: input.by,
    createdAt: input.nowIso,
  }
  await withLock(async () => {
    const rows = await read()
    rows.push(row)
    await write(rows)
  })
  return row
}

// fillBlanksOnly — 有账号的只补空格, 改填过的是 canEditQuality 那一档。
export async function updateQualityFile(
  id: string,
  patch: QualityFilePatch,
  opts?: { fillBlanksOnly?: boolean },
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const row = rows.find((r) => r.id === id)
    if (!row) return
    if (opts?.fillBlanksOnly) {
      for (const k of Object.keys(patch) as (keyof QualityFilePatch)[]) {
        if (patch[k] === undefined) continue
        if (row[k]) throw new Error('这一格填过了 — 要改找工程或于海伟')
      }
    }
    if (patch.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(patch.date))
      row.date = patch.date
    if (patch.title !== undefined && patch.title.trim()) row.title = patch.title.trim()
    if (patch.drawing !== undefined) row.drawing = patch.drawing.trim()
    if (patch.signer !== undefined) row.signer = patch.signer.trim()
    await write(rows)
  })
}

/** 往一份文件上挂一张图 —— 跟变更管理的配图一个路子。 */
export async function addQualityFilePhoto(input: {
  fileId: string
  body: Blob
  fileName: string
  contentType: string
  uploadedBy?: string
  nowIso: string
}): Promise<QualityFilePhoto> {
  const id = crypto.randomUUID()
  const m = input.fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  const ext = m ? m[1] : 'png'
  const key = `quality/files/${input.fileId}-${id}.${ext}`
  const upR = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, input.body, {
      contentType: input.contentType || 'application/octet-stream',
      upsert: false,
    })
  if (upR.error) throw upR.error
  const photo: QualityFilePhoto = {
    id,
    url: proxiedKeyUrl(key),
    filename: input.fileName,
    uploadedBy: input.uploadedBy,
    createdAt: input.nowIso,
  }
  await withLock(async () => {
    const rows = await read()
    const row = rows.find((r) => r.id === input.fileId)
    if (!row) throw new Error('这份文件找不到了')
    row.photos = [...row.photos, photo]
    await write(rows)
  })
  return photo
}

export async function deleteQualityFilePhoto(fileId: string, photoId: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const row = rows.find((r) => r.id === fileId)
    if (!row) return
    row.photos = row.photos.filter((p) => p.id !== photoId)
    await write(rows)
  })
}

export async function deleteQualityFile(id: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    if (!rows.some((r) => r.id === id)) return
    await write(rows.filter((r) => r.id !== id))
  })
}
