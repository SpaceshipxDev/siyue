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

  // 流式转发, 不 arrayBuffer() —— 这条路原来只走缩略图 (几十 KB), 现在也走
  // 零件图纸和三维模型 (几十 MB)。把整份读进内存再吐出去, 意味着一个人点一
  // 下下载, 全厂跑的那一个 Node 进程就得先扛住那几十兆; 流式转发则是边收边
  // 发, 内存里始终只有一小段。
  return new Response(data.stream(), {
    status: 200,
    headers: {
      'Content-Type': data.type || 'application/octet-stream',
      'Content-Length': String(data.size),
      // Callers append ?v=<ts> on swap, so each stable URL really is immutable.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}
