import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import type { ArchiveFile, ArchiveKind, ArchivePerson } from './hr-archive-shared'
import { isArchiveKind } from './hr-archive-shared'

/*
 * 人事档案的存取。口径在 lib/hr-archive-shared.ts。
 *
 * TABLE-FREE, 没有 migration:
 *   hr/archive.json                          [ArchivePerson, …]
 *   hr/archive/<personId>/<fileId>.<ext>     文件本身 (只从 /api/hr-archive 出)
 */

const KEY = 'hr/archive.json'
export const ARCHIVE_FILE_PREFIX = 'hr/archive/'

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

function str(v: unknown, max = 500): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function normalize(raw: unknown): ArchivePerson[] {
  if (!Array.isArray(raw)) return []
  const out: ArchivePerson[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.id !== 'string' || !str(r.name)) continue
    const files: ArchiveFile[] = Array.isArray(r.files)
      ? (r.files as Record<string, unknown>[])
          .filter((f) => f && typeof f.id === 'string' && isArchiveKind(f.kind))
          .map((f) => ({
            id: f.id as string,
            kind: f.kind as ArchiveKind,
            filename: str(f.filename, 200) || '文件',
            contentType: str(f.contentType, 100) || undefined,
            size: typeof f.size === 'number' ? f.size : undefined,
            uploadedBy: str(f.uploadedBy, 40) || undefined,
            createdAt: str(f.createdAt, 40),
          }))
      : []
    out.push({
      id: r.id,
      name: str(r.name, 40),
      dept: str(r.dept, 40) || undefined,
      lodging: r.lodging === '内宿' || r.lodging === '外宿' ? r.lodging : undefined,
      note: str(r.note) || undefined,
      files,
      leftAt: str(r.leftAt, 10) || undefined,
      leftBy: str(r.leftBy, 40) || undefined,
      createdBy: str(r.createdBy, 40) || undefined,
      createdAt: str(r.createdAt, 40),
    })
  }
  return out
}

async function read(): Promise<ArchivePerson[]> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return []
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return []
  }
}

async function write(rows: ArchivePerson[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

async function mutatePerson(id: string, fn: (p: ArchivePerson) => void): Promise<ArchivePerson> {
  return withLock(async () => {
    const rows = await read()
    const p = rows.find((x) => x.id === id)
    if (!p) throw new Error('找不到这份档案')
    fn(p)
    await write(rows)
    return p
  })
}

/** 按名字排。 */
export async function getArchive(): Promise<ArchivePerson[]> {
  return (await read()).sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

export async function getArchivePerson(id: string): Promise<ArchivePerson | undefined> {
  return (await read()).find((p) => p.id === id)
}

export async function createArchivePerson(
  input: { name: string; dept?: string },
  by: string,
): Promise<ArchivePerson> {
  return withLock(async () => {
    const rows = await read()
    const name = input.name.trim()
    if (rows.some((p) => p.name === name && !p.leftAt)) throw new Error(`「${name}」已经有档案了`)
    const p: ArchivePerson = {
      id: crypto.randomUUID(),
      name,
      dept: input.dept?.trim() || undefined,
      files: [],
      createdBy: by,
      createdAt: new Date().toISOString(),
    }
    rows.push(p)
    await write(rows)
    return p
  })
}

export async function updateArchivePerson(
  id: string,
  patch: { name?: string; dept?: string; lodging?: '内宿' | '外宿' | null; note?: string },
): Promise<void> {
  await mutatePerson(id, (p) => {
    if (patch.name !== undefined && patch.name.trim()) p.name = patch.name.trim().slice(0, 40)
    if (patch.dept !== undefined) p.dept = patch.dept.trim() || undefined
    if (patch.lodging !== undefined) p.lodging = patch.lodging ?? undefined
    if (patch.note !== undefined) p.note = patch.note.trim() || undefined
  })
}

/** 办离职 / 撤销离职。 */
export async function setArchiveLeft(id: string, leftAt: string | null, by: string): Promise<void> {
  await mutatePerson(id, (p) => {
    p.leftAt = leftAt ?? undefined
    p.leftBy = leftAt ? by : undefined
  })
}

/** 整份档案删掉 —— 连文件一起。 */
export async function deleteArchivePerson(id: string): Promise<void> {
  const gone = await withLock(async () => {
    const rows = await read()
    const p = rows.find((x) => x.id === id)
    if (!p) return undefined
    await write(rows.filter((x) => x.id !== id))
    return p
  })
  if (!gone) return
  const keys = gone.files.map((f) => fileKey(gone.id, f))
  if (keys.length > 0) await supabase.storage.from(STORAGE_BUCKET).remove(keys).catch(() => undefined)
}

const EXTS = ['png', 'jpg', 'jpeg', 'webp', 'heic', 'pdf'] as const

export function isAllowedArchiveFileName(name: string): boolean {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/)
  return !!m && (EXTS as readonly string[]).includes(m[1])
}

function extOf(name: string, type: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/)
  if (m && (EXTS as readonly string[]).includes(m[1])) return m[1]
  if (type === 'application/pdf') return 'pdf'
  if (type === 'image/png') return 'png'
  return 'jpg'
}

function fileKey(personId: string, f: Pick<ArchiveFile, 'id' | 'filename' | 'contentType'>): string {
  const safe = personId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return `${ARCHIVE_FILE_PREFIX}${safe}/${f.id}.${extOf(f.filename, f.contentType ?? '')}`
}

export async function addArchiveFile(input: {
  personId: string
  kind: ArchiveKind
  buf: ArrayBuffer
  fileName: string
  contentType: string
  by: string
}): Promise<ArchiveFile> {
  const file: ArchiveFile = {
    id: crypto.randomUUID(),
    kind: input.kind,
    filename: input.fileName.slice(0, 200) || '文件',
    contentType: input.contentType || undefined,
    size: input.buf.byteLength,
    uploadedBy: input.by,
    createdAt: new Date().toISOString(),
  }
  const up = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(fileKey(input.personId, file), Buffer.from(input.buf), {
      contentType: input.contentType || 'application/octet-stream',
      upsert: false,
    })
  if (up.error) throw up.error
  await mutatePerson(input.personId, (p) => {
    p.files.push(file)
  })
  return file
}

export async function deleteArchiveFile(personId: string, fileId: string): Promise<void> {
  let hit: ArchiveFile | undefined
  await mutatePerson(personId, (p) => {
    hit = p.files.find((f) => f.id === fileId)
    p.files = p.files.filter((f) => f.id !== fileId)
  })
  if (hit) await supabase.storage.from(STORAGE_BUCKET).remove([fileKey(personId, hit)]).catch(() => undefined)
}

/** 把文件读出来 (给 /api/hr-archive 往外送)。 */
export async function readArchiveFile(
  personId: string,
  fileId: string,
): Promise<{ file: ArchiveFile; data: Blob } | undefined> {
  const p = await getArchivePerson(personId)
  const file = p?.files.find((f) => f.id === fileId)
  if (!p || !file) return undefined
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(fileKey(p.id, file))
  if (error || !data) return undefined
  return { file, data }
}
