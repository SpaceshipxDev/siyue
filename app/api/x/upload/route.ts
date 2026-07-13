import { NextRequest } from 'next/server'
import { currentUser } from '@/lib/auth'
import { supabase, STORAGE_BUCKET } from '@/lib/supabase'
import { proxiedKeyUrl } from '@/lib/storage-url'
import { ALLOWED_IMAGE_MIMES, extForImage, MAX_IMAGE_BYTES } from '@/lib/component-image'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// /x image drop. Client downscales to jpeg before sending (see _sheet.tsx),
// so the 8MB cap is a backstop, not the normal path. Keys live under x/ in
// the shared uploads bucket and are served through the /api/img proxy like
// every other image in the app (China-latency reasons).

export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const form = await request.formData()
  const file = form.get('file')
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: 'no file' }, { status: 400 })
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return Response.json({ ok: false, error: 'file too large' }, { status: 413 })
  }
  if (!ALLOWED_IMAGE_MIMES.has(file.type)) {
    return Response.json({ ok: false, error: 'unsupported image type' }, { status: 415 })
  }
  const ext = extForImage(file.type, file.name)
  const key = `x/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, Buffer.from(await file.arrayBuffer()), {
      contentType: file.type,
      upsert: false,
    })
  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 })
  }
  return Response.json({ ok: true, url: proxiedKeyUrl(key) })
}
