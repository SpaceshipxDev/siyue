'use server'

// IMPORTANT — most server actions in this file are no longer called from
// client code. Client components write through `app/api/mutate/route.ts` via
// `lib/mutate.ts` instead. Why: a Next.js server action's response inlines
// the current page's RSC payload, which is a fat sustained HTTP/2 stream
// that the GFW frequently truncates for mainland users hitting the HK VM —
// surfacing as the framework's "this page couldn't load" overlay. The JSON
// dispatcher returns ~30 bytes and bypasses RSC entirely.
//
// Server actions are kept here for two reasons:
//   1. The few that ARE still client-called are followed by a navigation
//      (deleteJob → router.push('/'), confirmJob → router.push, login/
//      logout → redirect). The fat stream risk is bounded to one click.
//   2. Stale browser sessions with cached JS still find the actions; we
//      narrowed their `revalidatePath` scope from `'layout'` to page-scope
//      as defense-in-depth so even a stale-JS write produces a smaller
//      response stream.
//
// When adding a new mutation: prefer adding a `kind` to the dispatcher.

import { revalidatePath } from 'next/cache'
import type { Stage, JobStatus } from '@/lib/data'
import { BRAND } from '@/lib/brand'
import type { Customer, Vendor } from '@/lib/data'
import {
  appendComponent,
  assignJobToStage,
  assignToStage,
  closeReturn,
  confirmJob,
  createOutsourceBlockAt,
  createReturn,
  createVendor,
  getJob,
  deleteComponent,
  deleteJob,
  deleteOutsourceBlock,
  finishJobStage,
  finishStage,
  markJobAsDraft,
  parseJobNoConflictError,
  prepareShipping,
  resetDb,
  setBlockMembersReturnedQty,
  setBlockMemberUnitPrice,
  setComponentImage,
  setMemberReturnedQty,
  setPartRoute,
  setStageDoneQty,
  markJobStartedAt,
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
  type CreateBlockResult,
  type CreateReturnInput,
  type CustomerPatch,
  type JobPatch,
  type NewBlockInput,
  type SetPartRouteResult,
  type VendorPatch,
} from '@/lib/db'
import type { JobReturn } from '@/lib/data'
import {
  canClickStage,
  canCreatePartRow,
  canDeleteOrder,
  canDeletePartRow,
  requireCommerce,
  requireJobDeleter,
  requireOutsourceManager,
  requirePartRouteEditor,
  requireUser,
} from '@/lib/auth'

function revalidateStage(jobId: string, stage: Stage) {
  revalidatePath('/')
  revalidatePath(`/jobs/${jobId}`)
  revalidatePath(`/station/${encodeURIComponent(stage)}`)
  revalidatePath(`/station/${encodeURIComponent(stage)}/${jobId}`)
}

// Per-person stage scope (lib/auth STAGE_SCOPE_BY_USER_ID) — mirrors
// requireOwnStage in /api/mutate. The 无权 prefix in the message is
// load-bearing: the client denial dialog keys off it.
async function requireStage(stage: Stage) {
  const u = await requireUser()
  if (!canClickStage(u, stage)) {
    throw new Error(`无权操作 ${stage} 工段`)
  }
  return u
}

export async function startStageAction(
  jobId: string,
  componentId: string,
  stage: Stage,
): Promise<void> {
  const u = await requireStage(stage)
  await startStage(jobId, componentId, stage, u.name)
  revalidateStage(jobId, stage)
}

export async function finishStageAction(
  jobId: string,
  componentId: string,
  stage: Stage,
): Promise<void> {
  const u = await requireStage(stage)
  await finishStage(jobId, componentId, stage, u.name)
  revalidateStage(jobId, stage)
}

export async function undoStageAction(
  jobId: string,
  componentId: string,
  stage: Stage,
): Promise<void> {
  await requireStage(stage)
  await undoStage(jobId, componentId, stage)
  revalidateStage(jobId, stage)
}

export async function setStageDoneQtyAction(
  jobId: string,
  componentId: string,
  stage: Stage,
  qty: number,
): Promise<void> {
  const u = await requireStage(stage)
  await setStageDoneQty(jobId, componentId, stage, qty, u.name)
  revalidateStage(jobId, stage)
}

// 制作出货单 — single-shot write that turns a user's per-part shipping picks
// into a new shipment row + cumulative 出货 stage rollup. Auth follows the
// same gate as other 出货 writes (commerce, 工程 head, 出货 station head).
// Returns the new shipment's doc number so the client can deep-link the
// printed 出货单 it just made.
export type ShippingPickInput = { componentId: string; qty: number }

export type PrepareShippingResponse = {
  shipmentId: string
  docNo: string
}

export async function prepareShippingAction(
  jobId: string,
  selections: ShippingPickInput[],
): Promise<PrepareShippingResponse> {
  const u = await requireStage('出货')
  const result = await prepareShipping(jobId, selections, u.name)
  revalidateStage(jobId, '出货')
  revalidatePath(`/jobs/${jobId}/print/shipping`)
  revalidatePath(`/jobs/${jobId}/print/shipping/pdf`)
  return result
}

export async function startJobStageAction(
  jobId: string,
  stage: Stage,
): Promise<void> {
  const u = await requireStage(stage)
  await startJobStage(jobId, stage, u.name)
  revalidateStage(jobId, stage)
}

export async function finishJobStageAction(
  jobId: string,
  stage: Stage,
): Promise<void> {
  const u = await requireStage(stage)
  await finishJobStage(jobId, stage, u.name)
  revalidateStage(jobId, stage)
}

export async function undoJobStageAction(
  jobId: string,
  stage: Stage,
): Promise<void> {
  await requireStage(stage)
  await undoJobStage(jobId, stage)
  revalidateStage(jobId, stage)
}

export async function assignToStageAction(
  jobId: string,
  componentId: string,
  fromStage: Stage,
  toStage: Stage,
): Promise<void> {
  // Re-routing crosses stages — production users can only push from their own
  // station. We require fromStage match; commerce can do anything.
  const u = await requireStage(fromStage)
  await assignToStage(jobId, componentId, fromStage, toStage, u.name)
  revalidatePath('/')
  revalidatePath(`/jobs/${jobId}`)
  revalidatePath(`/station/${encodeURIComponent(fromStage)}`)
  revalidatePath(`/station/${encodeURIComponent(toStage)}`)
}

export async function assignJobToStageAction(
  jobId: string,
  fromStage: Stage,
  toStage: Stage,
): Promise<void> {
  const u = await requireStage(fromStage)
  await assignJobToStage(jobId, fromStage, toStage, u.name)
  revalidatePath('/')
  revalidatePath(`/jobs/${jobId}`)
  revalidatePath(`/station/${encodeURIComponent(fromStage)}`)
  revalidatePath(`/station/${encodeURIComponent(fromStage)}/${jobId}`)
  revalidatePath(`/station/${encodeURIComponent(toStage)}`)
}

// Job-level edits. Commerce + 工程 head share full edit rights here —
// 工程 needs every field on the import draft (they own imports too) and
// the post-confirmation /jobs/[id] page already hides customer/money
// inputs from them, so visibility (not field allowlisting) is what keeps
// 工程 out of commercial fields in normal use.
export async function updateJobAction(
  jobId: string,
  patch: JobPatch,
): Promise<void> {
  await requirePartRouteEditor()
  await updateJob(jobId, patch)
  revalidatePath('/')
}

// Notes are the one job field everyone owns. Production heads add 催单 /
// 急 / shop-floor context here; commerce can also write. Gated only by
// requireUser — no role check beyond authentication.
export async function updateJobNotesAction(
  jobId: string,
  notes: string | null,
): Promise<void> {
  await requireUser()
  await updateJob(jobId, { notes })
  revalidatePath('/')
}

// Component-level edits. Same model as updateJobAction — 工程 + commerce
// share full edit rights; UI visibility is the gate for who sees the
// money inputs on /jobs/[id].
export async function updateComponentAction(
  jobId: string,
  componentId: string,
  patch: ComponentPatch,
): Promise<void> {
  await requirePartRouteEditor()
  await updateComponent(jobId, componentId, patch)
  revalidatePath('/')
}

export async function resetDbAction(): Promise<void> {
  await requireCommerce()
  await resetDb()
  revalidatePath('/')
}

// Image / add-row / delete-row don't touch commercial data, so 工程 head
// gets them too — useful when a part shows up on the floor that's missing
// a photo or wasn't on the original 报价单.
export async function setComponentImageAction(
  jobId: string,
  componentId: string,
  imageUrl: string | null,
): Promise<void> {
  await requirePartRouteEditor()
  await setComponentImage(jobId, componentId, imageUrl)
  revalidatePath('/')
}

export async function appendComponentAction(jobId: string): Promise<string | undefined> {
  const u = await requireUser()
  if (!canCreatePartRow(u)) throw new Error('无权添加零件 (仅商务/工程可操作)')
  const id = await appendComponent(jobId)
  revalidatePath(`/import/${jobId}`)
  revalidatePath(`/jobs/${jobId}`)
  return id
}

export async function deleteComponentAction(
  jobId: string,
  componentId: string,
): Promise<void> {
  const u = await requireUser()
  if (!canDeletePartRow(u)) throw new Error('无权删除零件')
  await deleteComponent(jobId, componentId)
  revalidatePath(`/import/${jobId}`)
  revalidatePath(`/jobs/${jobId}`)
}

export async function setPartRouteAction(
  jobId: string,
  componentId: string,
  stages: Stage[],
  options: { force?: boolean } = {},
): Promise<SetPartRouteResult> {
  await requirePartRouteEditor()
  const result = await setPartRoute(jobId, componentId, stages, options)
  if (result.ok) {
    revalidatePath('/')
  }
  return result
}

export type ConfirmJobResult =
  | { ok: true }
  | {
      ok: false
      conflict: { id: string; jobNo: string; customer: string; status: JobStatus }
    }
  | { ok: false; error: string }

export async function confirmJobAction(
  jobId: string,
  startAt?: Stage,
): Promise<ConfirmJobResult> {
  // 工程 head can confirm imports they ran, same as commerce.
  const user = await requirePartRouteEditor()
  // Three names have to be on an order before it enters the board: 谁家的
  // (客户), 对面找谁 (客户工程师), 我们这边谁负责 (越侬商务). An order missing
  // any of them is one nobody can chase when the floor, the customer or the 账
  // comes asking three months later — and the moment of import is the only
  // moment anyone still remembers. Checked server-side because all three are
  // edited inline and could be blanked after the page rendered.
  const draft = await getJob(jobId)
  const required: [string, string | undefined][] = draft
    ? [
        ['客户', draft.customer],
        ['客户工程师', draft.engineer],
        [BRAND.commerceLabel, draft.yuenongBusiness],
      ]
    : []
  const missing = required.find(([, v]) => !(v ?? '').trim())
  if (missing) {
    return { ok: false, error: `请先填写「${missing[0]}」再确认导入` }
  }
  if (startAt) {
    await markJobStartedAt(jobId, startAt, user.name)
  }
  try {
    await confirmJob(jobId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const conflict = parseJobNoConflictError(message)
    if (conflict) return { ok: false, conflict }
    return { ok: false, error: message }
  }
  revalidatePath('/')
  return { ok: true }
}

export async function deleteJobAction(jobId: string): Promise<void> {
  // 商务 + named 工程 (于海伟) — see canDeleteJob. Was requireCommerce, which
  // silently no-op'd for 工程: they see the 收件箱 × (they run imports) and the
  // row vanished locally while the redirect killed the delete.
  await requireJobDeleter()
  // A confirmed 单号 can never be deleted — it carries production history the
  // factory relies on. Delete exists only to clean up unconfirmed imports
  // (drafts / failed parses), which is what the inbox and import screens use.
  const job = await getJob(jobId)
  if (job?.status === 'ready') throw new Error('已确认的工单不可删除')
  await deleteJob(jobId)
  // Page-scoped (not 'layout') — keeps the response RSC payload small so it
  // survives cross-border HTTP/2 paths for mainland users. The inbox list also
  // does an optimistic local removal, so even if this RSC reply is truncated
  // the UI stays correct.
  revalidatePath('/')
}

// The job page's 删除 — takes down ANY order, confirmed included. The one
// gesture in the product that erases production history (parts / 报工 /
// 出货记录 cascade on the jobs row), so the gate is a named allowlist
// (canDeleteOrder: 老板, Harry, 黄优兰香, 于海伟×2), not a role, and the
// client confirms in an anchored popover before calling. Throws (not
// redirect) so a bypassed button gets a readable error, not a bounce.
export async function deleteOrderAction(jobId: string): Promise<void> {
  const u = await requireUser()
  if (!canDeleteOrder(u)) throw new Error('无权删除工单')
  await deleteJob(jobId)
  // Page-scoped for the same GFW reason as deleteJobAction above.
  revalidatePath('/')
}

// Escape hatch for a stuck/failed parse: skip extraction entirely and drop
// the job into the draft editor so commerce or 工程 can hand-enter every
// field. Called from the import page's "stuck" UI after the 45s poller
// timeout.
export async function manualFillJobAction(jobId: string): Promise<void> {
  await requirePartRouteEditor()
  await markJobAsDraft(jobId)
  revalidatePath('/')
  revalidatePath(`/import/${jobId}`)
}

function revalidateExternal(jobId?: string) {
  revalidatePath('/')
  revalidatePath('/station/outsource')
  if (jobId) revalidatePath(`/jobs/${jobId}`)
}

export async function createOutsourceBlockAction(
  jobId: string,
  componentIds: string[],
  input: NewBlockInput,
): Promise<CreateBlockResult> {
  await requireOutsourceManager()
  const result = await createOutsourceBlockAt(jobId, componentIds, input)
  if (result.ok) revalidateExternal(jobId)
  return result
}

export async function updateOutsourceBlockAction(
  blockId: string,
  patch: BlockPatch,
  jobId?: string,
): Promise<void> {
  await requireOutsourceManager()
  await updateOutsourceBlock(blockId, patch)
  revalidateExternal(jobId)
  revalidatePath(`/print/outsource/${blockId}`)
}

// Set one member's absolute returned quantity (e.g. "6 of 11 are now back").
// Pass 0 to un-return; pass >= the member's qty to fully close. The block as
// a whole is "closed" once every member's returned_qty has reached its qty —
// derived in the UI, no separate call.
export async function setMemberReturnedQtyAction(
  blockId: string,
  componentId: string,
  qty: number,
  date: string | null,
  jobId?: string,
): Promise<void> {
  await requireOutsourceManager()
  await setMemberReturnedQty(blockId, componentId, qty, date)
  revalidateExternal(jobId)
}

// Bulk variant — sets per-member returned_qty in one round-trip, all stamped
// with the same date. Used by the 收件 button to record the day's batch.
export async function setBlockMembersReturnedQtyAction(
  blockId: string,
  items: { componentId: string; qty: number }[],
  date: string,
  jobId?: string,
): Promise<void> {
  await requireOutsourceManager()
  await setBlockMembersReturnedQty(blockId, items, date)
  revalidateExternal(jobId)
}

export async function setBlockMemberUnitPriceAction(
  blockId: string,
  componentId: string,
  unitPriceCny: number | null,
  jobId?: string,
): Promise<void> {
  await requireOutsourceManager()
  await setBlockMemberUnitPrice(blockId, componentId, unitPriceCny)
  revalidateExternal(jobId)
  revalidatePath(`/print/outsource/${blockId}`)
  revalidatePath(`/print/outsource/${blockId}/pdf`)
  revalidatePath(`/print/outsource/${blockId}/pdf/raw`)
}

export async function deleteOutsourceBlockAction(
  blockId: string,
  jobId?: string,
): Promise<void> {
  await requireOutsourceManager()
  await deleteOutsourceBlock(blockId)
  revalidateExternal(jobId)
}

export async function createVendorAction(
  name: string,
  notes?: string,
  address?: string,
): Promise<Vendor | undefined> {
  await requireOutsourceManager()
  const vendor = await createVendor({ name, notes, address })
  revalidateExternal()
  return vendor
}

// Used by the 供应商 combobox on the 外协单. Upserts the vendor by name and
// re-points the block at it.
export async function pickVendorForBlockAction(
  blockId: string,
  name: string,
): Promise<Vendor | undefined> {
  await requireOutsourceManager()
  const trimmed = name.trim()
  if (!trimmed) return undefined
  const vendor = await createVendor({ name: trimmed })
  if (!vendor) return undefined
  await updateOutsourceBlock(blockId, { vendorId: vendor.id })
  revalidateExternal()
  revalidatePath('/print/outsource', 'layout')
  return vendor
}

export async function updateVendorAction(
  vendorId: string,
  patch: VendorPatch,
): Promise<void> {
  await requireOutsourceManager()
  await updateVendor(vendorId, patch)
  revalidateExternal()
  // Print docs read vendor.name/notes/address directly.
  revalidatePath('/print/outsource', 'layout')
}

export async function updateCustomerAction(
  customerId: string,
  patch: CustomerPatch,
): Promise<void> {
  await requireCommerce()
  await updateCustomer(customerId, patch)
  revalidatePath('/')
}

// Writes a customer-field edit (联系人 / 联系方式 / 地址) by resolving the
// job's customer at save time. If the job has only the customer name and
// no linked Customer row, this upserts the row and patches customerId in
// the same call. Used by the 出货单 print page so an inline edit can never
// no-op just because the page rendered before the customer was linked —
// which is what produced the "preview shows 联系人, PDF prints '—'" bug.
export async function setJobCustomerFieldAction(
  jobId: string,
  field: 'contact' | 'address' | 'phone',
  value: string | null,
): Promise<void> {
  await requireCommerce()
  const job = await getJob(jobId)
  if (!job) return
  const customerName = job.customer?.trim()
  if (!customerName) return
  let customerId = job.customerId
  if (!customerId) {
    const c = await upsertCustomerByName(customerName)
    if (!c) return
    await updateJob(jobId, { customerId: c.id })
    customerId = c.id
  }
  const patch: CustomerPatch =
    field === 'contact'
      ? { contact: value }
      : field === 'address'
        ? { address: value }
        : { phone: value }
  await updateCustomer(customerId, patch)
  revalidatePath('/')
}

// === 退货 ===
//
// Opening/closing returns mirrors `setPartRouteAction` permission-wise:
// commerce + 工程 head can do it (canEditPartRoute via requirePartRouteEditor).
// 出货 station heads only ship — they don't decide rework. The actual rework
// route is trimmed by the 工程 head once the part is back on the floor, using
// the existing partRoute editor. createReturn re-opens 工程 (and every other
// in-route stage) on the named parts; closeReturn just stamps closed_at — the
// stage states do not snap back, the 工程 head closes the return when rework
// is genuinely done.

export async function createReturnAction(
  input: Omit<CreateReturnInput, 'byUserId'>,
): Promise<JobReturn> {
  const u = await requirePartRouteEditor()
  const result = await createReturn({ ...input, byUserId: u.id })
  revalidatePath('/')
  return result
}

export async function closeReturnAction(returnId: string): Promise<void> {
  await requirePartRouteEditor()
  await closeReturn(returnId)
  revalidatePath('/')
}

// Used by the 客户名称 combobox on the 出货单 and on the import draft.
// Resolves the typed name to a Customer row (creating one on first sight)
// and links it to the job. 工程 hits this on the import draft because they
// own imports too.
export async function pickCustomerForJobAction(
  jobId: string,
  name: string,
): Promise<Customer | undefined> {
  await requirePartRouteEditor()
  const trimmed = name.trim()
  if (!trimmed) {
    await updateJob(jobId, { customer: '', customerId: null })
    revalidatePath('/')
    return undefined
  }
  const customer = await upsertCustomerByName(trimmed)
  if (!customer) return undefined
  await updateJob(jobId, { customer: customer.name, customerId: customer.id })
  revalidatePath('/')
  return customer
}
