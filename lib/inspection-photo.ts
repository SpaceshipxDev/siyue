import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl } from './storage-url'
import { extForImage, safeId } from './component-image'

/*
 * Upload helper for 检验照片 (inspection photos). Used by
 * /api/upload-inspection-photo; rows live in part_photos (migration 0048).
 *
 * Storage layout in the `uploads` bucket:
 *   <jobId>/<componentId>/insp/<uuid>.<ext>
 *
 * The `insp/` subfolder keeps these strictly apart from the part reference
 * image at <jobId>/<componentId>.<ext> — that one prints on 外协单 / 出货单
 * and must never be clobbered by defect shots. Many photos per part, each
 * under its own uuid; deletion removes the single object.
 */

export type UploadInspectionPhotoInput = {
  jobId: string
  componentId: string
  bytes: Uint8Array | Buffer
  mime: string
  /** Used only to derive an extension when mime is unrecognized. */
  fallbackName?: string
}

export async function uploadInspectionPhoto(
  input: UploadInspectionPhotoInput,
): Promise<string> {
  const ext = extForImage(input.mime, input.fallbackName)
  const key = `${safeId(input.jobId)}/${safeId(input.componentId)}/insp/${crypto.randomUUID()}.${ext}`
  const body = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes)
  const upR = await supabase.storage.from(STORAGE_BUCKET).upload(key, body, {
    contentType: input.mime,
    upsert: false,
  })
  if (upR.error) throw upR.error
  // Same China-latency posture as component images: serve via /api/img so
  // the browser never talks to *.supabase.co directly.
  return proxiedKeyUrl(key)
}

// Best-effort storage removal for a stored photo url (either the proxied
// /api/img/<key>?v=… form or a legacy full Supabase public URL). Row deletion
// is the source of truth; a failed object removal just leaves an orphan blob.
export async function removeInspectionPhotoObject(url: string): Promise<void> {
  const key = storageKeyFromUrl(url)
  if (!key) return
  try {
    await supabase.storage.from(STORAGE_BUCKET).remove([key])
  } catch {
    // Orphan blob — harmless, skip.
  }
}

function storageKeyFromUrl(url: string): string | null {
  let path: string | null = null
  if (url.startsWith('/api/img/')) {
    path = url.slice('/api/img/'.length)
  } else {
    const m = /\/storage\/v1\/object\/public\/uploads\/(.+)$/.exec(url)
    if (m) path = m[1]
  }
  if (!path) return null
  const noQuery = path.split('?')[0]
  try {
    return noQuery.split('/').map(decodeURIComponent).join('/')
  } catch {
    return noQuery
  }
}
