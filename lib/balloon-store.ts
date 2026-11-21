import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl, storageKeyFromUrl } from './storage-url'
import {
  BALLOON_KINDS,
  MAX_SAMPLES,
  isBalloon,
  type Balloon,
  type BalloonSheet,
  type BalloonSheetPatch,
} from './balloon'

/*
 * 气泡图的存放处 —— 跟质量其它几张表一个路子, 不用建表:
 *   quality/balloons/index.json        [{id, title, …, 气泡数, 结论}] 列表页读这一份
 *   quality/balloons/<id>.json         一整张 (图 + 气泡 + 实测值)
 *   quality/balloons/<id>.<ext>        图纸图片
 */

const DIR = 'quality/balloons'
const INDEX = `${DIR}/index.json`

export type BalloonSheetSummary = Pick<
  BalloonSheet,
  'id' | 'title' | 'drawingNo' | 'jobNo' | 'customer' | 'imageUrl' | 'inspectedAt' | 'createdBy' | 'createdAt' | 'updatedAt'
> & { count: number; verdict: string }

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

async function readJson(key: string): Promise<unknown> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(key)
  if (error || !data) return null
  try {
    return JSON.parse(await data.text())
  } catch {
    return null
  }
}

async function writeJson(key: string, v: unknown): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, Buffer.from(JSON.stringify(v), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

const s = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '')
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9-]/g, '')

function normalize(raw: unknown): BalloonSheet | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.imageUrl !== 'string') return null
  const samples = typeof o.samples === 'number' && o.samples >= 1 ? Math.min(MAX_SAMPLES, Math.floor(o.samples)) : 3
  return {
    id: o.id,
    title: s(o.title),
    drawingNo: s(o.drawingNo),
    jobNo: s(o.jobNo),
    customer: s(o.customer),
    material: s(o.material),
    imageUrl: o.imageUrl,
    samples,
    balloons: Array.isArray(o.balloons) ? o.balloons.filter(isBalloon) : [],
    inspector: s(o.inspector),
    inspectedAt: s(o.inspectedAt, 10),
    note: s(o.note, 1000),
    createdBy: s(o.createdBy),
    createdAt: s(o.createdAt, 40),
    updatedAt: s(o.updatedAt, 40),
  }
}

function summarize(x: BalloonSheet, verdict: string): BalloonSheetSummary {
  return {
    id: x.id,
    title: x.title,
    drawingNo: x.drawingNo,
    jobNo: x.jobNo,
    customer: x.customer,
    imageUrl: x.imageUrl,
    inspectedAt: x.inspectedAt,
    createdBy: x.createdBy,
    createdAt: x.createdAt,
    updatedAt: x.updatedAt,
    count: x.balloons.length,
    verdict,
  }
}

async function readIndex(): Promise<BalloonSheetSummary[]> {
  const raw = await readJson(INDEX)
  return Array.isArray(raw) ? (raw as BalloonSheetSummary[]).filter((r) => r && typeof r.id === 'string') : []
}

export async function getBalloonSheets(): Promise<BalloonSheetSummary[]> {
  return (await readIndex()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export async function getBalloonSheet(id: string): Promise<BalloonSheet | null> {
  return normalize(await readJson(`${DIR}/${safeId(id)}.json`))
}

/** 图纸图片的原始字节 —— 识图要用。 */
export async function getBalloonImage(sheet: BalloonSheet): Promise<{ base64: string; mimeType: string } | null> {
  const key = storageKeyFromUrl(sheet.imageUrl)
  if (!key) return null
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(key)
  if (error || !data) return null
  const buf = Buffer.from(await data.arrayBuffer())
  return { base64: buf.toString('base64'), mimeType: data.type || 'image/png' }
}

export async function createBalloonSheet(input: {
  body: Blob
  fileName: string
  contentType: string
  title: string
  by: string
  nowIso: string
}): Promise<BalloonSheet> {
  const id = crypto.randomUUID()
  const m = input.fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  const ext = m ? m[1] : 'png'
  const key = `${DIR}/${id}.${ext}`
  const up = await supabase.storage.from(STORAGE_BUCKET).upload(key, input.body, {
    contentType: input.contentType || 'image/png',
    upsert: false,
  })
  if (up.error) throw up.error
  const sheet: BalloonSheet = {
    id,
    title: input.title.trim() || input.fileName.replace(/\.[^.]+$/, ''),
    drawingNo: '',
    jobNo: '',
    customer: '',
    material: '',
    imageUrl: proxiedKeyUrl(key),
    samples: 3,
    balloons: [],
    inspector: '',
    inspectedAt: input.nowIso.slice(0, 10),
    note: '',
    createdBy: input.by,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  }
  await withLock(async () => {
    await writeJson(`${DIR}/${id}.json`, sheet)
    const idx = await readIndex()
    idx.push(summarize(sheet, ''))
    await writeJson(INDEX, idx)
  })
  return sheet
}

export async function updateBalloonSheet(
  id: string,
  patch: BalloonSheetPatch,
  verdictOf: (s: BalloonSheet) => string,
): Promise<BalloonSheet> {
  return withLock(async () => {
    const cur = await getBalloonSheet(id)
    if (!cur) throw new Error('这张气泡图不在了')
    const next: BalloonSheet = { ...cur, updatedAt: new Date().toISOString() }
    for (const k of ['title', 'drawingNo', 'jobNo', 'customer', 'material', 'inspector', 'inspectedAt', 'note'] as const) {
      const v = patch[k]
      if (typeof v === 'string') next[k] = v.slice(0, k === 'note' ? 1000 : 200)
    }
    if (typeof patch.samples === 'number' && patch.samples >= 1)
      next.samples = Math.min(MAX_SAMPLES, Math.floor(patch.samples))
    if (Array.isArray(patch.balloons)) {
      next.balloons = patch.balloons
        .filter(isBalloon)
        .slice(0, 300)
        .map((b: Balloon) => ({
          ...b,
          x: Math.min(1, Math.max(0, b.x)),
          y: Math.min(1, Math.max(0, b.y)),
          kind: BALLOON_KINDS.includes(b.kind) ? b.kind : '尺寸',
          measured: b.measured.slice(0, MAX_SAMPLES).map((m) => m.slice(0, 40)),
        }))
    }
    await writeJson(`${DIR}/${safeId(id)}.json`, next)
    const idx = await readIndex()
    await writeJson(
      INDEX,
      idx.map((r) => (r.id === id ? summarize(next, verdictOf(next)) : r)),
    )
    return next
  })
}

export async function deleteBalloonSheet(id: string): Promise<void> {
  await withLock(async () => {
    const cur = await getBalloonSheet(id)
    const keys = [`${DIR}/${safeId(id)}.json`]
    const img = cur ? storageKeyFromUrl(cur.imageUrl) : null
    if (img) keys.push(img)
    await supabase.storage.from(STORAGE_BUCKET).remove(keys)
    const idx = await readIndex()
    await writeJson(INDEX, idx.filter((r) => r.id !== id))
  })
}
