import 'server-only'
import type { Stage } from './data'
import { STAGES } from './data'
import { supabase } from './supabase'
import { today, shanghaiWindow } from './today'

// Read shapes for the /pulse (现场) surface. Hits the views from
// migration 0019_pulse_views.sql — nothing here computes; the SQL does.
//
// Both loaders return scalar primitives, never typed-row objects, because
// the page renders them directly without further server-side reshaping.

export type StationWipRow = {
  stage: Stage
  jobsHere: number
  partsHere: number
  /** Parts here whose unit_price_cny AND line_total_cny are both NULL —
   *  the ¥0 contributors. Surfaced on the tile so a ¥0 column reads as
   *  "we don't know" instead of "this stage is worthless." */
  partsUnpriced: number
  wipCny: number
}

export type StationEventKind = 'started' | 'finished'

export type StationEvent = {
  ts: string
  stage: Stage
  kind: StationEventKind
  actorName?: string
  jobId: string
  jobNo: string
  customer: string
  product: string
  partId: string
  partName: string
  partQty: number
  doneQty?: number
}

type AnyRow = Record<string, unknown>

// Tolerate two flavors of "schema lags the app code" so deploys are
// forgiving:
//   • PGRST205 — PostgREST schema cache doesn't know the view (the view
//     itself hasn't been created yet — fresh DB, migration unapplied).
//   • 42703    — Postgres "column does not exist." Hit when an older
//     version of the view IS present but a newer column the loader asks
//     for hasn't been added yet (migration partially applied / pre-update).
// Both degrade to a zero-fallback so the page renders something instead
// of 500'ing. Loud error in dev still surfaces in `next dev` logs.
function isSchemaLagError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const code = (e as { code?: unknown }).code
  // PGRST205 — unknown table/view; 42703 — unknown column; PGRST202 — unknown
  // RPC; 42883 — function does not exist. All mean "schema lags the code"
  // (migration unapplied / partially applied) and degrade to empty instead
  // of 500'ing the page on a fresh or mid-deploy DB.
  return (
    code === 'PGRST205' ||
    code === '42703' ||
    code === 'PGRST202' ||
    code === '42883'
  )
}

// One row per stage. Guarantees all 9 stages are present (the view itself
// emits all 9, even when empty), so the page can render a fixed-width strip
// without zip-filling on the client.
export async function getStationWip(): Promise<StationWipRow[]> {
  const r = await supabase
    .from('station_wip')
    .select('stage, jobs_here, parts_here, parts_unpriced, wip_cny')
    .order('stage_ord', { ascending: true })
  if (r.error) {
    if (isSchemaLagError(r.error)) {
      // Pre-0019 environment — degrade to all-zeros so the page still
      // renders the strip with placeholder digits instead of a 500.
      return STAGES.map((s) => ({
        stage: s,
        jobsHere: 0,
        partsHere: 0,
        partsUnpriced: 0,
        wipCny: 0,
      }))
    }
    throw r.error
  }
  const byStage = new Map<Stage, StationWipRow>()
  for (const row of (r.data ?? []) as AnyRow[]) {
    const stage = row.stage as Stage
    byStage.set(stage, {
      stage,
      jobsHere: Number(row.jobs_here ?? 0),
      partsHere: Number(row.parts_here ?? 0),
      partsUnpriced: Number(row.parts_unpriced ?? 0),
      wipCny: Number(row.wip_cny ?? 0),
    })
  }
  // Preserve canonical STAGES order regardless of how the rows came back.
  return STAGES.map(
    (s) =>
      byStage.get(s) ?? {
        stage: s,
        jobsHere: 0,
        partsHere: 0,
        partsUnpriced: 0,
        wipCny: 0,
      },
  )
}

// Most recent stage events, optionally filtered to one stage. Limit is the
// number of rows to return, capped to the view's own LIMIT 2000.
export async function getStationEvents(opts?: {
  stage?: Stage
  limit?: number
}): Promise<StationEvent[]> {
  const limit = Math.max(1, Math.min(500, opts?.limit ?? 50))
  let q = supabase
    .from('station_events')
    .select(
      'ts, stage, kind, by_user_id, actor_name, part_id, part_name, part_qty, done_qty, job_id, job_no, customer, product',
    )
    .order('ts', { ascending: false })
    .limit(limit)
  if (opts?.stage) q = q.eq('stage', opts.stage)
  const r = await q
  if (r.error) {
    if (isSchemaLagError(r.error)) return []
    throw r.error
  }
  const out: StationEvent[] = []
  for (const row of (r.data ?? []) as AnyRow[]) {
    out.push({
      ts: row.ts as string,
      stage: row.stage as Stage,
      kind: row.kind as StationEventKind,
      actorName: (row.actor_name as string | null) ?? undefined,
      jobId: row.job_id as string,
      jobNo: (row.job_no as string | null) ?? '',
      customer: (row.customer as string | null) ?? '',
      product: (row.product as string | null) ?? '',
      partId: row.part_id as string,
      partName: (row.part_name as string | null) ?? '',
      partQty: Number(row.part_qty ?? 0),
      doneQty:
        row.done_qty == null ? undefined : Number(row.done_qty),
    })
  }
  return out
}

// === 报工 (worker output) reads — see migration 0025_worker_output.sql ===

// One worker's roll-up within a reporting window.
export type WorkerOutputRow = {
  actorName: string
  /** 完成零件 — count of part-stage completions ("components flowed through"). */
  finishes: number
  /** 开始 — count of part-stages this worker started (clicked ▶) in the window. */
  starts: number
  /** 件 — total physical pieces across those completions. */
  pieces: number
  /** ¥ 经手 — throughput value (counted once per finished stage; not revenue). */
  valueCny: number
  /** Completions whose part had no price set — the ¥0 contributors. */
  unpriced: number
  /** Most recent event of either kind — drives the 最后活动 column. */
  lastActiveTs?: string
}

export type WorkerEventKind = 'started' | 'finished'

// One 开始/完成 event in a worker's timeline (the per-worker drill-down).
// Carries the full component detail so the drill-down can render Excel-style
// rows (photo + 料号 + 材料 + 表面处理), matching the components table.
export type WorkerStageEvent = {
  ts: string
  kind: WorkerEventKind
  stage: Stage
  partName: string
  partQty: number
  valueCny: number
  unpriced: boolean
  jobId: string
  jobNo: string
  customer: string
  partNo?: string
  material?: string
  surfaceTreatment?: string
  /** Raw stored image URL — pass through proxiedStorageUrl() before rendering. */
  imageUrl?: string
}

// Daily/weekly/monthly scoreboard: one row per worker, sorted by output.
// Aggregation runs in Postgres (worker_output RPC), so a month-wide window
// returns a handful of worker rows, not every finish event.
export async function getWorkerOutput(
  window: {
    from: string
    to: string
  },
  // Optional station filter. Undefined = the global, all-stages scoreboard
  // (报工's original behaviour); a stage re-scopes counts + value to that one
  // station. Resolves to the worker_output() p_stage param (migration 0039).
  stage?: Stage,
): Promise<WorkerOutputRow[]> {
  const r = await supabase.rpc('worker_output', {
    p_from: window.from,
    p_to: window.to,
    p_stage: stage ?? null,
  })
  if (r.error) {
    if (isSchemaLagError(r.error)) return []
    throw r.error
  }
  const out: WorkerOutputRow[] = []
  for (const row of (r.data ?? []) as AnyRow[]) {
    out.push({
      actorName: (row.actor_name as string | null) ?? '—',
      finishes: Number(row.finishes ?? 0),
      starts: Number(row.starts ?? 0),
      pieces: Number(row.pieces ?? 0),
      valueCny: Number(row.value_cny ?? 0),
      unpriced: Number(row.unpriced ?? 0),
      lastActiveTs: (row.last_active as string | null) ?? undefined,
    })
  }
  return out
}

// One worker's stage events (开始 + 完成) within a window, newest first.
// Powers the 报工 drill-down. Bounded by `limit` so the read stays cheap.
export async function getWorkerTimeline(opts: {
  actorName: string
  from: string
  to: string
  /** Restrict to one event kind — the 报工 "completed components" view passes
   *  'finished' so the Excel rows are exactly the parts they finished. */
  kind?: WorkerEventKind
  /** Restrict to one station — the per-station 报工 cut filters the drill-down
   *  to the parts this worker finished *at that stage*. */
  stage?: Stage
  limit?: number
}): Promise<WorkerStageEvent[]> {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200))
  // worker_output excludes NULL-actor rows, so the scoreboard never links to
  // an unattributed worker — a plain equality filter is all we need here.
  let q = supabase
    .from('worker_stage_events')
    .select(
      'ts, kind, stage, part_name, part_qty, value_cny, is_unpriced, job_id, job_no, customer, part_no, material, surface_treatment, image_url',
    )
    .eq('actor_name', opts.actorName)
    .gte('ts', opts.from)
    .lt('ts', opts.to)
    .order('ts', { ascending: false })
    .limit(limit)
  if (opts.kind) q = q.eq('kind', opts.kind)
  if (opts.stage) q = q.eq('stage', opts.stage)
  const r = await q
  if (r.error) {
    if (isSchemaLagError(r.error)) return []
    throw r.error
  }
  const out: WorkerStageEvent[] = []
  for (const row of (r.data ?? []) as AnyRow[]) {
    out.push({
      ts: row.ts as string,
      kind: row.kind as WorkerEventKind,
      stage: row.stage as Stage,
      partName: (row.part_name as string | null) ?? '',
      partQty: Number(row.part_qty ?? 0),
      valueCny: Number(row.value_cny ?? 0),
      unpriced: Boolean(row.is_unpriced),
      jobId: row.job_id as string,
      jobNo: (row.job_no as string | null) ?? '',
      customer: (row.customer as string | null) ?? '',
      partNo: (row.part_no as string | null) ?? undefined,
      material: (row.material as string | null) ?? undefined,
      surfaceTreatment: (row.surface_treatment as string | null) ?? undefined,
      imageUrl: (row.image_url as string | null) ?? undefined,
    })
  }
  return out
}

// Today's 报工 scoreboard for one station — the station-axis cut of
// worker_output(): one row per worker, ranked by finishes, counting only their
// work *at this stage*, over the factory-local current day. Powers the
// per-station 报工 block embedded on the dashboard station tab; the full ranged
// view (any date range, drill-downs) lives at /report?stage=<stage>.
export async function getStationOutput(stage: Stage): Promise<WorkerOutputRow[]> {
  const window = shanghaiWindow(today(), 'day')
  return getWorkerOutput(window, stage)
}

// One worker's own numbers — today + this ISO week — for the personal "今日
// 产出" headline a floor worker sees the moment they land on their home view.
// Two worker_output() reads (factory-local day + week), each filtered down to
// this actor's row. Deliberately ALL-stages (no p_stage): it's "everything you
// pushed through today," not just your home station, so a worker who pitched in
// elsewhere still sees their full contribution.
export type WorkerSelfStats = {
  /** 完成零件 today — count of part-stage completions. */
  todayFinishes: number
  /** Physical pieces across today's completions. */
  todayPieces: number
  /** ¥ 经手 today — value that flowed through their hands. */
  todayValueCny: number
  /** Today's completions whose part had no price set (the ¥0 contributors). */
  todayUnpriced: number
  /** 完成零件 this week (Mon–Sun). */
  weekFinishes: number
  weekPieces: number
}

export async function getWorkerSelfStats(actorName: string): Promise<WorkerSelfStats> {
  const t = today()
  const [dayRows, weekRows] = await Promise.all([
    getWorkerOutput(shanghaiWindow(t, 'day')),
    getWorkerOutput(shanghaiWindow(t, 'week')),
  ])
  const d = dayRows.find((r) => r.actorName === actorName)
  const w = weekRows.find((r) => r.actorName === actorName)
  return {
    todayFinishes: d?.finishes ?? 0,
    todayPieces: d?.pieces ?? 0,
    todayValueCny: d?.valueCny ?? 0,
    todayUnpriced: d?.unpriced ?? 0,
    weekFinishes: w?.finishes ?? 0,
    weekPieces: w?.pieces ?? 0,
  }
}

// Formatter for event timestamps. Mirrors the floor-friendly compact form:
//   < 1 min ago     → 刚刚
//   < 60 min ago    → N 分钟前
//   < 24 h, today   → HH:MM
//   prior day(s)    → MM-DD HH:MM
//
// Pure / deterministic given (ts, now); page can pass an explicit `now` so
// SSR and the (eventual) client refresh agree on the rendered string.
export function formatEventTs(ts: string, now: Date = new Date()): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (sameDay) return `${hh}:${mm}`
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mo}-${dd} ${hh}:${mm}`
}

// === 报工 per-station cockpit reads (the /report?stage=<X> view) ===
//
// One station answers three questions a human actually asks standing at it:
//   ① 停留超期 — which components have been sitting here too long (bottleneck)
//   ② 本工段人员 — who worked here this period, and (drill) exactly what they did
//   ③ 流经工单 — which jobs flowed through here this period
// All derived from part_stages; ② + ③ share ONE query (worker_stage_events),
// grouped in JS so the client can expand people → jobs → components instantly
// without a round-trip. Cascade back-fills are excluded upstream in the view /
// RPC (migration 0071), so a shipper no longer pollutes a station's numbers.

/** A component that has been sitting in_progress at a station past the age cut. */
export type StuckPart = {
  partId: string
  partName: string
  partNo?: string
  jobId: string
  jobNo: string
  customer: string
  qty: number
  doneQty?: number
  /** ISO instant work began at this stage. */
  startedAt: string
  /** Whole days since startedAt (floor), for the "在此 N 天" tag. */
  daysHere: number
  imageUrl?: string
}

// Split an id list into chunks so a `.in(col, ids)` never overflows undici's
// ~16KB request-header limit (see project memory / getOutsourceBlockRows).
async function fetchInChunks<T>(
  ids: string[],
  run: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const CHUNK = 100
  const out: T[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    out.push(...(await run(ids.slice(i, i + CHUNK))))
  }
  return out
}

// Components stuck in_progress at `stage` for at least `minDays`, longest first.
// Bounded — a station rarely has more than a few dozen genuinely stuck parts.
export async function getStationStuck(
  stage: Stage,
  minDays: number,
  now: Date = new Date(),
): Promise<StuckPart[]> {
  const cutoffIso = new Date(now.getTime() - minDays * 86_400_000).toISOString()
  const ps = await supabase
    .from('part_stages')
    .select('part_id, started_at, done_qty')
    .eq('stage', stage)
    .eq('status', 'in_progress')
    .lt('started_at', cutoffIso)
    .order('started_at', { ascending: true })
    .limit(300)
  if (ps.error) {
    if (isSchemaLagError(ps.error)) return []
    throw ps.error
  }
  const rows = (ps.data ?? []) as AnyRow[]
  if (rows.length === 0) return []

  const partIds = rows.map((r) => r.part_id as string)
  const parts = await fetchInChunks(partIds, async (chunk) => {
    const r = await supabase
      .from('parts')
      .select('id, name, qty, part_no, image_url, job_id')
      .in('id', chunk)
    if (r.error) throw r.error
    return (r.data ?? []) as AnyRow[]
  })
  const partById = new Map(parts.map((p) => [p.id as string, p]))

  const jobIds = [...new Set(parts.map((p) => p.job_id as string))]
  const jobs = await fetchInChunks(jobIds, async (chunk) => {
    const r = await supabase
      .from('jobs')
      .select('id, job_no, customer')
      .in('id', chunk)
    if (r.error) throw r.error
    return (r.data ?? []) as AnyRow[]
  })
  const jobById = new Map(jobs.map((j) => [j.id as string, j]))

  const out: StuckPart[] = []
  for (const row of rows) {
    const p = partById.get(row.part_id as string)
    if (!p) continue
    const j = jobById.get(p.job_id as string)
    const startedAt = row.started_at as string
    const daysHere = Math.floor(
      (now.getTime() - new Date(startedAt).getTime()) / 86_400_000,
    )
    out.push({
      partId: p.id as string,
      partName: (p.name as string | null) ?? '部件',
      partNo: (p.part_no as string | null) ?? undefined,
      jobId: p.job_id as string,
      jobNo: (j?.job_no as string | null) ?? '',
      customer: (j?.customer as string | null) ?? '',
      qty: Number(p.qty ?? 0),
      doneQty: row.done_qty == null ? undefined : Number(row.done_qty),
      startedAt,
      daysHere,
      imageUrl: (p.image_url as string | null) ?? undefined,
    })
  }
  return out
}

// --- ② 本工段人员 + drill-down, and ③ 流经工单 — one query, grouped in JS ---

export type StationComponent = {
  ts: string
  partName: string
  partNo?: string
  qty: number
  valueCny: number
  unpriced: boolean
  imageUrl?: string
  jobId: string
  jobNo: string
  customer: string
}

/** One job's worth of a worker's finishes at this station (drill-down group). */
export type StationWorkerJob = {
  jobId: string
  jobNo: string
  customer: string
  finishes: number
  pieces: number
  valueCny: number
  components: StationComponent[]
}

export type StationWorker = {
  actorName: string
  finishes: number
  pieces: number
  valueCny: number
  unpriced: number
  lastActiveTs?: string
  jobs: StationWorkerJob[]
}

/** ③ A job that flowed through this station in the window. */
export type StationFlowJob = {
  jobId: string
  jobNo: string
  customer: string
  finishes: number
  pieces: number
  valueCny: number
  /** Distinct workers who finished a part of this job here. */
  workers: number
}

export type StationFinishes = {
  workers: StationWorker[]
  jobs: StationFlowJob[]
  totals: { finishes: number; pieces: number; valueCny: number; unpriced: number }
  /** True if the raw event cap was hit (some finishes omitted from drill-downs). */
  truncated: boolean
}

// Every finish event at `stage` within the window, grouped into the per-worker
// (→ per-job → per-component) tree the cockpit renders, plus the per-job flow
// list and headline totals. Reads worker_stage_events (cascade-excluded post
// 0071); capped so a huge month can't ship an unbounded payload to the client.
export async function getStationFinishes(
  stage: Stage,
  window: { from: string; to: string },
): Promise<StationFinishes> {
  const CAP = 3000
  const r = await supabase
    .from('worker_stage_events')
    .select(
      'ts, actor_name, part_name, part_qty, value_cny, is_unpriced, job_id, job_no, customer, part_no, image_url',
    )
    .eq('kind', 'finished')
    .eq('stage', stage)
    .gte('ts', window.from)
    .lt('ts', window.to)
    .order('ts', { ascending: false })
    .limit(CAP + 1)
  if (r.error) {
    if (isSchemaLagError(r.error)) {
      return { workers: [], jobs: [], totals: { finishes: 0, pieces: 0, valueCny: 0, unpriced: 0 }, truncated: false }
    }
    throw r.error
  }
  const all = (r.data ?? []) as AnyRow[]
  const truncated = all.length > CAP
  const events = truncated ? all.slice(0, CAP) : all

  // Worker → job → components, plus the flat per-job flow rollup.
  const workerMap = new Map<string, StationWorker>()
  const jobMap = new Map<string, StationFlowJob & { _actors: Set<string> }>()
  let tf = 0
  let tp = 0
  let tv = 0
  let tu = 0

  for (const e of events) {
    const actor = ((e.actor_name as string | null) ?? '—') || '—'
    const jobId = e.job_id as string
    const jobNo = (e.job_no as string | null) ?? ''
    const customer = (e.customer as string | null) ?? ''
    const qty = Number(e.part_qty ?? 0)
    const value = Number(e.value_cny ?? 0)
    const unpriced = Boolean(e.is_unpriced)
    const ts = e.ts as string

    tf += 1
    tp += qty
    tv += value
    if (unpriced) tu += 1

    // worker
    let w = workerMap.get(actor)
    if (!w) {
      w = { actorName: actor, finishes: 0, pieces: 0, valueCny: 0, unpriced: 0, lastActiveTs: ts, jobs: [] }
      workerMap.set(actor, w)
    }
    w.finishes += 1
    w.pieces += qty
    w.valueCny += value
    if (unpriced) w.unpriced += 1
    if (!w.lastActiveTs || ts > w.lastActiveTs) w.lastActiveTs = ts
    let wj = w.jobs.find((x) => x.jobId === jobId)
    if (!wj) {
      wj = { jobId, jobNo, customer, finishes: 0, pieces: 0, valueCny: 0, components: [] }
      w.jobs.push(wj)
    }
    wj.finishes += 1
    wj.pieces += qty
    wj.valueCny += value
    wj.components.push({
      ts,
      partName: (e.part_name as string | null) ?? '部件',
      partNo: (e.part_no as string | null) ?? undefined,
      qty,
      valueCny: value,
      unpriced,
      imageUrl: (e.image_url as string | null) ?? undefined,
      jobId,
      jobNo,
      customer,
    })

    // job flow
    let jf = jobMap.get(jobId)
    if (!jf) {
      jf = { jobId, jobNo, customer, finishes: 0, pieces: 0, valueCny: 0, workers: 0, _actors: new Set() }
      jobMap.set(jobId, jf)
    }
    jf.finishes += 1
    jf.pieces += qty
    jf.valueCny += value
    jf._actors.add(actor)
  }

  const workers = [...workerMap.values()].sort((a, b) => b.finishes - a.finishes || b.valueCny - a.valueCny)
  for (const w of workers) w.jobs.sort((a, b) => b.finishes - a.finishes)
  const jobs: StationFlowJob[] = [...jobMap.values()]
    .map(({ _actors, ...j }) => ({ ...j, workers: _actors.size }))
    .sort((a, b) => b.finishes - a.finishes)

  return { workers, jobs, totals: { finishes: tf, pieces: tp, valueCny: tv, unpriced: tu }, truncated }
}
