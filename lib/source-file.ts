import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl, storageKeyFromUrl } from './storage-url'

// Original-upload storage helpers. We park the source workbook inside the
// same `uploads` bucket that holds component images, but under a dedicated
// `__source.<ext>` filename so the prefix can never collide with a real
// componentId-based key. Public URL is what we hand to <a download>.

const ALLOWED_EXTS = ['xlsx', 'xls', 'csv'] as const
type SourceExt = (typeof ALLOWED_EXTS)[number]

function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function extFor(fileName: string, contentType: string): SourceExt {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  const fromName = m ? m[1] : ''
  if ((ALLOWED_EXTS as readonly string[]).includes(fromName)) {
    return fromName as SourceExt
  }
  if (
    contentType ===
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return 'xlsx'
  }
  if (contentType === 'application/vnd.ms-excel') return 'xls'
  if (contentType === 'text/csv') return 'csv'
  // Caller has already filtered by Excel/CSV in the dropzone — fall back
  // to xlsx rather than refusing the upload outright.
  return 'xlsx'
}

function keyFor(jobId: string, ext: SourceExt): string {
  return `${safeId(jobId)}/__source.${ext}`
}

// Replace any prior __source.* object first — the user may have swapped from
// .xlsx to .xls, etc. Listing the prefix is cheap (one job, max ~10 keys).
async function removeStaleSources(jobId: string, keepKey: string): Promise<void> {
  const { data } = await supabase.storage
    .from(STORAGE_BUCKET)
    .list(safeId(jobId))
  const stale = (data ?? [])
    .filter((o) => o.name.startsWith('__source.'))
    .map((o) => `${safeId(jobId)}/${o.name}`)
    .filter((k) => k !== keepKey)
  if (stale.length > 0) {
    await supabase.storage.from(STORAGE_BUCKET).remove(stale)
  }
}

export async function uploadSourceFile(input: {
  jobId: string
  buf: ArrayBuffer
  fileName: string
  contentType: string
}): Promise<string> {
  const ext = extFor(input.fileName, input.contentType)
  const key = keyFor(input.jobId, ext)
  await removeStaleSources(input.jobId, key)
  const upR = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, Buffer.from(input.buf), {
      contentType: input.contentType || 'application/octet-stream',
      upsert: true,
    })
  if (upR.error) throw upR.error
  // Route through /api/img so the browser fetches from our origin (Vercel
  // hnd1) instead of *.supabase.co — China clients pay one short hop instead
  // of a transpacific TLS handshake per download.
  return proxiedKeyUrl(key)
}

// Re-download a previously stored source workbook by its stored URL. Used by
// /api/retry-parse to re-run extraction without a fresh upload.
//
// The stored URL is a PROXIED path (`/api/img/<key>?v=…`) — relative, so a
// server-side `fetch()` on it throws "Failed to parse URL". We instead recover
// the storage key and pull the bytes straight from Supabase storage.
export async function downloadSourceFile(sourceFileUrl: string): Promise<ArrayBuffer> {
  const key = storageKeyFromUrl(sourceFileUrl)
  if (!key) {
    // Last-resort: an absolute http(s) URL we don't recognise. fetch() can at
    // least handle those (relative /api/img paths are what break it).
    if (/^https?:\/\//.test(sourceFileUrl)) {
      const r = await fetch(sourceFileUrl)
      if (!r.ok) throw new Error(`下载源文件失败 (${r.status})`)
      return r.arrayBuffer()
    }
    throw new Error(`无法解析源文件地址: ${sourceFileUrl}`)
  }
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(key)
  if (error || !data) {
    throw new Error(`下载源文件失败: ${error?.message ?? 'not found'}`)
  }
  return data.arrayBuffer()
}
