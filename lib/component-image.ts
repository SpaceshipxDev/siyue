import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl } from './storage-url'

/*
 * Upload helpers for per-component images. Used by:
 *   - /api/upload-image   (商务 manually swaps a photo from the import editor)
 *   - /api/ingest         (auto-import of images embedded in the source xlsx)
 *
 * Storage layout in the `uploads` bucket:
 *   <jobId>/<componentId>.<ext>   ← part image
 *   <jobId>/__source.<ext>        ← original workbook (see lib/source-file.ts)
 *
 * `componentId` here is the user-facing short id (`p1`, `p2`, …), not the
 * `jobId:p1` form used internally — that's what the column on the parts row
 * resolves to via findPartIdInSnap.
 */

export const ALLOWED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export function extForImage(mime: string, fallback?: string): string {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/gif') return 'gif'
  if (mime === 'image/bmp') return 'bmp'
  if (mime === 'image/tiff') return 'tif'
  if (fallback) {
    const m = fallback.match(/\.([a-z0-9]+)$/i)
    if (m) return m[1].toLowerCase()
  }
  return 'bin'
}

// Drop any prior `<componentId>.*` object whose extension differs from the
// one we're about to write — same component swapping format would otherwise
// leave the old key behind and fight the public-URL cache buster.
async function removeStaleVariants(jobId: string, componentId: string, keepExt: string) {
  const { data } = await supabase.storage.from(STORAGE_BUCKET).list(safeId(jobId))
  const prefix = `${safeId(componentId)}.`
  const stale = (data ?? [])
    .filter((o) => o.name.startsWith(prefix) && o.name !== `${safeId(componentId)}.${keepExt}`)
    .map((o) => `${safeId(jobId)}/${o.name}`)
  if (stale.length > 0) {
    await supabase.storage.from(STORAGE_BUCKET).remove(stale)
  }
}

export type UploadComponentImageInput = {
  jobId: string
  componentId: string
  bytes: Uint8Array | Buffer
  mime: string
  /** Used only to derive an extension when mime is unrecognized. */
  fallbackName?: string
  /** Skip the list+remove pass for stale variants. Set on fresh imports
   *  where we know nothing is under this jobId/componentId yet — saves one
   *  Supabase round trip per upload, which matters when extracting a workbook
   *  with ~100 embedded images. */
  skipStaleCheck?: boolean
}

export async function uploadComponentImage(input: UploadComponentImageInput): Promise<string> {
  const ext = extForImage(input.mime, input.fallbackName)
  const key = `${safeId(input.jobId)}/${safeId(input.componentId)}.${ext}`
  if (!input.skipStaleCheck) {
    await removeStaleVariants(input.jobId, input.componentId, ext)
  }
  const body = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes)
  const upR = await supabase.storage.from(STORAGE_BUCKET).upload(key, body, {
    contentType: input.mime,
    upsert: true,
  })
  if (upR.error) throw upR.error
  // Route through /api/img so browsers fetch from our own origin instead of
  // *.supabase.co (transpacific TLS per request from China). Cache-bust on
  // swap so <img> picks up the new bytes.
  return proxiedKeyUrl(key)
}
