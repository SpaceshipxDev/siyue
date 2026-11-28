import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl, storageKeyFromUrl } from './storage-url'
import type { VoucherFile } from './data'
import { cleanStatement, type PayStatement } from './pay-request-shared'

/*
 * 外协的手工对账单 (于海伟 2026-11-27) —— 供应商自己做的那张对账单, 导进来摆
 * 在外协对账页上, 跟系统排出来的那张对着看。一家一个月一份, 再导一次就整份
 * 换掉。只是摆着看: 不参与勾选、合计、确认, 也不进付款。
 *
 * 两种样子 (于海伟 2026-11-28: 传了一张照片, 被当成表格读成了乱码):
 *   Excel / CSV —— 原样读成一张表 (table);
 *   照片 / PDF —— 纸面那张拍下来的, 原样存着点开看 (files, 可以好几页)。
 *
 * TABLE-FREE, 没有 migration:
 *   duizhang/vendor-statements.json  { "<供应商>|<YYYY-MM>": { table?, files, by, at } }
 *   照片 / PDF 本体在 duizhang/vendor-statements/ 下。
 */

export type VendorStatement = {
  table?: PayStatement
  files: VoucherFile[]
  by: string
  at: string
}

const KEY = 'duizhang/vendor-statements.json'
const FILE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'heic', 'pdf'] as const

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const keyOf = (vendor: string, month: string) => `${vendor.trim()}|${month}`

export function isAllowedStatementFile(fileName: string): boolean {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  return !!m && (FILE_EXTS as readonly string[]).includes(m[1])
}

function files(v: unknown): VoucherFile[] {
  if (!Array.isArray(v)) return []
  return (v as unknown[]).flatMap((x) => {
    if (typeof x !== 'object' || x === null) return []
    const r = x as Record<string, unknown>
    if (typeof r.id !== 'string' || typeof r.url !== 'string') return []
    return [
      {
        id: r.id,
        url: r.url,
        filename: typeof r.filename === 'string' ? r.filename : '对账单',
        contentType: typeof r.contentType === 'string' ? r.contentType : undefined,
        uploadedBy: typeof r.uploadedBy === 'string' ? r.uploadedBy : undefined,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
      },
    ]
  })
}

async function read(): Promise<Record<string, VendorStatement>> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return {}
  try {
    const raw = JSON.parse(await data.text()) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const out: Record<string, VendorStatement> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null) continue
      const r = v as Record<string, unknown>
      // 头一版把表直接摊在这一层 (rows / filename), 新的放在 table 里。
      const t = (typeof r.table === 'object' && r.table !== null ? r.table : r) as Record<string, unknown>
      const table = cleanStatement(t.rows, t.filename)
      const fs = files(r.files)
      if (!table && fs.length === 0) continue
      out[k] = {
        table,
        files: fs,
        by: typeof r.by === 'string' ? r.by : '',
        at: typeof r.at === 'string' ? r.at : '',
      }
    }
    return out
  } catch {
    return {}
  }
}

async function write(all: Record<string, VendorStatement>): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(all), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

// 换掉的那份的照片 —— 删不掉也无害 (没人看得见的孤儿文件)。
async function forget(old: VendorStatement | undefined): Promise<void> {
  const keys = (old?.files ?? []).map((f) => storageKeyFromUrl(f.url)).filter((k): k is string => !!k)
  if (keys.length === 0) return
  try {
    await supabase.storage.from(STORAGE_BUCKET).remove(keys)
  } catch {
    // 见上
  }
}

async function replace(vendor: string, month: string, next: VendorStatement | undefined): Promise<void> {
  const old = await withLock(async () => {
    const all = await read()
    const k = keyOf(vendor, month)
    const prev = all[k]
    if (next) all[k] = next
    else if (prev) delete all[k]
    else return undefined
    await write(all)
    return prev
  })
  await forget(old)
}

export async function getVendorStatement(
  vendor: string,
  month: string,
): Promise<VendorStatement | undefined> {
  return (await read())[keyOf(vendor, month)]
}

/** Excel 读成的表 —— 整份换成它; 空 = 整份去掉。 */
export async function setVendorStatement(
  vendor: string,
  month: string,
  table: PayStatement | undefined,
  by: string,
): Promise<void> {
  await replace(vendor, month, table ? { table, files: [], by, at: new Date().toISOString() } : undefined)
}

/** 照片 / PDF (可以好几页) —— 整份换成这几张。 */
export async function setVendorStatementFiles(
  vendor: string,
  month: string,
  uploads: { buf: ArrayBuffer; fileName: string; contentType: string }[],
  by: string,
): Promise<void> {
  const safe = vendor.trim().replace(/[^a-zA-Z0-9._-]/g, '_') || 'vendor'
  const nowIso = new Date().toISOString()
  const out: VoucherFile[] = []
  for (const u of uploads) {
    const m = u.fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
    const ext = m && (FILE_EXTS as readonly string[]).includes(m[1]) ? m[1] : 'jpg'
    const id = crypto.randomUUID()
    const key = `duizhang/vendor-statements/${safe}-${month}/${id}.${ext}`
    const up = await supabase.storage.from(STORAGE_BUCKET).upload(key, Buffer.from(u.buf), {
      contentType: u.contentType || 'application/octet-stream',
      upsert: false,
    })
    if (up.error) throw up.error
    out.push({
      id,
      url: proxiedKeyUrl(key),
      filename: u.fileName || `对账单.${ext}`,
      filesize: u.buf.byteLength,
      contentType: u.contentType || undefined,
      uploadedBy: by,
      createdAt: nowIso,
    })
  }
  await replace(vendor, month, { files: out, by, at: nowIso })
}
