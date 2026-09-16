import 'server-only'
import { supabase, STORAGE_BUCKET } from '@/lib/supabase'

// Pre-fetch every component image in parallel before handing the data to
// react-pdf. Two reasons we don't let <Image src=httpsUrl> do it itself:
//   1. Bounded latency — one slow Storage request can stall the whole PDF
//      render. Here we cap each request and skip on timeout.
//   2. One fetch per URL — same image on multiple rows reuses the buffer.
//
// URL forms we accept (resolveStorageKey below):
//   • /api/img/<key>                  → newer code path
//   • https://<project>.supabase.co/storage/v1/object/public/<bucket>/<key>
//                                      → legacy public URLs
//   • https://<project>.supabase.co/storage/v1/object/<bucket>/<key>
//                                      → private-object URLs (rare here)
//
// In every case we go directly to the Supabase Storage admin client to
// download by key. Going through HTTP fetch was unreliable: proxied paths
// are relative and Node's fetch rejects them, and the public URL path
// silently 404'd for private buckets — both modes ended up "no image" in
// the printed PDF.

// 4 秒太紧: 一张单六张图一起发, 互相抢带宽, 慢的那几张就超时 —— 打出来的
// 纸上是几个破折号, 而客户核对的就是那几张图。放宽到 12 秒, 再限并发。
const IMAGE_TIMEOUT_MS = 12_000

// 一次最多抓四张 —— 图是几十上百 KB 的 PNG, 六张齐发只会让每一张都变慢, 慢
// 到超时。四张一批, 总时间反而更短, 而且不会有人"刚好排在第六个"就没图。
const IMAGE_CONCURRENCY = 4

export type ImageSource = { data: Buffer; format: 'png' | 'jpg' }

export async function fetchImages(
  urls: (string | undefined)[],
): Promise<Map<string, ImageSource>> {
  const out = new Map<string, ImageSource>()
  const unique = Array.from(new Set(urls.filter((u): u is string => Boolean(u))))
  for (let i = 0; i < unique.length; i += IMAGE_CONCURRENCY) {
    const batch = unique.slice(i, i + IMAGE_CONCURRENCY)
    await Promise.all(
      batch.map(async (url) => {
        // 超时/抖动再来一次 —— 纸上缺一张图, 客户当场就要问, 比多等一秒贵。
        const img = (await fetchOne(url)) ?? (await fetchOne(url))
        if (img) out.set(url, img)
      }),
    )
  }
  return out
}

function resolveStorageKey(url: string): string | undefined {
  if (url.startsWith('/api/img/')) {
    // strip leading slash + the api segment, then re-decode each part so
    // %20 / 中文 etc. land back as raw bytes for the storage client.
    return url
      .slice('/api/img/'.length)
      .split('?')[0] // drop ?v=<cachebuster>
      .split('/')
      .map(decodeURIComponent)
      .join('/')
  }
  const pubMatch = url.match(
    /^https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/(?:public\/)?[^/]+\/(.+)$/,
  )
  if (pubMatch) return decodeURIComponent(pubMatch[1])
  return undefined
}

async function fetchOne(url: string): Promise<ImageSource | undefined> {
  const key = resolveStorageKey(url)
  if (!key) return undefined
  try {
    // Race the download against a timeout so a wedged Storage request
    // can't hang the whole PDF render.
    const data = await Promise.race([
      supabase.storage.from(STORAGE_BUCKET).download(key),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('image fetch timeout')), IMAGE_TIMEOUT_MS),
      ),
    ])
    if (data.error || !data.data) return undefined
    const buf = Buffer.from(await data.data.arrayBuffer())
    const ct = (data.data.type ?? '').toLowerCase()
    const format: 'png' | 'jpg' =
      ct.includes('png') || sniffPng(buf) ? 'png' : 'jpg'
    return { data: buf, format }
  } catch {
    return undefined
  }
}

function sniffPng(buf: Buffer): boolean {
  return (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  )
}
