'use server'

import { revalidatePath } from 'next/cache'
import type { Stage } from '@/lib/data'
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
  deleteComponent,
  deleteJob,
  deleteOutsourceBlock,
  finishJobStage,
  finishStage,
  markJobAsDraft,
  parseJobNoConflictError,
  resetDb,
  setBlockMembersReturnedQty,
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
  type CreateReturnInput,
  type CustomerPatch,
  type JobPatch,
  type NewBlockInput,
  type SetPartRouteResult,
  type VendorPatch,
} from '@/lib/db'
import type { JobReturn } from '@/lib/data'
import {
  requireCommerce,
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

// Production users can only operate on their own assigned stage. Commerce
// users can operate on any stage.
async function requireStage(stage: Stage) {
  const u = await requireUser()
  if (u.role === 'production' && u.defaultStage !== stage) {
    throw new Error('无权操作其他工段')
  }
  return u
}

export async function startStageAction(
  jobId: string,
  componentId: string,
  stage: Stage,
): Promise<void> {
  await requireStage(stage)
  await startStage(jobId, componentId, stage)
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

export async function startJobStageAction(
  jobId: string,
  stage: Stage,
): Promise<void> {
  await requireStage(stage)
  await startJobStage(jobId, stage)
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
  revalidatePath('/', 'layout')
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
  revalidatePath('/', 'layout')
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
  revalidatePath('/', 'layout')
}

export async function resetDbAction(): Promise<void> {
  await requireCommerce()
  await resetDb()
  revalidatePath('/', 'layout')
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
  revalidatePath('/', 'layout')
}

export async function appendComponentAction(jobId: string): Promise<string | undefined> {
  await requirePartRouteEditor()
  const id = await appendComponent(jobId)
  revalidatePath(`/import/${jobId}`)
  revalidatePath(`/jobs/${jobId}`)
  return id
}

export async function deleteComponentAction(
  jobId: string,
  componentId: string,
): Promise<void> {
  await requirePartRouteEditor()
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
    revalidatePath('/', 'layout')
  }
  return result
}

export type ConfirmJobResult =
  | { ok: true }
  | { ok: false; conflict: { id: string; jobNo: string; customer: string } }
  | { ok: false; error: string }

export async function confirmJobAction(
  jobId: string,
  startAt?: Stage,
): Promise<ConfirmJobResult> {
  // 工程 head can confirm imports they ran, same as commerce.
  const user = await requirePartRouteEditor()
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
  revalidatePath('/', 'layout')
  return { ok: true }
}

export async function deleteJobAction(jobId: string): Promise<void> {
  await requireCommerce()
  await deleteJob(jobId)
  revalidatePath('/', 'layout')
}

// Escape hatch for a stuck/failed parse: skip extraction entirely and drop
// the job into the draft editor so commerce or 工程 can hand-enter every
// field. Called from the import page's "stuck" UI after the 45s poller
// timeout.
export async function manualFillJobAction(jobId: string): Promise<void> {
  await requirePartRouteEditor()
  await markJobAsDraft(jobId)
  revalidatePath('/', 'layout')
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
): Promise<string | undefined> {
  await requireOutsourceManager()
  const id = await createOutsourceBlockAt(jobId, componentIds, input)
  revalidateExternal(jobId)
  return id
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
  revalidatePath('/', 'layout')
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
  revalidatePath('/', 'layout')
  return result
}

export async function closeReturnAction(returnId: string): Promise<void> {
  await requirePartRouteEditor()
  await closeReturn(returnId)
  revalidatePath('/', 'layout')
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
    revalidatePath('/', 'layout')
    return undefined
  }
  const customer = await upsertCustomerByName(trimmed)
  if (!customer) return undefined
  await updateJob(jobId, { customer: customer.name, customerId: customer.id })
  revalidatePath('/', 'layout')
  return customer
}
