import 'server-only'
import type { NextRequest } from 'next/server'
import { supabase, STORAGE_BUCKET } from '@/lib/supabase'
import { getVendorByPortalToken } from '@/lib/db'

// Token-gated mirror of /api/img for the vendor portal. The portal has no
// session cookie, so its <img> tags can't pass the session-gated proxy; this
// route authorizes by the same unguessable vendor token as the page itself,
// then streams the storage object. Same immutable caching as /api/img —
// callers carry the ?v= cache-buster in the stored URL.

export const runtime = 'nodejs'

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string; path: string[] }> },
) {
  const { token, path } = await ctx.params
  const vendor = await getVendorByPortalToken(token)
  if (!vendor) return new Response('not found', { status: 404 })

  if (path.some((seg) => seg === '..' || seg.includes('/') || seg.includes('\0'))) {
    return new Response('bad path', { status: 400 })
  }
  const key = path.map(decodeURIComponent).join('/')

  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(key)
  if (error || !data) {
    return new Response('not found', { status: 404 })
  }

  const buf = await data.arrayBuffer()
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': data.type || 'application/octet-stream',
      'Content-Length': String(buf.byteLength),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}
