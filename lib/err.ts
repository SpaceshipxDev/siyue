// Turn any caught value into a readable string.
//
// The trap this exists to avoid: `String(err)` on a non-Error object yields
// "[object Object]". The extraction pipeline (lib/db.ts) throws raw Supabase
// `PostgrestError`s — plain objects shaped `{ message, details, hint, code }`,
// NOT `instanceof Error` — so `err instanceof Error ? err.message : String(err)`
// silently collapsed real database failures into "[object Object]" in
// parse_error, which the import page then shows under "AI 未能提取这份文件".
//
// Order of precedence:
//   1. real Error            → .message
//   2. string                → itself
//   3. object with .message  → .message (+ Postgres .details/.hint/.code if present)
//   4. anything else         → JSON, never "[object Object]"
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>
    if (typeof o.message === 'string' && o.message.length > 0) {
      // Supabase/Postgres errors carry useful context beyond `message`.
      const extra = [o.details, o.hint, o.code]
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .join(' · ')
      return extra ? `${o.message} (${extra})` : o.message
    }
    try {
      const json = JSON.stringify(err)
      if (json && json !== '{}') return json
    } catch {
      // circular or non-serializable — fall through
    }
  }
  return String(err)
}
