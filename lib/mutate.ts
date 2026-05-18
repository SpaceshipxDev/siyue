// Client-side helper for the JSON mutate dispatcher (app/api/mutate). Every
// inline-edit / stage-action / outsource / shipping write goes through this —
// 30-byte JSON request, 30-byte JSON response. Replaces the server-action
// path that used to inline a fresh RSC payload of the current page in the
// response (the wire shape that the GFW kept truncating for mainland users
// hitting the HK VM, surfacing as the "this page couldn't load" overlay).
//
// Usage from a client component:
//   await mutate({ kind: 'updateJob', jobId, patch: { jobNo: 'A-123' } })
//   const { id } = await mutate({ kind: 'appendComponent', jobId })
//
// The `data` field is only present for kinds that return a value (id,
// vendor, customer, conflict result, etc.). All others resolve to plain
// `{ ok: true }` and the caller can ignore the return.
//
// Resilience against mainland↔HK link flakiness:
//   • Every call attaches a UUID `requestId`. The server dedupes by it
//     (in-memory LRU, 60s TTL) so a retry after a response was killed
//     in-flight returns the original outcome instead of double-applying the
//     write. Critical for non-idempotent kinds (appendComponent,
//     createReturn, createOutsourceBlock).
//   • Transient network failures (fetch threw, response body truncated,
//     non-JSON 5xx) are retried up to 3 times with backoff [250, 750, 2000]
//     ms before giving up. The same requestId is reused across attempts.
//   • Structured server errors ({ ok: false, error }) are NOT retried — the
//     server told us why and another attempt would fail the same way.

export type MutateResult<T = undefined> =
  | (T extends undefined ? { ok: true } : { ok: true; data: T })

const RETRY_DELAYS_MS = [250, 750, 2000] as const

// Transient network failures inside fetch() / r.json() — body never landed
// or got truncated. Server-side rejections are reported as a normal thrown
// Error with the server's message and bypass the retry loop.
class TransientError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function newRequestId(): string {
  // Browsers post-2022 + Node 16.7+ ship crypto.randomUUID. Fall back to a
  // millisecond+random combo if it's somehow absent — collision risk in the
  // server's 60s dedup window is still ~0 for any realistic load.
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID) return g.crypto.randomUUID()
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

async function attempt<T>(
  payload: Record<string, unknown>,
): Promise<MutateResult<T>> {
  let r: Response
  try {
    r = await fetch('/api/mutate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    })
  } catch (e) {
    // TypeError ("Failed to fetch") — connection reset, DNS failure, GFW
    // RST mid-handshake. Server NEVER received it; safe to retry.
    throw new TransientError(e instanceof Error ? e.message : 'fetch failed')
  }

  let parsed: unknown
  try {
    parsed = await r.json()
  } catch {
    // Status arrived but body unreadable — typically a connection reset
    // after response headers but before the body fully streamed. Server
    // may have applied the write; the requestId dedup makes the retry safe.
    throw new TransientError(`HTTP ${r.status} · 响应中断`)
  }

  if (typeof parsed !== 'object' || parsed === null || !('ok' in parsed)) {
    // Status arrived but body is malformed (proxy / captive portal / GFW
    // injection). Retry.
    throw new TransientError(`HTTP ${r.status}`)
  }

  const data = parsed as { ok: boolean; error?: string; data?: unknown }
  if (!data.ok) {
    // Server-side rejection: validation, auth, business rule. Retrying
    // won't change the answer — propagate immediately.
    throw new Error(data.error ?? `HTTP ${r.status}`)
  }
  return data as MutateResult<T>
}

export async function mutate<T = undefined>(
  body: Record<string, unknown> & { kind: string },
): Promise<MutateResult<T>> {
  const payload = { ...body, requestId: newRequestId() }
  let lastTransient: TransientError | null = null
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    if (i > 0) await sleep(RETRY_DELAYS_MS[i - 1])
    try {
      return await attempt<T>(payload)
    } catch (e) {
      if (e instanceof TransientError) {
        lastTransient = e
        continue
      }
      throw e
    }
  }
  throw new Error(
    lastTransient ? `网络中断 · ${lastTransient.message}` : '网络中断',
  )
}
