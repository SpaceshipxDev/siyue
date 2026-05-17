import 'server-only'
import type { Stage } from './data'
import { STAGES } from './data'
import { supabase } from './supabase'

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
  return code === 'PGRST205' || code === '42703'
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
