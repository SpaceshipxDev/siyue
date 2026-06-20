import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl, storageKeyFromUrl } from './storage-url'
import type { ContractFile } from './data'

/*
 * 合同 (contract) storage. 财务 attaches the signed contract to an order,
 * downloads it later, and sees who uploaded it and when.
 *
 * Deliberately TABLE-FREE — no migration to apply by hand. Each order keeps:
 *   <jobId>/contracts/<uuid>.<ext>     the blob
 *   <jobId>/contracts/manifest.json    [{id,url,filename,filesize,...}, …]
 * The manifest carries the metadata storage can't (original filename, uploader)
 * so the 财务 tab renders the full list straight from the bucket. Contracts are
 * low-frequency, so the read-modify-write on the manifest is fine.
 */

const ALLOWED_EXTS = [
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'png',
  'jpg',
  'jpeg',
  'webp',
] as const
type ContractExt = (typeof ALLOWED_EXTS)[number]

function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export function isAllowedContractName(fileName: string): boolean {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  return !!m && (ALLOWED_EXTS as readonly string[]).includes(m[1])
}

function extFor(fileName: string, contentType: string): ContractExt {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  const fromName = m ? m[1] : ''
  if ((ALLOWED_EXTS as readonly string[]).includes(fromName)) {
    return fromName as ContractExt
  }
  if (contentType === 'application/pdf') return 'pdf'
  if (
    contentType ===
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'docx'
  }
  if (
    contentType ===
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return 'xlsx'
  }
  if (contentType === 'image/png') return 'png'
  if (contentType === 'image/jpeg') return 'jpg'
  return 'pdf'
}

function manifestKey(jobId: string): string {
  return `${safeId(jobId)}/contracts/manifest.json`
}

async function readManifest(jobId: string): Promise<ContractFile[]> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(manifestKey(jobId))
  if (error || !data) return [] // no contracts yet (or first ever)
  try {
    const text = await data.text()
    const arr = JSON.parse(text)
    return Array.isArray(arr) ? (arr as ContractFile[]) : []
  } catch {
    return []
  }
}

async function writeManifest(
  jobId: string,
  rows: ContractFile[],
): Promise<void> {
  const body = Buffer.from(JSON.stringify(rows), 'utf8')
  const upR = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(manifestKey(jobId), body, {
      contentType: 'application/json',
      upsert: true,
    })
  if (upR.error) throw upR.error
}

// All contracts on an order, newest first. Never throws on a missing manifest
// (degrades to an empty list) so the 财务 tab always renders.
export async function getContractFiles(jobId: string): Promise<ContractFile[]> {
  const rows = await readManifest(jobId)
  return rows
    .slice()
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
}

// Upload a contract blob + record it in the manifest. Returns the new row.
export async function addContractFile(input: {
  jobId: string
  buf: ArrayBuffer
  fileName: string
  contentType: string
  uploadedBy?: string
  nowIso: string
}): Promise<ContractFile> {
  const { jobId } = input
  const ext = extFor(input.fileName, input.contentType)
  const id = crypto.randomUUID()
  const key = `${safeId(jobId)}/contracts/${id}.${ext}`
  const upR = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, Buffer.from(input.buf), {
      contentType: input.contentType || 'application/octet-stream',
      upsert: false,
    })
  if (upR.error) throw upR.error

  const row: ContractFile = {
    id,
    url: proxiedKeyUrl(key),
    filename: input.fileName,
    filesize: input.buf.byteLength,
    contentType: input.contentType || undefined,
    uploadedBy: input.uploadedBy,
    createdAt: input.nowIso,
  }
  const rows = await readManifest(jobId)
  rows.push(row)
  await writeManifest(jobId, rows)
  return row
}

// Remove a contract: drop it from the manifest, then best-effort delete the
// blob. The manifest is the source of truth; an orphaned blob is harmless.
export async function deleteContractFile(
  jobId: string,
  contractId: string,
): Promise<void> {
  const rows = await readManifest(jobId)
  const target = rows.find((r) => r.id === contractId)
  if (!target) return
  await writeManifest(
    jobId,
    rows.filter((r) => r.id !== contractId),
  )
  const key = storageKeyFromUrl(target.url)
  if (key) {
    try {
      await supabase.storage.from(STORAGE_BUCKET).remove([key])
    } catch {
      // Orphan blob — harmless.
    }
  }
}
