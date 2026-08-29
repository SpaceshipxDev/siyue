import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl, storageKeyFromUrl } from './storage-url'
import type { ProcurementPhoto } from './data'

/*
 * 请购图片 — what the requester saw when they decided to buy it: a photo of
 * the broken tool, a screenshot of the 淘宝 listing, a drawing of the odd
 * shape a plate has to be cut to. Words in 备注 run out fast; a picture is
 * what makes the approver able to approve without walking over to ask.
 *
 * Deliberately TABLE-FREE — the same choice as 合同 (lib/contract-file.ts) and
 * 凭证 (lib/voucher-file.ts), so there is NO migration to apply by hand and
 * nothing to break on a stale DB. Each 采购 row keeps:
 *   procurement/<id>/photos/<uuid>.<ext>     the blob
 *   procurement/<id>/photos/manifest.json    [{id,url,filename,...}, …]
 * The manifest carries what storage can't (original filename, uploader), so
 * the panel renders its picture strip straight from the bucket.
 *
 * Read on demand, one row at a time (see /api/procurement-photos): the 采购
 * board loads every open purchase at once and a manifest read per row would
 * be hundreds of storage round-trips for pictures nobody has opened yet.
 */

// Phone shots and screenshots. heic covers iPhone photos that aren't
// transcoded before upload; pdf is here because a supplier quote often is one.
const ALLOWED_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'heic', 'pdf'] as const
type PhotoExt = (typeof ALLOWED_EXTS)[number]

function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export function isAllowedProcurementPhotoName(fileName: string): boolean {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  return !!m && (ALLOWED_EXTS as readonly string[]).includes(m[1])
}

function extFor(fileName: string, contentType: string): PhotoExt {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  const fromName = m ? m[1] : ''
  if ((ALLOWED_EXTS as readonly string[]).includes(fromName)) {
    return fromName as PhotoExt
  }
  if (contentType === 'application/pdf') return 'pdf'
  if (contentType === 'image/png') return 'png'
  if (contentType === 'image/webp') return 'webp'
  if (contentType === 'image/heic') return 'heic'
  return 'jpg'
}

function manifestKey(procurementId: string): string {
  return `procurement/${safeId(procurementId)}/photos/manifest.json`
}

async function readManifest(
  procurementId: string,
): Promise<ProcurementPhoto[]> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(manifestKey(procurementId))
  if (error || !data) return [] // no photos yet (or first ever)
  try {
    const arr = JSON.parse(await data.text())
    return Array.isArray(arr) ? (arr as ProcurementPhoto[]) : []
  } catch {
    return []
  }
}

async function writeManifest(
  procurementId: string,
  rows: ProcurementPhoto[],
): Promise<void> {
  const body = Buffer.from(JSON.stringify(rows), 'utf8')
  const upR = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(manifestKey(procurementId), body, {
      contentType: 'application/json',
      upsert: true,
    })
  if (upR.error) throw upR.error
}

// Every picture on one 采购, oldest first — the order they were added is the
// order the story happened in. Never throws on a missing manifest (degrades
// to an empty list) so the panel always renders.
export async function getProcurementPhotos(
  procurementId: string,
): Promise<ProcurementPhoto[]> {
  const rows = await readManifest(procurementId)
  return rows
    .slice()
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
}

// Upload a photo blob + record it in the manifest. Returns the new row.
export async function addProcurementPhoto(input: {
  procurementId: string
  buf: ArrayBuffer
  fileName: string
  contentType: string
  uploadedBy?: string
  nowIso: string
}): Promise<ProcurementPhoto> {
  const { procurementId } = input
  const ext = extFor(input.fileName, input.contentType)
  const id = crypto.randomUUID()
  const key = `procurement/${safeId(procurementId)}/photos/${id}.${ext}`
  const upR = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, Buffer.from(input.buf), {
      contentType: input.contentType || 'application/octet-stream',
      upsert: false,
    })
  if (upR.error) throw upR.error

  const row: ProcurementPhoto = {
    id,
    url: proxiedKeyUrl(key),
    filename: input.fileName,
    filesize: input.buf.byteLength,
    contentType: input.contentType || undefined,
    uploadedBy: input.uploadedBy,
    createdAt: input.nowIso,
  }
  const rows = await readManifest(procurementId)
  rows.push(row)
  await writeManifest(procurementId, rows)
  return row
}

// Remove a photo: drop it from the manifest, then best-effort delete the
// blob. The manifest is the source of truth; an orphaned blob is harmless.
export async function deleteProcurementPhoto(
  procurementId: string,
  photoId: string,
): Promise<void> {
  const rows = await readManifest(procurementId)
  const target = rows.find((r) => r.id === photoId)
  if (!target) return
  await writeManifest(
    procurementId,
    rows.filter((r) => r.id !== photoId),
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
