'use server'

import { supabase } from '@/lib/supabase'

export type JoinResult =
  | { ok: true; alreadyJoined: boolean }
  | { ok: false; error: string }

export type JoinInput = {
  email: string
  tiktok?: string
  instagram?: string
  brands?: string
}

// Loose-but-sane email check. We're gating a waitlist, not authenticating —
// the goal is to reject obvious typos, not to RFC-validate.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Strip the noise people paste into a "handle" field: a leading @, a full
// profile URL, query strings, surrounding whitespace. Leaves a bare handle.
function normalizeHandle(raw: string | undefined, host: RegExp): string | null {
  if (!raw) return null
  let v = raw.trim()
  if (!v) return null
  // Pull the handle out of a pasted profile URL (tiktok.com/@x, instagram.com/x).
  const urlMatch = v.match(host)
  if (urlMatch) v = urlMatch[1]
  v = v.replace(/^@+/, '').replace(/\/+$/, '').trim()
  if (!v) return null
  return v.slice(0, 80)
}

export async function joinWaitlist(input: JoinInput): Promise<JoinResult> {
  const email = (input.email ?? '').trim().toLowerCase()
  if (!email) return { ok: false, error: '请输入邮箱 / Enter your email' }
  if (email.length > 200 || !EMAIL_RE.test(email)) {
    return { ok: false, error: "That email doesn't look right." }
  }

  const tiktok = normalizeHandle(
    input.tiktok,
    /tiktok\.com\/@?([^/?#\s]+)/i,
  )
  const instagram = normalizeHandle(
    input.instagram,
    /instagram\.com\/([^/?#\s]+)/i,
  )
  const brands = (input.brands ?? '').trim().slice(0, 2000) || null

  const { error } = await supabase.from('afterlight_waitlist').insert({
    email,
    tiktok_handle: tiktok,
    instagram_handle: instagram,
    brands,
  })

  if (error) {
    // 23505 — unique violation on lower(email). They're already in. Treat as
    // a friendly success rather than surfacing a DB error to a happy signup.
    if (error.code === '23505') return { ok: true, alreadyJoined: true }

    // Table not created yet (PostgREST schema cache miss / undefined table).
    // Surface a clear, actionable message — this is the one out-of-band step.
    if (
      error.code === 'PGRST205' ||
      error.code === '42P01' ||
      /afterlight_waitlist/i.test(error.message ?? '')
    ) {
      console.error('[join] waitlist table missing — run migration 0024:', error)
      return {
        ok: false,
        error: 'Sign-ups aren’t live yet. Please try again shortly.',
      }
    }

    console.error('[join] insert failed:', error)
    return { ok: false, error: 'Something went wrong. Please try again.' }
  }

  return { ok: true, alreadyJoined: false }
}
