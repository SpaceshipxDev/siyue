import 'server-only'
import type { NextRequest } from 'next/server'
import { supabase, STORAGE_BUCKET } from '@/lib/supabase'

// Reverse-proxy for Supabase Storage objects. Lets Chinese clients fetch
// from our own origin (Vercel hnd1) instead of opening a transpacific TLS
// connection per <img> to AWS-hosted *.supabase.co. Upstream stays cached at
// Vercel's edge thanks to Cache-Control below; the browser then re-uses the
// per-URL cache because callers append ?v=<ts> on every replace, so a stable
// key really is immutable.

export const runtime = 'nodejs'

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params
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
      // Callers append ?v=<ts> on swap, so each stable URL really is immutable.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}
