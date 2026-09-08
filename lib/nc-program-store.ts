import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import type { NcProgram, NcProgramPatch } from './nc-program'

// 程序单的存放处 —— 一个 JSON, 跟 客诉 / 退货流转单 / 人事 一个路子: 没有
// migration 要人去应用。一个厂一年几千条程序, 一个 JSON 还撑得住; 撑不住那
// 天再搬表, 上面那层 (lib/nc-program.ts) 一个字都不用改。

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const KEY = 'programming/nc.json'

function str(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function minutes(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  const n = Math.round(v)
  if (n <= 0) return undefined
  return Math.min(100_000, n)
}

function normalize(raw: unknown): NcProgram[] {
  if (!Array.isArray(raw)) return []
  const out: NcProgram[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.id !== 'string' || !r.id) continue
    if (typeof r.componentId !== 'string' || !r.componentId) continue
    out.push({
      id: r.id,
      jobId: str(r.jobId, 80),
      componentId: r.componentId,
      partKey: str(r.partKey, 200) || undefined,
      no: str(r.no, 120),
      machine: str(r.machine, 60) || undefined,
      fixture: str(r.fixture, 120) || undefined,
      tools: str(r.tools, 300) || undefined,
      minutes: minutes(r.minutes),
      note: str(r.note, 500) || undefined,
      by: str(r.by, 40) || undefined,
      createdAt: str(r.createdAt, 40),
    })
  }
  return out
}

async function read(): Promise<NcProgram[]> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(KEY)
  if (error || !data) return []
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return []
  }
}

async function write(rows: NcProgram[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

/** 全部程序单 —— 工单页要拿它算"这个件以前编过没有", 所以整份读回来。 */
export async function getNcPrograms(): Promise<NcProgram[]> {
  return read()
}

export async function addNcProgram(
  input: {
    jobId: string
    componentId: string
    partKey?: string
    no: string
    machine?: string
    fixture?: string
    tools?: string
    minutes?: number
    note?: string
  },
  by: string,
  nowIso: string,
): Promise<NcProgram> {
  return withLock(async () => {
    const rows = await read()
    const row: NcProgram = {
      id: crypto.randomUUID(),
      jobId: input.jobId,
      componentId: input.componentId,
      partKey: str(input.partKey, 200) || undefined,
      no: str(input.no, 120),
      machine: str(input.machine, 60) || undefined,
      fixture: str(input.fixture, 120) || undefined,
      tools: str(input.tools, 300) || undefined,
      minutes: minutes(input.minutes),
      note: str(input.note, 500) || undefined,
      by,
      createdAt: nowIso,
    }
    rows.push(row)
    await write(rows)
    return row
  })
}

export async function updateNcProgram(
  id: string,
  patch: NcProgramPatch,
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const row = rows.find((r) => r.id === id)
    if (!row) return
    if (patch.no !== undefined) row.no = str(patch.no, 120)
    if (patch.machine !== undefined)
      row.machine = str(patch.machine, 60) || undefined
    if (patch.fixture !== undefined)
      row.fixture = str(patch.fixture, 120) || undefined
    if (patch.tools !== undefined) row.tools = str(patch.tools, 300) || undefined
    if (patch.minutes !== undefined) row.minutes = minutes(patch.minutes)
    if (patch.note !== undefined) row.note = str(patch.note, 500) || undefined
    await write(rows)
  })
}

export async function deleteNcProgram(id: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    if (!rows.some((r) => r.id === id)) return
    await write(rows.filter((r) => r.id !== id))
  })
}
