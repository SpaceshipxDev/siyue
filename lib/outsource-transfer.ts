import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import type { Stage } from './data'

/*
 * 转外协 (于海伟 2026-11-05) —— 工程 / 商务 / 程江华点好工单后, 某个零件要
 * 外发: 零件那一行点「转外协」。这个零件还没开工的 编程 / 操机 / 车铣 关掉,
 * 这张单进看板上的「待外协」; 商务给这个零件开了外协单 (外协操作照旧), 这条
 * 就自己消掉。点错了取消 (把关掉的工序还回去) 只有于海伟和老板。
 *
 * 一个零件一份 (于海伟 2026-11-07): 原来全厂一份 json, 线上几个进程前后脚各
 * 写各的, 后写的把先写的盖掉。文件名是 工单号.零件号 各自编成只有字母数字的
 * 一串 (零件号里有什么字符都不怕), 工单页按零件逐个对号去读, 不靠列目录。
 *
 * TABLE-FREE, 没有 migration:
 *   jobs/outsource-transfer/<b64(jobId)>.<b64(componentId)>.json   { jobId, removed, at, by }
 *   jobs/outsource-transfer/<jobId>__<componentId>.json   上一版的名字, 只读 + 清
 *   jobs/outsource-transfer.json                          最早那一份, 只读 + 清
 */

export type TransferMark = {
  jobId: string
  /** 转的时候关掉的那几道 —— 取消时原样还回去。 */
  removed: Stage[]
  at: string
  by: string
}

const DIR = 'jobs/outsource-transfer'
const LEGACY_KEY = 'jobs/outsource-transfer.json'
// 看板每次刷新都问一回 —— 同一个进程几秒内不重复列目录。
const TTL_MS = 5_000

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8')

const keyOf = (jobId: string, componentId: string) => `${DIR}/${b64(jobId)}.${b64(componentId)}.json`
const oldKeyOf = (jobId: string, componentId: string) => `${DIR}/${jobId}__${componentId}.json`

/** 目录里一份的名字 → 哪张单、哪个零件 (两种名字都认)。 */
function parseName(name: string): { jobId: string; componentId: string; key: string } | null {
  if (!name.endsWith('.json')) return null
  const base = name.slice(0, -'.json'.length)
  // 新名字中间是一个点 (编码里没有点, 可能有 __); 没有点的是上一版的 __ 名字。
  const dot = base.indexOf('.')
  if (dot > 0) {
    try {
      return { jobId: unb64(base.slice(0, dot)), componentId: unb64(base.slice(dot + 1)), key: `${DIR}/${name}` }
    } catch {
      return null
    }
  }
  const old = base.indexOf('__')
  if (old <= 0) return null
  return { jobId: base.slice(0, old), componentId: base.slice(old + 2), key: `${DIR}/${name}` }
}

function readMark(raw: unknown): TransferMark | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.jobId !== 'string' || !r.jobId) return null
  return {
    jobId: r.jobId,
    removed: Array.isArray(r.removed)
      ? (r.removed as unknown[]).filter((s): s is Stage => typeof s === 'string')
      : [],
    at: typeof r.at === 'string' ? r.at : '',
    by: typeof r.by === 'string' ? r.by : '',
  }
}

async function download(key: string): Promise<unknown> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(key)
  if (error || !data) return undefined
  try {
    return JSON.parse(await data.text())
  } catch {
    return undefined
  }
}

// ── 最早那一份 (全厂一个 json) —— 里面还挂着的照样算, 清的时候一起清。 ──

let legacyLock: Promise<unknown> = Promise.resolve()
function withLegacyLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = legacyLock.then(fn, fn)
  legacyLock = next.catch(() => undefined)
  return next
}

async function readLegacy(): Promise<Record<string, TransferMark>> {
  const raw = await download(LEGACY_KEY)
  const out: Record<string, TransferMark> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const m = readMark(v)
    if (m) out[id] = m
  }
  return out
}

async function dropLegacy(componentIds: string[]): Promise<void> {
  await withLegacyLock(async () => {
    const all = await readLegacy()
    if (!componentIds.some((id) => all[id])) return
    for (const id of componentIds) delete all[id]
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(LEGACY_KEY, Buffer.from(JSON.stringify(all), 'utf8'), {
        contentType: 'application/json',
        upsert: true,
      })
    if (error) throw error
  })
}

// ── 一个零件一份 ──

async function listAll(): Promise<{ jobId: string; componentId: string; key: string }[]> {
  const out: { jobId: string; componentId: string; key: string }[] = []
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .list(DIR, { limit: 1000, offset })
    if (error || !data) break
    for (const f of data) {
      const p = parseName(f.name)
      if (p) out.push(p)
    }
    if (data.length < 1000) break
  }
  return out
}

let idsCache: { at: number; ids: Set<string> } | null = null

/** 有零件转了外协、还没开外协单的工单。 */
export async function getTransferJobIds(): Promise<Set<string>> {
  if (idsCache && Date.now() - idsCache.at < TTL_MS) return idsCache.ids
  const [files, legacy] = await Promise.all([listAll(), readLegacy()])
  const ids = new Set([...files.map((f) => f.jobId), ...Object.values(legacy).map((m) => m.jobId)])
  idsCache = { at: Date.now(), ids }
  return ids
}

/** 一个零件的那一份 —— 按名字直接读, 新名字、上一版名字、最早那一份依次找。 */
async function readOne(
  jobId: string,
  componentId: string,
  legacy?: Record<string, TransferMark>,
): Promise<TransferMark | undefined> {
  const m =
    readMark(await download(keyOf(jobId, componentId))) ??
    readMark(await download(oldKeyOf(jobId, componentId)))
  if (m) return m
  const l = (legacy ?? (await readLegacy()))[componentId]
  return l && l.jobId === jobId ? l : undefined
}

/** 这张单上转了外协的零件 —— 一个零件一个零件对号读。 */
export async function getJobTransfers(
  jobId: string,
  componentIds: string[],
): Promise<Record<string, TransferMark>> {
  const [legacy, files] = await Promise.all([readLegacy(), listAll().catch(() => [])])
  // 上一版名字的那几份 —— 目录里有才去读, 不每个零件都多问一回。
  const oldKeys = new Set(files.filter((f) => f.key === oldKeyOf(f.jobId, f.componentId)).map((f) => f.key))
  const out: Record<string, TransferMark> = {}
  await Promise.all(
    componentIds.map(async (id) => {
      const m =
        readMark(await download(keyOf(jobId, id))) ??
        (oldKeys.has(oldKeyOf(jobId, id)) ? readMark(await download(oldKeyOf(jobId, id))) : null) ??
        (legacy[id]?.jobId === jobId ? legacy[id] : null)
      if (m) out[id] = m
    }),
  )
  return out
}

export async function getTransfer(jobId: string, componentId: string): Promise<TransferMark | undefined> {
  return readOne(jobId, componentId)
}

export async function setTransfer(componentId: string, mark: TransferMark): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(keyOf(mark.jobId, componentId), Buffer.from(JSON.stringify(mark), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
  idsCache = null
}

/**
 * 去掉几条 (外协单开了 / 取消转外协)。返回去掉之后这几张单上还剩几条 ——
 * 还有别的零件等着外发, 待外协就不能跟着消。
 */
export async function clearTransfers(componentIds: string[]): Promise<Map<string, number>> {
  const want = new Set(componentIds)
  const left = new Map<string, number>()
  if (want.size === 0) return left
  const [files, legacy] = await Promise.all([listAll(), readLegacy()])
  const gone = files.filter((f) => want.has(f.componentId))
  const goneLegacy = componentIds.filter((id) => legacy[id])
  if (gone.length === 0 && goneLegacy.length === 0) return left
  if (gone.length > 0) {
    const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(gone.map((f) => f.key))
    if (error) throw error
  }
  if (goneLegacy.length > 0) await dropLegacy(goneLegacy)
  idsCache = null
  const jobs = new Set([...gone.map((f) => f.jobId), ...goneLegacy.map((id) => legacy[id].jobId)])
  for (const j of jobs) {
    const rest = new Set([
      ...files.filter((f) => f.jobId === j && !want.has(f.componentId)).map((f) => f.componentId),
      ...Object.entries(legacy)
        .filter(([id, m]) => m.jobId === j && !want.has(id))
        .map(([id]) => id),
    ])
    left.set(j, rest.size)
  }
  return left
}
