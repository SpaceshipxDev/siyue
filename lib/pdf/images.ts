import 'server-only'

// Pre-fetch every component image in parallel before handing the data to
// react-pdf. Three reasons we don't let <Image src=httpsUrl> do it itself:
//   1. Bounded latency — one slow Supabase Storage request can stall the
//      whole PDF render. Here we cap each request and skip on timeout.
//   2. Deterministic output — a 200 OK with HTML (login page, error page)
//      would otherwise crash react-pdf. We sniff the Content-Type and drop
//      anything non-image.
//   3. One fetch per URL — if the same image appears on multiple rows we
//      reuse the buffer instead of hitting the network repeatedly.

const IMAGE_TIMEOUT_MS = 4_000
const ACCEPTED_PREFIXES = ['image/']

export type ImageSource = { data: Buffer; format: 'png' | 'jpg' }

export async function fetchImages(
  urls: (string | undefined)[],
): Promise<Map<string, ImageSource>> {
  const out = new Map<string, ImageSource>()
  const unique = Array.from(new Set(urls.filter((u): u is string => Boolean(u))))
  await Promise.all(
    unique.map(async (url) => {
      const img = await fetchOne(url)
      if (img) out.set(url, img)
    }),
  )
  return out
}

async function fetchOne(url: string): Promise<ImageSource | undefined> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
    if (!res.ok) return undefined
    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    if (!ACCEPTED_PREFIXES.some((p) => ct.startsWith(p))) return undefined
    const buf = Buffer.from(await res.arrayBuffer())
    const format: 'png' | 'jpg' =
      ct.includes('png') || sniffPng(buf) ? 'png' : 'jpg'
    return { data: buf, format }
  } catch {
    return undefined
  } finally {
    clearTimeout(t)
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
