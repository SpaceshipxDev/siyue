import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl, storageKeyFromUrl } from './storage-url'
import type { VoucherFile } from './data'

/*
 * 凭证 / 报销凭证 (expense vouchers). The finance person snaps the receipt and
 * attaches it to the 支出 row as proof — exactly what 王雪梅 asked for. Many
 * images per expense (a 报销 can bundle several receipts).
 *
 * Deliberately TABLE-FREE — the same choice as 合同 (lib/contract-file.ts), so
 * there is NO migration to apply by hand and nothing to break on a stale DB.
 * Each expense keeps:
 *   expenses/<expenseId>/vouchers/<uuid>.<ext>     the blob
 *   expenses/<expenseId>/vouchers/manifest.json    [{id,url,filename,...}, …]
 * The manifest carries the metadata storage can't (original filename, uploader)
 * so the ledger renders the receipt list straight from the bucket. Vouchers are
 * low-frequency per row, so the read-modify-write on the manifest is fine.
 */

// Receipts are phone photos or scans — images first, PDF for printed invoices.
// heic covers iPhone shots that aren't transcoded before upload.
const ALLOWED_EXTS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'heic',
  'pdf',
] as const
type VoucherExt = (typeof ALLOWED_EXTS)[number]

function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export function isAllowedVoucherName(fileName: string): boolean {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  return !!m && (ALLOWED_EXTS as readonly string[]).includes(m[1])
}

function extFor(fileName: string, contentType: string): VoucherExt {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  const fromName = m ? m[1] : ''
  if ((ALLOWED_EXTS as readonly string[]).includes(fromName)) {
    return fromName as VoucherExt
  }
  if (contentType === 'application/pdf') return 'pdf'
  if (contentType === 'image/png') return 'png'
  if (contentType === 'image/webp') return 'webp'
  if (contentType === 'image/heic') return 'heic'
  return 'jpg'
}

function manifestKey(expenseId: string): string {
  return `expenses/${safeId(expenseId)}/vouchers/manifest.json`
}

async function readManifest(expenseId: string): Promise<VoucherFile[]> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(manifestKey(expenseId))
  if (error || !data) return [] // no vouchers yet (or first ever)
  try {
    const text = await data.text()
    const arr = JSON.parse(text)
    return Array.isArray(arr) ? (arr as VoucherFile[]) : []
  } catch {
    return []
  }
}

async function writeManifest(
  expenseId: string,
  rows: VoucherFile[],
): Promise<void> {
  const body = Buffer.from(JSON.stringify(rows), 'utf8')
  const upR = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(manifestKey(expenseId), body, {
      contentType: 'application/json',
      upsert: true,
    })
  if (upR.error) throw upR.error
}

// All vouchers on an expense, newest first. Never throws on a missing manifest
// (degrades to an empty list) so the ledger always renders.
export async function getExpenseVouchers(
  expenseId: string,
): Promise<VoucherFile[]> {
  const rows = await readManifest(expenseId)
  return rows
    .slice()
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
}

// Vouchers for a page of expenses at once (bounded — the ledger slices to 25
// rows per page, so this is ~25 parallel reads, like the contract widget does
// one per job). Returns a map keyed by expenseId; absent keys = no vouchers.
export async function getVouchersForExpenses(
  expenseIds: string[],
): Promise<Record<string, VoucherFile[]>> {
  const out: Record<string, VoucherFile[]> = {}
  await Promise.all(
    expenseIds.map(async (id) => {
      const rows = await getExpenseVouchers(id)
      if (rows.length > 0) out[id] = rows
    }),
  )
  return out
}

// Upload a voucher blob + record it in the manifest. Returns the new row.
export async function addExpenseVoucher(input: {
  expenseId: string
  buf: ArrayBuffer
  fileName: string
  contentType: string
  uploadedBy?: string
  nowIso: string
}): Promise<VoucherFile> {
  const { expenseId } = input
  const ext = extFor(input.fileName, input.contentType)
  const id = crypto.randomUUID()
  const key = `expenses/${safeId(expenseId)}/vouchers/${id}.${ext}`
  const upR = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, Buffer.from(input.buf), {
      contentType: input.contentType || 'application/octet-stream',
      upsert: false,
    })
  if (upR.error) throw upR.error

  const row: VoucherFile = {
    id,
    url: proxiedKeyUrl(key),
    filename: input.fileName,
    filesize: input.buf.byteLength,
    contentType: input.contentType || undefined,
    uploadedBy: input.uploadedBy,
    createdAt: input.nowIso,
  }
  const rows = await readManifest(expenseId)
  rows.push(row)
  await writeManifest(expenseId, rows)
  return row
}

// Remove a voucher: drop it from the manifest, then best-effort delete the
// blob. The manifest is the source of truth; an orphaned blob is harmless.
export async function deleteExpenseVoucher(
  expenseId: string,
  voucherId: string,
): Promise<void> {
  const rows = await readManifest(expenseId)
  const target = rows.find((r) => r.id === voucherId)
  if (!target) return
  await writeManifest(
    expenseId,
    rows.filter((r) => r.id !== voucherId),
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
