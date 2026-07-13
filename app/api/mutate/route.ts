import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import {
  addOutsourceBlockMembers,
  appendComponent,
  assignJobToStage,
  assignToStage,
  closeReturn,
  createDailyFocusItem,
  createExpense,
  createExpenses,
  createNote,
  updateNote,
  deleteNote,
  raisePartDrawingChange,
  clearPartDrawingChange,
  createHandover,
  createOutsourceBlockAt,
  createProcurement,
  createProcurementProduct,
  createReturn,
  createVendor,
  deleteDailyFocusItem,
  deleteExpense,
  deleteHandover,
  deleteProcurement,
  deleteProcurementProduct,
  deleteComponent,
  deleteOutsourceBlock,
  deletePartPhoto,
  removeOutsourceBlockMember,
  finishJobStage,
  finishStage,
  getCachedMutationResponse,
  getJob,
  getMasterRowsByIds,
  recordMutationResponse,
  markJobAsDraft,
  prepareShipping,
  setBlockMembersReturnedQty,
  setBlockMemberUnitPrice,
  setBlockMemberQty,
  setComponentImage,
  setJobPin,
  setJobStagePin,
  setInspectionVerdict,
  setInspectionVerdictDetail,
  setOutsourceBlockStages,
  setJobIsProduct,
  setJobPaused,
  setJobType,
  setMemberReturnedQty,
  setPartRoute,
  setStageDoneQty,
  startJobStage,
  startStage,
  undoJobStage,
  undoStage,
  updateComponent,
  updateCustomer,
  updateDailyFocusItem,
  updateExpense,
  updateHandover,
  updateProcurement,
  updateProcurementProduct,
  updateJob,
  setJobStagePlan,
  updateOutsourceBlock,
  stampBlockWechatSent,
  updateShipmentFinance,
  updateVendor,
  upsertCustomerByName,
  upsertInspectionReport,
  createCaiwuRow,
  updateCaiwuRow,
  deleteCaiwuRow,
  createPoLine,
  updatePoLine,
  deletePoLine,
  createMoneyEvent,
  voidMoneyEvent,
  setJobBillable,
  type BlockPatch,
  type CaiwuPatch,
  type ComponentPatch,
  type CreateReturnInput,
  type CustomerPatch,
  type AddBlockMemberInput,
  type DailyFocusPatch,
  type NewCaiwuInput,
  type ExpensePatch,
  type HandoverPatch,
  type JobPatch,
  type NewBlockInput,
  type NewDailyFocusInput,
  type NewExpenseInput,
  type NewHandoverInput,
  type NewMoneyEventInput,
  type NewProcurementInput,
  type NewProcurementProductInput,
  type PoLinePatch,
  type ProcurementPatch,
  type ProcurementProductPatch,
  type ShipmentFinancePatch,
  type VendorPatch,
} from '@/lib/db'
import {
  canManageOutsource,
  canSeeExpenses,
  canSeeFactoryPulse,
  canSeeMoney,
  canUseNotes,
  currentUser,
  requireCommerce,
  requireOutsourceManager,
  requirePartRouteEditor,
  requireUser,
  type AuthUser,
} from '@/lib/auth'
import { logStageAction } from '@/lib/access-log'
import type { JobType, PlanKey, Stage, Verdict } from '@/lib/data'
import { rowStageCounts } from '@/lib/master'
import { isCaiwuSheet, JOB_TYPES, STAGES, VERDICTS } from '@/lib/data'
import { isExpenseCategory } from '@/lib/expenses'
import { isDimRow, type InspectionReportPatch } from '@/lib/inspection-report'
import { removeInspectionPhotoObject } from '@/lib/inspection-photo'
import { deleteContractFile } from '@/lib/contract-file'
import { deleteExpenseVoucher } from '@/lib/voucher-file'

// Single JSON dispatcher for mutating writes. Every existing inline-edit
// surface (job/component fields, stage cells, routing chips, outsource block
// edits, returns, shipping prep) used to call a Next.js server action. The
// action's response wire format inlines the current page's RSC payload so
// React can re-render in place — that fat sustained HTTP/2 stream is what the
// GFW kills on mainland → HK links, surfacing as the "this page couldn't
// load" overlay. This route writes the same data via the same `lib/db`
// functions but returns ~30 bytes of JSON, matching the survivability of the
// existing /api/job-status poller. Clients update local state optimistically;
// `force-dynamic` pages re-render with fresh data on the next navigation.
//
// We still call `revalidatePath` here (page-scoped, never `'layout'`) so other
// browsers' router caches pick up the change on next navigation. The CRITICAL
// difference vs server actions: this response itself contains no RSC.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ok<T = undefined> = T extends undefined
  ? { ok: true }
  : { ok: true; data: T }

type Err = { ok: false; error: string }

function ok<T>(data?: T): Ok<T> {
  return (data === undefined ? { ok: true } : { ok: true, data }) as Ok<T>
}

function err(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message } satisfies Err, { status })
}

// Post-write read-back for the job-level stage actions. The write has already
// committed by the time this runs, so a read failure must NOT fail the
// request — return undefined and the client synthesizes the transition
// optimistically instead.
async function freshStageCounts(
  jobId: string,
  stage: Stage,
): Promise<
  { counts: { inProgress: number; pending: number; done: number } } | undefined
> {
  try {
    const [row] = await getMasterRowsByIds([jobId])
    if (!row) return undefined
    return { counts: rowStageCounts(row, stage) }
  } catch {
    return undefined
  }
}

// In-memory idempotency cache. Clients (lib/mutate.ts) attach a UUID
// requestId to every POST. If the same requestId arrives twice within the
// TTL window — which happens when the response of the first attempt was
// killed mid-flight by the mainland↔HK link and the client retried — we
// serve the cached response instead of re-running the write. Without this,
// non-idempotent kinds (appendComponent, createOutsourceBlock, createReturn)
// would double-apply on retry. Single pm2 worker so a Map is sufficient;
// if we ever scale workers, this becomes Redis or a Postgres table.
type CachedResponse = {
  body: unknown
  status: number
  expiresAt: number
}
const IDEMPOTENCY_TTL_MS = 60_000
const IDEMPOTENCY_MAX_ENTRIES = 2000
const idempotencyCache = new Map<string, CachedResponse>()

function evictExpired(now: number) {
  for (const [k, v] of idempotencyCache) {
    if (v.expiresAt < now) idempotencyCache.delete(k)
  }
  // Map iteration order is insertion order; trim the oldest.
  if (idempotencyCache.size > IDEMPOTENCY_MAX_ENTRIES) {
    const overflow = idempotencyCache.size - IDEMPOTENCY_MAX_ENTRIES
    let i = 0
    for (const k of idempotencyCache.keys()) {
      if (i++ >= overflow) break
      idempotencyCache.delete(k)
    }
  }
}

// Wraps a Response such that we can both (a) return it to the original
// caller and (b) cache its body/status for a future retry. Response bodies
// can only be read once, so we capture body+status BEFORE constructing the
// outgoing Response.
async function cacheAndSend(
  requestId: string | null,
  body: unknown,
  status: number,
): Promise<Response> {
  if (requestId) {
    const now = Date.now()
    idempotencyCache.set(requestId, {
      body,
      status,
      expiresAt: now + IDEMPOTENCY_TTL_MS,
    })
    evictExpired(now)
    // Persist to the cross-worker store so a retry on another cluster worker
    // replays instead of re-applying. Fire-and-forget: awaiting would add a
    // round-trip to the response the client is waiting on, and a lost record
    // only weakens dedupe (never corrupts the write that already committed).
    void recordMutationResponse(requestId, status, body)
  }
  return Response.json(body, { status })
}

function isString(x: unknown): x is string {
  return typeof x === 'string'
}

function isStage(x: unknown): x is Stage {
  // Derive from the canonical STAGES list rather than a parallel literal — the
  // 喷漆丝印 → 喷漆/丝印 split (migration 0040) showed how a hand-copied stage
  // list silently drifts out of sync with lib/data.ts.
  return isString(x) && (STAGES as readonly string[]).includes(x)
}

// stage_plan keys: any 工段 plus the job-level 外协 slot (see PlanKey).
function isPlanKey(x: unknown): x is PlanKey {
  return isStage(x) || x === '外协'
}

function isVerdict(x: unknown): x is Verdict {
  // Same derive-don't-copy rule as isStage.
  return isString(x) && (VERDICTS as readonly string[]).includes(x)
}

function isValidHandoverItems(x: unknown): x is NewHandoverInput['items'] {
  if (!Array.isArray(x)) return false
  return x.every((it) => {
    if (typeof it !== 'object' || it === null) return false
    const o = it as Record<string, unknown>
    for (const f of ['orderNo', 'jobId', 'matter', 'owner', 'note']) {
      if (o[f] !== undefined && o[f] !== null && typeof o[f] !== 'string')
        return false
    }
    return true
  })
}

function isValidHandoverInput(x: unknown): x is NewHandoverInput {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (!isString(o.giver) || o.giver.trim().length === 0) return false
  if (!isString(o.date) || o.date.trim().length === 0) return false
  for (const f of ['department', 'reason', 'receiver']) {
    if (o[f] !== undefined && o[f] !== null && typeof o[f] !== 'string')
      return false
  }
  return isValidHandoverItems(o.items)
}

function isOptNumber(x: unknown): boolean {
  return x === undefined || x === null || typeof x === 'number'
}
function isOptString(x: unknown): boolean {
  return x === undefined || x === null || typeof x === 'string'
}

function isValidProcurementInput(x: unknown): x is NewProcurementInput {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (!isString(o.item) || o.item.trim().length === 0) return false
  if (!isString(o.orderDate) || o.orderDate.trim().length === 0) return false
  if (!isOptNumber(o.qty) || !isOptNumber(o.unitPriceCny)) return false
  if (!isOptString(o.supplier) || !isOptString(o.notes)) return false
  if (!isOptString(o.expectedDate)) return false
  if (!isOptString(o.productId) || !isOptString(o.link)) return false
  return true
}

function isValidProcurementPatch(x: unknown): x is ProcurementPatch {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (o.item !== undefined && (!isString(o.item) || o.item.trim().length === 0))
    return false
  if (
    o.orderDate !== undefined &&
    (!isString(o.orderDate) || o.orderDate.trim().length === 0)
  )
    return false
  if (!isOptNumber(o.qty) || !isOptNumber(o.unitPriceCny)) return false
  for (const f of ['supplier', 'expectedDate', 'arrivedDate', 'notes', 'link']) {
    if (!isOptString(o[f])) return false
  }
  if (
    o.status !== undefined &&
    o.status !== 'ordered' &&
    o.status !== 'arrived'
  )
    return false
  return true
}

function isValidProcurementProductInput(
  x: unknown,
): x is NewProcurementProductInput {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (!isString(o.name) || o.name.trim().length === 0) return false
  if (!isOptNumber(o.unitPriceCny)) return false
  for (const f of ['category', 'supplier', 'link', 'notes']) {
    if (!isOptString(o[f])) return false
  }
  return true
}

function isValidProcurementProductPatch(
  x: unknown,
): x is ProcurementProductPatch {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (o.name !== undefined && (!isString(o.name) || o.name.trim().length === 0))
    return false
  if (!isOptNumber(o.unitPriceCny)) return false
  for (const f of ['category', 'supplier', 'link', 'notes']) {
    if (!isOptString(o[f])) return false
  }
  return true
}

function isValidExpenseInput(x: unknown): x is NewExpenseInput {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (!isString(o.expenseDate) || !/^\d{4}-\d{2}-\d{2}$/.test(o.expenseDate))
    return false
  if (!isExpenseCategory(o.category)) return false
  if (typeof o.amountCny !== 'number' || !Number.isFinite(o.amountCny) || o.amountCny < 0)
    return false
  if (!isOptString(o.payee) || !isOptString(o.note)) return false
  return true
}

function isValidExpensePatch(x: unknown): x is ExpensePatch {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (
    o.expenseDate !== undefined &&
    (!isString(o.expenseDate) || !/^\d{4}-\d{2}-\d{2}$/.test(o.expenseDate))
  )
    return false
  if (o.category !== undefined && !isExpenseCategory(o.category)) return false
  if (
    o.amountCny !== undefined &&
    (typeof o.amountCny !== 'number' ||
      !Number.isFinite(o.amountCny) ||
      o.amountCny < 0)
  )
    return false
  if (!isOptString(o.payee) || !isOptString(o.note)) return false
  return true
}

function isValidDailyFocusInput(x: unknown): x is NewDailyFocusInput {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (!isString(o.day) || !/^\d{4}-\d{2}-\d{2}$/.test(o.day)) return false
  if (!isString(o.jobNoText)) return false
  if (!isOptString(o.jobId) || !isOptNumber(o.position)) return false
  for (const f of ['productText', 'dueText', 'feedback']) {
    if (!isOptString(o[f])) return false
  }
  // A row must carry SOMETHING — 单号 may be blank (note-only Excel lines)
  // but a fully empty row is a no-op the client should never send.
  const hasContent =
    o.jobNoText.trim().length > 0 ||
    ['productText', 'dueText', 'feedback'].some(
      (f) => typeof o[f] === 'string' && (o[f] as string).trim().length > 0,
    )
  return hasContent
}

function isValidDailyFocusPatch(x: unknown): x is DailyFocusPatch {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (o.jobNoText !== undefined && !isString(o.jobNoText)) return false
  if (!isOptNumber(o.position)) return false
  for (const f of ['jobId', 'productText', 'dueText', 'feedback']) {
    if (!isOptString(o[f])) return false
  }
  return true
}

// The free-text cell fields a caiwu row carries beyond 工号 / job link. Kept in
// sync with CAIWU_FIELD_COLS in lib/db.ts.
const CAIWU_CELL_FIELDS = [
  'customer',
  'contact',
  'date',
  'orderNo',
  'qty',
  'billable',
  'amount',
  'tax',
  'amountIncl',
  'invoiceNo',
  'log',
] as const

function isValidCaiwuInput(x: unknown): x is NewCaiwuInput {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (!isCaiwuSheet(o.sheet)) return false
  if (o.jobNoText !== undefined && !isString(o.jobNoText)) return false
  if (!isOptString(o.jobId) || !isOptNumber(o.position)) return false
  for (const f of CAIWU_CELL_FIELDS) if (!isOptString(o[f])) return false
  // A row must carry SOMETHING — an empty row is a no-op the client never sends.
  const hasContent =
    (typeof o.jobNoText === 'string' && o.jobNoText.trim().length > 0) ||
    Boolean(o.jobId) ||
    CAIWU_CELL_FIELDS.some(
      (f) => typeof o[f] === 'string' && (o[f] as string).trim().length > 0,
    )
  return hasContent
}

function isValidCaiwuPatch(x: unknown): x is CaiwuPatch {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (o.jobNoText !== undefined && !isString(o.jobNoText)) return false
  if (!isOptNumber(o.position) || !isOptString(o.jobId)) return false
  for (const f of CAIWU_CELL_FIELDS) if (!isOptString(o[f])) return false
  return true
}

type Body = Record<string, unknown> & { kind?: unknown }

export async function POST(request: NextRequest): Promise<Response> {
  const user = await currentUser()
  if (!user) return err('unauthorized', 401)

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return err('invalid json', 400)
  }
  const kind = body.kind
  if (!isString(kind)) return err('missing kind', 400)

  const requestId =
    typeof body.requestId === 'string' ? (body.requestId as string) : null

  // Idempotency: a client retry after a killed response carries the same
  // requestId; replay the cached reply instead of double-applying the write.
  // In-memory Map is the same-worker fast path; under pm2 cluster a retry can
  // hit a different worker, so we also consult the durable mutation_log store
  // (no-op if migration 0058 isn't applied yet).
  if (requestId) {
    const cached = idempotencyCache.get(requestId)
    if (cached && cached.expiresAt > Date.now()) {
      return Response.json(cached.body, { status: cached.status })
    }
    const durable = await getCachedMutationResponse(requestId)
    if (durable) {
      // Warm the local Map so subsequent same-worker retries skip the DB.
      idempotencyCache.set(requestId, {
        body: durable.body,
        status: durable.status,
        expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
      })
      return Response.json(durable.body, { status: durable.status })
    }
  }

  let response: Response
  try {
    response = await dispatch(kind, body)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[mutate]', kind, message)
    return cacheAndSend(
      requestId,
      { ok: false, error: message } satisfies Err,
      500,
    )
  }

  // dispatch() returns its result via Response.json(). Read it back so we
  // can cache body+status alongside the requestId, then reconstruct a fresh
  // Response. Cheap round-trip; the bodies are ~30 bytes.
  const status = response.status
  let parsedBody: unknown
  try {
    parsedBody = await response.json()
  } catch {
    // Shouldn't happen for any current dispatch case, but if it does we
    // fall through with no caching — the client will see the raw status.
    return Response.json({ ok: false, error: `HTTP ${status}` }, { status })
  }
  // Telemetry: where do 报工 taps physically happen — board cell, station
  // queue, or inside the job page? And how often does the clerk generate
  // the 微信 paste? Referer carries the answer. Successful calls only;
  // runs in after(), can never touch the response.
  if (status === 200 && LOGGED_KINDS.has(kind)) {
    logStageAction({
      userName: user.name,
      role: user.role,
      defaultStage: user.defaultStage,
      kind,
      stage: typeof body.stage === 'string' ? body.stage : undefined,
      referer: request.headers.get('referer'),
    })
  }
  return cacheAndSend(requestId, parsedBody, status)
}

// The 报工 tap family (the clicks whose LOCATION the owner asked about)
// plus the 微信-copy stamp (every copy re-fires it, so counting rows counts
// paste generations). Text edits, plan dates, outsource lifecycle etc. are
// deliberately not logged: they'd swamp the signal.
const LOGGED_KINDS = new Set([
  'startStage',
  'finishStage',
  'undoStage',
  'setStageDoneQty',
  'startJobStage',
  'finishJobStage',
  'undoJobStage',
  'setBlockWechatSent',
])

// Page-scoped revalidate helpers — never use `'layout'`. Each helper
// invalidates only the surface that genuinely changed so the next nav from
// any other browser reads fresh data, without inflating the response of
// THIS request (which is plain JSON anyway).
function revalidateJob(jobId: string) {
  revalidatePath('/')
  revalidatePath(`/jobs/${jobId}`)
  revalidatePath(`/import/${jobId}`)
}

function revalidateStage(jobId: string, stage: Stage) {
  revalidatePath('/')
  revalidatePath(`/jobs/${jobId}`)
  revalidatePath(`/station/${encodeURIComponent(stage)}`)
  revalidatePath(`/station/${encodeURIComponent(stage)}/${jobId}`)
}

function revalidateExternal(jobId?: string) {
  revalidatePath('/')
  revalidatePath('/station/outsource')
  if (jobId) revalidatePath(`/jobs/${jobId}`)
}

// Auth gates mirror the server-action versions in app/actions.ts exactly.
// Production-station users that are not 工程 head can only mutate their own
// stage column.
async function requireOwnStage(stage: Stage): Promise<AuthUser> {
  const u = await requireUser()
  if (
    u.role === 'production' &&
    u.defaultStage !== '工程' &&
    u.defaultStage !== stage
  ) {
    throw new Error('无权操作其他工段')
  }
  return u
}

async function dispatch(
  kind: string,
  body: Body,
): Promise<Response> {
  switch (kind) {
    // === Job-level edits ===
    case 'updateJob': {
      const jobId = body.jobId
      const patch = body.patch
      if (!isString(jobId) || typeof patch !== 'object' || patch === null)
        return err('bad updateJob args')
      await requirePartRouteEditor()
      await updateJob(jobId, patch as JobPatch)
      revalidateJob(jobId)
      return Response.json(ok())
    }

    // 计划交期 (排产) — set/clear ONE 工段's planned finish date. Single-stage on
    // purpose: the server merges it into the holistic map atomically, so the
    // client never ships (and can never clobber) the whole map.
    case 'setStagePlan': {
      const jobId = body.jobId
      const stage = body.stage
      const value = body.value
      if (!isString(jobId) || !isPlanKey(stage))
        return err('bad setStagePlan args')
      if (value !== null && value !== undefined && !isString(value))
        return err('bad stage plan value')
      // Only accept YYYY-MM-DD or YYYY-MM-DDTHH:mm so a stray/garbage string
      // can never land in the plan map. Empty/null clears (handled below).
      if (
        isString(value) &&
        value !== '' &&
        !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(value)
      )
        return err('bad stage plan date')
      await requirePartRouteEditor()
      await setJobStagePlan(jobId, stage, isString(value) ? value : null)
      revalidateJob(jobId)
      return Response.json(ok())
    }

    case 'updateJobNotes': {
      const jobId = body.jobId
      const notes = body.notes
      if (!isString(jobId)) return err('bad updateJobNotes args')
      if (notes !== null && !isString(notes)) return err('bad notes')
      await requireUser()
      await updateJob(jobId, { notes: notes as string | null })
      revalidateJob(jobId)
      return Response.json(ok())
    }

    // 外协预警 (待外协) — 工程 raises the heads-up that this job needs
    // outsourcing, before any vendor block exists. needs=true stamps the flag
    // + note + who/when; needs=false clears it. 商务 reads it as a pending
    // action on the master grid; createOutsourceBlockAt clears it on its own
    // once the block is made. Auth: the outsource managers (商务 + 工程 head).
    case 'setJobOutsourceFlag': {
      const jobId = body.jobId
      const needs = body.needs
      const note = body.note
      if (!isString(jobId) || typeof needs !== 'boolean')
        return err('bad setJobOutsourceFlag args')
      if (note !== undefined && note !== null && !isString(note))
        return err('bad note')
      const u = await requireOutsourceManager()
      const patch: JobPatch = needs
        ? {
            needsOutsource: true,
            // null (note explicitly emptied) clears it; undefined (note not
            // sent) leaves the existing note untouched.
            outsourceNote:
              note === undefined ? undefined : (note as string | null),
            outsourceFlaggedBy: u.name,
            outsourceFlaggedAt: new Date().toISOString(),
          }
        : {
            needsOutsource: false,
            outsourceNote: null,
            outsourceFlaggedBy: null,
            outsourceFlaggedAt: null,
          }
      await updateJob(jobId, patch)
      revalidateJob(jobId)
      revalidatePath('/station/outsource')
      return Response.json(ok())
    }

    // 零件图纸变更 — per-part drawing revisions (一次/二次/三次). The customer
    // revised drawings on a part mid-production; anyone cutting to the old
    // sheet is making scrap. Same auth as 外协 / 退货 (商务 + 工程 head). Raising
    // adds revision N+1 and lights the derived job headline; clearing a part
    // drops it when no other part is still open. There is no whole-job alarm.
    case 'raisePartDrawingChange': {
      const jobId = body.jobId
      const partId = body.partId
      const note = body.note
      const imageUrl = body.imageUrl
      if (!isString(jobId) || !isString(partId))
        return err('bad raisePartDrawingChange args')
      if (note !== undefined && note !== null && !isString(note))
        return err('bad note')
      if (imageUrl !== undefined && imageUrl !== null && !isString(imageUrl))
        return err('bad imageUrl')
      const u = await requireOutsourceManager()
      const revision = await raisePartDrawingChange({
        componentId: partId,
        jobId,
        note: typeof note === 'string' ? note : undefined,
        imageUrl: typeof imageUrl === 'string' ? imageUrl : undefined,
        raisedBy: u.name,
      })
      revalidateJob(jobId)
      return Response.json(ok({ revision }))
    }

    case 'clearPartDrawingChange': {
      const jobId = body.jobId
      const partId = body.partId
      if (!isString(jobId) || !isString(partId))
        return err('bad clearPartDrawingChange args')
      const u = await requireOutsourceManager()
      await clearPartDrawingChange({ componentId: partId, jobId, clearedBy: u.name })
      revalidateJob(jobId)
      return Response.json(ok())
    }

    // === Component-level edits ===
    case 'updateComponent': {
      const jobId = body.jobId
      const componentId = body.componentId
      const patch = body.patch
      if (
        !isString(jobId) ||
        !isString(componentId) ||
        typeof patch !== 'object' ||
        patch === null
      )
        return err('bad updateComponent args')
      await requirePartRouteEditor()
      await updateComponent(jobId, componentId, patch as ComponentPatch)
      revalidateJob(jobId)
      return Response.json(ok())
    }

    case 'setComponentImage': {
      const jobId = body.jobId
      const componentId = body.componentId
      const imageUrl = body.imageUrl
      if (!isString(jobId) || !isString(componentId))
        return err('bad setComponentImage args')
      if (imageUrl !== null && !isString(imageUrl))
        return err('bad imageUrl')
      await requirePartRouteEditor()
      await setComponentImage(jobId, componentId, imageUrl as string | null)
      revalidateJob(jobId)
      return Response.json(ok())
    }

    case 'appendComponent': {
      const jobId = body.jobId
      if (!isString(jobId)) return err('bad appendComponent args')
      await requirePartRouteEditor()
      const id = await appendComponent(jobId)
      revalidateJob(jobId)
      return Response.json(ok({ id }))
    }

    case 'deleteComponent': {
      const jobId = body.jobId
      const componentId = body.componentId
      if (!isString(jobId) || !isString(componentId))
        return err('bad deleteComponent args')
      await requirePartRouteEditor()
      await deleteComponent(jobId, componentId)
      revalidateJob(jobId)
      return Response.json(ok())
    }

    case 'setPartRoute': {
      const jobId = body.jobId
      const componentId = body.componentId
      const stages = body.stages
      const force = body.force === true
      if (
        !isString(jobId) ||
        !isString(componentId) ||
        !Array.isArray(stages) ||
        !stages.every(isStage)
      )
        return err('bad setPartRoute args')
      await requirePartRouteEditor()
      const result = await setPartRoute(jobId, componentId, stages as Stage[], {
        force,
      })
      if (result.ok) revalidateJob(jobId)
      return Response.json(ok(result))
    }

    // === Stage cell actions (per-component) ===
    case 'startStage': {
      const jobId = body.jobId
      const componentId = body.componentId
      const stage = body.stage
      if (!isString(jobId) || !isString(componentId) || !isStage(stage))
        return err('bad startStage args')
      const u = await requireOwnStage(stage)
      await startStage(jobId, componentId, stage, u.name)
      revalidateStage(jobId, stage)
      return Response.json(ok())
    }

    case 'finishStage': {
      const jobId = body.jobId
      const componentId = body.componentId
      const stage = body.stage
      if (!isString(jobId) || !isString(componentId) || !isStage(stage))
        return err('bad finishStage args')
      const u = await requireOwnStage(stage)
      await finishStage(jobId, componentId, stage, u.name)
      revalidateStage(jobId, stage)
      return Response.json(ok())
    }

    case 'undoStage': {
      const jobId = body.jobId
      const componentId = body.componentId
      const stage = body.stage
      if (!isString(jobId) || !isString(componentId) || !isStage(stage))
        return err('bad undoStage args')
      await requireOwnStage(stage)
      await undoStage(jobId, componentId, stage)
      revalidateStage(jobId, stage)
      return Response.json(ok())
    }

    case 'setStageDoneQty': {
      const jobId = body.jobId
      const componentId = body.componentId
      const stage = body.stage
      const qty = body.qty
      if (
        !isString(jobId) ||
        !isString(componentId) ||
        !isStage(stage) ||
        typeof qty !== 'number'
      )
        return err('bad setStageDoneQty args')
      const u = await requireOwnStage(stage)
      await setStageDoneQty(jobId, componentId, stage, qty, u.name)
      revalidateStage(jobId, stage)
      return Response.json(ok())
    }

    // 检验 verdict — the inspector's four buttons (重做/返修/外修/OK). OK
    // finishes the stage like a normal ✓; the rest hold the part at 检验
    // with a red tag. Clicking a verdict IS the inspection — no prior ▶.
    case 'setInspectionVerdict': {
      const jobId = body.jobId
      const componentId = body.componentId
      const verdict = body.verdict
      if (!isString(jobId) || !isString(componentId) || !isVerdict(verdict))
        return err('bad setInspectionVerdict args')
      const u = await requireOwnStage('检验')
      await setInspectionVerdict(jobId, componentId, verdict, u.name)
      revalidateStage(jobId, '检验')
      return Response.json(ok())
    }

    // 不良原因 / 责任人 on the 检验 verdict — commits on blur from the
    // inspection modal, independent of the verdict click.
    case 'setInspectionVerdictDetail': {
      const jobId = body.jobId
      const componentId = body.componentId
      const reason = body.reason
      const owner = body.owner
      const note = body.note
      if (!isString(jobId) || !isString(componentId)) {
        return err('bad setInspectionVerdictDetail args')
      }
      if (reason !== undefined && reason !== null && !isString(reason))
        return err('bad reason')
      if (owner !== undefined && owner !== null && !isString(owner))
        return err('bad owner')
      if (note !== undefined && note !== null && !isString(note))
        return err('bad note')
      await requireOwnStage('检验')
      await setInspectionVerdictDetail(jobId, componentId, {
        reason: reason as string | null | undefined,
        owner: owner as string | null | undefined,
        note: note as string | null | undefined,
      })
      revalidateStage(jobId, '检验')
      return Response.json(ok())
    }

    // 检验照片 removal. Upload goes through /api/upload-inspection-photo
    // (multipart); deletion is a normal JSON mutation. Row first (source of
    // truth), then best-effort storage object removal.
    case 'deletePartPhoto': {
      const jobId = body.jobId
      const photoId = body.photoId
      if (!isString(jobId) || !isString(photoId))
        return err('bad deletePartPhoto args')
      await requireOwnStage('检验')
      const url = await deletePartPhoto(jobId, photoId)
      if (url) await removeInspectionPhotoObject(url)
      revalidatePath(`/jobs/${jobId}`)
      return Response.json(ok())
    }

    // 合同 removal. Upload goes through /api/upload-contract (multipart);
    // deletion is a normal JSON mutation. Commerce-only (the 财务 surface).
    case 'deleteContract': {
      const jobId = body.jobId
      const contractId = body.contractId
      if (!isString(jobId) || !isString(contractId))
        return err('bad deleteContract args')
      await requireCommerce()
      await deleteContractFile(jobId, contractId)
      revalidatePath(`/jobs/${jobId}`)
      return Response.json(ok())
    }

    // 凭证 removal. Upload goes through /api/upload-voucher (multipart);
    // deletion is a normal JSON mutation. Gated to the 支出 surface (boss +
    // finance users), same as the expense ledger.
    case 'deleteVoucher': {
      const expenseId = body.expenseId
      const voucherId = body.voucherId
      if (!isString(expenseId) || !isString(voucherId))
        return err('bad deleteVoucher args')
      const u = await requireUser()
      if (!canSeeExpenses(u)) return err('forbidden', 403)
      await deleteExpenseVoucher(expenseId, voucherId)
      revalidatePath('/finance')
      return Response.json(ok())
    }

    // === Job-level stage actions (entire job at once) ===
    // Each returns the job's fresh {inProgress, pending, done} for the acted
    // stage. The master board fetches its rows ONCE per navigation (see
    // _master_loaders.tsx) — without this echo the cell's finish-vs-start
    // decision keeps reading the mount-time counts, so ▶ then ⏸ in the same
    // session re-issued startJobStage forever instead of finishing.
    case 'startJobStage': {
      const jobId = body.jobId
      const stage = body.stage
      if (!isString(jobId) || !isStage(stage))
        return err('bad startJobStage args')
      const u = await requireOwnStage(stage)
      await startJobStage(jobId, stage, u.name)
      revalidateStage(jobId, stage)
      return Response.json(ok(await freshStageCounts(jobId, stage)))
    }

    case 'finishJobStage': {
      const jobId = body.jobId
      const stage = body.stage
      if (!isString(jobId) || !isStage(stage))
        return err('bad finishJobStage args')
      const u = await requireOwnStage(stage)
      await finishJobStage(jobId, stage, u.name)
      revalidateStage(jobId, stage)
      return Response.json(ok(await freshStageCounts(jobId, stage)))
    }

    case 'undoJobStage': {
      const jobId = body.jobId
      const stage = body.stage
      if (!isString(jobId) || !isStage(stage))
        return err('bad undoJobStage args')
      await requireOwnStage(stage)
      await undoJobStage(jobId, stage)
      revalidateStage(jobId, stage)
      return Response.json(ok(await freshStageCounts(jobId, stage)))
    }

    case 'assignToStage': {
      const jobId = body.jobId
      const componentId = body.componentId
      const fromStage = body.fromStage
      const toStage = body.toStage
      if (
        !isString(jobId) ||
        !isString(componentId) ||
        !isStage(fromStage) ||
        !isStage(toStage)
      )
        return err('bad assignToStage args')
      const u = await requireOwnStage(fromStage)
      await assignToStage(jobId, componentId, fromStage, toStage, u.name)
      revalidatePath('/')
      revalidatePath(`/jobs/${jobId}`)
      revalidatePath(`/station/${encodeURIComponent(fromStage)}`)
      revalidatePath(`/station/${encodeURIComponent(toStage)}`)
      return Response.json(ok())
    }

    case 'assignJobToStage': {
      const jobId = body.jobId
      const fromStage = body.fromStage
      const toStage = body.toStage
      if (!isString(jobId) || !isStage(fromStage) || !isStage(toStage))
        return err('bad assignJobToStage args')
      const u = await requireOwnStage(fromStage)
      await assignJobToStage(jobId, fromStage, toStage, u.name)
      revalidatePath('/')
      revalidatePath(`/jobs/${jobId}`)
      revalidatePath(`/station/${encodeURIComponent(fromStage)}`)
      revalidatePath(`/station/${encodeURIComponent(fromStage)}/${jobId}`)
      revalidatePath(`/station/${encodeURIComponent(toStage)}`)
      return Response.json(ok())
    }

    // === Pin / unpin (boss's daily 排产 surface) ===
    case 'pinJob': {
      // Row-level master-grid pin (商务/工程's OWN priority sort). Distinct
      // from pinJobStage (per-station floor pin) — different surface,
      // different intent, shared auth.
      const jobId = body.jobId
      const pinned = body.pinned
      if (!isString(jobId) || typeof pinned !== 'boolean')
        return err('bad pinJob args')
      const u = await requireUser()
      if (!canManageOutsource(u)) {
        return err('无权置顶 (仅商务/工程可操作)', 403)
      }
      await setJobPin(jobId, pinned, u.name)
      revalidatePath('/')
      return Response.json(ok())
    }

    // Sets the global classification (短期/中期/长期/加急) on a job. 'rush'
    // is the global pin replacement — it floats the row to the top in every
    // view. Auth mirrors the old pinJob: 商务 + 工程 head only.
    case 'setJobType': {
      const jobId = body.jobId
      const jobType = body.jobType
      if (!isString(jobId)) return err('bad setJobType args')
      if (
        jobType !== null &&
        (!isString(jobType) || !JOB_TYPES.includes(jobType as JobType))
      ) {
        return err('bad setJobType args')
      }
      const u = await requireUser()
      if (!canManageOutsource(u)) {
        return err('无权设置工单类别 (仅商务/工程可操作)', 403)
      }
      await setJobType(jobId, jobType as JobType | null, u.name)
      // Every list-rendering surface re-sorts off jobType — master grid
      // plus every station workbench. Page-scoped only, per the file's
      // "never use 'layout'" rule.
      revalidatePath('/')
      revalidatePath(`/jobs/${jobId}`)
      for (const s of STAGES) {
        revalidatePath(`/station/${encodeURIComponent(s)}`)
      }
      return Response.json(ok())
    }

    // Independent 产品 tag. Same auth as setJobType (商务 + 工程 head).
    case 'setJobIsProduct': {
      const jobId = body.jobId
      const isProduct = body.isProduct
      if (!isString(jobId) || typeof isProduct !== 'boolean')
        return err('bad setJobIsProduct args')
      const u = await requireUser()
      if (!canManageOutsource(u)) {
        return err('无权设置工单类别 (仅商务/工程可操作)', 403)
      }
      await setJobIsProduct(jobId, isProduct)
      revalidatePath('/')
      revalidatePath(`/jobs/${jobId}`)
      for (const s of STAGES) {
        revalidatePath(`/station/${encodeURIComponent(s)}`)
      }
      return Response.json(ok())
    }

    // 暂停 (on-hold) toggle. Independent of setJobType — a job can be 加急 AND
    // 暂停. Unlike setJobType this is OPEN TO ANYONE LOGGED IN: any station can
    // flag a blocker, not just 商务/工程. Reason is optional free text.
    case 'setJobPaused': {
      const jobId = body.jobId
      const paused = body.paused
      const reason = body.reason
      if (!isString(jobId) || typeof paused !== 'boolean')
        return err('bad setJobPaused args')
      if (reason != null && !isString(reason))
        return err('bad setJobPaused args')
      const u = await requireUser()
      await setJobPaused(
        jobId,
        paused,
        (reason as string | undefined) ?? null,
        u.name,
      )
      revalidatePath('/')
      revalidatePath(`/jobs/${jobId}`)
      for (const s of STAGES) {
        revalidatePath(`/station/${encodeURIComponent(s)}`)
      }
      return Response.json(ok())
    }

    case 'pinJobStage': {
      const jobId = body.jobId
      const stage = body.stage
      const pinned = body.pinned
      if (!isString(jobId) || !isStage(stage) || typeof pinned !== 'boolean')
        return err('bad pinJobStage args')
      const u = await requireUser()
      // Only managerial scopes pin: commerce (boss) + 工程 head. Workers
      // see pins but never set them — pinning IS the management surface.
      if (!canManageOutsource(u)) {
        return err('无权置顶 (仅商务/工程可操作)', 403)
      }
      await setJobStagePin(jobId, stage, pinned, u.name)
      revalidatePath('/')
      revalidatePath(`/station/${encodeURIComponent(stage)}`)
      return Response.json(ok())
    }

    // === 出货 ===
    case 'prepareShipping': {
      const jobId = body.jobId
      const selections = body.selections
      if (
        !isString(jobId) ||
        !Array.isArray(selections) ||
        !selections.every(
          (s) =>
            typeof s === 'object' &&
            s !== null &&
            isString((s as { componentId: unknown }).componentId) &&
            typeof (s as { qty: unknown }).qty === 'number',
        )
      )
        return err('bad prepareShipping args')
      const u = await requireOwnStage('出货')
      const result = await prepareShipping(
        jobId,
        selections as { componentId: string; qty: number }[],
        u.name,
      )
      revalidateStage(jobId, '出货')
      revalidatePath(`/jobs/${jobId}/print/shipping`)
      revalidatePath(`/jobs/${jobId}/print/shipping/pdf`)
      return Response.json(ok(result))
    }

    // === Customer / vendor directory ===
    case 'updateCustomer': {
      const customerId = body.customerId
      const patch = body.patch
      if (!isString(customerId) || typeof patch !== 'object' || patch === null)
        return err('bad updateCustomer args')
      await requireCommerce()
      await updateCustomer(customerId, patch as CustomerPatch)
      revalidatePath('/')
      return Response.json(ok())
    }

    case 'setJobCustomerField': {
      const jobId = body.jobId
      const field = body.field
      const value = body.value
      if (
        !isString(jobId) ||
        !isString(field) ||
        !['contact', 'address', 'phone'].includes(field)
      )
        return err('bad setJobCustomerField args')
      if (value !== null && !isString(value)) return err('bad value')
      await requireCommerce()
      const job = await getJob(jobId)
      if (!job) return err('job not found', 404)
      const customerName = job.customer?.trim()
      if (!customerName) return Response.json(ok())
      let customerId = job.customerId
      if (!customerId) {
        const c = await upsertCustomerByName(customerName)
        if (!c) return err('customer upsert failed', 500)
        await updateJob(jobId, { customerId: c.id })
        customerId = c.id
      }
      const patch: CustomerPatch =
        field === 'contact'
          ? { contact: value as string | null }
          : field === 'address'
            ? { address: value as string | null }
            : { phone: value as string | null }
      await updateCustomer(customerId, patch)
      revalidatePath('/')
      return Response.json(ok())
    }

    case 'pickCustomerForJob': {
      const jobId = body.jobId
      const name = body.name
      if (!isString(jobId) || !isString(name))
        return err('bad pickCustomerForJob args')
      await requirePartRouteEditor()
      const trimmed = name.trim()
      if (!trimmed) {
        await updateJob(jobId, { customer: '', customerId: null })
        revalidateJob(jobId)
        return Response.json(ok({ customer: null }))
      }
      const customer = await upsertCustomerByName(trimmed)
      if (!customer) return err('customer upsert failed', 500)
      await updateJob(jobId, {
        customer: customer.name,
        customerId: customer.id,
      })
      revalidateJob(jobId)
      return Response.json(ok({ customer }))
    }

    case 'createVendor': {
      const name = body.name
      const notes = body.notes
      const address = body.address
      if (!isString(name)) return err('bad createVendor args')
      if (notes !== undefined && !isString(notes)) return err('bad notes')
      if (address !== undefined && !isString(address)) return err('bad address')
      await requireOutsourceManager()
      const vendor = await createVendor({
        name,
        notes: notes as string | undefined,
        address: address as string | undefined,
      })
      revalidateExternal()
      return Response.json(ok({ vendor }))
    }

    case 'updateVendor': {
      const vendorId = body.vendorId
      const patch = body.patch
      if (!isString(vendorId) || typeof patch !== 'object' || patch === null)
        return err('bad updateVendor args')
      await requireOutsourceManager()
      await updateVendor(vendorId, patch as VendorPatch)
      revalidateExternal()
      // 'layout' scope here is fine: this response itself is plain JSON with
      // no RSC stream, so the scope only affects the server-side data cache —
      // which we want broad so every printed 外协单 picks up the new vendor
      // name / address on next render. The wire payload mainland clients
      // receive stays small regardless of what we revalidate.
      revalidatePath('/print/outsource', 'layout')
      return Response.json(ok())
    }

    // === 外协 blocks ===
    case 'createOutsourceBlock': {
      const jobId = body.jobId
      const componentIds = body.componentIds
      const input = body.input
      if (
        !isString(jobId) ||
        !Array.isArray(componentIds) ||
        !componentIds.every(isString) ||
        typeof input !== 'object' ||
        input === null
      )
        return err('bad createOutsourceBlock args')
      await requireOutsourceManager()
      const result = await createOutsourceBlockAt(
        jobId,
        componentIds as string[],
        input as NewBlockInput,
      )
      if (result.ok) revalidateExternal(jobId)
      return Response.json(ok({ result }))
    }

    // Edit a block's covered stage set in place — no delete-and-recreate.
    case 'setOutsourceBlockStages': {
      const blockId = body.blockId
      const stages = body.stages
      const jobId = body.jobId
      if (
        !isString(blockId) ||
        !Array.isArray(stages) ||
        !stages.every((s: unknown) => isString(s) && (STAGES as readonly string[]).includes(s))
      )
        return err('bad setOutsourceBlockStages args')
      await requireOutsourceManager()
      const result = await setOutsourceBlockStages(
        blockId,
        stages as Stage[],
        body.force === true,
      )
      if (result.ok) {
        if (isString(jobId)) revalidateExternal(jobId)
        revalidatePath(`/print/outsource/${blockId}`)
      }
      return Response.json(ok({ result }))
    }

    // Add parts to an existing block (the "forgot one part" fix).
    case 'addOutsourceBlockMembers': {
      const blockId = body.blockId
      const items = body.items
      const jobId = body.jobId
      const validItem = (x: unknown): boolean => {
        if (typeof x !== 'object' || x === null) return false
        const o = x as Record<string, unknown>
        if (!isString(o.componentId)) return false
        if (!isOptNumber(o.qty) || !isOptNumber(o.unitPriceCny)) return false
        return true
      }
      if (
        !isString(blockId) ||
        !Array.isArray(items) ||
        items.length === 0 ||
        !items.every(validItem)
      )
        return err('bad addOutsourceBlockMembers args')
      await requireOutsourceManager()
      const result = await addOutsourceBlockMembers(
        blockId,
        items as AddBlockMemberInput[],
        body.force === true,
      )
      if (result.ok) {
        if (isString(jobId)) revalidateExternal(jobId)
        revalidatePath(`/print/outsource/${blockId}`)
      }
      return Response.json(ok({ result }))
    }

    case 'updateOutsourceBlock': {
      const blockId = body.blockId
      const patch = body.patch
      const jobId = body.jobId
      if (!isString(blockId) || typeof patch !== 'object' || patch === null)
        return err('bad updateOutsourceBlock args')
      if (jobId !== undefined && !isString(jobId)) return err('bad jobId')
      await requireOutsourceManager()
      await updateOutsourceBlock(blockId, patch as BlockPatch)
      revalidateExternal(jobId as string | undefined)
      revalidatePath(`/print/outsource/${blockId}`)
      return Response.json(ok())
    }

    case 'setBlockWechatSent': {
      const blockId = body.blockId
      const jobId = body.jobId
      if (!isString(blockId)) return err('bad setBlockWechatSent args')
      if (jobId !== undefined && !isString(jobId)) return err('bad jobId')
      await requireOutsourceManager()
      await stampBlockWechatSent(blockId)
      revalidateExternal(jobId as string | undefined)
      return Response.json(ok())
    }

    case 'deleteOutsourceBlock': {
      const blockId = body.blockId
      const jobId = body.jobId
      if (!isString(blockId)) return err('bad deleteOutsourceBlock args')
      if (jobId !== undefined && !isString(jobId)) return err('bad jobId')
      await requireOutsourceManager()
      await deleteOutsourceBlock(blockId)
      revalidateExternal(jobId as string | undefined)
      return Response.json(ok())
    }

    case 'removeOutsourceBlockMember': {
      const blockId = body.blockId
      const componentId = body.componentId
      const jobId = body.jobId
      if (!isString(blockId) || !isString(componentId))
        return err('bad removeOutsourceBlockMember args')
      if (jobId !== undefined && !isString(jobId)) return err('bad jobId')
      await requireOutsourceManager()
      await removeOutsourceBlockMember(blockId, componentId)
      revalidateExternal(jobId as string | undefined)
      revalidatePath(`/print/outsource/${blockId}`)
      revalidatePath(`/print/outsource/${blockId}/pdf`)
      revalidatePath(`/print/outsource/${blockId}/pdf/raw`)
      return Response.json(ok())
    }

    case 'pickVendorForBlock': {
      const blockId = body.blockId
      const name = body.name
      if (!isString(blockId) || !isString(name))
        return err('bad pickVendorForBlock args')
      await requireOutsourceManager()
      const trimmed = name.trim()
      if (!trimmed) return Response.json(ok({ vendor: null }))
      const vendor = await createVendor({ name: trimmed })
      if (!vendor) return err('vendor upsert failed', 500)
      await updateOutsourceBlock(blockId, { vendorId: vendor.id })
      revalidateExternal()
      revalidatePath('/print/outsource', 'layout')
      return Response.json(ok({ vendor }))
    }

    case 'setMemberReturnedQty': {
      const blockId = body.blockId
      const componentId = body.componentId
      const qty = body.qty
      const date = body.date
      const jobId = body.jobId
      if (
        !isString(blockId) ||
        !isString(componentId) ||
        typeof qty !== 'number'
      )
        return err('bad setMemberReturnedQty args')
      if (date !== null && !isString(date)) return err('bad date')
      if (jobId !== undefined && !isString(jobId)) return err('bad jobId')
      await requireOutsourceManager()
      await setMemberReturnedQty(
        blockId,
        componentId,
        qty,
        date as string | null,
      )
      revalidateExternal(jobId as string | undefined)
      return Response.json(ok())
    }

    case 'setBlockMembersReturnedQty': {
      const blockId = body.blockId
      const items = body.items
      const date = body.date
      const jobId = body.jobId
      if (
        !isString(blockId) ||
        !Array.isArray(items) ||
        !items.every(
          (it) =>
            typeof it === 'object' &&
            it !== null &&
            isString((it as { componentId: unknown }).componentId) &&
            typeof (it as { qty: unknown }).qty === 'number',
        ) ||
        !isString(date)
      )
        return err('bad setBlockMembersReturnedQty args')
      if (jobId !== undefined && !isString(jobId)) return err('bad jobId')
      await requireOutsourceManager()
      await setBlockMembersReturnedQty(
        blockId,
        items as { componentId: string; qty: number }[],
        date,
      )
      revalidateExternal(jobId as string | undefined)
      return Response.json(ok())
    }

    case 'setBlockMemberUnitPrice': {
      const blockId = body.blockId
      const componentId = body.componentId
      const unitPriceCny = body.unitPriceCny
      const jobId = body.jobId
      if (!isString(blockId) || !isString(componentId))
        return err('bad setBlockMemberUnitPrice args')
      if (unitPriceCny !== null && typeof unitPriceCny !== 'number')
        return err('bad unitPriceCny')
      if (jobId !== undefined && !isString(jobId)) return err('bad jobId')
      await requireOutsourceManager()
      await setBlockMemberUnitPrice(
        blockId,
        componentId,
        unitPriceCny as number | null,
      )
      revalidateExternal(jobId as string | undefined)
      revalidatePath(`/print/outsource/${blockId}`)
      revalidatePath(`/print/outsource/${blockId}/pdf`)
      revalidatePath(`/print/outsource/${blockId}/pdf/raw`)
      return Response.json(ok())
    }

    case 'setBlockMemberQty': {
      const blockId = body.blockId
      const componentId = body.componentId
      const qty = body.qty
      const jobId = body.jobId
      if (!isString(blockId) || !isString(componentId))
        return err('bad setBlockMemberQty args')
      if (qty !== null && typeof qty !== 'number') return err('bad qty')
      if (jobId !== undefined && !isString(jobId)) return err('bad jobId')
      await requireOutsourceManager()
      await setBlockMemberQty(blockId, componentId, qty as number | null)
      revalidateExternal(jobId as string | undefined)
      revalidatePath(`/print/outsource/${blockId}`)
      revalidatePath(`/print/outsource/${blockId}/pdf`)
      revalidatePath(`/print/outsource/${blockId}/pdf/raw`)
      return Response.json(ok())
    }

    // === 退货 ===
    case 'createReturn': {
      const input = body.input
      if (typeof input !== 'object' || input === null)
        return err('bad createReturn args')
      const u = await requirePartRouteEditor()
      const result = await createReturn({
        ...(input as Omit<CreateReturnInput, 'byUserId'>),
        byUserId: u.id,
      })
      revalidatePath('/')
      const inputJobId = (input as { jobId?: unknown }).jobId
      if (isString(inputJobId)) revalidatePath(`/jobs/${inputJobId}`)
      revalidatePath('/returns')
      return Response.json(ok(result))
    }

    case 'closeReturn': {
      const returnId = body.returnId
      if (!isString(returnId)) return err('bad closeReturn args')
      await requirePartRouteEditor()
      await closeReturn(returnId)
      revalidatePath('/')
      revalidatePath('/returns')
      return Response.json(ok())
    }

    // === Import recovery ===
    case 'manualFillJob': {
      const jobId = body.jobId
      if (!isString(jobId)) return err('bad manualFillJob args')
      await requirePartRouteEditor()
      await markJobAsDraft(jobId)
      revalidateJob(jobId)
      return Response.json(ok())
    }

    // === 财务 / 应收账款 (开票 + 回款) ===
    case 'updateShipmentFinance': {
      const shipmentId = body.shipmentId
      const patch = body.patch
      if (
        !isString(shipmentId) ||
        typeof patch !== 'object' ||
        patch === null
      )
        return err('bad updateShipmentFinance args')
      // Validate each field is string|null (text) or number|null (money/date
      // are stored as text/numeric — dates arrive as YYYY-MM-DD strings).
      const p = patch as Record<string, unknown>
      const textFields = [
        'contact',
        'pendingFlag',
        'invoiceNo',
        'invoiceDate',
        'paymentDate',
      ]
      const numFields = ['saleAmountCny', 'invoiceAmountCny', 'paymentAmountCny']
      for (const f of textFields) {
        if (f in p && p[f] !== null && !isString(p[f]))
          return err(`bad ${f}`)
      }
      for (const f of numFields) {
        if (f in p && p[f] !== null && typeof p[f] !== 'number')
          return err(`bad ${f}`)
      }
      const u = await requireCommerce()
      await updateShipmentFinance(
        shipmentId,
        patch as ShipmentFinancePatch,
        u.name,
      )
      revalidatePath('/finance')
      return Response.json(ok())
    }

    // === 财务 / 分期账 (po_lines + money_events, migration 0075) ===
    case 'createPoLine': {
      const jobId = body.jobId
      if (!isString(jobId)) return err('bad createPoLine args')
      let init: { poNo?: string; materialNo?: string; amountCny?: number } | undefined
      if (body.init !== undefined) {
        if (typeof body.init !== 'object' || body.init === null)
          return err('bad createPoLine init')
        const i = body.init as Record<string, unknown>
        if ('poNo' in i && !isString(i.poNo)) return err('bad poNo')
        if ('materialNo' in i && !isString(i.materialNo)) return err('bad materialNo')
        if (
          'amountCny' in i &&
          (typeof i.amountCny !== 'number' ||
            !Number.isFinite(i.amountCny) ||
            i.amountCny < 0)
        )
          return err('bad amountCny')
        init = {
          ...(i.poNo !== undefined ? { poNo: i.poNo as string } : {}),
          ...(i.materialNo !== undefined ? { materialNo: i.materialNo as string } : {}),
          ...(i.amountCny !== undefined ? { amountCny: i.amountCny as number } : {}),
        }
      }
      const u = await requireCommerce()
      const id = await createPoLine(jobId, u.name, init)
      revalidatePath('/finance')
      return Response.json(ok({ id }))
    }

    case 'updatePoLine': {
      const lineId = body.lineId
      const patch = body.patch
      if (!isString(lineId) || typeof patch !== 'object' || patch === null)
        return err('bad updatePoLine args')
      const p = patch as Record<string, unknown>
      if ('poNo' in p && !isString(p.poNo)) return err('bad poNo')
      if ('materialNo' in p && p.materialNo !== null && !isString(p.materialNo))
        return err('bad materialNo')
      if (
        'amountCny' in p &&
        (typeof p.amountCny !== 'number' ||
          !Number.isFinite(p.amountCny) ||
          p.amountCny < 0)
      )
        return err('bad amountCny')
      await requireCommerce()
      await updatePoLine(lineId, patch as PoLinePatch)
      revalidatePath('/finance')
      return Response.json(ok())
    }

    case 'deletePoLine': {
      const lineId = body.lineId
      if (!isString(lineId)) return err('bad deletePoLine args')
      await requireCommerce()
      await deletePoLine(lineId)
      revalidatePath('/finance')
      return Response.json(ok())
    }

    case 'createMoneyEvent': {
      const input = body.input
      if (typeof input !== 'object' || input === null)
        return err('bad createMoneyEvent args')
      const i = input as Record<string, unknown>
      if (!isString(i.poLineId)) return err('bad poLineId')
      if (i.kind !== 'invoice' && i.kind !== 'payment') return err('bad kind')
      if (
        typeof i.amountCny !== 'number' ||
        !Number.isFinite(i.amountCny) ||
        i.amountCny <= 0
      )
        return err('bad amountCny')
      if (!isString(i.eventDate) || !/^\d{4}-\d{2}-\d{2}$/.test(i.eventDate))
        return err('bad eventDate')
      if ('invoiceNo' in i && !isString(i.invoiceNo)) return err('bad invoiceNo')
      if ('note' in i && !isString(i.note)) return err('bad note')
      const u = await requireCommerce()
      const id = await createMoneyEvent(input as NewMoneyEventInput, u.name)
      revalidatePath('/finance')
      return Response.json(ok({ id }))
    }

    case 'voidMoneyEvent': {
      const eventId = body.eventId
      if (!isString(eventId)) return err('bad voidMoneyEvent args')
      const u = await requireCommerce()
      const id = await voidMoneyEvent(eventId, u.name)
      revalidatePath('/finance')
      return Response.json(ok({ id }))
    }

    case 'setJobBillable': {
      const jobId = body.jobId
      const billable = body.billable
      if (!isString(jobId) || typeof billable !== 'boolean')
        return err('bad setJobBillable args')
      await requireCommerce()
      await setJobBillable(jobId, billable)
      revalidatePath('/finance')
      return Response.json(ok())
    }

    // === 工作交接单 (handover sheets) ===
    case 'createHandover': {
      const input = body.input
      if (!isValidHandoverInput(input))
        return err('bad createHandover args')
      const u = await requireUser()
      const id = await createHandover(input, u.name)
      revalidatePath('/handover')
      return Response.json(ok({ id }))
    }

    case 'updateHandover': {
      const handoverId = body.handoverId
      const patch = body.patch
      if (!isString(handoverId) || typeof patch !== 'object' || patch === null)
        return err('bad updateHandover args')
      // items, when present, must be a well-formed array.
      const items = (patch as { items?: unknown }).items
      if (items !== undefined && !isValidHandoverItems(items))
        return err('bad updateHandover items')
      await requireUser()
      await updateHandover(handoverId, patch as HandoverPatch)
      revalidatePath('/handover')
      return Response.json(ok())
    }

    case 'deleteHandover': {
      const handoverId = body.handoverId
      if (!isString(handoverId)) return err('bad deleteHandover args')
      await requireUser()
      await deleteHandover(handoverId)
      revalidatePath('/handover')
      return Response.json(ok())
    }

    // === 采购 (procurement ledger) — anyone signed in can write ===
    case 'createProcurement': {
      const input = body.input
      if (!isValidProcurementInput(input))
        return err('bad createProcurement args')
      const u = await requireUser()
      const id = await createProcurement(input, u.name)
      revalidatePath('/procurement')
      return Response.json(ok({ id }))
    }

    case 'updateProcurement': {
      const procurementId = body.procurementId
      const patch = body.patch
      if (!isString(procurementId) || !isValidProcurementPatch(patch))
        return err('bad updateProcurement args')
      await requireUser()
      await updateProcurement(procurementId, patch)
      revalidatePath('/procurement')
      return Response.json(ok())
    }

    case 'deleteProcurement': {
      const procurementId = body.procurementId
      if (!isString(procurementId)) return err('bad deleteProcurement args')
      await requireUser()
      await deleteProcurement(procurementId)
      revalidatePath('/procurement')
      return Response.json(ok())
    }

    // === 物料库 (procurement product catalog) — anyone signed in can write ===
    case 'createProcurementProduct': {
      const input = body.input
      if (!isValidProcurementProductInput(input))
        return err('bad createProcurementProduct args')
      const u = await requireUser()
      const product = await createProcurementProduct(input, u.name)
      revalidatePath('/procurement')
      return Response.json(ok({ product }))
    }

    case 'updateProcurementProduct': {
      const productId = body.productId
      const patch = body.patch
      if (!isString(productId) || !isValidProcurementProductPatch(patch))
        return err('bad updateProcurementProduct args')
      await requireUser()
      await updateProcurementProduct(productId, patch)
      revalidatePath('/procurement')
      return Response.json(ok())
    }

    case 'deleteProcurementProduct': {
      const productId = body.productId
      if (!isString(productId)) return err('bad deleteProcurementProduct args')
      await requireUser()
      await deleteProcurementProduct(productId)
      revalidatePath('/procurement')
      return Response.json(ok())
    }

    // === 出厂检验报告 — whole-document upsert from the editable print page.
    // 质量/检验 stations fill it; 工程 + commerce can correct it.
    case 'upsertInspectionReport': {
      const jobId = body.jobId
      const componentId = body.componentId
      const patch = body.patch
      if (
        !isString(jobId) ||
        !isString(componentId) ||
        typeof patch !== 'object' ||
        patch === null
      )
        return err('bad upsertInspectionReport args')
      const p = patch as Record<string, unknown>
      if (p.dims !== undefined && (!Array.isArray(p.dims) || !p.dims.every(isDimRow) || p.dims.length > 60))
        return err('bad dims')
      if (
        p.processChecks !== undefined &&
        (!Array.isArray(p.processChecks) || !p.processChecks.every(isString))
      )
        return err('bad processChecks')
      for (const f of ['performance', 'appearance', 'packaging']) {
        const v = p[f]
        if (v === undefined) continue
        if (typeof v !== 'object' || v === null) return err(`bad ${f}`)
        for (const val of Object.values(v as Record<string, unknown>)) {
          if (typeof val !== 'string') return err(`bad ${f}`)
        }
      }
      for (const f of [
        'reportNo',
        'inspectMethod',
        'disposition',
        'customerPlan',
        'finalVerdict',
        'evaluation',
        'confirmer',
        'inspector',
        'approver',
        'inspectedAt',
      ]) {
        if (!isOptString(p[f])) return err(`bad ${f}`)
      }
      const u = await requireUser()
      const allowed =
        u.role === 'commerce' ||
        u.defaultStage === '工程' ||
        u.defaultStage === '检验' ||
        u.defaultStage === '质量'
      if (!allowed) return err('forbidden', 403)
      await upsertInspectionReport(
        jobId,
        componentId,
        patch as InspectionReportPatch,
        u.name,
      )
      revalidatePath(`/jobs/${jobId}/print/inspection/${componentId}`)
      return Response.json(ok())
    }

    // === 支出台账 (expense ledger) — boss + designated finance users only.
    // Payroll rows carry per-person salaries; the gate matches the page
    // (canSeeExpenses), returning 403 rather than redirecting. ===
    case 'createExpense': {
      const input = body.input
      if (!isValidExpenseInput(input)) return err('bad createExpense args')
      const u = await requireUser()
      if (!canSeeExpenses(u)) return err('forbidden', 403)
      const id = await createExpense(input, u.name)
      revalidatePath('/finance')
      return Response.json(ok({ id }))
    }

    case 'createExpenses': {
      const inputs = body.inputs
      // Batch — powers 复制上月工资. Capped: a payroll run is dozens of rows,
      // never hundreds; anything bigger is a client bug.
      if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 50)
        return err('bad createExpenses args')
      if (!inputs.every(isValidExpenseInput)) return err('bad createExpenses args')
      const u = await requireUser()
      if (!canSeeExpenses(u)) return err('forbidden', 403)
      const ids = await createExpenses(inputs, u.name)
      revalidatePath('/finance')
      return Response.json(ok({ ids }))
    }

    case 'updateExpense': {
      const expenseId = body.expenseId
      const patch = body.patch
      if (!isString(expenseId) || !isValidExpensePatch(patch))
        return err('bad updateExpense args')
      const u = await requireUser()
      if (!canSeeExpenses(u)) return err('forbidden', 403)
      await updateExpense(expenseId, patch)
      revalidatePath('/finance')
      return Response.json(ok())
    }

    case 'deleteExpense': {
      const expenseId = body.expenseId
      if (!isString(expenseId)) return err('bad deleteExpense args')
      const u = await requireUser()
      if (!canSeeExpenses(u)) return err('forbidden', 403)
      await deleteExpense(expenseId)
      revalidatePath('/finance')
      return Response.json(ok())
    }

    // === 笔记 (notes) — per-author scratchpad, 商务 + 工程 (canUseNotes).
    // Rows are only ever born with real text: the board keeps drafts local
    // until the first non-whitespace commit, and the gate here re-enforces
    // it — an empty note is a draft, not a row. All three ops scope to the
    // caller's own notes. ===
    case 'createNote': {
      const text = body.body
      if (!isString(text) || !text.trim()) return err('bad createNote args')
      const u = await requireUser()
      if (!canUseNotes(u)) return err('forbidden', 403)
      const id = await createNote(u.id, text)
      revalidatePath('/notes')
      return Response.json(ok({ id }))
    }

    case 'updateNote': {
      const noteId = body.noteId
      const text = body.body
      if (!isString(noteId) || !isString(text)) return err('bad updateNote args')
      const u = await requireUser()
      if (!canUseNotes(u)) return err('forbidden', 403)
      await updateNote(noteId, text, u.id)
      revalidatePath('/notes')
      return Response.json(ok())
    }

    case 'deleteNote': {
      const noteId = body.noteId
      if (!isString(noteId)) return err('bad deleteNote args')
      const u = await requireUser()
      if (!canUseNotes(u)) return err('forbidden', 403)
      await deleteNote(noteId, u.id)
      revalidatePath('/notes')
      return Response.json(ok())
    }

    // === 重点 (daily focus list) — same gate as the /daily page (现场 view:
    // commerce + 工程 head). Floor workers neither see nor write it. ===
    case 'createDailyFocus': {
      const input = body.input
      if (!isValidDailyFocusInput(input)) return err('bad createDailyFocus args')
      const u = await requireUser()
      if (!canSeeFactoryPulse(u)) return err('forbidden', 403)
      const id = await createDailyFocusItem(input, u.name)
      revalidatePath('/daily')
      return Response.json(ok({ id }))
    }

    case 'updateDailyFocus': {
      const itemId = body.itemId
      const patch = body.patch
      if (!isString(itemId) || !isValidDailyFocusPatch(patch))
        return err('bad updateDailyFocus args')
      const u = await requireUser()
      if (!canSeeFactoryPulse(u)) return err('forbidden', 403)
      await updateDailyFocusItem(itemId, patch)
      revalidatePath('/daily')
      return Response.json(ok())
    }

    case 'deleteDailyFocus': {
      const itemId = body.itemId
      if (!isString(itemId)) return err('bad deleteDailyFocus args')
      const u = await requireUser()
      if (!canSeeFactoryPulse(u)) return err('forbidden', 403)
      await deleteDailyFocusItem(itemId)
      revalidatePath('/daily')
      return Response.json(ok())
    }

    // === 财务 (caiwu — the two finance spreadsheets) — money, so 商务 only
    // (canSeeMoney). Production never reaches /finance to begin with. ===
    case 'createCaiwu': {
      const input = body.input
      if (!isValidCaiwuInput(input)) return err('bad createCaiwu args')
      const u = await requireUser()
      if (!canSeeMoney(u)) return err('forbidden', 403)
      const id = await createCaiwuRow(input, u.name)
      revalidatePath('/finance')
      return Response.json(ok({ id }))
    }

    case 'updateCaiwu': {
      const itemId = body.itemId
      const patch = body.patch
      if (!isString(itemId) || !isValidCaiwuPatch(patch))
        return err('bad updateCaiwu args')
      const u = await requireUser()
      if (!canSeeMoney(u)) return err('forbidden', 403)
      await updateCaiwuRow(itemId, patch)
      revalidatePath('/finance')
      return Response.json(ok())
    }

    case 'deleteCaiwu': {
      const itemId = body.itemId
      if (!isString(itemId)) return err('bad deleteCaiwu args')
      const u = await requireUser()
      if (!canSeeMoney(u)) return err('forbidden', 403)
      await deleteCaiwuRow(itemId)
      revalidatePath('/finance')
      return Response.json(ok())
    }

    default:
      return err(`unknown kind: ${kind}`, 400)
  }
}
