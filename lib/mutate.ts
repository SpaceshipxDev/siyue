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

export type MutateResult<T = undefined> =
  | (T extends undefined ? { ok: true } : { ok: true; data: T })

export async function mutate<T = undefined>(
  body: Record<string, unknown> & { kind: string },
): Promise<MutateResult<T>> {
  const r = await fetch('/api/mutate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  // The dispatcher always replies JSON; only the network layer (or GFW) can
  // give us a non-2xx with no body. Surface either as a thrown Error so call
  // sites can keep their existing try/catch + optimistic-state revert path.
  let parsed: unknown
  try {
    parsed = await r.json()
  } catch {
    throw new Error(`HTTP ${r.status}`)
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('ok' in parsed)
  ) {
    throw new Error(`HTTP ${r.status}`)
  }
  const data = parsed as { ok: boolean; error?: string; data?: unknown }
  if (!data.ok) {
    throw new Error(data.error ?? `HTTP ${r.status}`)
  }
  return data as MutateResult<T>
}
