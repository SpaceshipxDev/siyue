import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 计划 —— 每个工段每天排了哪些活、谁做、做完没有、没做完为什么。
 *
 * 原来的「重点」是一张不分工段的必须完成清单; 计划把它拆到工段上, 一个工段
 * 一张表 (编程 / 操机 / 车铣 / 手工 / 打磨)。每一格都是手填的 —— 排产是人定的,
 * 系统猜不出来。
 *
 * 只有「完成情况」不全靠手填: 工单在那一道上报工报完了, 计划这一行就自动算
 * 完成 (app/plan/page 里对着看板的数算, 不存在这里)。手填的完成时间优先。
 *
 * Table-free, 跟 质量那几张表一个路子: 没有 migration 要人去应用。
 */

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const KEY = 'plan/rows.json'

export const PLAN_STAGES = ['编程', '操机', '车铣', '手工', '打磨'] as const
export type PlanStage = (typeof PLAN_STAGES)[number]

/** 操作人员 —— 一个名字, 后面可以标 正面 / 反面 / 别的 (操机那几张表用)。 */
export type PlanWorker = { name: string; side?: string }

export type PlanRow = {
  id: string
  stage: PlanStage
  date: string // 计划日期 YYYY-MM-DD
  jobNo: string // 工单号
  seq?: string // 序列号 — 编程: 零件那一行的 # (01 / 1.1)
  machine?: string // 机台号 — 操机 / 车铣 / 手工 / 打磨
  workers: PlanWorker[]
  doneAt?: string // 完成时间 — 手填的
  note?: string // 备注说明
  reason?: string // 未完成原因说明
  by?: string
  createdAt: string
}

export type PlanPatch = {
  date?: string
  jobNo?: string
  seq?: string
  machine?: string
  workers?: PlanWorker[]
  doneAt?: string
  note?: string
  reason?: string
}

function str(v: unknown, max = 500): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

export function isPlanStage(v: unknown): v is PlanStage {
  return typeof v === 'string' && (PLAN_STAGES as readonly string[]).includes(v)
}

export function normalizeWorkers(raw: unknown): PlanWorker[] {
  if (!Array.isArray(raw)) return []
  const out: PlanWorker[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    const name = str(r.name, 40)
    if (!name || out.some((w) => w.name === name)) continue
    const side = str(r.side, 40)
    out.push(side ? { name, side } : { name })
  }
  return out.slice(0, 30)
}

function normalize(raw: unknown): PlanRow[] {
  if (!Array.isArray(raw)) return []
  const out: PlanRow[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.id !== 'string' || !isPlanStage(r.stage)) continue
    out.push({
      id: r.id,
      stage: r.stage,
      date: /^\d{4}-\d{2}-\d{2}$/.test(str(r.date)) ? str(r.date) : '',
      jobNo: str(r.jobNo, 60),
      seq: str(r.seq, 20) || undefined,
      machine: str(r.machine, 40) || undefined,
      workers: normalizeWorkers(r.workers),
      doneAt: str(r.doneAt, 40) || undefined,
      note: str(r.note) || undefined,
      reason: str(r.reason) || undefined,
      by: str(r.by, 40) || undefined,
      createdAt: str(r.createdAt),
    })
  }
  return out
}

async function read(): Promise<PlanRow[]> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return []
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return []
  }
}

async function write(rows: PlanRow[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

// 日期新的在前; 同一天按录入先后。
export async function getPlanRows(): Promise<PlanRow[]> {
  return (await read()).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.createdAt < b.createdAt ? -1 : 1
  })
}

export async function addPlanRow(
  input: { stage: PlanStage } & PlanPatch,
  by: string,
  nowIso: string,
): Promise<PlanRow> {
  const row: PlanRow = {
    id: crypto.randomUUID(),
    stage: input.stage,
    date: /^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '') ? input.date! : nowIso.slice(0, 10),
    jobNo: str(input.jobNo, 60),
    seq: str(input.seq, 20) || undefined,
    machine: str(input.machine, 40) || undefined,
    workers: normalizeWorkers(input.workers),
    doneAt: str(input.doneAt, 40) || undefined,
    note: str(input.note) || undefined,
    reason: str(input.reason) || undefined,
    by,
    createdAt: nowIso,
  }
  await withLock(async () => {
    const rows = await read()
    rows.push(row)
    await write(rows)
  })
  return row
}

export async function updatePlanRow(id: string, patch: PlanPatch): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const row = rows.find((r) => r.id === id)
    if (!row) throw new Error('这一行已经没有了，刷新看看')
    if (patch.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(patch.date)) row.date = patch.date
    if (patch.jobNo !== undefined) row.jobNo = str(patch.jobNo, 60)
    if (patch.seq !== undefined) row.seq = str(patch.seq, 20) || undefined
    if (patch.machine !== undefined) row.machine = str(patch.machine, 40) || undefined
    if (patch.workers !== undefined) row.workers = normalizeWorkers(patch.workers)
    if (patch.doneAt !== undefined) row.doneAt = str(patch.doneAt, 40) || undefined
    if (patch.note !== undefined) row.note = str(patch.note) || undefined
    if (patch.reason !== undefined) row.reason = str(patch.reason) || undefined
    await write(rows)
  })
}

export async function deletePlanRow(id: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    if (!rows.some((r) => r.id === id)) return
    await write(rows.filter((r) => r.id !== id))
  })
}
