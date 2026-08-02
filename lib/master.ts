// Lightweight read-shape for the master grid (app/page.tsx → MasterSheet,
// StationSummary, InboxList). Built from the SQL views in migration 0018 —
// avoids the cross-border full-snapshot load that scales with the entire
// factory's lifetime data. See supabase/migrations/0018_master_rollup.sql
// for the source of truth on each precomputed field.
//
// The grid renders per (row, stage) cells; this module mirrors that shape
// 1:1 so the page handler never iterates components in JS.

import type { JobStatus, JobType, PlanKey, ReturnReason, Stage } from './data'
import { STAGES, dueState } from './data'
import { today } from './today'
import type { OrderMoneyStatus } from './order-money'

// Precomputed per (job, stage). Replaces the per-cell traversal of
// job.components + their stages that the old shape forced on every cell.
export type MasterCell = {
  /** Parts whose route includes this stage. 0 ⇒ na column. */
  total: number
  /** In-house done. */
  inHouseDone: number
  /** Vendor returned the part fully — counts as done from the row's POV. */
  outsourcedClosed: number
  /** Still at a vendor. Counts as done in the rollup; jobStageCounts ignores. */
  outsourcedOpen: number
  /** In-house in_progress, not covered by an open block. */
  inProgress: number
  /** In-house pending, not covered by an open block. */
  pending: number
  /** Sum of done_qty across in_progress rows — feeds the partial-cell number. */
  inProgressDoneQtySum: number
  /** ISO ts of the oldest in_progress start across the cell. Drives the timer chip. */
  earliestInProgressAt?: string
  /** Most recent finish (ISO ts preferred, else MM-DD). Drives the done-tier sort. */
  latestFinishedAt?: string
  /** MM-DD display string of the most recent finish. */
  latestCompletedAt?: string
  /** Name of whoever most recently clicked ✓ here (经手). Drives the master-grid
   * hover attribution. Undefined when nothing here was finished by a person. */
  latestBy?: string
  /** At least one pending in-house part has every prior in-route stage effectively done. */
  hasMinePending: boolean
  /** Some prior in-route stage on at least one part here is unfinished (pending/in_progress/open). */
  hasUpstreamActive: boolean
  /** Boss-pinned at this station (job_stage_pins row exists). */
  pinnedAt?: string
}

export type MasterActiveReturn = {
  id: string
  dueDate: string
  reason: ReturnReason
}

// One row per job — what MasterSheet renders, what StationSummary sums.
// Fields that used to be derived in JS via job.components iteration are
// now precomputed by the views.
export type MasterRow = {
  id: string
  jobNo: string
  customer: string
  product: string
  /** 工程师 — the customer's representative (also labelled 联系人 on source
   *  docs; same person). Customer-facing PII (scrubbed for production
   *  scopes). Drives the commerce/boss dashboard subtext. */
  engineer?: string
  /** 越侬商务 — OUR salesperson on this order (the in-house counterpart to
   *  engineer). Internal, never scrubbed: the floor needs to know who to ask
   *  about a drawing or a date. Shown on every production row. */
  yuenongBusiness?: string
  amountCny?: number
  /** Original contract dueDate from the jobs row. Use `effectiveDueDate` for sort/color. */
  dueDate: string
  /** dueDate, overridden by activeReturn.dueDate while a 退货 is open. */
  effectiveDueDate: string
  /** 二次交期 — optional second delivery date. Display-only; never feeds
   *  effectiveDueDate / color / sort. Blank for legacy rows. */
  secondaryDueDate?: string
  /** 计划交期 (排产) — per-工段 planned finish date (plus the job-level 外协
   *  key), holistic for the job. Keyed by PlanKey; value 'YYYY-MM-DD' or
   *  'YYYY-MM-DDTHH:mm'. Display/planning only — NEVER feeds effectiveDueDate
   *  / color / sort / queue order. Empty ({}) for legacy rows. */
  stagePlan: Partial<Record<PlanKey, string>>
  notes?: string
  status: JobStatus
  createdAt?: string
  /** Global classification — drives color stripe/chip AND float-to-top
   *  when jobType === 'rush'. Undefined for legacy rows imported before
   *  the field existed. */
  jobType?: JobType
  /** 产品 — independent stack-on-top tag. Coexists with jobType. */
  isProduct?: boolean
  /** 暂停 — job deliberately blocked / on hold. Independent of jobType +
   *  isProduct. Truthy ⇒ carved out of 在产 into the 暂停 column. Doubles as
   *  the "blocked since" timestamp. Undefined ⇒ flowing. See migration 0050. */
  pausedAt?: string
  /** Optional free-text reason a job was paused (tooltip / detail display). */
  pauseReason?: string
  /** 待外协 — 工程 flagged this job as needing outsourcing, before a vendor
   *  block exists. Cleared once 商务 creates the block (→ hasOpenOutsource).
   *  Drives the 待外协 row badge + the 商务 pending filter. */
  needsOutsource?: boolean
  /** Engineer's free-text spec for what needs outsourcing (tooltip + filter). */
  outsourceNote?: string
  /** 图纸变更 — live drawing-change alarm: the customer revised drawings
   *  mid-production. Drives the overdue row badge + the master-board alarm
   *  facet (which only renders while ≥1 alarm is live). Cleared by 商务/工程
   *  head once new drawings are confirmed distributed. */
  drawingChangeOpen?: boolean
  /** What changed / which parts — written by whoever raised the alarm. */
  drawingChangeNote?: string
  /** Row-level boss pin (jobs.pinned_at). Legacy — kept for sub-sort
   *  recency within the rush bucket. Not rendered. */
  pinnedAt?: string
  /** Some part has an open outsource block on a non-出货 stage. */
  hasOpenOutsource: boolean
  /** Some part is held at 检验 with a blocking verdict (重做/返修/外修).
   *  Drives the red 检验异常 row badge on the workbench + master grid. */
  hasOpenInspectionVerdict?: boolean
  /** Sum of distinct outsource block amounts attached to this job's parts. */
  externalSpendCny: number
  /** Margin = amountCny - externalSpendCny, or undefined if amountCny is null. */
  marginCny?: number
  /** True when 出货 has total > 0 and every in-route 出货 part is in-house done. */
  isShipped: boolean
  /** 收款 — where the order's money sits in the get-paid pipeline (在产 →
   *  待开票 → 待回款 → 逾期 / 已结清). Drives the commerce-only 收款 column on
   *  the master board. Computed off shipments + shipment_finance, NOT the
   *  rollup view — see lib/db.ts#getOrderMoneyLightByJob. Undefined ⇒ scrubbed
   *  (non-commerce) or no money read attached. */
  moneyStatus?: OrderMoneyStatus
  /** 应收余额 — ¥ still owed across the order's shipments (0 until invoiced). */
  outstandingCny?: number
  /** Days past the AR aging window on the most-overdue shipment; only set when
   *  moneyStatus === 'overdue'. Drives the "逾期 N天" readout. */
  overdueDays?: number
  /** Parts count (drives inbox label, no other display use). */
  componentCount: number
  /** Lowercased haystack for substring search — built by the view. */
  searchHaystack: string
  /** Open 退货, if any. */
  activeReturn?: MasterActiveReturn
  /** Per-stage cells. Stages without any in-route part are absent (na). */
  cells: Partial<Record<Stage, MasterCell>>
}

export type MasterAggregates = {
  totalJobs: number
  inProgress: number
  paused: number
  overdue: number
  dueToday: number
  totalAmountCny: number
  totalExternalSpendCny: number
  totalMarginCny: number
  byStage: Partial<
    Record<
      Stage,
      {
        here: number
        dueToday: number
        overdue: number
        parts: number
      }
    >
  >
}

// =====================================================================
// Helpers — drop-in replacements for the lib/data.ts helpers that the
// master-grid path used. Each takes the precomputed cell or row instead
// of iterating components.
// =====================================================================

export type RowRollupKind = 'pending' | 'partial' | 'done' | 'na'

export type RowRollup = {
  kind: RowRollupKind
  done: number
  total: number
  latestDate?: string
  /** 经手 — name of the most recent finisher at this stage, for hover attribution. */
  latestBy?: string
  outsourcedOpen: number
}

/** Replaces lib/data.ts#rollupStage for MasterRow. */
export function rowRollupStage(row: MasterRow, stage: Stage): RowRollup {
  const cell = row.cells[stage]
  if (!cell || cell.total === 0) {
    return { kind: 'na', done: 0, total: 0, outsourcedOpen: 0 }
  }
  const doneAggregate = cell.inHouseDone + cell.outsourcedClosed + cell.outsourcedOpen
  const latestDate = cell.latestCompletedAt
  const latestBy = cell.latestBy
  if (doneAggregate === cell.total) {
    return {
      kind: 'done',
      done: doneAggregate,
      total: cell.total,
      latestDate,
      latestBy,
      outsourcedOpen: cell.outsourcedOpen,
    }
  }
  if (doneAggregate === 0) {
    return {
      kind: cell.inProgress > 0 ? 'partial' : 'pending',
      done: 0,
      total: cell.total,
      latestDate,
      latestBy,
      outsourcedOpen: cell.outsourcedOpen,
    }
  }
  return {
    kind: 'partial',
    done: doneAggregate,
    total: cell.total,
    latestDate,
    latestBy,
    outsourcedOpen: cell.outsourcedOpen,
  }
}

/** Replaces lib/data.ts#jobStageCounts. inProgress + pending = in-house only;
 *  done counts in-house + outsourced_closed (matches effectiveStageState's
 *  'done' kind including vendor returns). */
export function rowStageCounts(
  row: MasterRow,
  stage: Stage,
): { inProgress: number; pending: number; done: number } {
  const c = row.cells[stage]
  if (!c) return { inProgress: 0, pending: 0, done: 0 }
  return {
    inProgress: c.inProgress,
    pending: c.pending,
    done: c.inHouseDone + c.outsourcedClosed,
  }
}

/** Replaces lib/data.ts#jobIsMineAtStage. */
export function rowIsMineAtStage(row: MasterRow, stage: Stage): boolean {
  const c = row.cells[stage]
  if (!c) return false
  if (c.inProgress > 0) return true
  return c.hasMinePending
}

/** Replaces lib/data.ts#jobIsDoneAtStage. "Done" = no in-house work remains. */
export function rowIsDoneAtStage(row: MasterRow, stage: Stage): boolean {
  const c = row.cells[stage]
  if (!c || c.total === 0) return false
  return c.inProgress === 0 && c.pending === 0
}

/** Replaces lib/data.ts#jobIsUpstreamOfStage. */
export function rowIsUpstreamOfStage(row: MasterRow, stage: Stage): boolean {
  const c = row.cells[stage]
  if (!c) return false
  return c.hasUpstreamActive
}

/** Replaces lib/data.ts#jobMostRecentFinishedAt. */
export function rowMostRecentFinishedAt(row: MasterRow, stage: Stage): string {
  return row.cells[stage]?.latestFinishedAt ?? ''
}

/** Boss-pinned at this station. Replaces lib/data.ts#jobIsPinnedAtStage. */
export function rowIsPinnedAtStage(row: MasterRow, stage: Stage): boolean {
  return Boolean(row.cells[stage]?.pinnedAt)
}

/** Row-level boss pin. Replaces lib/data.ts#jobIsPinned. */
export function rowIsPinned(row: MasterRow): boolean {
  return Boolean(row.pinnedAt)
}

/** True when this row should float to the top of every view. The new
 *  global priority signal — supersedes rowIsPinned/rowIsPinnedAtStage. */
export function rowIsRush(row: MasterRow): boolean {
  return row.jobType === 'rush'
}

/** Replaces lib/data.ts#jobTimerAtStage. MVP: only the in_progress branch.
 *  When no in_progress but some pending and stage = 工程 (no upstream), fall
 *  back to createdAt — the most common case the boss watches. Other stages
 *  with only-pending currently return null in lite mode; jobTimerAtStage's
 *  per-part "arrived" lookup is not modeled in the rollup view. */
export function rowTimerAtStage(
  row: MasterRow,
  stage: Stage,
): { since: string; tone: 'pending' | 'in_progress' } | null {
  const c = row.cells[stage]
  if (!c) return null
  if (c.earliestInProgressAt) {
    return { since: c.earliestInProgressAt, tone: 'in_progress' }
  }
  if (c.pending > 0 && stage === STAGES[0] && row.createdAt) {
    return { since: row.createdAt, tone: 'pending' }
  }
  return null
}

/** Effective due date for sort/color (open return overrides). Pre-baked by
 *  the page handler from row.effectiveDueDate; this helper exists for parity
 *  with the Job-based call sites that read jobEffectiveDueDate(j). */
export function rowEffectiveDueDate(row: MasterRow): string {
  return row.effectiveDueDate
}

/** True when shipping is fully closed out. */
export function rowIsShipped(row: MasterRow): boolean {
  return row.isShipped
}

/** Text match for production scopes, whose searchHaystack arrives empty (it
 *  carries customer PII). Matches exactly the fields they can read on the row:
 *  工号 / 产品 / 越侬商务 — the last because "show me everything 王雪梅 is
 *  running" is a question the floor actually asks. `query` must already be
 *  trimmed and lowercased. */
export function rowMatchesProductionQuery(row: MasterRow, query: string): boolean {
  return (
    row.jobNo.toLowerCase().includes(query) ||
    row.product.toLowerCase().includes(query) ||
    (row.yuenongBusiness ?? '').toLowerCase().includes(query)
  )
}

/** True for 收件箱 jobs (parsing/draft/failed) — not yet confirmed orders, so
 *  they belong only to the inbox and must never count toward 在产 / 暂停 / 已出货
 *  on the production board. Mirrors master_board_summary's status guard. */
export function rowIsInbox(row: MasterRow): boolean {
  return (
    row.status === 'parsing' ||
    row.status === 'draft' ||
    row.status === 'failed'
  )
}

/** True when the job is deliberately on hold (暂停). Independent of isShipped;
 *  the 在产 / 暂停 / 已出货 split treats 暂停 as a slice of not-yet-shipped. */
export function rowIsPaused(row: MasterRow): boolean {
  return Boolean(row.pausedAt)
}

/** Computes effectiveDueDate from a dueDate + activeReturn — mirrors lib/data.ts. */
export function computeEffectiveDueDate(
  dueDate: string,
  activeReturn?: { dueDate?: string | null } | null,
): string {
  if (activeReturn?.dueDate) return activeReturn.dueDate
  return dueDate
}

/** Computes isShipped from the 出货 cell. */
export function computeIsShipped(cells: Partial<Record<Stage, MasterCell>>): boolean {
  const c = cells['出货']
  if (!c || c.total === 0) return false
  return c.inProgress === 0 && c.pending === 0
}

/** Convenience: dueState + days-from-today on a row, since both call sites
 *  on the master page need both. */
export function rowDueState(row: MasterRow, ref: string = today()) {
  return dueState(row.effectiveDueDate, ref)
}

/** Replaces lib/_workbench.tsx#jobIsDownstreamOf. At 出货 specifically the
 *  third tab pivots to "已出货" so the caller checks isShipped instead. */
export function rowIsDownstreamOf(row: MasterRow, stage: Stage): boolean {
  if (stage === '出货') return row.isShipped
  if (row.isShipped) return false
  const idx = STAGES.indexOf(stage)
  if (idx < 0) return false
  for (let i = idx + 1; i < STAGES.length; i++) {
    const c = row.cells[STAGES[i]]
    if (!c) continue
    // Some part has moved past pending at a later stage → downstream signal.
    // "Closed" outsourced and in-house done both count; vendor-open work also
    // counts as "moved past me." Matches effectiveStageState's done/outsourced
    // branches in lib/data.ts#jobIsDownstreamOf.
    if (c.inProgress > 0 || c.inHouseDone > 0 || c.outsourcedClosed > 0 || c.outsourcedOpen > 0) {
      return true
    }
  }
  return false
}

/** Replaces lib/_workbench.tsx#upstreamActiveStages — prior stages with
 *  in_progress in-house work OR open outsource. Closed-outsource priors are
 *  effectively done so they don't show as "正在 · ...". */
export function rowUpstreamActiveStages(row: MasterRow, stage: Stage): Stage[] {
  const idx = STAGES.indexOf(stage)
  if (idx <= 0) return []
  const out: Stage[] = []
  for (let i = 0; i < idx; i++) {
    const s = STAGES[i]
    const c = row.cells[s]
    if (!c) continue
    if (c.inProgress > 0 || c.outsourcedOpen > 0) out.push(s)
  }
  return out
}
