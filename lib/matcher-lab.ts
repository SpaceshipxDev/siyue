import 'server-only'

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type LabVariant = {
  id: string
  label: string
  asset: string
  thumbnail: string
  source: string
}

export type LabDocument = {
  id: string
  label: string
  family: string
  asset: string
  thumbnail: string
  source: string
  variants: LabVariant[]
}

export type LabManifest = {
  generatedAt: string
  root: string
  referenceCount: number
  variantCount: number
  chosenCount: number
  documents: LabDocument[]
}

export type MatcherResult = {
  decision: 'match' | 'ambiguous' | 'no_match'
  best?: {
    page_id: string
    component_id: string
    score: number
    cosine: number
    inliers: number
    inlier_ratio: number
    coverage: number
  } | null
  candidates?: Array<{
    page_id: string
    component_id: string
    score: number
    cosine: number
    inliers: number
  }>
  latency_ms: number
  via?: 'local' | 'gemini_embedding_2'
  stages?: Record<string, number>
}

function labRoot(): string {
  return path.resolve(
    process.env.MATCHER_LAB_DATA ||
      path.join(/*turbopackIgnore: true*/ process.cwd(), 'services/matcher/testdata/matcher-lab-100'),
  )
}

export async function readLabManifest(): Promise<LabManifest> {
  const value = JSON.parse(await readFile(path.join(labRoot(), 'manifest.json'), 'utf8')) as LabManifest
  return { ...value, root: labRoot() }
}

export function resolveLabAsset(relative: string): string {
  const root = labRoot()
  const resolved = path.resolve(root, relative)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('invalid lab asset path')
  }
  return resolved
}

function matcherUrl(): string {
  return process.env.MATCHER_URL || 'http://127.0.0.1:8788'
}

function matcherToken(): string {
  return process.env.MATCHER_TOKEN || 'dev'
}

async function matcherFetch(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${matcherUrl()}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${matcherToken()}`,
      ...init?.headers,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(60_000),
  })
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff'
  return 'image/jpeg'
}

export async function matcherStats(): Promise<Record<string, unknown> | null> {
  try {
    const response = await matcherFetch('/stats')
    return response.ok ? ((await response.json()) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function registerLabDocument(document: LabDocument): Promise<void> {
  const filePath = resolveLabAsset(document.asset)
  const bytes = await readFile(filePath)
  const form = new FormData()
  form.set('page_id', `matcher-lab:${document.id}`)
  form.set('component_id', document.id)
  form.set('kind', 'other')
  form.set('image', new Blob([bytes], { type: contentType(filePath) }), path.basename(filePath))
  const response = await matcherFetch('/register', { method: 'POST', body: form })
  if (!response.ok) {
    throw new Error(`register ${document.id}: ${response.status} ${await response.text()}`)
  }
}

export async function registerAllLabDocuments(
  onProgress?: (completed: number) => void,
): Promise<{ registered: number; elapsedMs: number }> {
  const manifest = await readLabManifest()
  const started = performance.now()
  let completed = 0
  for (const document of manifest.documents) {
    await registerLabDocument(document)
    completed += 1
    onProgress?.(completed)
  }
  return { registered: completed, elapsedMs: Math.round(performance.now() - started) }
}

export async function matchLabAsset(asset: string): Promise<MatcherResult> {
  const filePath = resolveLabAsset(asset)
  const bytes = await readFile(filePath)
  return matchImageBytes(bytes, path.basename(filePath), contentType(filePath))
}

export async function matchImageBytes(
  bytes: Uint8Array,
  filename = 'upload.jpg',
  type = 'image/jpeg',
): Promise<MatcherResult> {
  const form = new FormData()
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  form.set('image', new Blob([body], { type }), filename)
  const response = await matcherFetch('/match', { method: 'POST', body: form })
  if (!response.ok) {
    throw new Error(`matcher returned ${response.status}: ${await response.text()}`)
  }
  return (await response.json()) as MatcherResult
}

export async function runLabSuite(documentIds?: string[]): Promise<{
  total: number
  correct: number
  wrong: number
  noMatch: number
  accuracyPct: number
  p50Ms: number
  p95Ms: number
  cases: Array<{
    documentId: string
    variantId: string
    expected: string
    predicted: string | null
    correct: boolean
    result: MatcherResult
  }>
}> {
  const manifest = await readLabManifest()
  const allowed = documentIds?.length ? new Set(documentIds) : null
  const cases = []
  for (const document of manifest.documents) {
    if (allowed && !allowed.has(document.id)) continue
    for (const variant of document.variants) {
      const result = await matchLabAsset(variant.asset)
      const predicted = result.best?.component_id || null
      cases.push({
        documentId: document.id,
        variantId: variant.id,
        expected: document.id,
        predicted,
        correct: result.decision === 'match' && predicted === document.id,
        result,
      })
    }
  }
  const latencies = cases.map((item) => item.result.latency_ms).sort((a, b) => a - b)
  const correct = cases.filter((item) => item.correct).length
  const noMatch = cases.filter((item) => item.result.decision === 'no_match').length
  const percentile = (fraction: number) =>
    latencies.length ? latencies[Math.max(0, Math.ceil(latencies.length * fraction) - 1)] : 0
  return {
    total: cases.length,
    correct,
    wrong: cases.length - correct - noMatch,
    noMatch,
    accuracyPct: cases.length ? Math.round((correct / cases.length) * 10_000) / 100 : 0,
    p50Ms: Math.round(percentile(0.5)),
    p95Ms: Math.round(percentile(0.95)),
    cases,
  }
}

export async function revealLabFolder(): Promise<string> {
  const root = labRoot()
  if (process.platform !== 'darwin') {
    throw new Error(`Finder reveal is only available on macOS. Folder: ${root}`)
  }
  await execFileAsync('open', ['-R', path.join(root, 'manifest.json')])
  return root
}
