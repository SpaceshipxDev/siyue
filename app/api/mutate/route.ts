import { NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import {
  appendComponent,
  assignJobToStage,
  assignToStage,
  closeReturn,
  createOutsourceBlockAt,
  createReturn,
  createVendor,
  deleteComponent,
  deleteOutsourceBlock,
  removeOutsourceBlockMember,
  finishJobStage,
  finishStage,
  getJob,
  markJobAsDraft,
  prepareShipping,
  setBlockMembersReturnedQty,
  setBlockMemberUnitPrice,
  setComponentImage,
  setJobPin,
  setJobStagePin,
  setMemberReturnedQty,
  setPartRoute,
  setStageDoneQty,
  startJobStage,
  startStage,
  undoJobStage,
  undoStage,
  updateComponent,
  updateCustomer,
  updateJob,
  updateOutsourceBlock,
  updateVendor,
  upsertCustomerByName,
  type BlockPatch,
  type ComponentPatch,
  type CreateReturnInput,
  type CustomerPatch,
  type JobPatch,
  type NewBlockInput,
  type VendorPatch,
} from '@/lib/db'
import {
  canManageOutsource,
  currentUser,
  requireCommerce,
  requireOutsourceManager,
  requirePartRouteEditor,
  requireUser,
  type AuthUser,
} from '@/lib/auth'
import type { Stage } from '@/lib/data'

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
  }
  return Response.json(body, { status })
}

function isString(x: unknown): x is string {
  return typeof x === 'string'
}

function isStage(x: unknown): x is Stage {
  return (
    isString(x) &&
    ['工程', '编程', '操机', '手工', '打磨', '喷漆丝印', '质量', '出货'].includes(x)
  )
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
  if (requestId) {
    const cached = idempotencyCache.get(requestId)
    if (cached && cached.expiresAt > Date.now()) {
      return Response.json(cached.body, { status: cached.status })
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
  return cacheAndSend(requestId, parsedBody, status)
}

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
      await requireOwnStage(stage)
      await startStage(jobId, componentId, stage)
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

    // === Job-level stage actions (entire job at once) ===
    case 'startJobStage': {
      const jobId = body.jobId
      const stage = body.stage
      if (!isString(jobId) || !isStage(stage))
        return err('bad startJobStage args')
      await requireOwnStage(stage)
      await startJobStage(jobId, stage)
      revalidateStage(jobId, stage)
      return Response.json(ok())
    }

    case 'finishJobStage': {
      const jobId = body.jobId
      const stage = body.stage
      if (!isString(jobId) || !isStage(stage))
        return err('bad finishJobStage args')
      const u = await requireOwnStage(stage)
      await finishJobStage(jobId, stage, u.name)
      revalidateStage(jobId, stage)
      return Response.json(ok())
    }

    case 'undoJobStage': {
      const jobId = body.jobId
      const stage = body.stage
      if (!isString(jobId) || !isStage(stage))
        return err('bad undoJobStage args')
      await requireOwnStage(stage)
      await undoJobStage(jobId, stage)
      revalidateStage(jobId, stage)
      return Response.json(ok())
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
      const id = await createOutsourceBlockAt(
        jobId,
        componentIds as string[],
        input as NewBlockInput,
      )
      revalidateExternal(jobId)
      return Response.json(ok({ id }))
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

    default:
      return err(`unknown kind: ${kind}`, 400)
  }
}
