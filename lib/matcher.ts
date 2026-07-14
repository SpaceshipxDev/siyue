import 'server-only'
import {
  downloadPacketPage,
  findActivePartsByIdentity,
  listUnregisteredPages,
  markPageRegistered,
  partFacts,
  tokenForPartId,
  type PartFacts,
} from './packets'
import { readPhotoIdentity } from './packet-extract'

// Client for the Python matcher service (services/matcher — SSCD shortlist
// + LightGlue/homography verification). The web app never blocks on it being
// perfect: registration failures are retried by sweepRegistrations, and a
// down/unsure matcher falls back to one Gemini OCR read of the photographed
// page's identity fields (货号/图纸号) + a DB lookup.

const MATCHER_URL = () => process.env.MATCHER_URL || 'http://127.0.0.1:8788'
const MATCHER_TOKEN = () => process.env.MATCHER_TOKEN || 'dev'

async function matcherFetch(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 15000, ...rest } = init
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(`${MATCHER_URL()}${path}`, {
      ...rest,
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${MATCHER_TOKEN()}`,
        ...(rest.headers ?? {}),
      },
    })
  } finally {
    clearTimeout(t)
  }
}

export async function registerPage(page: {
  pageId: string
  partId: string
  kind?: string
  bytes: Uint8Array
  contentType: string
}): Promise<boolean> {
  try {
    const fd = new FormData()
    fd.set('page_id', page.pageId)
    fd.set('component_id', page.partId)
    fd.set('kind', page.kind ?? 'other')
    fd.set(
      'image',
      new Blob([page.bytes as BlobPart], { type: page.contentType }),
      'page.jpg',
    )
    const res = await matcherFetch('/register', {
      method: 'POST',
      body: fd,
      timeoutMs: 30000,
    })
    return res.ok
  } catch {
    return false
  }
}

// Re-push any pages the matcher hasn't confirmed. Called opportunistically
// after ingestion and from the match route — cheap no-op when nothing is
// pending, self-healing when the matcher was down during ingestion.
export async function sweepRegistrations(max = 10): Promise<void> {
  let pending: Awaited<ReturnType<typeof listUnregisteredPages>>
  try {
    pending = await listUnregisteredPages(max)
  } catch {
    return
  }
  for (const page of pending) {
    const blob = await downloadPacketPage(page.storageKey)
    if (!blob) continue
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const ok = await registerPage({
      pageId: page.id,
      partId: page.partId,
      kind: page.kind,
      bytes,
      contentType: blob.type || 'image/jpeg',
    })
    if (ok) await markPageRegistered(page.id, page.source)
  }
}

type MatcherCandidate = {
  page_id: string
  component_id: string
  score: number
  cosine?: number
  inliers?: number
  kind?: string
}

type MatcherResponse = {
  decision: 'match' | 'ambiguous' | 'no_match'
  best?: MatcherCandidate
  candidates?: MatcherCandidate[]
  latency_ms?: number
  stages?: { embed_ms?: number; shortlist_ms?: number; verify_ms?: number }
}

export type PhotoMatchCandidate = PartFacts & { token?: string }

export type PhotoMatchResult =
  | { decision: 'match'; token: string; part: PhotoMatchCandidate; via: 'matcher' | 'ocr'; latencyMs: number }
  | { decision: 'ambiguous'; candidates: PhotoMatchCandidate[]; via: 'matcher' | 'ocr'; latencyMs: number }
  | { decision: 'no_match'; via: 'matcher' | 'ocr' | 'none'; latencyMs: number }

async function withTokens(facts: PartFacts[]): Promise<PhotoMatchCandidate[]> {
  return Promise.all(
    facts.map(async (f) => ({ ...f, token: await tokenForPartId(f.partId) })),
  )
}

async function ocrFallback(
  pendingRead: Promise<Awaited<ReturnType<typeof readPhotoIdentity>> | null>,
  started: number,
): Promise<PhotoMatchResult> {
  try {
    const read = await pendingRead
    if (!read) {
      return { decision: 'no_match', via: 'none', latencyMs: Date.now() - started }
    }
    if (read.kind !== 'drawing' && read.kind !== 'program') {
      return { decision: 'no_match', via: 'ocr', latencyMs: Date.now() - started }
    }
    if (!read.partNo && !read.drawingNo) {
      return { decision: 'no_match', via: 'ocr', latencyMs: Date.now() - started }
    }
    const parts = await findActivePartsByIdentity(read)
    if (parts.length === 1) {
      const [cand] = await withTokens(parts)
      if (cand.token) {
        return {
          decision: 'match',
          token: cand.token,
          part: cand,
          via: 'ocr',
          latencyMs: Date.now() - started,
        }
      }
    }
    if (parts.length > 1) {
      return {
        decision: 'ambiguous',
        candidates: (await withTokens(parts)).slice(0, 4),
        via: 'ocr',
        latencyMs: Date.now() - started,
      }
    }
    return { decision: 'no_match', via: 'ocr', latencyMs: Date.now() - started }
  } catch {
    return { decision: 'no_match', via: 'none', latencyMs: Date.now() - started }
  }
}

function logMatch(result: PhotoMatchResult, matcher: MatcherResponse | undefined): PhotoMatchResult {
  console.log(
    '[match-photo]',
    JSON.stringify({
      decision: result.decision,
      via: result.via,
      latencyMs: result.latencyMs,
      matcherMs: matcher?.latency_ms,
      stages: matcher?.stages,
      bestCosine: matcher?.best?.cosine,
      bestInliers: matcher?.best?.inliers,
    }),
  )
  return result
}

// The floor's one question: "which part is this sheet of paper?"
// Matcher first (fast, geometric proof); OCR identity read as the fallback.
export async function matchPhoto(
  bytes: Uint8Array,
  contentType: string,
): Promise<PhotoMatchResult> {
  const started = Date.now()
  // Fire the Gemini identity read alongside the matcher rather than after it:
  // a geometric match discards the read (one cheap flash-lite call), but a
  // miss now pays max(matcher, ocr) instead of matcher + ocr.
  const pendingRead = readPhotoIdentity({
    mimeType: contentType,
    data: Buffer.from(bytes).toString('base64'),
  }).catch(() => null)
  let matcher: MatcherResponse | undefined
  try {
    const fd = new FormData()
    fd.set('image', new Blob([bytes as BlobPart], { type: contentType }), 'query.jpg')
    const res = await matcherFetch('/match', { method: 'POST', body: fd, timeoutMs: 12000 })
    if (res.ok) matcher = (await res.json()) as MatcherResponse
  } catch {
    matcher = undefined
  }

  // Program sheets (程序单) share one printed template — geometric consensus
  // lands on the form grid, not the part. Observed live: 100 inliers against
  // a component whose 程序单 was never enrolled. For program-kind evidence
  // the printed header (零件编号/模具编号) IS the identity; the already-
  // in-flight OCR read decides, and geometry is at most a tiebreaker.
  if (matcher && matcher.decision !== 'no_match') {
    const top = matcher.best ?? matcher.candidates?.[0]
    if (top?.kind === 'program') {
      const viaOcr = await ocrFallback(pendingRead, started)
      return logMatch(viaOcr, matcher)
    }
  }

  if (matcher?.decision === 'match' && matcher.best) {
    const facts = await partFacts([matcher.best.component_id])
    if (facts.length === 1) {
      const [cand] = await withTokens(facts)
      if (cand.token) {
        return logMatch(
          {
            decision: 'match',
            token: cand.token,
            part: cand,
            via: 'matcher',
            latencyMs: Date.now() - started,
          },
          matcher,
        )
      }
    }
  }

  if (matcher?.decision === 'ambiguous' && matcher.candidates?.length) {
    const ids = [...new Set(matcher.candidates.map((c) => c.component_id))].slice(0, 4)
    const facts = await partFacts(ids)
    if (facts.length > 0) {
      return logMatch(
        {
          decision: 'ambiguous',
          candidates: await withTokens(facts),
          via: 'matcher',
          latencyMs: Date.now() - started,
        },
        matcher,
      )
    }
  }

  // no_match / matcher down / dangling component ids → OCR identity read.
  return logMatch(await ocrFallback(pendingRead, started), matcher)
}
