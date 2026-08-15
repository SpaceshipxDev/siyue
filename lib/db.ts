import {
  BLOCKING_VERDICTS,
  DEFAULT_ROUTE_STAGES,
  JOBS as SEED,
  STAGES,
  VENDORS as VENDOR_SEED,
  blockClosedAt,
  blockLineTotalsSum,
  isMemberFullyReturned,
  jobIntakeDate,
  jobNoSortKey,
  procurementTotalCny,
  stageStartImpliesUpstreamDone,
} from './data'
import { today, todayMMDD } from './today'
import type {
  CaiwuRow,
  CaiwuSheet,
  Component,
  Customer,
  CustomerId,
  DailyFocusItem,
  Handover,
  HandoverItem,
  Job,
  JobReturn,
  JobStatus,
  JobType,
  OutsourceBlock,
  PartPhoto,
  PlanKey,
  Procurement,
  ProcurementProduct,
  ProcurementStatus,
  ReturnReason,
  ReturnStatus,
  Stage,
  StageState,
  StageStatus,
  Vendor,
  VendorId,
  Verdict,
} from './data'
import { supabase } from './supabase'
import { docNoDayPrefix, formatDocNo } from './brand'
import { rowRollupStage, type MasterAggregates, type MasterCell, type MasterRow } from './master'
import type { FinanceRow } from './finance'
import { financeStatus, outstanding, overdueDays } from './finance'
import type { OrderMoneyRow, OrderMoneyStatus } from './order-money'
import { orderMoneyStatusFrom } from './order-money'
import { isExpenseCategory } from './expenses'
import type { Expense, ExpenseCategory } from './expenses'
import type { Note, PartDrawingChange } from './data'
import { isDimRow } from './inspection-report'
import type { InspectionReport, InspectionReportPatch } from './inspection-report'
import { buildRows } from './fenqi'
import type { FenqiData, FenqiJob, FenqiLine, FenqiEvent } from './fenqi'

/*
 * Persistence is Supabase Postgres. Seven flat tables, all snake_case in the
 * DB, camelCase in TS via row mappers below. Schema lives under
 * supabase/migrations/.
 *
 *   jobs                  (id, job_no, customer, product, amount_cny, due_date, notes,
 *                          status, source_file, parse_error, shipping_doc_no, created_at, position)
 *   parts                 (id, job_id, position, name, qty, material, surface_treatment, notes, image_url)
 *   part_stages           (id, part_id, stage, status, completed_at, by_actor)  unique (part_id, stage)
 *   vendors               (id, name, notes, address)
 *   outsource_blocks      (id, vendor_id, stages text[], amount_cny, sent_date,
 *                          expected_return, notes, doc_no)
 *   outsource_block_parts (block_id, part_id, position, returned_at)
 *                          primary key (block_id, part_id)
 *
 * Block closure is derived from per-member returned_at — see blockClosedAt
 * in lib/data.ts. The old outsource_blocks.actual_return column was dropped
 * in migration 0006 once partial returns landed.
 */

// === Row types (camelCase, what the rest of the codebase already speaks) ===

type JobRow = {
  id: string
  jobNo: string
  customer: string
  customerId?: string
  product: string
  amountCny?: number
  dueDate: string
  secondaryDueDate?: string
  stagePlan?: Partial<Record<Stage, string>>
  notes?: string
  status?: JobStatus
  sourceFile?: string
  sourceFileUrl?: string
  parseError?: string
  shippingDocNo?: string
  createdBy?: string
  contractNo?: string
  batchNo?: string
  engineer?: string
  yuenongBusiness?: string
  createdAt: string
  position: number
  pinnedAt?: string
  pinnedBy?: string
  jobType?: JobType
  isProduct?: boolean
  pausedAt?: string
  pauseReason?: string
  pausedBy?: string
  needsOutsource?: boolean
  outsourceNote?: string
  outsourceFlaggedBy?: string
  outsourceFlaggedAt?: string
  drawingChangeOpen?: boolean
  drawingChangeNote?: string
  drawingChangeBy?: string
  drawingChangeAt?: string
}

type PartRow = {
  id: string
  jobId: string
  position: number
  name: string
  qty: number
  material?: string
  surfaceTreatment?: string
  notes?: string
  imageUrl?: string
  unitPriceCny?: number
  lineTotalCny?: number
  partNo?: string
  process?: string
  shipmentLog?: string
  seqLabel?: string
}

type PartStageRow = {
  id: string
  partId: string
  stage: Stage
  status: StageStatus
  completedAt?: string
  startedAt?: string
  finishedAt?: string
  by?: string
  // Who clicked ▶ (start), as opposed to `by` (who clicked ✓ finish). Kept in
  // its own column because start and finish can be different people, and 报功
  // counts each worker's starts separately. Set on every start path; preserved
  // through finish via the `...row` spread.
  startedBy?: string
  doneQty?: number
  // 检验-only verdict trio — see StageState in lib/data.ts.
  verdict?: Verdict
  verdictAt?: string
  verdictBy?: string
  // 检验-only verdict detail (migration 0052): 不良原因 + 责任人. Deliberately
  // NOT written by toPartStage — they ride a targeted update in
  // setInspectionVerdictDetail so the general stage upsert keeps working on a
  // pre-0052 DB.
  verdictReason?: string
  verdictOwner?: string
  // 备注 on a passing (OK) verdict (migration 0064). Same targeted-update path.
  verdictNote?: string
}

type VendorRow = {
  id: VendorId
  name: string
  notes?: string
  address?: string
  // Portal link token (migration 0073). Never written via toVendor — only
  // ensureVendorPortalTokens mints it, so vendor edits can't clobber it.
  portalToken?: string
}

type CustomerRow = {
  id: CustomerId
  name: string
  contact?: string
  address?: string
  phone?: string
}

type OutsourceBlockRow = {
  id: string
  vendorId: VendorId
  activity?: string
  stages: Stage[]
  amountCny: number | null
  sentDate: string
  expectedReturn: string
  notes?: string
  docNo?: string
  createdBy?: string
  recipientAddress?: string
  recipientContactName?: string
  recipientContactPhone?: string
  isRush?: boolean
  // Vendor-reported portal state (migration 0073). Read-only from the
  // factory's side; written only by the /w/<token> portal actions.
  vendorSeenAt?: string
  vendorAckAt?: string
  vendorPromisedDate?: string
  vendorDelayReason?: string
  vendorShippedAt?: string
  // 0077: stamped when the WeChat share message is copied for this block.
  wechatSentAt?: string
}

type OutsourceBlockPartRow = {
  blockId: string
  partId: string
  position: number
  // Explicit per-member outsource quantity. Undefined = inherit parts.qty
  // (legacy rows + the "send all" default). When set, this is the count the
  // boss chose to send to the vendor for this part on this block, and it —
  // not parts.qty — drives the member's qty, return cap, and closure.
  qty?: number
  returnedAt?: string
  returnedQty?: number
  // Per-unit vendor price for this part on this block — what the PDF
  // prints in the 单价 column. Independent of block.amountCny: the
  // block-level total stays the manually-entered grand total (加急/待补金额
  // semantics), while line subtotals are derived from qty × unitPriceCny.
  unitPriceCny?: number
}

type ReturnRow = {
  id: string
  jobId: string
  reason: ReturnReason
  reasonText?: string
  dueDate: string
  status: ReturnStatus
  createdAt: string
  closedAt?: string
  createdBy?: string
}

type ReturnPartRow = { returnId: string; partId: string; qty: number }

type ShipmentRow = {
  id: string
  jobId: string
  docNo?: string
  createdAt: string
  createdBy?: string
}

type ShipmentPartRow = {
  shipmentId: string
  partId: string
  qty: number
}

// 财务 side-table row (supabase/migrations/0026_shipment_finance.sql). 1:1
// with shipments; absent until 商务 first records 开票/回款 on a delivery.
type ShipmentFinanceRow = {
  shipmentId: string
  saleAmountCny?: number
  contact?: string
  pendingFlag?: string
  invoiceNo?: string
  invoiceDate?: string
  invoiceAmountCny?: number
  paymentDate?: string
  paymentAmountCny?: number
}

// Boss's per-station pin. One row per (job, stage) the boss has starred.
// Persistent until unpinned — see supabase/migrations/0016_job_stage_pins.sql.
type JobStagePinRow = {
  jobId: string
  stage: Stage
  pinnedAt: string
  pinnedBy?: string
}

type DbSnapshot = {
  jobs: JobRow[]
  parts: PartRow[]
  partStages: PartStageRow[]
  vendors: VendorRow[]
  customers: CustomerRow[]
  outsourceBlocks: OutsourceBlockRow[]
  blockParts: OutsourceBlockPartRow[]
  returns: ReturnRow[]
  returnParts: ReturnPartRow[]
  shipments: ShipmentRow[]
  shipmentParts: ShipmentPartRow[]
  pins: JobStagePinRow[]
  // Indexes — built once in loadSnapshot so the master-board read goes from
  // O(jobs × parts × stages × totalRows) scans down to plain map lookups.
  // Keep the flat arrays around for compatibility; hot paths consult the
  // indexes instead.
  idx: SnapshotIndex
}

type SnapshotIndex = {
  jobById: Map<string, JobRow>
  partById: Map<string, PartRow>
  // Parts grouped by jobId, pre-sorted by position so composeJob doesn't
  // re-sort on every render.
  partsByJob: Map<string, PartRow[]>
  // (partId, stage) → row. Composite key is "${partId} ${stage}" — the
  // null separator avoids collisions with any stage character.
  stageByPartStage: Map<string, PartStageRow>
  // All stage rows for a given part, unordered (callers iterate STAGES in
  // canonical order and lookup per stage).
  stagesByPart: Map<string, PartStageRow[]>
  blockById: Map<string, OutsourceBlockRow>
  // Outsource blocks attached to a part. Each block appears once per part it
  // covers — for partBlocksInSnap.
  blocksByPart: Map<string, OutsourceBlockRow[]>
  // Block-part membership rows, grouped both ways. blockPartsByBlock is
  // pre-sorted by position so blockMembers is a straight map+sorted iter.
  blockPartsByBlock: Map<string, OutsourceBlockPartRow[]>
  blockPartsByPart: Map<string, OutsourceBlockPartRow[]>
  // At most one open return per job (DB guarantees via partial unique index).
  openReturnByJob: Map<string, ReturnRow>
  returnPartsByReturn: Map<string, ReturnPartRow[]>
  // Per-job shipments, sorted by createdAt ASC so callers can walk the audit
  // log in chronological order without re-sorting on every render.
  shipmentsByJob: Map<string, ShipmentRow[]>
  shipmentPartsByShipment: Map<string, ShipmentPartRow[]>
  // Boss-set pins, grouped by job. Tiny set per job (usually 0, occasionally
  // 1–2 stages). `composeJob` flattens this into Job.pinnedStages.
  pinnedStagesByJob: Map<string, Set<Stage>>
}

const STAGE_KEY_SEP = ' '
function stageKey(partId: string, stage: Stage): string {
  return `${partId}${STAGE_KEY_SEP}${stage}`
}

function buildIndex(snap: Omit<DbSnapshot, 'idx'>): SnapshotIndex {
  const jobById = new Map<string, JobRow>()
  for (const j of snap.jobs) jobById.set(j.id, j)

  const partById = new Map<string, PartRow>()
  const partsByJob = new Map<string, PartRow[]>()
  for (const p of snap.parts) {
    partById.set(p.id, p)
    let arr = partsByJob.get(p.jobId)
    if (!arr) {
      arr = []
      partsByJob.set(p.jobId, arr)
    }
    arr.push(p)
  }
  // composeJob expects parts sorted by position — sort once here.
  for (const arr of partsByJob.values()) {
    arr.sort((a, b) => a.position - b.position)
  }

  const stageByPartStage = new Map<string, PartStageRow>()
  const stagesByPart = new Map<string, PartStageRow[]>()
  for (const r of snap.partStages) {
    stageByPartStage.set(stageKey(r.partId, r.stage), r)
    let arr = stagesByPart.get(r.partId)
    if (!arr) {
      arr = []
      stagesByPart.set(r.partId, arr)
    }
    arr.push(r)
  }

  const blockById = new Map<string, OutsourceBlockRow>()
  for (const b of snap.outsourceBlocks) blockById.set(b.id, b)

  const blockPartsByBlock = new Map<string, OutsourceBlockPartRow[]>()
  const blockPartsByPart = new Map<string, OutsourceBlockPartRow[]>()
  for (const bp of snap.blockParts) {
    let byBlock = blockPartsByBlock.get(bp.blockId)
    if (!byBlock) {
      byBlock = []
      blockPartsByBlock.set(bp.blockId, byBlock)
    }
    byBlock.push(bp)
    let byPart = blockPartsByPart.get(bp.partId)
    if (!byPart) {
      byPart = []
      blockPartsByPart.set(bp.partId, byPart)
    }
    byPart.push(bp)
  }
  // blockMembers iterates members in position order — sort once.
  for (const arr of blockPartsByBlock.values()) {
    arr.sort((a, b) => a.position - b.position)
  }

  // Match the original `outsourceBlocks.filter(b => myBlockIds.has(b.id))`
  // ordering — iterate global outsource_blocks in their natural order and
  // distribute each block into every covered part's list.
  const blocksByPart = new Map<string, OutsourceBlockRow[]>()
  for (const b of snap.outsourceBlocks) {
    const bps = blockPartsByBlock.get(b.id) ?? []
    for (const bp of bps) {
      let arr = blocksByPart.get(bp.partId)
      if (!arr) {
        arr = []
        blocksByPart.set(bp.partId, arr)
      }
      // Same block appearing twice in blockParts for the same part would be
      // a unique-constraint violation upstream; the includes() check is a
      // belt-and-braces guard for malformed data.
      if (!arr.includes(b)) arr.push(b)
    }
  }

  const openReturnByJob = new Map<string, ReturnRow>()
  for (const r of snap.returns) {
    if (r.status === 'open') openReturnByJob.set(r.jobId, r)
  }

  const returnPartsByReturn = new Map<string, ReturnPartRow[]>()
  for (const rp of snap.returnParts) {
    let arr = returnPartsByReturn.get(rp.returnId)
    if (!arr) {
      arr = []
      returnPartsByReturn.set(rp.returnId, arr)
    }
    arr.push(rp)
  }

  const shipmentsByJob = new Map<string, ShipmentRow[]>()
  for (const s of snap.shipments) {
    let arr = shipmentsByJob.get(s.jobId)
    if (!arr) {
      arr = []
      shipmentsByJob.set(s.jobId, arr)
    }
    arr.push(s)
  }
  for (const arr of shipmentsByJob.values()) {
    arr.sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    )
  }

  const shipmentPartsByShipment = new Map<string, ShipmentPartRow[]>()
  for (const sp of snap.shipmentParts) {
    let arr = shipmentPartsByShipment.get(sp.shipmentId)
    if (!arr) {
      arr = []
      shipmentPartsByShipment.set(sp.shipmentId, arr)
    }
    arr.push(sp)
  }

  const pinnedStagesByJob = new Map<string, Set<Stage>>()
  for (const p of snap.pins) {
    let set = pinnedStagesByJob.get(p.jobId)
    if (!set) {
      set = new Set()
      pinnedStagesByJob.set(p.jobId, set)
    }
    set.add(p.stage)
  }

  return {
    jobById,
    partById,
    partsByJob,
    stageByPartStage,
    stagesByPart,
    blockById,
    blocksByPart,
    blockPartsByBlock,
    blockPartsByPart,
    openReturnByJob,
    returnPartsByReturn,
    shipmentsByJob,
    shipmentPartsByShipment,
    pinnedStagesByJob,
  }
}

// === Row mappers ===

type AnyRow = Record<string, unknown>

function fromJob(r: AnyRow): JobRow {
  return {
    id: r.id as string,
    jobNo: r.job_no as string,
    customer: r.customer as string,
    customerId: (r.customer_id as string | null) ?? undefined,
    product: r.product as string,
    amountCny: r.amount_cny == null ? undefined : Number(r.amount_cny),
    dueDate: r.due_date as string,
    secondaryDueDate: (r.secondary_due_date as string | null) ?? undefined,
    stagePlan:
      (r.stage_plan as Partial<Record<Stage, string>> | null) ?? undefined,
    notes: (r.notes as string | null) ?? undefined,
    status: (r.status as JobStatus | null) ?? undefined,
    sourceFile: (r.source_file as string | null) ?? undefined,
    sourceFileUrl: (r.source_file_url as string | null) ?? undefined,
    parseError: (r.parse_error as string | null) ?? undefined,
    shippingDocNo: (r.shipping_doc_no as string | null) ?? undefined,
    createdBy: (r.created_by as string | null) ?? undefined,
    contractNo: (r.contract_no as string | null) ?? undefined,
    batchNo: (r.batch_no as string | null) ?? undefined,
    engineer: (r.engineer as string | null) ?? undefined,
    yuenongBusiness: (r.yuenong_business as string | null) ?? undefined,
    createdAt: r.created_at as string,
    position: Number(r.position ?? 0),
    pinnedAt: (r.pinned_at as string | null) ?? undefined,
    pinnedBy: (r.pinned_by as string | null) ?? undefined,
    jobType: ((r.job_type as string | null) ?? undefined) as JobType | undefined,
    isProduct: (r.is_product as boolean | null) ?? undefined,
    pausedAt: (r.paused_at as string | null) ?? undefined,
    pauseReason: (r.pause_reason as string | null) ?? undefined,
    pausedBy: (r.paused_by as string | null) ?? undefined,
    needsOutsource: (r.needs_outsource as boolean | null) ?? undefined,
    outsourceNote: (r.outsource_note as string | null) ?? undefined,
    outsourceFlaggedBy: (r.outsource_flagged_by as string | null) ?? undefined,
    outsourceFlaggedAt: (r.outsource_flagged_at as string | null) ?? undefined,
    drawingChangeOpen: (r.drawing_change_open as boolean | null) ?? undefined,
    drawingChangeNote: (r.drawing_change_note as string | null) ?? undefined,
    drawingChangeBy: (r.drawing_change_by as string | null) ?? undefined,
    drawingChangeAt: (r.drawing_change_at as string | null) ?? undefined,
  }
}

function toJob(r: JobRow) {
  return {
    id: r.id,
    job_no: r.jobNo,
    customer: r.customer,
    customer_id: r.customerId ?? null,
    product: r.product,
    amount_cny: r.amountCny ?? null,
    due_date: r.dueDate,
    secondary_due_date: r.secondaryDueDate ?? null,
    stage_plan: r.stagePlan ?? {},
    notes: r.notes ?? null,
    status: r.status ?? 'ready',
    source_file: r.sourceFile ?? null,
    source_file_url: r.sourceFileUrl ?? null,
    parse_error: r.parseError ?? null,
    shipping_doc_no: r.shippingDocNo ?? null,
    created_by: r.createdBy ?? null,
    contract_no: r.contractNo ?? null,
    batch_no: r.batchNo ?? null,
    engineer: r.engineer ?? null,
    yuenong_business: r.yuenongBusiness ?? null,
    created_at: r.createdAt,
    position: r.position,
    pinned_at: r.pinnedAt ?? null,
    pinned_by: r.pinnedBy ?? null,
    job_type: r.jobType ?? null,
    is_product: r.isProduct ?? false,
    paused_at: r.pausedAt ?? null,
    pause_reason: r.pauseReason ?? null,
    paused_by: r.pausedBy ?? null,
    needs_outsource: r.needsOutsource ?? false,
    outsource_note: r.outsourceNote ?? null,
    outsource_flagged_by: r.outsourceFlaggedBy ?? null,
    outsource_flagged_at: r.outsourceFlaggedAt ?? null,
    drawing_change_open: r.drawingChangeOpen ?? false,
    drawing_change_note: r.drawingChangeNote ?? null,
    drawing_change_by: r.drawingChangeBy ?? null,
    drawing_change_at: r.drawingChangeAt ?? null,
  }
}

function fromPart(r: AnyRow): PartRow {
  return {
    id: r.id as string,
    jobId: r.job_id as string,
    position: Number(r.position ?? 0),
    name: (r.name as string | null) ?? '',
    qty: Number(r.qty ?? 0),
    material: (r.material as string | null) ?? undefined,
    surfaceTreatment: (r.surface_treatment as string | null) ?? undefined,
    notes: (r.notes as string | null) ?? undefined,
    imageUrl: (r.image_url as string | null) ?? undefined,
    unitPriceCny: r.unit_price_cny == null ? undefined : Number(r.unit_price_cny),
    lineTotalCny: r.line_total_cny == null ? undefined : Number(r.line_total_cny),
    partNo: (r.part_no as string | null) ?? undefined,
    process: (r.process as string | null) ?? undefined,
    shipmentLog: (r.shipment_log as string | null) ?? undefined,
    seqLabel: (r.seq_label as string | null) ?? undefined,
  }
}

// NOTE: shipment_log and seq_label are intentionally NOT written here. Neither
// exists at part creation — a shipment record is typed later on the job detail,
// and a fresh part's # is derived from its position until someone overrides it —
// and every toPart call is an INSERT. Keeping them out keeps part-creation /
// 导入订单 decoupled from migrations 0069 / 0088: if a column isn't applied yet,
// inserts still succeed. The only writer of either is updateComponent, gated on
// patch.shipmentLog / patch.seqLabel.
function toPart(r: PartRow) {
  return {
    id: r.id,
    job_id: r.jobId,
    position: r.position,
    name: r.name,
    qty: r.qty,
    material: r.material ?? null,
    surface_treatment: r.surfaceTreatment ?? null,
    notes: r.notes ?? null,
    image_url: r.imageUrl ?? null,
    unit_price_cny: r.unitPriceCny ?? null,
    line_total_cny: r.lineTotalCny ?? null,
    part_no: r.partNo ?? null,
    process: r.process ?? null,
  }
}

function fromPartStage(r: AnyRow): PartStageRow {
  return {
    id: r.id as string,
    partId: r.part_id as string,
    stage: r.stage as Stage,
    status: r.status as StageStatus,
    completedAt: (r.completed_at as string | null) ?? undefined,
    startedAt: (r.started_at as string | null) ?? undefined,
    finishedAt: (r.finished_at as string | null) ?? undefined,
    by: (r.by_actor as string | null) ?? undefined,
    startedBy: (r.started_by_actor as string | null) ?? undefined,
    doneQty:
      r.done_qty != null && Number.isFinite(Number(r.done_qty))
        ? Number(r.done_qty)
        : undefined,
    verdict: (r.verdict as Verdict | null) ?? undefined,
    verdictAt: (r.verdict_at as string | null) ?? undefined,
    verdictBy: (r.verdict_by as string | null) ?? undefined,
    verdictReason: (r.verdict_reason as string | null) ?? undefined,
    verdictOwner: (r.verdict_owner as string | null) ?? undefined,
    verdictNote: (r.verdict_note as string | null) ?? undefined,
  }
}

function toPartStage(r: PartStageRow) {
  return {
    id: r.id,
    part_id: r.partId,
    stage: r.stage,
    status: r.status,
    completed_at: r.completedAt ?? null,
    started_at: r.startedAt ?? null,
    finished_at: r.finishedAt ?? null,
    by_actor: r.by ?? null,
    started_by_actor: r.startedBy ?? null,
    done_qty: r.doneQty ?? null,
    verdict: r.verdict ?? null,
    verdict_at: r.verdictAt ?? null,
    verdict_by: r.verdictBy ?? null,
  }
}

function fromBlock(r: AnyRow): OutsourceBlockRow {
  return {
    id: r.id as string,
    vendorId: r.vendor_id as string,
    activity: (r.activity as string | null) ?? undefined,
    stages: (r.stages as Stage[]) ?? [],
    amountCny: r.amount_cny == null ? null : Number(r.amount_cny),
    sentDate: r.sent_date as string,
    expectedReturn: r.expected_return as string,
    notes: (r.notes as string | null) ?? undefined,
    docNo: (r.doc_no as string | null) ?? undefined,
    createdBy: (r.created_by as string | null) ?? undefined,
    recipientAddress: (r.recipient_address as string | null) ?? undefined,
    recipientContactName: (r.recipient_contact_name as string | null) ?? undefined,
    recipientContactPhone: (r.recipient_contact_phone as string | null) ?? undefined,
    isRush: Boolean(r.is_rush),
    vendorSeenAt: (r.vendor_seen_at as string | null) ?? undefined,
    vendorAckAt: (r.vendor_ack_at as string | null) ?? undefined,
    vendorPromisedDate: (r.vendor_promised_date as string | null) ?? undefined,
    vendorDelayReason: (r.vendor_delay_reason as string | null) ?? undefined,
    vendorShippedAt: (r.vendor_shipped_at as string | null) ?? undefined,
    wechatSentAt: (r.wechat_sent_at as string | null) ?? undefined,
  }
}

// NOTE: deliberately does NOT serialize the vendor_* portal columns —
// toBlock feeds inserts/seed-upserts, and vendor state must only ever be
// written by the portal actions (setBlockVendorState).
function toBlock(r: OutsourceBlockRow) {
  return {
    id: r.id,
    vendor_id: r.vendorId,
    activity: r.activity ?? null,
    stages: r.stages,
    amount_cny: r.amountCny,
    sent_date: r.sentDate,
    expected_return: r.expectedReturn,
    notes: r.notes ?? null,
    doc_no: r.docNo ?? null,
    created_by: r.createdBy ?? null,
    recipient_address: r.recipientAddress ?? null,
    recipient_contact_name: r.recipientContactName ?? null,
    recipient_contact_phone: r.recipientContactPhone ?? null,
    is_rush: r.isRush ?? false,
  }
}

function fromBlockPart(r: AnyRow): OutsourceBlockPartRow {
  return {
    blockId: r.block_id as string,
    partId: r.part_id as string,
    position: Number(r.position ?? 0),
    qty:
      r.qty != null && Number.isFinite(Number(r.qty))
        ? Number(r.qty)
        : undefined,
    returnedAt: (r.returned_at as string | null) ?? undefined,
    returnedQty:
      r.returned_qty != null && Number.isFinite(Number(r.returned_qty))
        ? Number(r.returned_qty)
        : 0,
    unitPriceCny:
      r.unit_price_cny != null && Number.isFinite(Number(r.unit_price_cny))
        ? Number(r.unit_price_cny)
        : undefined,
  }
}

function toBlockPart(r: OutsourceBlockPartRow) {
  return {
    block_id: r.blockId,
    part_id: r.partId,
    position: r.position,
    qty: r.qty ?? null,
    returned_at: r.returnedAt ?? null,
    returned_qty: r.returnedQty ?? 0,
    unit_price_cny: r.unitPriceCny ?? null,
  }
}

function fromVendor(r: AnyRow): VendorRow {
  return {
    id: r.id as string,
    name: r.name as string,
    notes: (r.notes as string | null) ?? undefined,
    address: (r.address as string | null) ?? undefined,
    portalToken: (r.portal_token as string | null) ?? undefined,
  }
}

function toVendor(r: VendorRow) {
  return {
    id: r.id,
    name: r.name,
    notes: r.notes ?? null,
    address: r.address ?? null,
  }
}

function fromCustomer(r: AnyRow): CustomerRow {
  return {
    id: r.id as string,
    name: r.name as string,
    contact: (r.contact as string | null) ?? undefined,
    address: (r.address as string | null) ?? undefined,
    phone: (r.phone as string | null) ?? undefined,
  }
}

function toCustomer(r: CustomerRow) {
  return {
    id: r.id,
    name: r.name,
    contact: r.contact ?? null,
    address: r.address ?? null,
    phone: r.phone ?? null,
  }
}

function fromReturn(r: AnyRow): ReturnRow {
  return {
    id: r.id as string,
    jobId: r.job_id as string,
    reason: r.reason as ReturnReason,
    reasonText: (r.reason_text as string | null) ?? undefined,
    dueDate: r.due_date as string,
    status: r.status as ReturnStatus,
    createdAt: r.created_at as string,
    closedAt: (r.closed_at as string | null) ?? undefined,
    createdBy: (r.created_by_user_id as string | null) ?? undefined,
  }
}

function toReturn(r: ReturnRow) {
  return {
    id: r.id,
    job_id: r.jobId,
    reason: r.reason,
    reason_text: r.reasonText ?? null,
    due_date: r.dueDate,
    status: r.status,
    closed_at: r.closedAt ?? null,
    created_by_user_id: r.createdBy ?? null,
  }
}

function fromReturnPart(r: AnyRow): ReturnPartRow {
  return {
    returnId: r.return_id as string,
    partId: r.part_id as string,
    qty: Number(r.qty ?? 0),
  }
}

function fromShipment(r: AnyRow): ShipmentRow {
  return {
    id: r.id as string,
    jobId: r.job_id as string,
    docNo: (r.doc_no as string | null) ?? undefined,
    createdAt: r.created_at as string,
    createdBy: (r.created_by as string | null) ?? undefined,
  }
}

function toShipment(r: ShipmentRow) {
  return {
    id: r.id,
    job_id: r.jobId,
    doc_no: r.docNo ?? null,
    created_at: r.createdAt,
    created_by: r.createdBy ?? null,
  }
}

function fromShipmentPart(r: AnyRow): ShipmentPartRow {
  return {
    shipmentId: r.shipment_id as string,
    partId: r.part_id as string,
    qty: Number(r.qty ?? 0),
  }
}

function toShipmentPart(r: ShipmentPartRow) {
  return {
    shipment_id: r.shipmentId,
    part_id: r.partId,
    qty: r.qty,
  }
}

function fromShipmentFinance(r: AnyRow): ShipmentFinanceRow {
  return {
    shipmentId: r.shipment_id as string,
    saleAmountCny:
      r.sale_amount_cny == null ? undefined : Number(r.sale_amount_cny),
    contact: (r.contact as string | null) ?? undefined,
    pendingFlag: (r.pending_flag as string | null) ?? undefined,
    invoiceNo: (r.invoice_no as string | null) ?? undefined,
    invoiceDate: (r.invoice_date as string | null) ?? undefined,
    invoiceAmountCny:
      r.invoice_amount_cny == null ? undefined : Number(r.invoice_amount_cny),
    paymentDate: (r.payment_date as string | null) ?? undefined,
    paymentAmountCny:
      r.payment_amount_cny == null ? undefined : Number(r.payment_amount_cny),
  }
}

function fromPin(r: AnyRow): JobStagePinRow {
  return {
    jobId: r.job_id as string,
    stage: r.stage as Stage,
    pinnedAt: r.pinned_at as string,
    pinnedBy: (r.pinned_by as string | null) ?? undefined,
  }
}

// In-process write lock — serializes multi-row writes within one Vercel
// function instance. Cross-instance races are MVP-acceptable.
let writeChain: Promise<unknown> = Promise.resolve()

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn)
  writeChain = next.catch(() => undefined)
  return next
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// === Auto-seed on empty DB ===

let seedingPromise: Promise<void> | null = null

async function ensureSeeded(): Promise<void> {
  if (seedingPromise) return seedingPromise
  const p = (async () => {
    const { count, error } = await supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
    if (error) throw error
    if ((count ?? 0) > 0) return
    await seedFromConstants()
  })()
  seedingPromise = p
  try {
    await p
  } catch (e) {
    seedingPromise = null
    throw e
  }
}

async function seedFromConstants(): Promise<void> {
  const now = new Date().toISOString()
  const jobRows: JobRow[] = []
  const partRows: PartRow[] = []
  const stageRows: PartStageRow[] = []
  const blockRows: OutsourceBlockRow[] = []
  const blockPartRows: OutsourceBlockPartRow[] = []

  SEED.forEach((j, ji) => {
    jobRows.push({
      id: j.id,
      jobNo: j.jobNo,
      customer: j.customer,
      product: j.product,
      amountCny: j.amountCny,
      dueDate: j.dueDate,
      notes: j.notes,
      status: 'ready',
      createdAt: now,
      position: ji,
    })
    j.components.forEach((c, ci) => {
      const partId = `${j.id}:${c.id}`
      partRows.push({
        id: partId,
        jobId: j.id,
        position: ci,
        name: c.name,
        qty: c.qty,
        material: c.material,
        surfaceTreatment: c.surfaceTreatment,
        notes: c.notes,
      })
      for (const stage of STAGES) {
        const s = c.stages[stage]
        if (!s) continue
        stageRows.push({
          id: `${partId}:${stage}`,
          partId,
          stage,
          status: s.status,
          completedAt: s.completedAt,
          by: s.by,
        })
      }
      for (const b of c.outsourceBlocks ?? []) {
        if (!blockRows.some((br) => br.id === b.id)) {
          blockRows.push({
            id: b.id,
            vendorId: b.vendorId,
            stages: b.stages,
            amountCny: b.amountCny,
            sentDate: b.sentDate,
            expectedReturn: b.expectedReturn,
            notes: b.notes,
          })
        }
        const member = b.members.find((m) => m.componentId === c.id)
        blockPartRows.push({
          blockId: b.id,
          partId,
          position: 0,
          returnedAt: member?.returnedAt,
        })
      }
    })
  })

  if (VENDOR_SEED.length > 0) {
    const rows = VENDOR_SEED.map((v) => toVendor({ id: v.id, name: v.name, notes: v.notes }))
    const { error } = await supabase.from('vendors').upsert(rows, {
      onConflict: 'id',
      ignoreDuplicates: true,
    })
    if (error) throw error
  }
  if (jobRows.length) {
    const { error } = await supabase
      .from('jobs')
      .upsert(jobRows.map(toJob), { onConflict: 'id', ignoreDuplicates: true })
    if (error) throw error
  }
  if (partRows.length) {
    const { error } = await supabase
      .from('parts')
      .upsert(partRows.map(toPart), { onConflict: 'id', ignoreDuplicates: true })
    if (error) throw error
  }
  if (stageRows.length) {
    const { error } = await supabase
      .from('part_stages')
      .upsert(stageRows.map(toPartStage), { onConflict: 'id', ignoreDuplicates: true })
    if (error) throw error
  }
  if (blockRows.length) {
    const { error } = await supabase
      .from('outsource_blocks')
      .upsert(blockRows.map(toBlock), { onConflict: 'id', ignoreDuplicates: true })
    if (error) throw error
  }
  if (blockPartRows.length) {
    const { error } = await supabase
      .from('outsource_block_parts')
      .upsert(blockPartRows.map(toBlockPart), {
        onConflict: 'block_id,part_id',
        ignoreDuplicates: true,
      })
    if (error) throw error
  }
}

// === Snapshot loader (single bulk fetch of all five tables) ===

// PostgREST (and therefore @supabase/supabase-js .select()) caps a single
// response at 1000 rows by default — anything past that is silently
// truncated. For a real factory dataset (jobs × ~10 parts × 9 stages),
// part_stages alone exceeds 1000 within a few dozen jobs. A truncated
// snapshot manifests as ghost-state bugs: a chip renders hollow because
// its row didn't fit in the page, the user clicks to add it, the server
// also doesn't see the row in its own snapshot, the upsert is a no-op
// against the row that actually exists, and on refresh the chip pops back
// to its truncated rendering. Same pagination needed for every table —
// jobs/parts/customers all grow with usage.
const PAGE_SIZE = 1000

async function selectAll(table: string): Promise<AnyRow[]> {
  const out: AnyRow[] = []
  let from = 0
  // Loop until a page returns fewer than PAGE_SIZE rows. range() is
  // inclusive on both ends, so [0, 999] is the first 1000 rows.
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const rows = (data ?? []) as AnyRow[]
    out.push(...rows)
    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return out
}

// Paginated `.in('col', values)` fetch. Two limits bite here, on opposite
// ends of the request:
//   1. Response rows — PostgREST's 1000-row cap. A single job with ≥112
//      parts puts part_stages over the cap and the tail rows vanish from the
//      snapshot (the chip-widget ghost-state bug the selectAll comment warns
//      about). Handled by range() windowing.
//   2. Request URL — undici rejects request headers over ~16KB
//      (HeadersOverflowError / UND_ERR_HEADERS_OVERFLOW). A job with enough
//      parts (~350+) makes the `.in('part_id', [...])` URL overflow, which
//      fails loadJobSnapshot — and thus 外协 创建 / any per-job write — on the
//      biggest jobs. So we also CHUNK the values list: ~36-char UUIDs × 100
//      keeps each URL ~4KB, and every chunk is range-paginated in turn.
async function selectAllIn(
  table: string,
  column: string,
  values: string[],
): Promise<AnyRow[]> {
  if (values.length === 0) return []
  const IN_CHUNK = 100
  const out: AnyRow[] = []
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const chunk = values.slice(i, i + IN_CHUNK)
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .in(column, chunk)
        .range(from, from + PAGE_SIZE - 1)
      if (error) throw error
      const rows = (data ?? []) as AnyRow[]
      out.push(...rows)
      if (rows.length < PAGE_SIZE) break
      from += PAGE_SIZE
    }
  }
  return out
}

// Run a SELECT/UPDATE/DELETE whose only large filter is a `.in(col, ids)`
// list, in chunks, so the request URL never crosses undici's ~16KB header
// limit on jobs with hundreds of parts (the same overflow selectAllIn guards
// against — see its comment). `build(chunk)` returns the PostgREST builder for
// one slice; rows from every chunk are concatenated. Effects/rows must be
// independent per chunk (true for these per-part writes) since order across
// chunks isn't defined. No range() paging here — callers either don't read
// rows back (UPDATE/DELETE) or read a bounded set (.limit / by unique id).
async function inChunks<T = AnyRow>(
  ids: string[],
  build: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const IN_CHUNK = 100
  const out: T[] = []
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await build(ids.slice(i, i + IN_CHUNK))
    if (error) throw error
    if (data) out.push(...data)
  }
  return out
}

// PostgREST returns code 'PGRST205' when a table referenced in a query
// doesn't exist in the schema cache. Used by the pin loaders to tolerate
// pre-migration state so the rest of the app keeps working until the
// boss/operator applies supabase/migrations/0016_job_stage_pins.sql.
function isMissingTableError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const code = (e as { code?: unknown }).code
  return code === 'PGRST205'
}

// "column does not exist" (42703) — hit when the running code selects a view
// column a not-yet-applied migration hasn't added. Lets hot read paths fall
// back to the pre-migration column set instead of 500'ing the whole page.
function isMissingColumnError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const code = (e as { code?: unknown }).code
  // 42703 — Postgres "column does not exist" (SELECT path).
  // PGRST204 — PostgREST "could not find column in schema cache", which is
  // what an INSERT/UPDATE payload naming a not-yet-migrated column raises.
  return code === '42703' || code === 'PGRST204'
}

function isMissingFunctionError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const code = (e as { code?: unknown }).code
  return code === 'PGRST202' || code === '42883'
}

let warnedMissingPins = false
function warnMissingPinsTableOnce(): void {
  if (warnedMissingPins) return
  warnedMissingPins = true
  console.warn(
    '[siyue] job_stage_pins table missing — pin feature is no-op until ' +
      'supabase/migrations/0016_job_stage_pins.sql is applied.',
  )
}

// Same as selectAll, but tolerates a missing-table error by returning [].
// Use ONLY for tables that may genuinely not exist yet (newly-added in a
// migration that hasn't been applied to the live DB).
async function selectAllOptional(table: string): Promise<AnyRow[]> {
  try {
    return await selectAll(table)
  } catch (e) {
    if (isMissingTableError(e)) {
      warnMissingPinsTableOnce()
      return []
    }
    throw e
  }
}

// ── Cross-worker idempotency (mutation_log, migration 0058) ──────────────
// The /api/mutate route dedupes client retries. In-memory works for one pm2
// worker; under cluster mode a retry can land on a different worker, so the
// durable store below is the cross-worker backstop. Both helpers degrade to
// no-op / null if the table isn't applied yet (running-code-ahead-of-DB), so
// the route falls back to its in-memory Map cleanly.
const MUTATION_LOG_TTL_MS = 60_000

export async function getCachedMutationResponse(
  requestId: string,
): Promise<{ status: number; body: unknown } | null> {
  try {
    const { data, error } = await supabase
      .from('mutation_log')
      .select('status, body, created_at')
      .eq('request_id', requestId)
      .maybeSingle()
    if (error) {
      if (isMissingTableError(error)) return null
      throw error
    }
    if (!data) return null
    // Honor the same TTL the in-memory cache uses — a stale requestId reuse
    // (vanishingly unlikely with UUIDs) shouldn't replay an ancient response.
    const createdAt = Date.parse((data as AnyRow).created_at as string)
    if (Number.isFinite(createdAt) && Date.now() - createdAt > MUTATION_LOG_TTL_MS) {
      return null
    }
    return { status: (data as AnyRow).status as number, body: (data as AnyRow).body }
  } catch (e) {
    // Never let the idempotency lookup fail the mutation itself — log and
    // proceed as a cache miss (worst case: a killed-then-retried write may
    // re-run, same risk as the pre-cluster single-worker Map on eviction).
    console.error('[mutation_log] lookup failed', e)
    return null
  }
}

export async function recordMutationResponse(
  requestId: string,
  status: number,
  body: unknown,
): Promise<void> {
  try {
    const { error } = await supabase
      .from('mutation_log')
      .upsert(
        { request_id: requestId, status, body: body as AnyRow },
        { onConflict: 'request_id' },
      )
    if (error && !isMissingTableError(error)) throw error
  } catch (e) {
    // Recording is best-effort; a failure here only weakens dedupe, never the
    // write that already succeeded.
    console.error('[mutation_log] record failed', e)
  }
}

// Focused loader for a single job. Pulls only the rows that belong to this
// job — never the whole database — so getJob and the post-write composers
// stay flat-fast even when the factory has thousands of total rows. Returns
// the same DbSnapshot shape as loadSnapshot so composeJob is unchanged.
//
// Vendors and customers are intentionally left empty: composeJob doesn't
// reference them (vendor-name decoration happens in `effectiveStageState`,
// which the page passes its own `vendors` list into separately).
//
// Outsource blocks are de-facto per-job — `createOutsourceBlockAt` enforces
// that every component in a block belongs to the same job. So fetching the
// block rows whose ids appear in this job's block_parts is sufficient, and
// no cross-job parts need to be loaded for blockMembers to render.
async function loadJobSnapshot(jobId: string): Promise<DbSnapshot> {
  await ensureSeeded()

  const [jobR, partsR, returnsR] = await Promise.all([
    supabase.from('jobs').select('*').eq('id', jobId).maybeSingle(),
    supabase.from('parts').select('*').eq('job_id', jobId),
    supabase.from('returns').select('*').eq('job_id', jobId),
  ])
  if (jobR.error) throw jobR.error
  if (partsR.error) throw partsR.error
  if (returnsR.error) throw returnsR.error

  if (!jobR.data) {
    const empty = {
      jobs: [] as JobRow[],
      parts: [] as PartRow[],
      partStages: [] as PartStageRow[],
      vendors: [] as VendorRow[],
      customers: [] as CustomerRow[],
      outsourceBlocks: [] as OutsourceBlockRow[],
      blockParts: [] as OutsourceBlockPartRow[],
      returns: [] as ReturnRow[],
      returnParts: [] as ReturnPartRow[],
      shipments: [] as ShipmentRow[],
      shipmentParts: [] as ShipmentPartRow[],
      pins: [] as JobStagePinRow[],
    }
    return { ...empty, idx: buildIndex(empty) }
  }

  const jobs = [fromJob(jobR.data as AnyRow)]
  const parts = (partsR.data ?? []).map(fromPart)
  const returns = (returnsR.data ?? []).map(fromReturn)
  const partIds = parts.map((p) => p.id)
  const returnIds = returns.map((r) => r.id)

  // Every `.in()` here goes through selectAllIn so the PostgREST 1000-row
  // cap doesn't silently lop off the tail. part_stages is the one that
  // actually trips on real factory jobs (≥112 parts × 9 stages > 1000) —
  // see the selectAll comment for the ghost-state bug that follows when
  // it does.
  const [partStagesRaw, blockPartsRaw, returnPartsRaw, pinsRaw] =
    await Promise.all([
      selectAllIn('part_stages', 'part_id', partIds),
      selectAllIn('outsource_block_parts', 'part_id', partIds),
      selectAllIn('return_parts', 'return_id', returnIds),
      (async () => {
        try {
          const { data, error } = await supabase
            .from('job_stage_pins')
            .select('*')
            .eq('job_id', jobId)
          if (error) throw error
          return data ?? []
        } catch (e) {
          if (isMissingTableError(e)) {
            warnMissingPinsTableOnce()
            return []
          }
          throw e
        }
      })(),
    ])
  const shipmentsR = await supabase
    .from('shipments')
    .select('*')
    .eq('job_id', jobId)
  if (shipmentsR.error) throw shipmentsR.error

  const partStages = partStagesRaw.map(fromPartStage)
  const blockParts = blockPartsRaw.map(fromBlockPart)
  const returnParts = returnPartsRaw.map(fromReturnPart)
  const shipments = (shipmentsR.data ?? []).map(fromShipment)
  const pins = pinsRaw.map(fromPin)

  const shipmentIds = shipments.map((s) => s.id)
  const shipmentParts = (
    await selectAllIn('shipment_parts', 'shipment_id', shipmentIds)
  ).map(fromShipmentPart)

  const blockIds = [...new Set(blockParts.map((bp) => bp.blockId))]
  const outsourceBlocks = (
    await selectAllIn('outsource_blocks', 'id', blockIds)
  ).map(fromBlock)

  const base = {
    jobs,
    parts,
    partStages,
    vendors: [] as VendorRow[],
    customers: [] as CustomerRow[],
    outsourceBlocks,
    blockParts,
    returns,
    returnParts,
    shipments,
    shipmentParts,
    pins,
  }
  return { ...base, idx: buildIndex(base) }
}

// === Focused resolvers for the write-path sweep ===
//
// Mutation handlers used to call loadSnapshot() to compose state for the
// affected job — at 500 jobs × 30 parts that's a 15MB cross-border fetch
// per click. The handlers below now scope to loadJobSnapshot(jobId) instead,
// but a few cross-job checks (jobNo uniqueness, vendor existence, block →
// owning-job lookup) need narrow queries here. Keep each one minimal.

// Direct DB query for jobNo conflicts. Replaces findJobNoConflictInSnap for
// the (jobNo, excludeJobId?) signature, so updateJob / fillParsedJob /
// confirmJob don't have to scan the whole snapshot just to check uniqueness.
async function findJobNoConflictByQuery(
  jobNo: string,
  excludeJobId?: string,
): Promise<JobNoConflict | null> {
  const trimmed = jobNo.trim()
  if (!trimmed) return null
  let q = supabase
    .from('jobs')
    .select('id, job_no, customer, status')
    .eq('job_no', trimmed)
    .in('status', ['draft', 'ready'])
  if (excludeJobId) q = q.neq('id', excludeJobId)
  const { data, error } = await q.limit(1)
  if (error) throw error
  const row = (data ?? [])[0] as AnyRow | undefined
  if (!row) return null
  return {
    id: row.id as string,
    jobNo: row.job_no as string,
    customer: row.customer as string,
    status: row.status as JobStatus,
  }
}

// Lookup helper: a block ID → its owning job ID. Outsource blocks span
// parts of a single job (createOutsourceBlockAt enforces it), so any member
// resolves to the same jobId.
async function resolveBlockJobId(blockId: string): Promise<string | undefined> {
  const { data: bpData, error: bpError } = await supabase
    .from('outsource_block_parts')
    .select('part_id')
    .eq('block_id', blockId)
    .limit(1)
  if (bpError) throw bpError
  const bp = (bpData ?? [])[0] as AnyRow | undefined
  if (!bp) return undefined
  const { data: pData, error: pError } = await supabase
    .from('parts')
    .select('job_id')
    .eq('id', bp.part_id as string)
    .maybeSingle()
  if (pError) throw pError
  return (pData?.job_id as string | undefined) ?? undefined
}

// Tiny existence check for createOutsourceBlockAt's vendor guard. The
// loadJobSnapshot path doesn't load vendors (composeJob doesn't need them);
// this gives back the boolean without dragging the whole vendor table in.
async function vendorExistsByQuery(vendorId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('vendors')
    .select('id')
    .eq('id', vendorId)
    .limit(1)
  if (error) throw error
  return (data ?? []).length > 0
}

async function loadSnapshot(): Promise<DbSnapshot> {
  await ensureSeeded()
  const [
    jobs,
    parts,
    stages,
    vendors,
    customers,
    blocks,
    blockParts,
    returns,
    returnParts,
    shipments,
    shipmentParts,
    pins,
  ] = await Promise.all([
    selectAll('jobs'),
    selectAll('parts'),
    selectAll('part_stages'),
    selectAll('vendors'),
    selectAll('customers'),
    selectAll('outsource_blocks'),
    selectAll('outsource_block_parts'),
    selectAll('returns'),
    selectAll('return_parts'),
    selectAll('shipments'),
    selectAll('shipment_parts'),
    selectAllOptional('job_stage_pins'),
  ])
  const base = {
    jobs: jobs.map(fromJob),
    parts: parts.map(fromPart),
    partStages: stages.map(fromPartStage),
    vendors: vendors.map(fromVendor),
    customers: customers.map(fromCustomer),
    outsourceBlocks: blocks.map(fromBlock),
    blockParts: blockParts.map(fromBlockPart),
    returns: returns.map(fromReturn),
    returnParts: returnParts.map(fromReturnPart),
    shipments: shipments.map(fromShipment),
    shipmentParts: shipmentParts.map(fromShipmentPart),
    pins: pins.map(fromPin),
  }
  return { ...base, idx: buildIndex(base) }
}

// === Compose nested Job from flat rows ===

// Strip the `${jobId}:` prefix from a part_id to match the exposed
// component id (see composeJob below). Used by both the activeReturn parts
// list and the shipments audit log so consumers compare on the same key.
function trimPartId(partId: string): string {
  return partId.split(':').slice(1).join(':') || partId
}

function composeJob(job: JobRow, snap: DbSnapshot): Job {
  const myParts = snap.idx.partsByJob.get(job.id) ?? []
  const openReturn = snap.idx.openReturnByJob.get(job.id)
  let activeReturn: JobReturn | undefined
  if (openReturn) {
    const rps = snap.idx.returnPartsByReturn.get(openReturn.id) ?? []
    activeReturn = {
      id: openReturn.id,
      jobId: openReturn.jobId,
      reason: openReturn.reason,
      reasonText: openReturn.reasonText,
      dueDate: openReturn.dueDate,
      status: openReturn.status,
      createdAt: openReturn.createdAt,
      closedAt: openReturn.closedAt,
      createdBy: openReturn.createdBy,
      parts: rps.map((rp) => ({
        partId: trimPartId(rp.partId),
        qty: rp.qty,
      })),
    }
  }
  const shipments = (snap.idx.shipmentsByJob.get(job.id) ?? []).map((s) => ({
    id: s.id,
    docNo: s.docNo,
    createdAt: s.createdAt,
    createdBy: s.createdBy,
    parts: (snap.idx.shipmentPartsByShipment.get(s.id) ?? []).map((sp) => ({
      componentId: trimPartId(sp.partId),
      qty: sp.qty,
    })),
  }))
  return {
    id: job.id,
    jobNo: job.jobNo,
    customer: job.customer,
    customerId: job.customerId,
    product: job.product,
    amountCny: job.amountCny,
    dueDate: job.dueDate,
    secondaryDueDate: job.secondaryDueDate,
    stagePlan: job.stagePlan,
    notes: job.notes,
    status: job.status,
    sourceFile: job.sourceFile,
    sourceFileUrl: job.sourceFileUrl,
    parseError: job.parseError,
    shippingDocNo: job.shippingDocNo,
    createdBy: job.createdBy,
    contractNo: job.contractNo,
    batchNo: job.batchNo,
    engineer: job.engineer,
    yuenongBusiness: job.yuenongBusiness,
    createdAt: job.createdAt,
    components: myParts.map((p) => {
      // Per-part route: only stages with a row in part_stages apply. A gap
      // means the part doesn't visit that station at all (n/a). 出货 is
      // guaranteed by the write path to always have a row.
      const partStages: Partial<Record<Stage, StageState>> = {}
      for (const stage of STAGES) {
        const row = snap.idx.stageByPartStage.get(stageKey(p.id, stage))
        if (row) {
          partStages[stage] = {
            status: row.status,
            completedAt: row.completedAt,
            startedAt: row.startedAt,
            finishedAt: row.finishedAt,
            by: row.by,
            startedBy: row.startedBy,
            doneQty: row.doneQty,
            verdict: row.verdict,
            verdictAt: row.verdictAt,
            verdictBy: row.verdictBy,
            verdictReason: row.verdictReason,
            verdictOwner: row.verdictOwner,
            verdictNote: row.verdictNote,
          }
        }
      }
      const blocks = (snap.idx.blocksByPart.get(p.id) ?? [])
        .map<OutsourceBlock>((b) => ({
          id: b.id,
          vendorId: b.vendorId,
          activity: b.activity,
          stages: b.stages,
          amountCny: b.amountCny,
          sentDate: b.sentDate,
          expectedReturn: b.expectedReturn,
          notes: b.notes,
          docNo: b.docNo,
          createdBy: b.createdBy,
          recipientAddress: b.recipientAddress,
          recipientContactName: b.recipientContactName,
          recipientContactPhone: b.recipientContactPhone,
          isRush: b.isRush,
          vendorSeenAt: b.vendorSeenAt,
          vendorAckAt: b.vendorAckAt,
          vendorPromisedDate: b.vendorPromisedDate,
          vendorDelayReason: b.vendorDelayReason,
          vendorShippedAt: b.vendorShippedAt,
          members: blockMembers(snap, b.id),
        }))
      return {
        id: trimPartId(p.id),
        name: p.name,
        qty: p.qty,
        material: p.material,
        surfaceTreatment: p.surfaceTreatment,
        process: p.process,
        notes: p.notes,
        imageUrl: p.imageUrl,
        unitPriceCny: p.unitPriceCny,
        lineTotalCny: p.lineTotalCny,
        partNo: p.partNo,
        shipmentLog: p.shipmentLog,
        seqLabel: p.seqLabel,
        stages: partStages,
        outsourceBlocks: blocks.length > 0 ? blocks : undefined,
      }
    }),
    activeReturn,
    shipments,
    pinnedStages: (() => {
      const set = snap.idx.pinnedStagesByJob.get(job.id)
      if (!set || set.size === 0) return undefined
      // Stable canonical order so client snapshots compare cleanly.
      return STAGES.filter((s) => set.has(s))
    })(),
    pinnedAt: job.pinnedAt,
    pinnedBy: job.pinnedBy,
    jobType: job.jobType,
    isProduct: job.isProduct,
    pausedAt: job.pausedAt,
    pauseReason: job.pauseReason,
    pausedBy: job.pausedBy,
    needsOutsource: job.needsOutsource,
    outsourceNote: job.outsourceNote,
    outsourceFlaggedBy: job.outsourceFlaggedBy,
    outsourceFlaggedAt: job.outsourceFlaggedAt,
    drawingChangeOpen: job.drawingChangeOpen,
    drawingChangeNote: job.drawingChangeNote,
    drawingChangeBy: job.drawingChangeBy,
    drawingChangeAt: job.drawingChangeAt,
  }
}

// === Snapshot helpers (mirror what `read()` + in-memory math used to do) ===

function findPartIdInSnap(
  snap: DbSnapshot,
  jobId: string,
  componentId: string,
): string | undefined {
  // Modern parts use `${jobId}:${componentId}` as the row id — try that first.
  const direct = `${jobId}:${componentId}`
  if (snap.idx.partById.has(direct)) return direct
  // Legacy / hand-typed componentId path: the row id might equal the
  // componentId itself, but only count it if it belongs to this job.
  const byBare = snap.idx.partById.get(componentId)
  if (byBare && byBare.jobId === jobId) return byBare.id
  return undefined
}

function partBlocksInSnap(snap: DbSnapshot, partId: string): OutsourceBlockRow[] {
  return snap.idx.blocksByPart.get(partId) ?? []
}

function blockMembers(snap: DbSnapshot, blockId: string) {
  const bps = snap.idx.blockPartsByBlock.get(blockId) ?? []
  return bps
    .map((bp) => {
      const part = snap.idx.partById.get(bp.partId)
      if (!part) {
        // Orphan blockParts row — referenced part has been deleted or re-id'd.
        // Surfacing it as a placeholder instead of dropping it keeps row
        // counts honest on the printed 外协单 and gives commerce a visible
        // cue to fix the data. PDF renderer detects the `__orphan__`
        // componentId prefix and styles the row in red.
        return {
          componentId: `__orphan__:${bp.partId}`,
          name: `[已删除零件 ${bp.partId}]`,
          qty: bp.qty != null ? bp.qty : 0,
          material: undefined,
          imageUrl: undefined,
          partNo: undefined,
          returnedAt: bp.returnedAt,
          returnedQty: bp.returnedQty ?? 0,
          unitPriceCny: bp.unitPriceCny,
        }
      }
      return {
        componentId: part.id.split(':').slice(1).join(':') || part.id,
        name: part.name,
        // Effective outsource qty: the explicit per-member qty when set,
        // otherwise the part's full qty (legacy / "send all").
        qty: bp.qty != null ? bp.qty : part.qty,
        material: part.material,
        partNo: part.partNo,
        imageUrl: part.imageUrl,
        returnedAt: bp.returnedAt,
        returnedQty: bp.returnedQty ?? 0,
        unitPriceCny: bp.unitPriceCny,
      }
    })
}

function canStartInSnap(snap: DbSnapshot, partId: string, stage: Stage): boolean {
  const blocks = partBlocksInSnap(snap, partId)
  // Per-stage gate only — a block covering OTHER stages on this part doesn't
  // block in-house work on stages the vendor isn't handling. Treat each
  // non-outsourced stage as if the part were fully in-house.
  if (blocks.some((b) => b.stages.includes(stage))) return false
  const row = snap.idx.stageByPartStage.get(stageKey(partId, stage))
  return row ? row.status === 'pending' : false
}

// Starting a stage IS physical evidence the part reached this station — every
// prior in-route stage already happened in the real world, whether or not its
// head remembered to tap ✓. Close them at the same instant as the start, so a
// missed upstream tap can't strand the part in every queue behind it (the
// 上游-forever failure: 编程 forgets to tick, 操机 can see the part on their
// bench but their station page files the job under 上游 with no action).
//
// Attribution stays honest without any reporting change: `by` is left unset
// (by_actor NULL) because nobody tapped those stages — worker_output/
// worker_stage_events (0072) already drop null actors, so the starter is
// never credited with upstream finishes. Genuinely-tapped stages are 'done'
// and untouched, same rule as cascadeBackFinish.
//
// Vendor-covered stages are skipped entirely: the outsource block lifecycle
// (回厂 / 出货 sweep) owns their truth, and every rollup reads them through
// the block, not the part_stages row.
function cascadeBackStart(
  snap: DbSnapshot,
  partId: string,
  atStage: Stage,
  date: string,
  startedAtIso: string,
): PartStageRow[] {
  const idx = STAGES.indexOf(atStage)
  if (idx <= 0) return []
  const blocks = partBlocksInSnap(snap, partId)
  const changed: PartStageRow[] = []
  for (let i = 0; i < idx; i++) {
    const s = STAGES[i]
    if (blocks.some((b) => b.stages.includes(s))) continue
    if (!stageStartImpliesUpstreamDone(atStage, s)) continue
    const row = snap.idx.stageByPartStage.get(stageKey(partId, s))
    if (!row) continue
    if (row.status === 'done') continue
    changed.push({
      ...row,
      status: 'done',
      completedAt: date,
      finishedAt: startedAtIso,
      by: undefined,
      doneQty: undefined,
    })
  }
  return changed
}

function cascadeBackFinish(
  snap: DbSnapshot,
  partId: string,
  upToStage: Stage,
  date: string,
  finishedAtIso: string,
  actor: string,
): PartStageRow[] {
  // Only 出货 cascades back. Confirming finish at any other station applies
  // strictly to that station — heads sign off on their own work, not their
  // upstream's. 出货 is the exception: shipping a part implies everything
  // earlier was done, and we let the shipping head close out the row in one
  // click rather than chasing missed taps at prior stations. That includes
  // stages covered by an outsource block: if the part physically shipped,
  // the vendor's work is over, whether or not anyone logged the 回厂.
  if (upToStage !== '出货') return []
  const idx = STAGES.indexOf(upToStage)
  const changed: PartStageRow[] = []
  for (let i = 0; i < idx; i++) {
    const s = STAGES[i]
    const row = snap.idx.stageByPartStage.get(stageKey(partId, s))
    if (!row) continue
    if (row.status === 'done') continue
    changed.push({
      ...row,
      status: 'done',
      completedAt: date,
      finishedAt: finishedAtIso,
      by: actor,
      doneQty: undefined,
    })
  }
  return changed
}

// 出货 sweep of vendor lines — the physical counterpart of cascadeBackFinish.
// Shipping means the parts exist and left the building, so any still-open
// outsource-block member for them is de facto returned: stamp returned_qty
// to the member qty so blockClosedAt derives a close and the board's
// 外协-open signal (cell ⏸外协 + row badge) clears. Runs inside the caller's
// write lock; one small UPDATE per unsettled member.
async function closeOpenOutsourceMembersForParts(
  snap: DbSnapshot,
  partIds: string[],
  date: string,
): Promise<void> {
  for (const partId of partIds) {
    const blocks = partBlocksInSnap(snap, partId)
    for (const b of blocks) {
      const bps = snap.idx.blockPartsByBlock.get(b.id) ?? []
      const bp = bps.find((x) => x.partId === partId)
      if (!bp) continue
      const part = snap.idx.partById.get(partId)
      const memberQty = bp.qty != null ? bp.qty : (part?.qty ?? 0)
      if ((bp.returnedQty ?? 0) >= memberQty) continue
      const { error } = await supabase
        .from('outsource_block_parts')
        .update({ returned_qty: memberQty, returned_at: date })
        .eq('block_id', b.id)
        .eq('part_id', partId)
      if (error) throw error
    }
  }
}

async function upsertStages(rows: PartStageRow[]): Promise<void> {
  if (rows.length === 0) return
  const { error } = await supabase
    .from('part_stages')
    .upsert(rows.map(toPartStage), { onConflict: 'id' })
  if (error) throw error
}

// === Reads ===

export async function getJobs(): Promise<Job[]> {
  const snap = await loadSnapshot()
  return snap.jobs
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((j) => composeJob(j, snap))
}

// Block-focused read for /station/outsource (and any future block listing).
// Returns one entry per outsource block with its members + job context,
// without loading any unrelated jobs / parts / part_stages. Replaces the
// allOutsourceBlocks(jobs) traversal that needed the full snapshot.
//
// One trip to Supabase fans out into four small parallel queries:
//   • outsource_blocks            ~hundreds, paginated
//   • outsource_block_parts       ~hundreds, paginated
//   • parts (light cols)          only parts that appear in a block_parts row
//   • jobs (light cols)           only jobs of those parts
// All assembly happens here so callers get the OpenBlockRow shape they expect.
export async function getOutsourceBlockRows(): Promise<
  import('./data').OpenBlockRow[]
> {
  await ensureSeeded()
  const PAGE = 1000
  // The board aggregates EVERY outsource block across all jobs, so the
  // parts/jobs id-lists here grow without bound. Chunk any `.in(col, ids)`
  // list so the request URL never crosses undici's ~16KB header limit
  // (HeadersOverflowError) — past ~360 ids the whole board failed to render,
  // which read to the floor as "服务器停止". Each chunk is still response-
  // paginated (count-aware head + fanned-out tails) against the 1000-row cap.
  const IN_CHUNK = 100
  const fetchAll = async <T>(
    qb: () => ReturnType<typeof supabase.from>,
    sel: string,
    inCol?: string,
    inVals?: string[],
  ): Promise<T[]> => {
    if (inCol && (!inVals || inVals.length === 0)) return []
    const chunks: (string[] | undefined)[] =
      inCol && inVals
        ? Array.from({ length: Math.ceil(inVals.length / IN_CHUNK) }, (_, i) =>
            inVals.slice(i * IN_CHUNK, i * IN_CHUNK + IN_CHUNK),
          )
        : [undefined]

    const out: T[] = []
    for (const chunk of chunks) {
      const build = (countMode: 'exact' | undefined) => {
        let q = qb().select(sel, countMode ? { count: countMode } : undefined)
        if (inCol && chunk) q = q.in(inCol, chunk)
        return q
      }
      // Same parallel-pagination pattern as getMasterRows: one count-aware
      // first page, then any remaining pages fanned out in Promise.all.
      const first = await build('exact').range(0, PAGE - 1)
      if (first.error) throw first.error
      const head = (first.data ?? []) as T[]
      const total = first.count ?? head.length
      out.push(...head)
      if (total <= PAGE) continue
      const tailRanges: Array<[number, number]> = []
      for (let from = PAGE; from < total; from += PAGE) {
        tailRanges.push([from, Math.min(from + PAGE - 1, total - 1)])
      }
      const tails = await Promise.all(
        tailRanges.map(([lo, hi]) => build(undefined).range(lo, hi)),
      )
      for (const r of tails) {
        if (r.error) throw r.error
        out.push(...((r.data ?? []) as T[]))
      }
    }
    return out
  }

  const [blocksRows, blockPartsRows] = await Promise.all([
    fetchAll<AnyRow>(() => supabase.from('outsource_blocks'), '*'),
    fetchAll<AnyRow>(() => supabase.from('outsource_block_parts'), '*'),
  ])
  if (blocksRows.length === 0) return []

  const partIds = Array.from(new Set(blockPartsRows.map((bp) => bp.part_id as string)))
  const partsRows = await fetchAll<AnyRow>(
    () => supabase.from('parts'),
    'id, job_id, name, qty, material, image_url, position',
    'id',
    partIds,
  )
  const jobIds = Array.from(new Set(partsRows.map((p) => p.job_id as string)))
  const jobsRows = await fetchAll<AnyRow>(
    () => supabase.from('jobs'),
    'id, job_no, customer, product',
    'id',
    jobIds,
  )

  const partById = new Map<string, AnyRow>()
  for (const p of partsRows) partById.set(p.id as string, p)
  const jobById = new Map<string, AnyRow>()
  for (const j of jobsRows) jobById.set(j.id as string, j)
  const blockPartsByBlock = new Map<string, AnyRow[]>()
  for (const bp of blockPartsRows) {
    const arr = blockPartsByBlock.get(bp.block_id as string) ?? []
    arr.push(bp)
    blockPartsByBlock.set(bp.block_id as string, arr)
  }

  const rows: import('./data').OpenBlockRow[] = []
  for (const b of blocksRows) {
    const members = (blockPartsByBlock.get(b.id as string) ?? [])
      .slice()
      .sort((a, c) => Number(a.position ?? 0) - Number(c.position ?? 0))
      .map((bp) => {
        const part = partById.get(bp.part_id as string)
        if (!part) {
          return {
            componentId: `__orphan__:${bp.part_id}`,
            name: `[已删除零件 ${bp.part_id}]`,
            qty: bp.qty != null ? Number(bp.qty) : 0,
            material: undefined,
            imageUrl: undefined,
            returnedQty: bp.returned_qty == null ? 0 : Number(bp.returned_qty),
            returnedAt: (bp.returned_at as string | null) ?? undefined,
            unitPriceCny:
              bp.unit_price_cny == null ? undefined : Number(bp.unit_price_cny),
          }
        }
        const pid = part.id as string
        const componentId = pid.split(':').slice(1).join(':') || pid
        return {
          componentId,
          name: (part.name as string) ?? '',
          qty: bp.qty != null ? Number(bp.qty) : Number(part.qty ?? 0),
          material: (part.material as string | null) ?? undefined,
          imageUrl: (part.image_url as string | null) ?? undefined,
          returnedQty: bp.returned_qty == null ? 0 : Number(bp.returned_qty),
          returnedAt: (bp.returned_at as string | null) ?? undefined,
          unitPriceCny:
            bp.unit_price_cny == null ? undefined : Number(bp.unit_price_cny),
        }
      })
    // Block needs ONE owning job for context — every member belongs to the
    // same job (createOutsourceBlockAt enforces it), so pull from the first
    // resolvable member.
    const firstPart = (blockPartsByBlock.get(b.id as string) ?? [])
      .map((bp) => partById.get(bp.part_id as string))
      .find((p) => p)
    if (!firstPart) continue
    const job = jobById.get(firstPart.job_id as string)
    if (!job) continue
    rows.push({
      jobId: job.id as string,
      jobNo: (job.job_no as string) ?? '',
      customer: (job.customer as string) ?? '',
      product: (job.product as string) ?? '',
      block: {
        id: b.id as string,
        vendorId: b.vendor_id as string,
        activity: (b.activity as string | null) ?? undefined,
        stages: (b.stages as Stage[]) ?? [],
        amountCny: b.amount_cny == null ? null : Number(b.amount_cny),
        sentDate: b.sent_date as string,
        expectedReturn: b.expected_return as string,
        notes: (b.notes as string | null) ?? undefined,
        docNo: (b.doc_no as string | null) ?? undefined,
        createdBy: (b.created_by as string | null) ?? undefined,
        recipientAddress: (b.recipient_address as string | null) ?? undefined,
        recipientContactName: (b.recipient_contact_name as string | null) ?? undefined,
        recipientContactPhone: (b.recipient_contact_phone as string | null) ?? undefined,
        isRush: Boolean(b.is_rush),
        vendorSeenAt: (b.vendor_seen_at as string | null) ?? undefined,
        vendorAckAt: (b.vendor_ack_at as string | null) ?? undefined,
        vendorPromisedDate: (b.vendor_promised_date as string | null) ?? undefined,
        vendorDelayReason: (b.vendor_delay_reason as string | null) ?? undefined,
        vendorShippedAt: (b.vendor_shipped_at as string | null) ?? undefined,
        wechatSentAt: (b.wechat_sent_at as string | null) ?? undefined,
        members,
      },
    })
  }
  return rows
}

// Lightweight per-job components (id, name, qty) for a set of jobs.
// Used by /returns to populate the inline 开退货 picker for candidate rows
// without forcing a full snapshot. Empty input → empty map.
export async function getJobsComponents(
  jobIds: string[],
): Promise<Map<string, Array<{ id: string; name: string; qty: number }>>> {
  const out = new Map<string, Array<{ id: string; name: string; qty: number }>>()
  if (jobIds.length === 0) return out
  // /returns passes EVERY shipped job (614+ today, growing). Two limits bit the
  // old single `.in('job_id', jobIds)`: the URL crossed undici's ~16KB header
  // cap (HeadersOverflowError → page down) AND, even short of that, an
  // un-ranged select silently truncates at PostgREST's 1000-row cap. selectAllIn
  // chunks the id-list (~4KB URLs) and paginates each chunk, fixing both. It
  // loses global ordering, so we sort each job's parts by position after
  // grouping (a part's rows all land in the one chunk holding its job_id).
  type PartPick = { id: string; name: string; qty: number; position: number }
  const grouped = new Map<string, PartPick[]>()
  for (const r of (await selectAllIn('parts', 'job_id', jobIds)) as AnyRow[]) {
    const jobId = r.job_id as string
    let arr = grouped.get(jobId)
    if (!arr) {
      arr = []
      grouped.set(jobId, arr)
    }
    arr.push({
      id: (r.id as string).split(':').slice(1).join(':') || (r.id as string),
      name: (r.name as string) ?? '',
      qty: Number(r.qty ?? 0),
      position: Number(r.position ?? 0),
    })
  }
  for (const [jobId, arr] of grouped) {
    arr.sort((a, b) => a.position - b.position)
    out.set(
      jobId,
      arr.map(({ id, name, qty }) => ({ id, name, qty })),
    )
  }
  return out
}

// Per-stage average flow minutes — the StationSummary "平均工段时长" tile.
// Fed by the stage_flow_minutes view; null per stage until the view has at
// least 3 fully-stamped samples for that stage.
export async function getStageFlowMinutes(): Promise<Map<Stage, number>> {
  const r = await supabase
    .from('stage_flow_minutes')
    .select('stage, avg_minutes')
  if (r.error) {
    // View may not exist yet on pre-0018 envs — let the page render with —.
    if (isMissingTableError(r.error)) return new Map()
    throw r.error
  }
  const out = new Map<Stage, number>()
  for (const row of (r.data ?? []) as AnyRow[]) {
    const minutes = Number(row.avg_minutes ?? NaN)
    if (Number.isFinite(minutes)) out.set(row.stage as Stage, minutes)
  }
  return out
}

// Master-grid read. Returns the precomputed shape MasterSheet renders
// directly — no full-snapshot scan, no component iteration on the server.
// Implemented against the SQL views from migration 0018; see lib/master.ts
// for the consumer-side type + helpers.
//
// Replaces the old `getJobs()` call in app/page.tsx for the
// commerce/工程/master-sheet path. StationWorkbench (per-station drill-down)
// still uses the full Job shape since it renders per-component rows.
type MasterRowsScope =
  | { kind: 'all' }
  | { kind: 'ids'; ids: string[] }
  | { kind: 'inbox' }
  // 'ship' splits the 'all' board scope by is_shipped so the board can paint
  // the ~200 active orders first and stream the ~1,200 shipped ones after —
  // 84% of the book is shipped history nobody looks at on landing.
  | { kind: 'ship'; shipped: boolean }

type MasterBoardTableRow = {
  job_id: string
  position: number | string | null
  job_no: string
  job_no_sort_key: string | null
  job_intake_date: string | null
  customer: string
  product: string
  engineer: string | null
  yuenong_business: string | null
  amount_cny: number | string | null
  due_date: string
  effective_due_date: string
  secondary_due_date: string | null
  notes: string | null
  status: JobStatus | null
  created_at: string | null
  pinned_at: string | null
  job_type: JobType | null
  is_product: boolean | null
  paused_at: string | null
  pause_reason: string | null
  needs_outsource: boolean | null
  outsource_note: string | null
  drawing_change_open: boolean | null
  drawing_change_note: string | null
  has_open_outsource: boolean | null
  has_open_inspection_verdict: boolean | null
  external_spend_cny: number | string | null
  margin_cny: number | string | null
  is_shipped: boolean | null
  component_count: number | null
  search_haystack: string | null
  active_return_id: string | null
  active_return_due_date: string | null
  active_return_reason: ReturnReason | null
  cells: unknown
  stage_plan: unknown
}

export type MasterRowsPageOptions = {
  limit: number
  cursor?: string
  q?: string
  jobNoOnlySearch?: boolean
  ship?: 'live' | 'paused' | 'shipped'
  sort?: 'due' | 'jobNo'
  dateStart?: string
  dateEnd?: string
}

export type MasterRowsPage = {
  rows: MasterRow[]
  nextCursor?: string
  total: number
}

export type MasterStatusFilter = 'pending' | 'partial' | 'done'

export type MasterFacetsOptions = {
  q?: string
  jobNoOnlySearch?: boolean
  ship?: 'live' | 'paused' | 'shipped'
  sort?: 'due' | 'jobNo'
  dateStart?: string
  dateEnd?: string
  statusByStage?: Partial<Record<Stage, MasterStatusFilter>>
}

export type MasterStageFacet = {
  pending: number
  partial: number
  done: number
  total: number
}

export type MasterFacets = {
  byStage: Record<Stage, MasterStageFacet>
}

type MasterRowsKeysetCursor =
  | { kind: 'due'; effectiveDueDate: string; id: string }
  | { kind: 'jobNo'; jobNoSortKey: string; id: string }

function encodeMasterRowsCursor(cursor: MasterRowsKeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeMasterRowsCursor(raw: string | undefined): MasterRowsKeysetCursor | null {
  if (!raw) return null
  // Compatibility with the first paged endpoint deploy, which used numeric
  // offsets. Numeric cursors stay on the fallback path below.
  if (/^\d+$/.test(raw)) return null
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as Partial<MasterRowsKeysetCursor>
    if (
      parsed.kind === 'due' &&
      typeof parsed.effectiveDueDate === 'string' &&
      typeof parsed.id === 'string'
    ) {
      return {
        kind: 'due',
        effectiveDueDate: parsed.effectiveDueDate,
        id: parsed.id,
      }
    }
    if (
      parsed.kind === 'jobNo' &&
      typeof parsed.jobNoSortKey === 'string' &&
      typeof parsed.id === 'string'
    ) {
      return { kind: 'jobNo', jobNoSortKey: parsed.jobNoSortKey, id: parsed.id }
    }
  } catch {
    return null
  }
  return null
}

function keysetCursorForRow(
  row: MasterRow,
  sort: 'due' | 'jobNo',
): MasterRowsKeysetCursor {
  return sort === 'jobNo'
    ? { kind: 'jobNo', jobNoSortKey: jobNoSortKey(row), id: row.id }
    : { kind: 'due', effectiveDueDate: row.effectiveDueDate, id: row.id }
}

const EMPTY_MASTER_AGGREGATES: MasterAggregates = {
  totalJobs: 0,
  inProgress: 0,
  paused: 0,
  overdue: 0,
  dueToday: 0,
  totalAmountCny: 0,
  totalExternalSpendCny: 0,
  totalMarginCny: 0,
  byStage: {},
}

export async function getMasterAggregates(): Promise<MasterAggregates> {
  await ensureSeeded()
  const r = await supabase
    .from('master_board_summary')
    .select(
      'total_jobs, in_progress_jobs, paused_jobs, overdue_jobs, due_today_jobs, total_amount_cny, total_external_spend_cny, total_margin_cny, by_stage',
    )
    .limit(1)
    .maybeSingle()
  if (r.error) {
    if (isMissingTableError(r.error) || isMissingColumnError(r.error)) {
      return EMPTY_MASTER_AGGREGATES
    }
    throw r.error
  }
  const row = (r.data ?? {}) as AnyRow
  const byStageRaw = row.by_stage && typeof row.by_stage === 'object'
    ? (row.by_stage as Record<
        string,
        { here?: unknown; dueToday?: unknown; overdue?: unknown; parts?: unknown }
      >)
    : {}
  const byStage: MasterAggregates['byStage'] = {}
  for (const stage of STAGES) {
    const s = byStageRaw[stage]
    if (!s) continue
    byStage[stage] = {
      here: Number(s.here ?? 0),
      dueToday: Number(s.dueToday ?? 0),
      overdue: Number(s.overdue ?? 0),
      parts: Number(s.parts ?? 0),
    }
  }
  return {
    totalJobs: Number(row.total_jobs ?? 0),
    inProgress: Number(row.in_progress_jobs ?? 0),
    paused: Number(row.paused_jobs ?? 0),
    overdue: Number(row.overdue_jobs ?? 0),
    dueToday: Number(row.due_today_jobs ?? 0),
    totalAmountCny: Number(row.total_amount_cny ?? 0),
    totalExternalSpendCny: Number(row.total_external_spend_cny ?? 0),
    totalMarginCny: Number(row.total_margin_cny ?? 0),
    byStage,
  }
}

export async function getMasterRowsByIds(ids: string[]): Promise<MasterRow[]> {
  const uniq = Array.from(new Set(ids.filter(Boolean)))
  if (uniq.length === 0) return []
  // The 'ids' scope filters with `.in('job_id', ids)` in both the fast and
  // fallback paths; chunk so a caller passing a large id-list can't overflow the
  // ~16KB URL header cap. Only the small daily-focus set comes through today, so
  // the common case is a single call.
  const CHUNK = 100
  if (uniq.length <= CHUNK) return getMasterRowsScoped({ kind: 'ids', ids: uniq })
  const out: MasterRow[] = []
  for (let i = 0; i < uniq.length; i += CHUNK) {
    out.push(
      ...(await getMasterRowsScoped({ kind: 'ids', ids: uniq.slice(i, i + CHUNK) })),
    )
  }
  return out
}

export async function getInboxRows(): Promise<MasterRow[]> {
  return getMasterRowsScoped({ kind: 'inbox' })
}

export async function getMasterRows(): Promise<MasterRow[]> {
  return getMasterRowsScoped({ kind: 'all' })
}

export async function getMasterRowsByShipped(
  shipped: boolean,
): Promise<MasterRow[]> {
  return getMasterRowsScoped({ kind: 'ship', shipped })
}

export async function getMasterRowsPage(
  opts: MasterRowsPageOptions,
): Promise<MasterRowsPage> {
  const page = await getMasterRowsPageFromBoardTable(opts)
  if (page) return page

  // Pre-0060 fallback: preserve behavior by filtering in memory. This is not
  // the scalable path, but it keeps deploy-before-migration safe.
  let rows = await getMasterRows()
  const q = opts.q?.trim().toLowerCase()
  if (q) {
    rows = opts.jobNoOnlySearch
      ? rows.filter((r) => r.jobNo.toLowerCase().includes(q))
      : rows.filter((r) => r.searchHaystack.includes(q))
  }
  if (opts.ship === 'shipped') rows = rows.filter((r) => r.isShipped)
  else if (opts.ship === 'paused') {
    rows = rows.filter((r) => !r.isShipped && r.pausedAt)
  } else if (opts.ship === 'live') {
    rows = rows.filter((r) => !r.isShipped && !r.pausedAt)
  }
  if (opts.dateStart) {
    rows = rows.filter((r) => {
      const d = opts.sort === 'jobNo' ? jobIntakeDate(r) : r.effectiveDueDate
      return Boolean(d && d >= opts.dateStart!)
    })
  }
  if (opts.dateEnd) {
    rows = rows.filter((r) => {
      const d = opts.sort === 'jobNo' ? jobIntakeDate(r) : r.effectiveDueDate
      return Boolean(d && d <= opts.dateEnd!)
    })
  }
  rows = sortRowsForPage(rows, opts.sort ?? 'due')
  const limit = Math.max(1, opts.limit)
  const keyset = decodeMasterRowsCursor(opts.cursor)
  let start = 0
  if (keyset) {
    const idx = rows.findIndex((r) => {
      if (keyset.kind === 'jobNo') {
        const byJob = jobNoSortKey(r).localeCompare(keyset.jobNoSortKey)
        return byJob > 0 || (byJob === 0 && r.id > keyset.id)
      }
      const byDue = r.effectiveDueDate.localeCompare(keyset.effectiveDueDate)
      return byDue > 0 || (byDue === 0 && r.id > keyset.id)
    })
    start = idx < 0 ? rows.length : idx
  } else {
    start = Math.max(0, Number(opts.cursor ?? 0) || 0)
  }
  const slice = rows.slice(start, start + limit)
  const next =
    start + limit < rows.length && slice.length > 0
      ? encodeMasterRowsCursor(keysetCursorForRow(slice[slice.length - 1], opts.sort ?? 'due'))
      : undefined
  return { rows: slice, nextCursor: next, total: rows.length }
}

export async function getMasterFacets(
  opts: MasterFacetsOptions,
): Promise<MasterFacets> {
  const fast = await getMasterFacetsFromBoardTable(opts)
  if (fast) return fast

  let rows = await getMasterRows()
  rows = filterRowsForMasterFacets(rows, opts)
  return countMasterFacets(rows, opts.statusByStage ?? {})
}

function filterRowsForMasterFacets(
  input: MasterRow[],
  opts: MasterFacetsOptions,
): MasterRow[] {
  let rows = input
  const q = opts.q?.trim().toLowerCase()
  if (q) {
    rows = opts.jobNoOnlySearch
      ? rows.filter((r) => r.jobNo.toLowerCase().includes(q))
      : rows.filter((r) => r.searchHaystack.includes(q))
  }
  if (opts.ship === 'shipped') rows = rows.filter((r) => r.isShipped)
  else if (opts.ship === 'paused') {
    rows = rows.filter((r) => !r.isShipped && r.pausedAt)
  } else if (opts.ship === 'live') {
    rows = rows.filter((r) => !r.isShipped && !r.pausedAt)
  }
  if (opts.dateStart) {
    rows = rows.filter((r) => {
      const d = opts.sort === 'jobNo' ? jobIntakeDate(r) : r.effectiveDueDate
      return Boolean(d && d >= opts.dateStart!)
    })
  }
  if (opts.dateEnd) {
    rows = rows.filter((r) => {
      const d = opts.sort === 'jobNo' ? jobIntakeDate(r) : r.effectiveDueDate
      return Boolean(d && d <= opts.dateEnd!)
    })
  }
  return rows
}

function countMasterFacets(
  rows: MasterRow[],
  statusByStage: Partial<Record<Stage, MasterStatusFilter>>,
): MasterFacets {
  const activeStages = STAGES.filter((s) => statusByStage[s])
  const byStage = {} as Record<Stage, MasterStageFacet>
  for (const stage of STAGES) {
    const others = activeStages.filter((s) => s !== stage)
    let pending = 0
    let partial = 0
    let done = 0
    for (const row of rows) {
      if (!others.every((s) => rowRollupStage(row, s).kind === statusByStage[s]))
        continue
      const kind = rowRollupStage(row, stage).kind
      if (kind === 'pending') pending++
      else if (kind === 'partial') partial++
      else if (kind === 'done') done++
    }
    byStage[stage] = { pending, partial, done, total: pending + partial + done }
  }
  return { byStage }
}

async function getMasterFacetsFromBoardTable(
  opts: MasterFacetsOptions,
): Promise<MasterFacets | null> {
  await ensureSeeded()
  const ready = await masterBoardRowsReady()
  if (!ready) return null
  const r = await supabase.rpc('master_board_facets', {
    p_q: opts.q?.trim() || null,
    p_job_no_only: Boolean(opts.jobNoOnlySearch),
    p_ship: opts.ship ?? null,
    p_sort: opts.sort ?? 'due',
    p_date_start: opts.dateStart ?? null,
    p_date_end: opts.dateEnd ?? null,
    p_status_filters: opts.statusByStage ?? {},
  })
  if (r.error) {
    if (
      isMissingFunctionError(r.error) ||
      isMissingTableError(r.error) ||
      isMissingColumnError(r.error)
    ) {
      return null
    }
    throw r.error
  }
  const byStage = {} as Record<Stage, MasterStageFacet>
  for (const stage of STAGES) {
    byStage[stage] = { pending: 0, partial: 0, done: 0, total: 0 }
  }
  for (const row of (r.data ?? []) as Array<{
    stage: string
    pending: number | string | null
    partial: number | string | null
    done: number | string | null
    total: number | string | null
  }>) {
    if (!(STAGES as readonly string[]).includes(row.stage)) continue
    byStage[row.stage as Stage] = {
      pending: Number(row.pending ?? 0),
      partial: Number(row.partial ?? 0),
      done: Number(row.done ?? 0),
      total: Number(row.total ?? 0),
    }
  }
  return { byStage }
}

async function masterBoardRowsReady(): Promise<boolean> {
  await ensureSeeded()
  const [jobs, board] = await Promise.all([
    supabase.from('jobs').select('id', { count: 'exact', head: true }),
    supabase
      .from('master_board_rows')
      .select('job_id', { count: 'exact', head: true }),
  ])
  if (jobs.error) throw jobs.error
  if (board.error) {
    if (isMissingTableError(board.error) || isMissingColumnError(board.error)) {
      return false
    }
    throw board.error
  }
  return (board.count ?? 0) >= (jobs.count ?? 0)
}

function sortRowsForPage(rows: MasterRow[], sort: 'due' | 'jobNo'): MasterRow[] {
  const out = [...rows]
  if (sort === 'jobNo') {
    out.sort((a, b) => {
      const byJob = jobNoSortKey(a).localeCompare(jobNoSortKey(b))
      return byJob || a.id.localeCompare(b.id)
    })
  } else {
    out.sort((a, b) => {
      const byDue = a.effectiveDueDate.localeCompare(b.effectiveDueDate)
      return byDue || a.id.localeCompare(b.id)
    })
  }
  return out
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function numberOrUndefined(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function numberOrZero(v: unknown): number {
  return numberOrUndefined(v) ?? 0
}

function masterCellFromBoardJson(v: unknown): MasterCell | undefined {
  const c = asRecord(v)
  const total = numberOrZero(c.total)
  const hasPayload = Object.keys(c).length > 0
  if (!hasPayload) return undefined
  return {
    total,
    inHouseDone: numberOrZero(c.inHouseDone),
    outsourcedClosed: numberOrZero(c.outsourcedClosed),
    outsourcedOpen: numberOrZero(c.outsourcedOpen),
    inProgress: numberOrZero(c.inProgress),
    pending: numberOrZero(c.pending),
    inProgressDoneQtySum: numberOrZero(c.inProgressDoneQtySum),
    earliestInProgressAt: optionalString(c.earliestInProgressAt),
    latestFinishedAt: optionalString(c.latestFinishedAt),
    latestCompletedAt: optionalString(c.latestCompletedAt),
    latestBy: optionalString(c.latestBy),
    hasMinePending: Boolean(c.hasMinePending),
    hasUpstreamActive: Boolean(c.hasUpstreamActive),
    pinnedAt: optionalString(c.pinnedAt),
  }
}

// 计划交期 (排产) jsonb → typed map. Keeps only real Stage keys with a
// non-empty string value; anything else (legacy junk, '{}') → {}.
function stagePlanFromJson(v: unknown): Partial<Record<PlanKey, string>> {
  const raw = asRecord(v)
  const out: Partial<Record<PlanKey, string>> = {}
  // 外协 rides in the same jsonb map as the 工段 keys — see PlanKey.
  const keys: readonly PlanKey[] = [...STAGES, '外协']
  for (const stage of keys) {
    const val = raw[stage]
    if (typeof val === 'string' && val) out[stage] = val
  }
  return out
}

function masterRowFromBoardTable(row: MasterBoardTableRow): MasterRow {
  const cells: Partial<Record<Stage, MasterCell>> = {}
  const rawCells = asRecord(row.cells)
  for (const stage of STAGES) {
    const cell = masterCellFromBoardJson(rawCells[stage])
    if (cell) cells[stage] = cell
  }
  const stagePlan = stagePlanFromJson(row.stage_plan)
  const amountCny = numberOrUndefined(row.amount_cny)
  const externalSpendCny = numberOrZero(row.external_spend_cny)
  return {
    id: row.job_id,
    jobNo: row.job_no,
    customer: row.customer,
    product: row.product,
    engineer: row.engineer ?? undefined,
    yuenongBusiness: row.yuenong_business ?? undefined,
    amountCny,
    dueDate: row.due_date,
    effectiveDueDate: row.effective_due_date,
    secondaryDueDate: row.secondary_due_date ?? undefined,
    stagePlan,
    notes: row.notes ?? undefined,
    status: row.status ?? 'ready',
    createdAt: row.created_at ?? undefined,
    pinnedAt: row.pinned_at ?? undefined,
    jobType: row.job_type ?? undefined,
    isProduct: row.is_product ?? undefined,
    pausedAt: row.paused_at ?? undefined,
    pauseReason: row.pause_reason ?? undefined,
    needsOutsource: row.needs_outsource ?? undefined,
    outsourceNote: row.outsource_note ?? undefined,
    drawingChangeOpen: row.drawing_change_open ?? undefined,
    drawingChangeNote: row.drawing_change_note ?? undefined,
    hasOpenOutsource: Boolean(row.has_open_outsource),
    hasOpenInspectionVerdict: row.has_open_inspection_verdict ?? undefined,
    externalSpendCny,
    marginCny:
      row.margin_cny == null
        ? amountCny == null
          ? undefined
          : amountCny - externalSpendCny
        : numberOrUndefined(row.margin_cny),
    isShipped: Boolean(row.is_shipped),
    componentCount: Number(row.component_count ?? 0),
    searchHaystack: row.search_haystack ?? '',
    activeReturn:
      row.active_return_id && row.active_return_due_date && row.active_return_reason
        ? {
            id: row.active_return_id,
            dueDate: row.active_return_due_date,
            reason: row.active_return_reason,
          }
        : undefined,
    cells,
  }
}

async function getMasterRowsFromBoardTable(
  scope: MasterRowsScope,
): Promise<MasterRow[] | null> {
  await ensureSeeded()
  const ready = await masterBoardRowsReady()
  if (!ready) return null
  const PAGE = 1000
  const COLS =
    'job_id, position, job_no, job_no_sort_key, job_intake_date, customer, product, engineer, yuenong_business, amount_cny, due_date, effective_due_date, secondary_due_date, notes, status, created_at, pinned_at, job_type, is_product, paused_at, pause_reason, needs_outsource, outsource_note, drawing_change_open, drawing_change_note, has_open_outsource, has_open_inspection_verdict, external_spend_cny, margin_cny, is_shipped, component_count, search_haystack, active_return_id, active_return_due_date, active_return_reason, cells, stage_plan'

  const build = (countMode: 'exact' | undefined) => {
    let q = supabase
      .from('master_board_rows')
      .select(COLS, countMode ? { count: countMode } : undefined)
    if (scope.kind === 'ids') q = q.in('job_id', scope.ids)
    else if (scope.kind === 'inbox')
      q = q.in('status', ['parsing', 'draft', 'failed'])
    // The 'all' board scope is confirmed orders only. parsing/draft/failed jobs
    // belong to 收件箱 (getInboxRows) exclusively — letting them through here
    // double-counts them as 在产 and renders empty "解析中…" rows on the floor.
    // Mirrors master_board_summary's `status not in (...)` guard.
    else {
      q = q.not('status', 'in', '(parsing,draft,failed)')
      if (scope.kind === 'ship') q = q.eq('is_shipped', scope.shipped)
    }
    return q.order('position', { ascending: true })
  }

  const first = await build('exact').range(0, PAGE - 1)
  if (first.error) {
    if (isMissingTableError(first.error) || isMissingColumnError(first.error)) {
      return null
    }
    throw first.error
  }
  const rows = ((first.data ?? []) as unknown as MasterBoardTableRow[]).slice()
  const total = first.count ?? rows.length
  if (total > PAGE) {
    const ranges: Array<[number, number]> = []
    for (let from = PAGE; from < total; from += PAGE) {
      ranges.push([from, Math.min(from + PAGE - 1, total - 1)])
    }
    const tails = await Promise.all(
      ranges.map(([lo, hi]) => build(undefined).range(lo, hi)),
    )
    for (const t of tails) {
      if (t.error) throw t.error
      rows.push(...((t.data ?? []) as unknown as MasterBoardTableRow[]))
    }
  }
  return rows.map(masterRowFromBoardTable)
}

async function getMasterRowsPageFromBoardTable(
  opts: MasterRowsPageOptions,
): Promise<MasterRowsPage | null> {
  await ensureSeeded()
  const ready = await masterBoardRowsReady()
  if (!ready) return null
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit || 100)))
  const keyset = decodeMasterRowsCursor(opts.cursor)
  const offsetCursor = keyset ? 0 : Math.max(0, Number(opts.cursor ?? 0) || 0)
  const COLS =
    'job_id, position, job_no, job_no_sort_key, job_intake_date, customer, product, engineer, yuenong_business, amount_cny, due_date, effective_due_date, secondary_due_date, notes, status, created_at, pinned_at, job_type, is_product, paused_at, pause_reason, needs_outsource, outsource_note, drawing_change_open, drawing_change_note, has_open_outsource, has_open_inspection_verdict, external_spend_cny, margin_cny, is_shipped, component_count, search_haystack, active_return_id, active_return_due_date, active_return_reason, cells, stage_plan'

  let q = supabase
    .from('master_board_rows')
    .select(COLS, { count: 'exact' })
    // Board paging is confirmed orders only; 收件箱 jobs (parsing/draft/failed)
    // never page through here. Without this the 'live' tab counts them as 在产.
    .not('status', 'in', '(parsing,draft,failed)')

  const query = opts.q?.trim().toLowerCase()
  if (query) {
    const escaped = query.replace(/[%_]/g, (m) => `\\${m}`)
    q = opts.jobNoOnlySearch
      ? q.ilike('job_no', `%${escaped}%`)
      : q.ilike('search_haystack', `%${escaped}%`)
  }
  if (opts.ship === 'shipped') {
    q = q.eq('is_shipped', true)
  } else if (opts.ship === 'paused') {
    q = q.eq('is_shipped', false).not('paused_at', 'is', null)
  } else if (opts.ship === 'live') {
    q = q.eq('is_shipped', false).is('paused_at', null)
  }
  const dateColumn = opts.sort === 'jobNo' ? 'job_intake_date' : 'effective_due_date'
  if (opts.dateStart) q = q.gte(dateColumn, opts.dateStart)
  if (opts.dateEnd) q = q.lte(dateColumn, opts.dateEnd)

  if (opts.sort === 'jobNo') {
    if (keyset?.kind === 'jobNo') {
      q = q.or(
        `job_no_sort_key.gt.${keyset.jobNoSortKey},and(job_no_sort_key.eq.${keyset.jobNoSortKey},job_id.gt.${keyset.id})`,
      )
    }
    q = q
      .order('job_no_sort_key', { ascending: true })
      .order('job_id', { ascending: true })
  } else {
    if (keyset?.kind === 'due') {
      q = q.or(
        `effective_due_date.gt.${keyset.effectiveDueDate},and(effective_due_date.eq.${keyset.effectiveDueDate},job_id.gt.${keyset.id})`,
      )
    }
    q = q
      .order('effective_due_date', { ascending: true })
      .order('job_id', { ascending: true })
  }

  const rangeStart = keyset ? 0 : offsetCursor
  const r = await q.range(rangeStart, rangeStart + limit - 1)
  if (r.error) {
    if (isMissingTableError(r.error) || isMissingColumnError(r.error)) return null
    throw r.error
  }
  const rows = ((r.data ?? []) as unknown as MasterBoardTableRow[]).map(
    masterRowFromBoardTable,
  )
  const total = r.count ?? rows.length
  const nextCursor =
    rangeStart + limit < total && rows.length > 0
      ? encodeMasterRowsCursor(keysetCursorForRow(rows[rows.length - 1], opts.sort ?? 'due'))
      : undefined
  return { rows, nextCursor, total }
}

async function getMasterRowsScoped(scope: MasterRowsScope): Promise<MasterRow[]> {
  const fastRows = await getMasterRowsFromBoardTable(scope)
  if (fastRows) return fastRows
  await ensureSeeded()
  type RollupRow = {
    job_id: string
    stage: Stage
    total: number
    outsourced_closed: number
    outsourced_open: number
    in_progress: number
    pending: number
    in_progress_done_qty_sum: number
    earliest_in_progress_at: string | null
    latest_finished_at: string | null
    latest_completed_at: string | null
    has_mine_pending: boolean
    has_upstream_active: boolean
    latest_by_actor: string | null
  }
  type SummaryRow = {
    job_id: string
    external_spend_cny: number | string | null
    has_open_outsource: boolean
    active_return_id: string | null
    active_return_due_date: string | null
    active_return_reason: ReturnReason | null
    component_count: number
    search_haystack: string
  }
  // PostgREST caps single .select() responses at 1000 rows by default. At
  // 500 jobs × 9 stages = ~4,500 rollup rows this needs multiple pages, and
  // sequential pagination at 5 round-trips × 150ms RTT = ~750ms — visible
  // slowness on the commerce master view, which renders the whole grid.
  //
  // Strategy: do an initial count=exact request for page 0, then issue any
  // remaining page requests in PARALLEL. Total wall time = 2 round-trips
  // regardless of row count, vs N+1 sequential before.
  const PAGE = 1000
  type SupabaseQuery = {
    select: (columns: string, options?: { count?: 'exact' }) => SupabaseQuery
    order: (column: string, options?: { ascending: boolean }) => SupabaseQuery
    in: (column: string, values: readonly string[]) => SupabaseQuery
    not: (column: string, operator: string, value: string) => SupabaseQuery
    range: (from: number, to: number) => Promise<{
      data: unknown[] | null
      error: unknown
      count?: number | null
    }>
  }
  const fetchAll = async <T>(
    qb: () => SupabaseQuery,
    sel: string,
    order?: { column: string; ascending: boolean },
    filter?: (q: SupabaseQuery) => SupabaseQuery,
  ): Promise<{ data: T[]; error: unknown }> => {
    const buildQuery = (countMode: 'exact' | undefined) => {
      let q = qb().select(sel, countMode ? { count: countMode } : undefined)
      if (filter) q = filter(q)
      if (order) q = q.order(order.column, { ascending: order.ascending })
      return q
    }
    // First page also asks for the exact total so we know how many more
    // pages to fire in parallel — count=exact adds one COUNT(*) on the
    // server but saves us all the sequential RTTs.
    const first = await buildQuery('exact').range(0, PAGE - 1)
    if (first.error) return { data: [] as T[], error: first.error }
    const head = (first.data ?? []) as T[]
    const total = first.count ?? head.length
    if (total <= PAGE) return { data: head, error: null }

    const tailRanges: Array<[number, number]> = []
    for (let from = PAGE; from < total; from += PAGE) {
      tailRanges.push([from, Math.min(from + PAGE - 1, total - 1)])
    }
    const tailResults = await Promise.all(
      tailRanges.map(([lo, hi]) => buildQuery(undefined).range(lo, hi)),
    )
    const out: T[] = head.slice()
    for (const r of tailResults) {
      if (r.error) return { data: out, error: r.error }
      out.push(...((r.data ?? []) as T[]))
    }
    return { data: out, error: null }
  }

  // latest_by_actor is appended by migration 0028. Keep a by-less column list
  // so we can fall back when the running code is ahead of the DB (the master
  // grid renders without the 经手 hover instead of 500'ing).
  const ROLLUP_COLS_BASE =
    'job_id, stage, total, outsourced_closed, outsourced_open, in_progress, pending, in_progress_done_qty_sum, earliest_in_progress_at, latest_finished_at, latest_completed_at, has_mine_pending, has_upstream_active'
  const ROLLUP_COLS = `${ROLLUP_COLS_BASE}, latest_by_actor`

  // needs_outsource / outsource_note land in migration 0041. Same running-code-
  // ahead-of-DB guard as ROLLUP_COLS: keep a base list so a pre-0041 DB renders
  // the board (sans 待外协 badge) instead of 500'ing the entire master grid.
  const JOBS_COLS_BASE =
    'id, job_no, customer, product, engineer, amount_cny, due_date, notes, status, created_at, position, pinned_at, job_type, is_product'
  // secondary_due_date lands in migration 0044; needs_outsource / outsource_note
  // in 0041; drawing_change_open / drawing_change_note in 0049; paused_at /
  // pause_reason in 0050. All ride the extended list so a DB behind the running
  // code falls back to JOBS_COLS_BASE (rendering without the 二次交期 / 待外协 /
  // 图纸变更 / 暂停 extras) rather than 500'ing the whole master grid.
  const JOBS_COLS = `${JOBS_COLS_BASE}, needs_outsource, outsource_note, secondary_due_date, stage_plan, drawing_change_open, drawing_change_note, paused_at, pause_reason, yuenong_business`

  const buildJobsQuery = () => supabase.from('jobs') as unknown as SupabaseQuery
  const filterJobs = (q: SupabaseQuery): SupabaseQuery => {
    if (scope.kind === 'ids') return q.in('id', scope.ids)
    if (scope.kind === 'inbox') return q.in('status', ['parsing', 'draft', 'failed'])
    // 'all' board scope: confirmed orders only (parsing/draft/failed live in 收件箱).
    return q.not('status', 'in', '(parsing,draft,failed)') as SupabaseQuery
  }

  const jobsR = await fetchAll<AnyRow>(
    buildJobsQuery,
    JOBS_COLS,
    { column: 'position', ascending: true },
    filterJobs,
  )
  let jobsRows = (jobsR.data ?? []) as AnyRow[]
  if (jobsR.error) {
    if (isMissingColumnError(jobsR.error)) {
      const retry = await fetchAll<AnyRow>(
        buildJobsQuery,
        JOBS_COLS_BASE,
        { column: 'position', ascending: true },
        filterJobs,
      )
      if (retry.error) throw retry.error
      jobsRows = (retry.data ?? []) as AnyRow[]
    } else {
      throw jobsR.error
    }
  }
  const jobIds = jobsRows.map((r) => r.id as string).filter(Boolean)
  if (jobIds.length === 0) return []

  const scopeByJobIds = (table: string) =>
    supabase.from(table) as unknown as SupabaseQuery

  // CRITICAL: this fallback runs whenever master_board_rows isn't ready (table
  // missing/behind a migration, or a column the fast path needs is absent). At
  // production scale (hundreds of jobs) a single `.in('job_id', jobIds)` here
  // would put every board job-id in one URL and overflow undici's ~16KB header
  // cap (HeadersOverflowError) — turning "degrade to the slow path" into a TOTAL
  // board outage. Chunk the id-list so the safety net actually degrades
  // gracefully (slower) instead of cliff-failing. Each table is fetched per
  // id-chunk in parallel and merged.
  const JOB_ID_CHUNK = 100
  const jobIdChunks: string[][] = []
  for (let i = 0; i < jobIds.length; i += JOB_ID_CHUNK) {
    jobIdChunks.push(jobIds.slice(i, i + JOB_ID_CHUNK))
  }
  const fetchByJobIds = async (
    table: string,
    cols: string,
  ): Promise<{ data: AnyRow[]; error: unknown }> => {
    const parts = await Promise.all(
      jobIdChunks.map((chunk) =>
        fetchAll<AnyRow>(() => scopeByJobIds(table), cols, undefined, (q) =>
          q.in('job_id', chunk),
        ),
      ),
    )
    const data: AnyRow[] = []
    for (const p of parts) {
      if (p.error) return { data, error: p.error }
      data.push(...(p.data ?? []))
    }
    return { data, error: null }
  }

  const [rollupR, summaryR, pinsR, verdictR] = await Promise.all([
    fetchByJobIds('job_stage_rollup', ROLLUP_COLS),
    fetchByJobIds(
      'job_summary',
      'job_id, external_spend_cny, has_open_outsource, active_return_id, active_return_due_date, active_return_reason, component_count, search_haystack',
    ),
    fetchByJobIds('job_stage_pins', 'job_id, stage, pinned_at'),
    // Open blocking verdicts at 检验 — drives the red 检验异常 row badge.
    // parts!inner embeds job_id. Chunk the parts.job_id IN list the same way so
    // it can't overflow either, even though the open-defect set is small.
    (async (): Promise<{ data: AnyRow[]; error: unknown }> => {
      const parts = await Promise.all(
        jobIdChunks.map((chunk) =>
          supabase
            .from('part_stages')
            .select('parts!inner(job_id)')
            .eq('stage', '检验')
            .neq('status', 'done')
            .in('parts.job_id', chunk)
            .in('verdict', BLOCKING_VERDICTS),
        ),
      )
      const data: AnyRow[] = []
      for (const p of parts) {
        if (p.error) return { data, error: p.error }
        data.push(...((p.data ?? []) as AnyRow[]))
      }
      return { data, error: null }
    })(),
  ])
  let rollupRows = (rollupR.data ?? []) as unknown as RollupRow[]
  if (rollupR.error) {
    if (isMissingColumnError(rollupR.error)) {
      const retry = await fetchByJobIds('job_stage_rollup', ROLLUP_COLS_BASE)
      if (retry.error) throw retry.error
      rollupRows = (retry.data ?? []) as unknown as RollupRow[]
    } else {
      throw rollupR.error
    }
  }
  if (summaryR.error) throw summaryR.error
  // Pins table is optional pre-migration-0016 — tolerate its absence so a
  // fresh install without the pins migration still renders the grid.
  if (pinsR.error && !isMissingTableError(pinsR.error)) throw pinsR.error
  if (pinsR.error) warnMissingPinsTableOnce()

  // Preserve jobs.position order from the SQL order-by above; rowsByIdInOrder
  // tracks insertion order so we can return in that order without an explicit
  // sort. (Map preserves insertion order.)
  const rowsById = new Map<string, MasterRow>()
  for (const r of jobsRows) {
    const id = r.id as string
    rowsById.set(id, {
      id,
      jobNo: r.job_no as string,
      customer: r.customer as string,
      product: r.product as string,
      engineer: (r.engineer as string | null) ?? undefined,
      yuenongBusiness: (r.yuenong_business as string | null) ?? undefined,
      amountCny: r.amount_cny == null ? undefined : Number(r.amount_cny),
      dueDate: r.due_date as string,
      effectiveDueDate: r.due_date as string, // overridden below if open return
      secondaryDueDate: (r.secondary_due_date as string | null) ?? undefined,
      stagePlan: stagePlanFromJson(r.stage_plan),
      notes: (r.notes as string | null) ?? undefined,
      status: ((r.status as JobStatus | null) ?? 'ready') as JobStatus,
      createdAt: (r.created_at as string | null) ?? undefined,
      pinnedAt: (r.pinned_at as string | null) ?? undefined,
      jobType: ((r.job_type as string | null) ?? undefined) as JobType | undefined,
      isProduct: (r.is_product as boolean | null) ?? undefined,
      pausedAt: (r.paused_at as string | null) ?? undefined,
      pauseReason: (r.pause_reason as string | null) ?? undefined,
      needsOutsource: (r.needs_outsource as boolean | null) ?? undefined,
      outsourceNote: (r.outsource_note as string | null) ?? undefined,
      drawingChangeOpen: (r.drawing_change_open as boolean | null) ?? undefined,
      drawingChangeNote: (r.drawing_change_note as string | null) ?? undefined,
      hasOpenOutsource: false,
      externalSpendCny: 0,
      marginCny: undefined,
      isShipped: false,
      componentCount: 0,
      searchHaystack: '',
      activeReturn: undefined,
      cells: {},
    })
  }

  // Per-job derived bits.
  for (const s of (summaryR.data ?? []) as unknown as SummaryRow[]) {
    const row = rowsById.get(s.job_id)
    if (!row) continue
    const ext = s.external_spend_cny == null ? 0 : Number(s.external_spend_cny)
    row.externalSpendCny = Number.isFinite(ext) ? ext : 0
    row.hasOpenOutsource = Boolean(s.has_open_outsource)
    row.componentCount = Number(s.component_count ?? 0)
    row.searchHaystack = s.search_haystack ?? ''
    if (s.active_return_id && s.active_return_due_date && s.active_return_reason) {
      row.activeReturn = {
        id: s.active_return_id,
        dueDate: s.active_return_due_date,
        reason: s.active_return_reason,
      }
      // Open return overrides effective due date — see jobEffectiveDueDate.
      row.effectiveDueDate = s.active_return_due_date
    }
    row.marginCny =
      typeof row.amountCny === 'number' ? row.amountCny - row.externalSpendCny : undefined
  }

  // Per-stage cells.
  for (const r of rollupRows) {
    const row = rowsById.get(r.job_id)
    if (!row) continue
    const inHouseDone =
      Number(r.total ?? 0) -
      Number(r.outsourced_closed ?? 0) -
      Number(r.outsourced_open ?? 0) -
      Number(r.in_progress ?? 0) -
      Number(r.pending ?? 0)
    row.cells[r.stage] = {
      total: Number(r.total ?? 0),
      inHouseDone: Math.max(0, inHouseDone),
      outsourcedClosed: Number(r.outsourced_closed ?? 0),
      outsourcedOpen: Number(r.outsourced_open ?? 0),
      inProgress: Number(r.in_progress ?? 0),
      pending: Number(r.pending ?? 0),
      inProgressDoneQtySum: Number(r.in_progress_done_qty_sum ?? 0),
      earliestInProgressAt: r.earliest_in_progress_at ?? undefined,
      latestFinishedAt: r.latest_finished_at ?? undefined,
      latestCompletedAt: r.latest_completed_at ?? undefined,
      latestBy: (r.latest_by_actor as string | null) ?? undefined,
      hasMinePending: Boolean(r.has_mine_pending),
      hasUpstreamActive: Boolean(r.has_upstream_active),
      pinnedAt: undefined,
    }
  }

  // Stage-level pins.
  for (const p of (pinsR.data ?? []) as AnyRow[]) {
    const row = rowsById.get(p.job_id as string)
    if (!row) continue
    const cell = row.cells[p.stage as Stage]
    if (cell) cell.pinnedAt = (p.pinned_at as string | null) ?? undefined
    else {
      // Pin exists for a stage the rollup considers na (no parts in route).
      // Surface it anyway with a zero-total cell so jobIsPinnedAtStage still
      // returns true — matches the prior behavior of jobIsPinnedAtStage
      // running off the unconditional pinnedStages array.
      row.cells[p.stage as Stage] = {
        total: 0,
        inHouseDone: 0,
        outsourcedClosed: 0,
        outsourcedOpen: 0,
        inProgress: 0,
        pending: 0,
        inProgressDoneQtySum: 0,
        hasMinePending: false,
        hasUpstreamActive: false,
        pinnedAt: (p.pinned_at as string | null) ?? undefined,
      }
    }
  }

  // 检验异常 — blocking verdicts. Tolerate a pre-0048 DB (missing column /
  // stage) the same way as the other running-code-ahead-of-DB guards: render
  // the grid without the badge instead of 500'ing.
  if (verdictR.error) {
    if (!isMissingColumnError(verdictR.error) && !isMissingTableError(verdictR.error)) {
      throw verdictR.error
    }
  } else {
    for (const v of (verdictR.data ?? []) as AnyRow[]) {
      const jobId = (v.parts as AnyRow | null)?.job_id as string | undefined
      if (!jobId) continue
      const row = rowsById.get(jobId)
      if (row) row.hasOpenInspectionVerdict = true
    }
  }

  // isShipped — derived from 出货 cell.
  for (const row of rowsById.values()) {
    const c = row.cells['出货']
    row.isShipped = Boolean(c && c.total > 0 && c.inProgress === 0 && c.pending === 0)
  }

  // Map insertion order = SQL ORDER BY position above — same row order as the
  // old getJobs() path.
  const composed = Array.from(rowsById.values())
  // Pre-0060 fallback can't push the ship split into SQL (is_shipped lives on
  // master_board_rows); filter post-compose instead.
  if (scope.kind === 'ship') {
    return composed.filter((r) => Boolean(r.isShipped) === scope.shipped)
  }
  return composed
}

// === 财务 / 应收账款 ledger ===

// Per-unit price for a part: explicit unit price wins, else derive from a
// whole-line total. Returns undefined when the part carries no price signal.
function partUnitPrice(p: PartRow): number | undefined {
  if (typeof p.unitPriceCny === 'number' && Number.isFinite(p.unitPriceCny)) {
    return p.unitPriceCny
  }
  if (
    typeof p.lineTotalCny === 'number' &&
    Number.isFinite(p.lineTotalCny) &&
    p.qty > 0
  ) {
    return p.lineTotalCny / p.qty
  }
  return undefined
}

// One ledger row per shipment (出货单). Joins each shipment to its job
// (customer / 商务 / 外发金额), its parts (qty / 物料号 / auto 金额), and the
// 财务 side-table (开票 / 回款). The whole factory's shipment history is
// loaded — finance scans it as one running list — mirroring how getMasterRows
// pulls the full board. Sorted newest-delivery-first.
export async function getFinanceRows(): Promise<FinanceRow[]> {
  await ensureSeeded()
  const [
    shipmentsRaw,
    shipmentPartsRaw,
    jobsRaw,
    partsRaw,
    financeRaw,
    outsourceBlocksRaw,
    outsourceBlockPartsRaw,
  ] = await Promise.all([
    selectAll('shipments'),
    selectAll('shipment_parts'),
    selectAll('jobs'),
    selectAll('parts'),
    // shipment_finance may not exist until migration 0026 is applied — degrade
    // to a blank ledger (every row 未开票) rather than 500 the page.
    selectAllOptional('shipment_finance'),
    // 外发金额 computed live off the blocks — NOT off job_summary.external_
    // spend_cny, which used to drop 加急 (rush) blocks priced per-member via
    // unit_price_cny, so the ledger under-reported. Two light reads (the parts
    // + jobs are already loaded above, so we deliberately DON'T call the
    // heavier getOutsourceBlockRows, which would re-fetch both).
    selectAll('outsource_blocks'),
    selectAll('outsource_block_parts'),
  ])

  const jobById = new Map<string, JobRow>()
  for (const r of jobsRaw) jobById.set(r.id as string, fromJob(r))

  const partById = new Map<string, PartRow>()
  for (const r of partsRaw) {
    const p = fromPart(r)
    partById.set(p.id, p)
  }

  const financeByShipment = new Map<string, ShipmentFinanceRow>()
  for (const r of financeRaw) {
    const f = fromShipmentFinance(r)
    financeByShipment.set(f.shipmentId, f)
  }

  // Per-block 外发金额 = block-level amount when set, else Σ(qty × unit_price)
  // across its members (rush pricing). Block qty falls back to the part qty
  // (0045 override). Reuses partById for job attribution + qty — no extra reads.
  const blockAmount = new Map<string, number | null>()
  for (const b of outsourceBlocksRaw) {
    blockAmount.set(
      b.id as string,
      b.amount_cny == null ? null : Number(b.amount_cny),
    )
  }
  const blockLineSum = new Map<string, number>()
  const jobByBlock = new Map<string, string>()
  for (const bp of outsourceBlockPartsRaw) {
    const blockId = bp.block_id as string
    const part = partById.get(bp.part_id as string)
    if (part && !jobByBlock.has(blockId)) jobByBlock.set(blockId, part.jobId)
    const unit = bp.unit_price_cny == null ? undefined : Number(bp.unit_price_cny)
    if (unit !== undefined && Number.isFinite(unit)) {
      const qty = bp.qty != null ? Number(bp.qty) : part ? part.qty : 0
      blockLineSum.set(blockId, (blockLineSum.get(blockId) ?? 0) + qty * unit)
    }
  }
  const externalSpendByJob = new Map<string, number>()
  for (const [blockId, jobId] of jobByBlock) {
    const amt = blockAmount.get(blockId)
    const spend = amt != null ? amt : blockLineSum.get(blockId) ?? 0
    externalSpendByJob.set(jobId, (externalSpendByJob.get(jobId) ?? 0) + spend)
  }

  const partsByShipment = new Map<string, ShipmentPartRow[]>()
  for (const r of shipmentPartsRaw) {
    const sp = fromShipmentPart(r)
    let arr = partsByShipment.get(sp.shipmentId)
    if (!arr) {
      arr = []
      partsByShipment.set(sp.shipmentId, arr)
    }
    arr.push(sp)
  }

  const shipments = shipmentsRaw.map(fromShipment)
  // Count shipments per job so a single-shipment job can fall the whole job
  // amount back into 金额 when its parts carry no unit prices.
  const shipmentCountByJob = new Map<string, number>()
  for (const s of shipments) {
    shipmentCountByJob.set(s.jobId, (shipmentCountByJob.get(s.jobId) ?? 0) + 1)
  }

  const rows: FinanceRow[] = shipments.map((s) => {
    const job = jobById.get(s.jobId)
    const sps = partsByShipment.get(s.id) ?? []
    let qty = 0
    let priced = 0
    let pricedAny = false
    const partNoSet = new Set<string>()
    for (const sp of sps) {
      qty += sp.qty
      const part = partById.get(sp.partId)
      if (part?.partNo) partNoSet.add(part.partNo)
      const unit = part ? partUnitPrice(part) : undefined
      if (unit !== undefined) {
        priced += sp.qty * unit
        pricedAny = true
      }
    }
    let computedAmountCny: number | undefined
    if (pricedAny) {
      computedAmountCny = Math.round(priced)
    } else if (
      (shipmentCountByJob.get(s.jobId) ?? 0) === 1 &&
      typeof job?.amountCny === 'number'
    ) {
      // Whole job shipped in one batch and no per-part prices — the job total
      // IS this delivery's value.
      computedAmountCny = job.amountCny
    }

    const fin = financeByShipment.get(s.id)
    return {
      shipmentId: s.id,
      docNo: s.docNo,
      shipDate: s.createdAt,
      jobId: s.jobId,
      jobNo: job?.jobNo ?? '',
      customer: job?.customer ?? '',
      product: job?.product ?? '',
      salesperson: job?.createdBy ?? s.createdBy,
      qty,
      partNos: Array.from(partNoSet).join(', '),
      computedAmountCny,
      externalSpendCny: externalSpendByJob.get(s.jobId) ?? 0,
      saleAmountCny: fin?.saleAmountCny,
      contact: fin?.contact,
      pendingFlag: fin?.pendingFlag,
      invoiceNo: fin?.invoiceNo,
      invoiceDate: fin?.invoiceDate,
      invoiceAmountCny: fin?.invoiceAmountCny,
      paymentDate: fin?.paymentDate,
      paymentAmountCny: fin?.paymentAmountCny,
    }
  })

  // Newest delivery first. createdAt is ISO so a string compare is a time
  // compare; fall back to docNo for the rare same-instant pair.
  rows.sort(
    (a, b) =>
      b.shipDate.localeCompare(a.shipDate) ||
      (b.docNo ?? '').localeCompare(a.docNo ?? ''),
  )
  return rows
}

// 订单资金 (per-order money) read — the boss's "money visibility" board.
// One row per confirmed order. Assembled from FOUR small reads only — jobs,
// shipments, shipment_finance, and the outsource blocks — and pointedly NOT
// from the master rollup or getFinanceRows, both of which drag in the whole
// 4k+-row parts table on every load. The order board never needs a single
// part row, so skipping that is the difference between ~3s and sub-second at
// thousands of jobs. 金额 / 合同号 / 客户 / 商务 come straight off jobs; 外协
// 支出·单数·周期 off the blocks; 开票·回款·应收·逾期 off shipments+finance;
// 出货 = "has a 出货单" (which is exactly what you invoice against).
// 收款 light — the per-order money state surfaced on the master board's 收款
// column. DUAL SOURCE since migration 0075: a job that carries ≥1 分期账 PO
// line is computed from the NEW installment ledger (po_lines + money_events,
// via fenqi.buildRows) so this light can never disagree with her /finance
// sheet; every other job falls back to the LEGACY shipment_finance
// aggregation (the handful of rows entered before the rebuild). Still keyed by
// jobId; a job with neither a 出货单 nor a booked line is simply absent (the
// board treats absent as 在产 → blank cell, no money due yet).
export type OrderMoneyLite = {
  status: OrderMoneyStatus
  outstandingCny: number
  /** Days past the aging window on the most-overdue shipment (status 'overdue' only). */
  overdueDays?: number
}

export async function getOrderMoneyLightByJob(): Promise<
  Map<string, OrderMoneyLite>
> {
  const todayStr = today()
  const [shipmentsRaw, financeRaw, poLinesRaw, moneyEventsRaw, jobsRaw] =
    await Promise.all([
      selectAll('shipments'),
      selectAllOptional('shipment_finance'),
      selectAllOptional('po_lines'),
      selectAllOptional('money_events'),
      selectAll('jobs'),
    ])

  const out = new Map<string, OrderMoneyLite>()

  // Jobs the ledger owns (≥1 PO line); their money is derived, not aggregated.
  const ledgerJobIds = new Set<string>()
  for (const r of poLinesRaw) ledgerJobIds.add(r.job_id as string)

  // billable: NULL/true = 收费, false = 免收 (migration 0075 default).
  const billableByJob = new Map<string, boolean>()
  for (const r of jobsRaw) billableByJob.set(r.id as string, r.billable !== false)

  // Any 出货单 → isShipped signal, shared by both paths.
  const shippedJobs = new Set<string>()
  for (const sr of shipmentsRaw) shippedJobs.add(sr.job_id as string)

  // ── Ledger path (migration 0075) ── build a minimal FenqiData for just the
  // ledger jobs (jobNo/customer/shipDate irrelevant to the light) and reuse the
  // exact same derivation as her sheet and the boss's wall.
  const ledgerJobs: FenqiJob[] = []
  for (const jobId of ledgerJobIds) {
    ledgerJobs.push({
      jobId,
      jobNo: '',
      customer: '',
      billable: billableByJob.get(jobId) ?? true,
    })
  }
  const ledgerData: FenqiData = {
    jobs: ledgerJobs,
    lines: poLinesRaw.map(fromPoLine),
    events: moneyEventsRaw.map(fromMoneyEvent),
  }
  for (const row of buildRows(ledgerData, todayStr)) {
    if (row.status === 'free') {
      // 免收 — nothing to collect; render as settled with no overdue.
      out.set(row.job.jobId, { status: 'settled', outstandingCny: 0 })
      continue
    }
    const outstandingCny = Math.max(0, row.unpaid)
    const status = orderMoneyStatusFrom({
      hasOverdue: row.status === 'overdue',
      isShipped: shippedJobs.has(row.job.jobId),
      hasInvoice: row.invoiced > 0,
      outstandingCny,
    })
    out.set(row.job.jobId, {
      status,
      outstandingCny,
      overdueDays: status === 'overdue' ? row.overdueDays : undefined,
    })
  }

  // ── Legacy path (pre-0075 shipment_finance) ── only jobs the ledger doesn't
  // own; the 5 rows entered the old way keep their exact behavior.
  const finByShipment = new Map<string, ShipmentFinanceRow>()
  for (const r of financeRaw) {
    const f = fromShipmentFinance(r)
    finByShipment.set(f.shipmentId, f)
  }

  type Agg = {
    invoiced: number
    paid: number
    outstanding: number
    hasInvoice: boolean
    hasOverdue: boolean
    overdueDays: number
    count: number
  }
  const byJob = new Map<string, Agg>()
  for (const sr of shipmentsRaw) {
    const s = fromShipment(sr)
    if (ledgerJobIds.has(s.jobId)) continue // ledger owns this job's money
    const agg =
      byJob.get(s.jobId) ??
      ({
        invoiced: 0,
        paid: 0,
        outstanding: 0,
        hasInvoice: false,
        hasOverdue: false,
        overdueDays: 0,
        count: 0,
      } as Agg)
    agg.count += 1
    const fin = finByShipment.get(s.id)
    if (fin) {
      // Reuse the AR domain logic verbatim by shaping the side-table row into a
      // FinanceRow — same as getOrderMoneyRows, so the board light and the AR
      // ledger can never disagree on outstanding / overdue.
      const row: FinanceRow = {
        shipmentId: s.id,
        shipDate: s.createdAt,
        jobId: s.jobId,
        jobNo: '',
        customer: '',
        product: '',
        qty: 0,
        partNos: '',
        externalSpendCny: 0,
        saleAmountCny: fin.saleAmountCny,
        contact: fin.contact,
        pendingFlag: fin.pendingFlag,
        invoiceNo: fin.invoiceNo,
        invoiceDate: fin.invoiceDate,
        invoiceAmountCny: fin.invoiceAmountCny,
        paymentDate: fin.paymentDate,
        paymentAmountCny: fin.paymentAmountCny,
      }
      if (fin.invoiceDate) {
        agg.hasInvoice = true
        agg.invoiced += fin.invoiceAmountCny ?? 0
      }
      agg.paid += fin.paymentAmountCny ?? 0
      agg.outstanding += outstanding(row)
      if (financeStatus(row, todayStr) === 'overdue') {
        agg.hasOverdue = true
        const d = overdueDays(fin.invoiceDate, todayStr)
        if (d > agg.overdueDays) agg.overdueDays = d
      }
    }
    byJob.set(s.jobId, agg)
  }

  for (const [jobId, agg] of byJob) {
    const status = orderMoneyStatusFrom({
      hasOverdue: agg.hasOverdue,
      isShipped: agg.count > 0,
      hasInvoice: agg.hasInvoice,
      outstandingCny: agg.outstanding,
    })
    out.set(jobId, {
      status,
      outstandingCny: agg.outstanding,
      overdueDays: status === 'overdue' ? agg.overdueDays : undefined,
    })
  }
  return out
}

// === 分期账 (installment ledger, migration 0075) ===
//
// The data layer under lib/fenqi.ts — the DB read/writes; all derivation
// (待开票 / 未收 / aging / sentences) lives in that pure module. Money hangs
// off the 订单号 (po_lines); each line carries append-only 开票 / 收款
// events (money_events). NOTHING is stored as a balance and 红冲 is a reversal
// ROW, never a delete, so the book stays auditable.

// Raw row → domain, snake→camel. Shared by getFenqiData and the board light so
// both read the ledger through one mapper.
function fromPoLine(r: AnyRow): FenqiLine {
  return {
    id: r.id as string,
    jobId: r.job_id as string,
    poNo: (r.po_no as string | null) ?? '',
    materialNo: (r.material_no as string | null) ?? undefined,
    amountCny: Number(r.amount_cny ?? 0),
    createdAt: r.created_at as string,
  }
}

function fromMoneyEvent(r: AnyRow): FenqiEvent {
  return {
    id: r.id as string,
    poLineId: r.po_line_id as string,
    kind: r.kind as FenqiEvent['kind'],
    amountCny: Number(r.amount_cny),
    eventDate: r.event_date as string,
    invoiceNo: (r.invoice_no as string | null) ?? undefined,
    note: (r.note as string | null) ?? undefined,
    reversalOf: (r.reversal_of as string | null) ?? undefined,
    createdBy: (r.created_by as string | null) ?? undefined,
    createdAt: r.created_at as string,
  }
}

// The whole ledger, ready for lib/fenqi's buildRows. Money starts at delivery:
// the pool is jobs with ≥1 出货单 OR ≥1 booked PO line — everything upstream
// stays out. jobs.* is read raw here (not via fromJob) so the ledger's shape
// stays independent of the master-board JobRow.
export async function getFenqiData(): Promise<FenqiData> {
  const [jobsRaw, shipmentsRaw, poLinesRaw, moneyEventsRaw] = await Promise.all([
    selectAll('jobs'),
    selectAll('shipments'),
    selectAllOptional('po_lines'),
    selectAllOptional('money_events'),
  ])

  // Latest 出货 per job → factory-local YYYY-MM-DD (max over created_at, ISO
  // strings compare lexically).
  const latestShipIso = new Map<string, string>()
  for (const sr of shipmentsRaw) {
    const jobId = sr.job_id as string
    const iso = sr.created_at as string
    const cur = latestShipIso.get(jobId)
    if (!cur || iso > cur) latestShipIso.set(jobId, iso)
  }
  const shipDateByJob = new Map<string, string>()
  for (const [jobId, iso] of latestShipIso) {
    shipDateByJob.set(
      jobId,
      new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }),
    )
  }

  const lineJobIds = new Set<string>()
  for (const r of poLinesRaw) lineJobIds.add(r.job_id as string)

  const jobs: FenqiJob[] = []
  const jobIds = new Set<string>()
  for (const r of jobsRaw) {
    const jobId = r.id as string
    const shipDate = shipDateByJob.get(jobId)
    if (!shipDate && !lineJobIds.has(jobId)) continue // not yet in the pool
    jobIds.add(jobId)
    jobs.push({
      jobId,
      jobNo: (r.job_no as string | null) ?? '',
      customer: (r.customer as string | null) ?? '',
      contact: (r.engineer as string | null) ?? undefined,
      salesperson:
        (r.yuenong_business as string | null) ??
        (r.created_by as string | null) ??
        undefined,
      shipDate,
      billable: r.billable !== false,
      jobAmountCny: r.amount_cny == null ? undefined : Number(r.amount_cny),
    })
  }

  const lines: FenqiLine[] = []
  for (const r of poLinesRaw) {
    if (!jobIds.has(r.job_id as string)) continue // defensive — orphan line
    lines.push(fromPoLine(r))
  }

  const events: FenqiEvent[] = moneyEventsRaw.map(fromMoneyEvent)

  return { jobs, lines, events }
}

// === 订单账 (/finance 订单 tab) ==============================================
//
// One payload: every confirmed order + its full money story — 订单额, the
// 外协 blocks it paid for (vendor, 工序, resolved spend), the 采购 buys linked
// to it (关联工号). Client-driven like getFenqiData: the tab filters/searches/
// exports in the browser off this one read.
//
// Block spend mirrors getFinanceRows exactly: block-level amount_cny when set,
// else Σ(数量 × 单价) across members (rush pricing), else null (未定价 —
// counted as 0 in the rollup, surfaced as 未定价 in the row's panel).
export async function getOrderLedgerRows(): Promise<
  import('./data').OrderLedgerRow[]
> {
  await ensureSeeded()

  // Column-scoped paginated read — selectAll's loop but without dragging every
  // column of the two biggest tables (jobs carries notes/stage_plan blobs,
  // parts carries image URLs) into a page whose payload ships to the client.
  const fetchCols = async (
    table: string,
    cols: string,
    eq?: [col: string, val: string],
  ): Promise<AnyRow[]> => {
    const out: AnyRow[] = []
    let from = 0
    while (true) {
      let q = supabase.from(table).select(cols)
      if (eq) q = q.eq(eq[0], eq[1])
      const { data, error } = await q.range(from, from + PAGE_SIZE - 1)
      if (error) throw error
      const rows = (data ?? []) as unknown as AnyRow[]
      out.push(...rows)
      if (rows.length < PAGE_SIZE) break
      from += PAGE_SIZE
    }
    return out
  }

  const [jobsRaw, blocksRaw, blockPartsRaw, partsRaw, vendors, procurements] =
    await Promise.all([
      fetchCols(
        'jobs',
        'id, job_no, customer, product, amount_cny, due_date, created_at',
        ['status', 'ready'],
      ),
      fetchCols(
        'outsource_blocks',
        'id, vendor_id, activity, amount_cny, sent_date, doc_no',
      ),
      fetchCols(
        'outsource_block_parts',
        'block_id, part_id, qty, unit_price_cny',
      ),
      fetchCols('parts', 'id, job_id, qty'),
      getVendors(),
      getProcurements(),
    ])

  const vendorName = new Map<string, string>()
  for (const v of vendors) vendorName.set(v.id, v.name)

  const partById = new Map<string, { jobId: string; qty: number }>()
  for (const p of partsRaw)
    partById.set(p.id as string, {
      jobId: p.job_id as string,
      qty: Number(p.qty ?? 0),
    })

  // Per-block: owning job + member line-total sum (undefined when no member
  // carries a 单价 — that keeps a genuinely unpriced block null, not ¥0).
  const jobByBlock = new Map<string, string>()
  const lineSumByBlock = new Map<string, number>()
  for (const bp of blockPartsRaw) {
    const blockId = bp.block_id as string
    const part = partById.get(bp.part_id as string)
    if (part && !jobByBlock.has(blockId)) jobByBlock.set(blockId, part.jobId)
    const unit = bp.unit_price_cny == null ? undefined : Number(bp.unit_price_cny)
    if (unit !== undefined && Number.isFinite(unit)) {
      const qty = bp.qty != null ? Number(bp.qty) : (part?.qty ?? 0)
      lineSumByBlock.set(blockId, (lineSumByBlock.get(blockId) ?? 0) + qty * unit)
    }
  }

  const outsourceByJob = new Map<string, import('./data').OrderLedgerOutsource[]>()
  for (const b of blocksRaw) {
    const blockId = b.id as string
    const jobId = jobByBlock.get(blockId)
    if (!jobId) continue // memberless / orphaned block — nothing to charge
    const amount =
      b.amount_cny != null
        ? Number(b.amount_cny)
        : (lineSumByBlock.get(blockId) ?? null)
    const arr = outsourceByJob.get(jobId) ?? []
    arr.push({
      blockId,
      vendorName:
        vendorName.get(b.vendor_id as string) ?? (b.vendor_id as string),
      activity: (b.activity as string | null) ?? undefined,
      docNo: (b.doc_no as string | null) ?? undefined,
      sentDate: (b.sent_date as string) ?? '',
      amountCny: amount,
    })
    outsourceByJob.set(jobId, arr)
  }

  // 采购 attribution: job_id when linked, else the typed 工号 snapshot (some
  // rows carry only the text). 已驳回 rows never became cost — skip them.
  const jobIdByNo = new Map<string, string>()
  for (const j of jobsRaw) {
    const no = ((j.job_no as string | null) ?? '').trim().toLowerCase()
    if (no) jobIdByNo.set(no, j.id as string)
  }
  const jobIdSet = new Set(jobsRaw.map((j) => j.id as string))
  const buysByJob = new Map<string, import('./data').OrderLedgerBuy[]>()
  for (const p of procurements) {
    if (p.status === 'rejected') continue
    const jobId =
      p.jobId && jobIdSet.has(p.jobId)
        ? p.jobId
        : p.jobNo
          ? jobIdByNo.get(p.jobNo.trim().toLowerCase())
          : undefined
    if (!jobId) continue // shop supplies etc. — not an order's cost
    const arr = buysByJob.get(jobId) ?? []
    arr.push({
      id: p.id,
      item: p.item,
      supplier: p.supplier,
      qty: p.qty,
      unitPriceCny: p.unitPriceCny,
      totalCny: procurementTotalCny(p),
      status: p.status,
      orderDate: p.orderDate,
    })
    buysByJob.set(jobId, arr)
  }

  const rows: import('./data').OrderLedgerRow[] = []
  for (const j of jobsRaw) {
    const jobId = j.id as string
    const outsource = outsourceByJob.get(jobId) ?? []
    const buys = buysByJob.get(jobId) ?? []
    let outsourceCny = 0
    for (const o of outsource) if (o.amountCny != null) outsourceCny += o.amountCny
    let procurementCny = 0
    for (const b of buys) if (b.totalCny != null) procurementCny += b.totalCny
    rows.push({
      jobId,
      jobNo: (j.job_no as string | null) ?? '',
      customer: (j.customer as string | null) ?? '',
      product: (j.product as string | null) ?? '',
      createdDate: new Date(j.created_at as string).toLocaleDateString(
        'en-CA',
        { timeZone: 'Asia/Shanghai' },
      ),
      dueDate: (j.due_date as string | null) ?? '',
      amountCny: j.amount_cny == null ? undefined : Number(j.amount_cny),
      outsource,
      buys,
      outsourceCny,
      procurementCny,
    })
  }
  // Newest order first — the ledger reads top-down like the 外协台. Ties on
  // the intake day break by 工号 (jobNoSortKey already inverts to newest-first
  // under an ASC compare).
  rows.sort(
    (a, b) =>
      b.createdDate.localeCompare(a.createdDate) ||
      jobNoSortKey(a).localeCompare(jobNoSortKey(b)),
  )
  return rows
}

// Book a 订单号 line on a job. `init` carries the values she typed in the
// draft row (订单号 / 物料号 / 金额); omitted ⇒ a blank line (kept for callers
// that still want an empty row).
export async function createPoLine(
  jobId: string,
  createdBy: string,
  init?: { poNo?: string; materialNo?: string; amountCny?: number },
): Promise<string> {
  const id = uid('pol')
  const { error } = await supabase.from('po_lines').insert({
    id,
    job_id: jobId,
    po_no: init?.poNo?.trim() ?? '',
    material_no: init?.materialNo?.trim() || null,
    amount_cny: init?.amountCny ?? 0,
    created_by: createdBy,
  })
  if (error) throw error
  return id
}

export type PoLinePatch = {
  poNo?: string
  materialNo?: string | null
  amountCny?: number
}

// Edit a line in place; only the keys she touched are written.
export async function updatePoLine(
  lineId: string,
  patch: PoLinePatch,
): Promise<void> {
  const update: AnyRow = {}
  if (patch.poNo !== undefined) update.po_no = patch.poNo
  if (patch.materialNo !== undefined) update.material_no = patch.materialNo
  if (patch.amountCny !== undefined) update.amount_cny = patch.amountCny
  if (Object.keys(update).length === 0) return
  const { error } = await supabase
    .from('po_lines')
    .update(update)
    .eq('id', lineId)
  if (error) throw error
}

// Delete a line — but only while it's clean. Once it carries any 开票/收款
// event the money must be 红冲'd first, never silently dropped.
export async function deletePoLine(lineId: string): Promise<void> {
  const { data, error } = await supabase
    .from('money_events')
    .select('id')
    .eq('po_line_id', lineId)
    .limit(1)
  if (error) throw error
  if (data && data.length > 0) {
    throw new Error('该订单号下已有开票/收款记录，请先作废')
  }
  const { error: delErr } = await supabase
    .from('po_lines')
    .delete()
    .eq('id', lineId)
  if (delErr) throw delErr
}

export type NewMoneyEventInput = {
  poLineId: string
  kind: 'invoice' | 'payment'
  amountCny: number
  eventDate: string
  invoiceNo?: string
  note?: string
}

// Append one 开票 or 收款 event to a line.
export async function createMoneyEvent(
  input: NewMoneyEventInput,
  createdBy: string,
): Promise<string> {
  const id = uid('mev')
  const { error } = await supabase.from('money_events').insert({
    id,
    po_line_id: input.poLineId,
    kind: input.kind,
    amount_cny: input.amountCny,
    event_date: input.eventDate,
    invoice_no: input.invoiceNo?.trim() || null,
    note: input.note?.trim() || null,
    created_by: createdBy,
  })
  if (error) throw error
  return id
}

// 红冲 — void an event by appending its mirror. Both rows stay in the book;
// the original renders struck-through and the reversal marker is hidden. Guards
// against voiding a reversal, or double-voiding the same event.
export async function voidMoneyEvent(
  eventId: string,
  createdBy: string,
): Promise<string> {
  const { data: orig, error: fetchErr } = await supabase
    .from('money_events')
    .select('id, po_line_id, kind, amount_cny, reversal_of')
    .eq('id', eventId)
    .maybeSingle()
  if (fetchErr) throw fetchErr
  if (!orig) throw new Error('记录不存在')
  if ((orig as AnyRow).reversal_of) throw new Error('红冲记录不能再作废')

  const { data: existing, error: existErr } = await supabase
    .from('money_events')
    .select('id')
    .eq('reversal_of', eventId)
    .limit(1)
  if (existErr) throw existErr
  if (existing && existing.length > 0) throw new Error('这笔已作废')

  const id = uid('mev')
  const { error } = await supabase.from('money_events').insert({
    id,
    po_line_id: (orig as AnyRow).po_line_id as string,
    kind: (orig as AnyRow).kind as string,
    amount_cny: (orig as AnyRow).amount_cny,
    event_date: today(),
    note: '红冲',
    reversal_of: eventId,
    created_by: createdBy,
  })
  if (error) throw error
  return id
}

// 是否收费 toggle. Store NULL for the default 收费 state so legacy rows and
// reset rows look identical; false only when 免收.
export async function setJobBillable(
  jobId: string,
  billable: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('jobs')
    .update({ billable: billable ? null : false })
    .eq('id', jobId)
  if (error) throw error
}

export async function getOrderMoneyRows(): Promise<OrderMoneyRow[]> {
  const todayStr = today()
  const [jobsRaw, shipmentsRaw, financeRaw, blockRows] = await Promise.all([
    selectAll('jobs'),
    selectAll('shipments'),
    selectAllOptional('shipment_finance'),
    getOutsourceBlockRows(),
  ])

  // 外协 aggregated per order: how many blocks, how much, and the turnaround
  // span (first 派单 → last 回件, or still-out while any block is open).
  type OutAgg = {
    count: number
    open: number
    spend: number
    firstSent?: string
    lastReturn?: string
  }
  const outByJob = new Map<string, OutAgg>()
  for (const r of blockRows) {
    const b = r.block
    const closedAt = blockClosedAt(b) // ISO ts, or undefined while open
    const spend = b.amountCny ?? blockLineTotalsSum(b) ?? 0
    const agg = outByJob.get(r.jobId) ?? { count: 0, open: 0, spend: 0 }
    agg.count += 1
    if (!closedAt) agg.open += 1
    agg.spend += spend
    if (b.sentDate && (!agg.firstSent || b.sentDate < agg.firstSent)) {
      agg.firstSent = b.sentDate
    }
    if (closedAt) {
      const ymd = closedAt.slice(0, 10)
      if (!agg.lastReturn || ymd > agg.lastReturn) agg.lastReturn = ymd
    }
    outByJob.set(r.jobId, agg)
  }

  // shipment_finance keyed by shipment (usually a small / nearly-empty table).
  const finByShipment = new Map<string, ShipmentFinanceRow>()
  for (const r of financeRaw) {
    const f = fromShipmentFinance(r)
    finByShipment.set(f.shipmentId, f)
  }

  // 应收 aggregated per order across its 出货单 — no parts, no shipment_parts.
  type ArAgg = {
    invoiced: number
    paid: number
    outstanding: number
    hasInvoice: boolean
    hasOverdue: boolean
    lastShip?: string
    count: number
  }
  const arByJob = new Map<string, ArAgg>()
  for (const sr of shipmentsRaw) {
    const s = fromShipment(sr)
    const agg =
      arByJob.get(s.jobId) ??
      ({
        invoiced: 0,
        paid: 0,
        outstanding: 0,
        hasInvoice: false,
        hasOverdue: false,
        count: 0,
      } as ArAgg)
    agg.count += 1
    const ymd = (s.createdAt ?? '').slice(0, 10)
    if (ymd && (!agg.lastShip || ymd > agg.lastShip)) agg.lastShip = ymd
    const fin = finByShipment.get(s.id)
    if (fin) {
      // Reuse the AR domain logic (outstanding / overdue aging) verbatim by
      // shaping the side-table row into a FinanceRow. computedAmountCny is left
      // undefined — the order board doesn't price shipments off parts.
      const row: FinanceRow = {
        shipmentId: s.id,
        shipDate: s.createdAt,
        jobId: s.jobId,
        jobNo: '',
        customer: '',
        product: '',
        qty: 0,
        partNos: '',
        externalSpendCny: 0,
        saleAmountCny: fin.saleAmountCny,
        contact: fin.contact,
        pendingFlag: fin.pendingFlag,
        invoiceNo: fin.invoiceNo,
        invoiceDate: fin.invoiceDate,
        invoiceAmountCny: fin.invoiceAmountCny,
        paymentDate: fin.paymentDate,
        paymentAmountCny: fin.paymentAmountCny,
      }
      if (fin.invoiceDate) {
        agg.hasInvoice = true
        agg.invoiced += fin.invoiceAmountCny ?? 0
      }
      agg.paid += fin.paymentAmountCny ?? 0
      agg.outstanding += outstanding(row)
      if (financeStatus(row, todayStr) === 'overdue') agg.hasOverdue = true
    }
    arByJob.set(s.jobId, agg)
  }

  const rows: OrderMoneyRow[] = []
  for (const jr of jobsRaw) {
    // Confirmed orders only — 收件箱 (parsing/draft/failed) aren't orders yet.
    if ((jr.status as string) !== 'ready') continue
    const id = jr.id as string
    const out = outByJob.get(id)
    const ar = arByJob.get(id)
    const contractNo = ((jr.contract_no as string | null) ?? '').trim()
    const amountCny = jr.amount_cny == null ? undefined : Number(jr.amount_cny)
    const outsourceSpendCny = out?.spend ?? 0
    rows.push({
      jobId: id,
      jobNo: (jr.job_no as string) ?? '',
      customer: (jr.customer as string) ?? '',
      product: (jr.product as string) ?? '',
      engineer: ((jr.engineer as string | null) ?? undefined) || undefined,
      salesperson: ((jr.created_by as string | null) ?? undefined) || undefined,
      status: 'ready',
      createdAt: (jr.created_at as string | null) ?? undefined,
      dueDate: (jr.due_date as string | null) ?? undefined,
      contractNo: contractNo || undefined,
      amountCny,
      outsourceCount: out?.count ?? 0,
      outsourceOpenCount: out?.open ?? 0,
      outsourceSpendCny,
      outsourceFirstSent: out?.firstSent,
      // Span is only "finished" when nothing is still out.
      outsourceLastReturn: out && out.open === 0 ? out.lastReturn : undefined,
      // 出货 for money purposes = a 出货单 exists (what you invoice against).
      isShipped: (ar?.count ?? 0) > 0,
      lastShipDate: ar?.lastShip,
      shipmentCount: ar?.count ?? 0,
      invoicedCny: ar?.invoiced ?? 0,
      paidCny: ar?.paid ?? 0,
      outstandingCny: ar?.outstanding ?? 0,
      hasInvoice: ar?.hasInvoice ?? false,
      hasOverdue: ar?.hasOverdue ?? false,
      marginCny:
        amountCny != null ? amountCny - outsourceSpendCny : undefined,
    })
  }

  // Newest order on top — the master board / AR ledger reading order. Color +
  // filters surface the problem rows; the default stays predictable.
  rows.sort(
    (a, b) =>
      (b.createdAt ?? '').localeCompare(a.createdAt ?? '') ||
      jobNoSortKey({ jobNo: a.jobNo }).localeCompare(
        jobNoSortKey({ jobNo: b.jobNo }),
      ),
  )
  return rows
}

export type ShipmentFinancePatch = {
  saleAmountCny?: number | null
  contact?: string | null
  pendingFlag?: string | null
  invoiceNo?: string | null
  invoiceDate?: string | null
  invoiceAmountCny?: number | null
  paymentDate?: string | null
  paymentAmountCny?: number | null
}

// Upsert the 财务 row for a shipment. Creates the side-table row on first
// edit (the shipment itself must already exist). Only the fields present in
// `patch` are written, so independent 开票 / 回款 edits never clobber each
// other.
export async function updateShipmentFinance(
  shipmentId: string,
  patch: ShipmentFinancePatch,
  updatedBy?: string,
): Promise<void> {
  await withWriteLock(async () => {
    const update: AnyRow = { shipment_id: shipmentId, updated_at: new Date().toISOString() }
    if (updatedBy !== undefined) update.updated_by = updatedBy
    if (patch.saleAmountCny !== undefined) update.sale_amount_cny = patch.saleAmountCny
    if (patch.contact !== undefined) update.contact = patch.contact
    if (patch.pendingFlag !== undefined) update.pending_flag = patch.pendingFlag
    if (patch.invoiceNo !== undefined) update.invoice_no = patch.invoiceNo
    if (patch.invoiceDate !== undefined) update.invoice_date = patch.invoiceDate
    if (patch.invoiceAmountCny !== undefined) update.invoice_amount_cny = patch.invoiceAmountCny
    if (patch.paymentDate !== undefined) update.payment_date = patch.paymentDate
    if (patch.paymentAmountCny !== undefined) update.payment_amount_cny = patch.paymentAmountCny
    const { error } = await supabase
      .from('shipment_finance')
      .upsert(update, { onConflict: 'shipment_id' })
    if (error) throw error
  })
}

// One order's 出货单 + their 开票/回款 state — the payload behind the board's
// click-to-fill 收款 popover. Scoped to a single job (never the whole DB), so
// it's sub-second. shipment_finance rows are created lazily on first 开票/回款,
// so most shipments come back with empty invoice/payment — that's the point:
// the boss taps to fill them in from the board.
export type OrderShipmentFinance = {
  shipmentId: string
  docNo?: string
  shipDate: string
  invoiceDate?: string
  invoiceAmountCny?: number
  paymentDate?: string
  paymentAmountCny?: number
}

export async function getOrderShipmentsForMoney(
  jobId: string,
): Promise<OrderShipmentFinance[]> {
  const { data: sRows, error: sErr } = await supabase
    .from('shipments')
    .select('id, doc_no, created_at')
    .eq('job_id', jobId)
    .order('created_at', { ascending: true })
  if (sErr) throw sErr
  const shipments = sRows ?? []
  if (shipments.length === 0) return []

  const ids = shipments.map((s) => s.id as string)
  const finByShip = new Map<string, ShipmentFinanceRow>()
  const { data: fRows, error: fErr } = await supabase
    .from('shipment_finance')
    .select('*')
    .in('shipment_id', ids)
  if (fErr) {
    if (!isMissingTableError(fErr)) throw fErr
  }
  for (const r of fRows ?? []) {
    const f = fromShipmentFinance(r)
    finByShip.set(f.shipmentId, f)
  }

  return shipments.map((s) => {
    const f = finByShip.get(s.id as string)
    return {
      shipmentId: s.id as string,
      docNo: (s.doc_no as string | null) ?? undefined,
      shipDate: s.created_at as string,
      invoiceDate: f?.invoiceDate,
      invoiceAmountCny: f?.invoiceAmountCny,
      paymentDate: f?.paymentDate,
      paymentAmountCny: f?.paymentAmountCny,
    }
  })
}

export async function getJob(id: string): Promise<Job | undefined> {
  // Job-detail page hot path. Touches only this job's rows — never the
  // whole database — so it stays sub-second even at 1000+ jobs.
  const snap = await loadJobSnapshot(id)
  const j = snap.idx.jobById.get(id)
  if (!j) return undefined
  const job = composeJob(j, snap)
  // 检验照片 — loaded only on the job detail (lists leave inspectionPhotos
  // undefined). One extra scoped query; merged post-compose so the snapshot
  // shape stays untouched.
  const partIds = snap.parts.map((p) => p.id)
  if (partIds.length > 0) {
    // Tolerate a not-yet-migrated DB (same posture as job_stage_pins) — the
    // job page must not 500 just because 0048 hasn't been applied.
    let photoRows: AnyRow[] = []
    try {
      photoRows = await selectAllIn('part_photos', 'part_id', partIds)
    } catch (e) {
      if (!isMissingTableError(e)) throw e
    }
    const byPart = new Map<string, PartPhoto[]>()
    for (const r of photoRows) {
      const pid = trimPartId(r.part_id as string)
      const arr = byPart.get(pid) ?? []
      arr.push({
        id: r.id as string,
        url: r.url as string,
        createdBy: (r.created_by as string | null) ?? undefined,
        createdAt: r.created_at as string,
      })
      byPart.set(pid, arr)
    }
    for (const arr of byPart.values()) {
      arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    }
    for (const c of job.components) {
      c.inspectionPhotos = byPart.get(c.id) ?? []
    }

    // 图纸变更 revisions — same scoped/merged pattern as 检验照片. Tolerates a
    // pre-0067 DB (renders no badges instead of 500'ing).
    let dcRows: AnyRow[] = []
    try {
      dcRows = await selectAllIn('part_drawing_changes', 'part_id', partIds)
    } catch (e) {
      if (!isMissingTableError(e)) throw e
    }
    const dcByPart = new Map<string, PartDrawingChange[]>()
    for (const r of dcRows) {
      const pid = trimPartId(r.part_id as string)
      const arr = dcByPart.get(pid) ?? []
      arr.push({
        id: r.id as string,
        revision: Number(r.revision) || 0,
        note: (r.note as string | null) ?? undefined,
        imageUrl: (r.image_url as string | null) ?? undefined,
        raisedBy: (r.raised_by as string | null) ?? undefined,
        raisedAt: r.raised_at as string,
        clearedAt: (r.cleared_at as string | null) ?? undefined,
        clearedBy: (r.cleared_by as string | null) ?? undefined,
      })
      dcByPart.set(pid, arr)
    }
    for (const arr of dcByPart.values()) {
      arr.sort((a, b) => a.revision - b.revision)
    }
    for (const c of job.components) {
      c.drawingChanges = dcByPart.get(c.id) ?? []
    }
  }
  return job
}

// Tiny status-only read for the /import poller. Returns ~50 bytes — small
// enough to survive flaky cross-border HTTP/2 paths where a full RSC refresh
// would get truncated. The import page polls this every 1.5s; do NOT add fields
// here without thinking about that hot loop.
export async function getJobStatus(
  id: string,
): Promise<{ status: JobStatus; parseError: string | null } | undefined> {
  const { data, error } = await supabase
    .from('jobs')
    .select('status, parse_error')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!data) return undefined
  return {
    status: data.status as JobStatus,
    parseError: (data.parse_error as string | null) ?? null,
  }
}

// === Stage transitions (single part) ===

export async function startStage(
  jobId: string,
  componentId: string,
  stage: Stage,
  actor: string,
): Promise<void> {
  await withWriteLock(async () => {
    const snap = await loadJobSnapshot(jobId)
    const partId = findPartIdInSnap(snap, jobId, componentId)
    if (!partId) return
    if (!canStartInSnap(snap, partId, stage)) return
    const row = snap.idx.stageByPartStage.get(stageKey(partId, stage))
    if (!row) return
    const now = new Date().toISOString()
    await upsertStages([
      {
        ...row,
        status: 'in_progress',
        completedAt: undefined,
        startedAt: now,
        by: undefined,
        startedBy: actor,
        doneQty: undefined,
      },
      // Part is physically here ⇒ close any upstream stage that missed its tap.
      ...cascadeBackStart(snap, partId, stage, todayMMDD(), now),
    ])
  })
}

export async function finishStage(
  jobId: string,
  componentId: string,
  stage: Stage,
  actor: string,
): Promise<void> {
  await withWriteLock(async () => {
    const snap = await loadJobSnapshot(jobId)
    const partId = findPartIdInSnap(snap, jobId, componentId)
    if (!partId) return
    const row = snap.idx.stageByPartStage.get(stageKey(partId, stage))
    if (!row) return
    if (row.status !== 'in_progress') return
    const date = todayMMDD()
    const finishedAt = new Date().toISOString()
    const main: PartStageRow = {
      ...row,
      status: 'done',
      completedAt: date,
      finishedAt,
      by: actor,
      doneQty: undefined,
    }
    const cascaded = cascadeBackFinish(snap, partId, stage, date, finishedAt, actor)
    await upsertStages([main, ...cascaded])
    // Shipping settles the part's vendor lines too (see cascadeBackFinish).
    if (stage === '出货') {
      await closeOpenOutsourceMembersForParts(snap, [partId], today())
    }
  })
}

// 检验 verdict — the inspector's single gesture. OK is a normal finish
// (same cascade-back + timestamps as finishStage) with the verdict stamped
// alongside; a blocking verdict (重做/返修/外修) holds the part at 检验:
// status forced to in_progress (clicking a verdict IS the inspection — no
// separate ▶ start), red tag painted from the verdict fields. The inspector
// can re-verdict any number of times; the last click wins.
export async function setInspectionVerdict(
  jobId: string,
  componentId: string,
  verdict: Verdict,
  actor: string,
): Promise<void> {
  await withWriteLock(async () => {
    const snap = await loadJobSnapshot(jobId)
    const partId = findPartIdInSnap(snap, jobId, componentId)
    if (!partId) return
    const row = snap.idx.stageByPartStage.get(stageKey(partId, '检验'))
    if (!row) return // 检验 not in this part's route — no-op
    const now = new Date().toISOString()
    if (verdict === 'OK') {
      const date = todayMMDD()
      const main: PartStageRow = {
        ...row,
        status: 'done',
        completedAt: date,
        startedAt: row.startedAt ?? now,
        finishedAt: now,
        by: actor,
        doneQty: undefined,
        verdict: 'OK',
        verdictAt: now,
        verdictBy: actor,
      }
      const cascaded = cascadeBackFinish(snap, partId, '检验', date, now, actor)
      await upsertStages([main, ...cascaded])
      return
    }
    await upsertStages([
      {
        ...row,
        status: 'in_progress',
        startedAt: row.startedAt ?? now,
        startedBy: row.startedBy ?? actor,
        completedAt: undefined,
        finishedAt: undefined,
        by: undefined,
        verdict,
        verdictAt: now,
        verdictBy: actor,
      },
    ])
  })
}

// 不良原因 + 责任人 on the 检验 row (migration 0052). Targeted update kept
// separate from the verdict click so the two inputs commit on blur without
// re-touching status/timestamps — and so a pre-0052 DB degrades to "doesn't
// persist yet" instead of breaking every stage write.
export async function setInspectionVerdictDetail(
  jobId: string,
  componentId: string,
  detail: { reason?: string | null; owner?: string | null; note?: string | null },
): Promise<void> {
  await withWriteLock(async () => {
    const snap = await loadJobSnapshot(jobId)
    const partId = findPartIdInSnap(snap, jobId, componentId)
    if (!partId) return
    const row = snap.idx.stageByPartStage.get(stageKey(partId, '检验'))
    if (!row) return
    const update: AnyRow = {}
    if (detail.reason !== undefined)
      update.verdict_reason = detail.reason?.trim() || null
    if (detail.owner !== undefined)
      update.verdict_owner = detail.owner?.trim() || null
    if (detail.note !== undefined)
      update.verdict_note = detail.note?.trim() || null
    if (Object.keys(update).length === 0) return
    const { error } = await supabase
      .from('part_stages')
      .update(update)
      .eq('id', row.id)
    if (error && !isMissingColumnError(error)) throw error
  })
}

// === 检验照片 (part_photos) ===

// Append one inspection photo. The storage upload happens in the API route
// (lib/inspection-photo.ts); this records the row so every viewer of the job
// detail sees it. Returns the new photo id, or undefined when the component
// can't be resolved.
export async function addPartPhoto(
  jobId: string,
  componentId: string,
  url: string,
  actor: string,
): Promise<PartPhoto | undefined> {
  return withWriteLock(async () => {
    const snap = await loadJobSnapshot(jobId)
    const partId = findPartIdInSnap(snap, jobId, componentId)
    if (!partId) return undefined
    const photo: PartPhoto = {
      id: crypto.randomUUID(),
      url,
      createdBy: actor,
      createdAt: new Date().toISOString(),
    }
    const { error } = await supabase.from('part_photos').insert({
      id: photo.id,
      part_id: partId,
      url: photo.url,
      created_by: photo.createdBy,
      created_at: photo.createdAt,
    })
    if (error) throw error
    return photo
  })
}

// Delete an inspection photo row. Returns the stored url so the caller can
// also remove the storage object. Scoped to the job so a stale/foreign id
// can't delete across jobs.
export async function deletePartPhoto(
  jobId: string,
  photoId: string,
): Promise<string | undefined> {
  return withWriteLock(async () => {
    const snap = await loadJobSnapshot(jobId)
    const partIds = snap.parts.map((p) => p.id)
    if (partIds.length === 0) return undefined
    // The .in('part_id', …) is just a cross-job guard; only the chunk holding
    // the photo's part deletes a row, the rest no-op.
    const deleted = await inChunks(partIds, (chunk) =>
      supabase
        .from('part_photos')
        .delete()
        .eq('id', photoId)
        .in('part_id', chunk)
        .select('url'),
    )
    return (deleted[0]?.url as string | undefined) ?? undefined
  })
}

// 合同文件 (contract uploads) are TABLE-FREE — stored in the bucket with a JSON
// manifest. See lib/contract-file.ts. Nothing to do here.

// Set the running partial-completion count at a stage. The default click on
// the cell still finishes the whole row in one shot — this is the secondary
// path for "I did 3 of 5". When qty reaches the part's qty the row is
// promoted through the same finish path as finishStage (cascade-back, dates,
// done_qty cleared). When 0 < qty < part.qty the row stays in_progress with
// the count saved; when qty === 0 the row goes back to a fresh in_progress
// (or pending if it was pending before).
export async function setStageDoneQty(
  jobId: string,
  componentId: string,
  stage: Stage,
  qty: number,
  actor: string,
): Promise<void> {
  await withWriteLock(async () => {
    const snap = await loadJobSnapshot(jobId)
    const partId = findPartIdInSnap(snap, jobId, componentId)
    if (!partId) return
    const part = snap.idx.partById.get(partId)
    if (!part) return
    const row = snap.idx.stageByPartStage.get(stageKey(partId, stage))
    if (!row) return
    const max = Math.max(0, Math.floor(part.qty))
    const clamped = Math.max(0, Math.min(max, Math.floor(qty)))
    // Idempotent: setting qty to part.qty on an already-done row is a no-op.
    // Callers (e.g. the 出货单 qty cell) write through unconditionally, so we
    // short-circuit here rather than asking every caller to guard.
    if (row.status === 'done' && clamped >= max && max > 0) return
    if (clamped >= max && max > 0) {
      const date = todayMMDD()
      const finishedAt = new Date().toISOString()
      const main: PartStageRow = {
        ...row,
        status: 'done',
        completedAt: date,
        startedAt: row.startedAt ?? finishedAt,
        finishedAt,
        by: actor,
        doneQty: undefined,
      }
      const cascaded = cascadeBackFinish(snap, partId, stage, date, finishedAt, actor)
      await upsertStages([main, ...cascaded])
      // Shipping settles the part's vendor lines too (see cascadeBackFinish).
      if (stage === '出货') {
        await closeOpenOutsourceMembersForParts(snap, [partId], today())
      }
      return
    }
    // Falling through from a 'done' row (qty < max) flips it back to
    // in_progress with the new partial. Upstream cascade rows stay done —
    // the shipping head already verified them when they originally finished
    // this stage; we're just amending the shipped count, not re-opening the
    // production trail.
    await upsertStages([
      {
        ...row,
        status: 'in_progress',
        startedAt: row.startedAt ?? new Date().toISOString(),
        completedAt: undefined,
        finishedAt: undefined,
        by: actor,
        startedBy: row.startedBy ?? actor,
        doneQty: clamped > 0 ? clamped : undefined,
      },
    ])
  })
}

export type ShippingSelection = { componentId: string; qty: number }

export type PrepareShippingResult = {
  shipmentId: string
  docNo: string
}

// 制作出货单 — emits one shipment + N shipment_parts rows for the batch and
// brings the 出货 stage rollup in sync with the new cumulative across all
// shipments. Each `selections` entry is a DELTA (units to ship this round),
// not the absolute total: the picker is the only place where shipping
// decisions are made, so the delta semantics keeps repeat submissions honest.
//
// Validation is loud: an over-ship pick (qty > remaining) throws so the UI
// can surface "数量超过剩余" instead of silently dropping the request. Empty
// selections also throw — every batch must ship at least one unit, otherwise
// we'd litter the audit log with zero-row shipments.
export async function prepareShipping(
  jobId: string,
  selections: ShippingSelection[],
  actor: string,
): Promise<PrepareShippingResult> {
  return withWriteLock(async () => {
    const snap = await loadJobSnapshot(jobId)
    const job = snap.idx.jobById.get(jobId)
    if (!job) throw new Error('工单不存在')
    const parts = snap.idx.partsByJob.get(jobId) ?? []
    if (parts.length === 0) throw new Error('工单没有零件')

    // Resolve every pick's client-side componentId to its DB partId, collapse
    // dupes, and clamp to integers. Zero / negative picks are silently
    // dropped — they're not "errors", just nothing to ship for that row.
    const deltas = new Map<string, number>()
    for (const sel of selections) {
      const qty = Math.floor(Number(sel.qty))
      if (!Number.isFinite(qty) || qty <= 0) continue
      const partId = findPartIdInSnap(snap, jobId, sel.componentId)
      if (!partId) continue
      deltas.set(partId, (deltas.get(partId) ?? 0) + qty)
    }
    if (deltas.size === 0) throw new Error('请至少选择一个零件')

    // Existing cumulative per part = sum across this job's prior shipments.
    // Validate every delta against the part's remaining headroom before any
    // write goes out so the whole submission is all-or-nothing.
    const cumulative = new Map<string, number>()
    for (const s of snap.idx.shipmentsByJob.get(jobId) ?? []) {
      for (const sp of snap.idx.shipmentPartsByShipment.get(s.id) ?? []) {
        cumulative.set(sp.partId, (cumulative.get(sp.partId) ?? 0) + sp.qty)
      }
    }
    for (const [partId, delta] of deltas) {
      const part = snap.idx.partById.get(partId)
      if (!part) throw new Error('零件不存在')
      const already = cumulative.get(partId) ?? 0
      const remaining = Math.max(0, part.qty - already)
      if (delta > remaining) {
        throw new Error(`${part.name} 数量超过剩余 (${remaining})`)
      }
    }

    // Allocate the shipment doc_no for the batch. Same YNMX-yy-m-d-NNN format
    // as the other printed docs; the counter is scoped to the shipments table
    // so it doesn't fight with jobs.shipping_doc_no or outsource_blocks.doc_no.
    const now = new Date()
    const prefix = docNoDayPrefix(now)
    const seq = await nextSeqForPrefix('shipments', 'doc_no', prefix)
    const docNo = formatDocNo(now, seq)
    const shipmentId = uid('s')
    const createdAt = now.toISOString()

    const shipmentRow: ShipmentRow = {
      id: shipmentId,
      jobId,
      docNo,
      createdAt,
      createdBy: actor,
    }
    const shipmentPartRows: ShipmentPartRow[] = []
    for (const [partId, qty] of deltas) {
      shipmentPartRows.push({ shipmentId, partId, qty })
    }

    // Stage rollup: new cumulative per touched part, then map to 出货 status.
    // Untouched parts keep whatever state they had — direct cell clicks on
    // 出货 (legacy workbench path) aren't blown away by a fresh batch.
    const stageUpdates: PartStageRow[] = []
    const fullyShippedPartIds: string[] = []
    const date = todayMMDD()
    for (const [partId, delta] of deltas) {
      const part = snap.idx.partById.get(partId)
      if (!part) continue
      const row = snap.idx.stageByPartStage.get(stageKey(partId, '出货'))
      if (!row) continue
      const newCumulative = (cumulative.get(partId) ?? 0) + delta
      const max = Math.max(0, Math.floor(part.qty))
      if (newCumulative >= max && max > 0) {
        // Fully shipped — close out the row and let 出货's cascade-back finish
        // any upstream stages that hadn't been ticked yet (same finishStage
        // semantics; commerce shouldn't have to chase missed station taps).
        stageUpdates.push({
          ...row,
          status: 'done',
          completedAt: date,
          startedAt: row.startedAt ?? createdAt,
          finishedAt: createdAt,
          by: actor,
          doneQty: undefined,
        })
        const cascaded = cascadeBackFinish(snap, partId, '出货', date, createdAt, actor)
        stageUpdates.push(...cascaded)
        fullyShippedPartIds.push(partId)
      } else {
        stageUpdates.push({
          ...row,
          status: 'in_progress',
          startedAt: row.startedAt ?? createdAt,
          completedAt: undefined,
          finishedAt: undefined,
          by: actor,
          doneQty: newCumulative > 0 ? newCumulative : undefined,
        })
      }
    }

    // Audit log first, rollup second. If the rollup write blows up, the
    // shipment row will still be there for the next snapshot to reconcile —
    // we never want to "ship" without leaving a trace.
    const insS = await supabase.from('shipments').insert(toShipment(shipmentRow))
    if (insS.error) throw insS.error
    if (shipmentPartRows.length > 0) {
      const insP = await supabase
        .from('shipment_parts')
        .insert(shipmentPartRows.map(toShipmentPart))
      if (insP.error) throw insP.error
    }
    if (stageUpdates.length > 0) await upsertStages(stageUpdates)
    // Shipping settles the parts' vendor lines too (see cascadeBackFinish).
    if (fullyShippedPartIds.length > 0) {
      await closeOpenOutsourceMembersForParts(snap, fullyShippedPartIds, today())
    }

    return { shipmentId, docNo }
  })
}

export async function undoStage(
  jobId: string,
  componentId: string,
  stage: Stage,
): Promise<void> {
  await withWriteLock(async () => {
    const snap = await loadJobSnapshot(jobId)
    const partId = findPartIdInSnap(snap, jobId, componentId)
    if (!partId) return
    const row = snap.idx.stageByPartStage.get(stageKey(partId, stage))
    if (!row) return
    if (row.status !== 'done') return
    await upsertStages([
      {
        ...row,
        status: 'in_progress',
        completedAt: undefined,
        by: undefined,
        doneQty: undefined,
      },
    ])
  })
}

export async function assignToStage(
  jobId: string,
  componentId: string,
  fromStage: Stage,
  toStage: Stage,
  actor: string,
): Promise<void> {
  if (fromStage === toStage) return
  await withWriteLock(async () => {
    const snap = await loadJobSnapshot(jobId)
    const partId = findPartIdInSnap(snap, jobId, componentId)
    if (!partId) return
    const fromRow = snap.idx.stageByPartStage.get(stageKey(partId, fromStage))
    const toRow = snap.idx.stageByPartStage.get(stageKey(partId, toStage))
    if (!fromRow || !toRow) return
    const now = new Date().toISOString()
    const updates: PartStageRow[] = []
    if (fromRow.status === 'in_progress') {
      updates.push({
        ...fromRow,
        status: 'pending',
        completedAt: undefined,
        by: undefined,
        doneQty: undefined,
      })
    }
    updates.push({
      ...toRow,
      status: 'in_progress',
      completedAt: undefined,
      startedAt: now,
      by: actor,
      doneQty: undefined,
    })
    await upsertStages(updates)
  })
}

// === Stage transitions (whole job) ===

export async function assignJobToStage(
  jobId: string,
  fromStage: Stage,
  toStage: Stage,
  actor: string,
): Promise<void> {
  if (fromStage === toStage) return
  await withWriteLock(async () => {
    const snap = await loadJobSnapshot(jobId)
    const fromIdx = STAGES.indexOf(fromStage)
    const parts = snap.idx.partsByJob.get(jobId) ?? []
    const updates: PartStageRow[] = []
    for (const part of parts) {
      const stateAt = (s: Stage) =>
        snap.idx.stageByPartStage.get(stageKey(part.id, s))?.status ?? 'pending'
      const fromCur = stateAt(fromStage)
      if (fromCur === 'done') continue
      if (fromCur === 'pending') {
        // A stage with no part_stages row is NOT in this part's route (n/a) —
        // it can't block the handoff. Only real, unfinished rows do.
        const prevDone = STAGES.slice(0, fromIdx).every((s) => {
          const row = snap.idx.stageByPartStage.get(stageKey(part.id, s))
          return !row || row.status === 'done'
        })
        if (!prevDone) continue
        const elsewhereInProgress = STAGES.some(
          (s) => s !== fromStage && stateAt(s) === 'in_progress',
        )
        if (elsewhereInProgress) continue
      }
      const fromRow = snap.idx.stageByPartStage.get(stageKey(part.id, fromStage))
      const toRow = snap.idx.stageByPartStage.get(stageKey(part.id, toStage))
      if (!toRow) continue
      if (fromRow && fromRow.status === 'in_progress') {
        updates.push({
          ...fromRow,
          status: 'pending',
          completedAt: undefined,
          by: undefined,
          doneQty: undefined,
        })
      }
      updates.push({
        ...toRow,
        status: 'in_progress',
        completedAt: undefined,
        startedAt: new Date().toISOString(),
        by: actor,
        doneQty: undefined,
      })
    }
    await upsertStages(updates)
  })
}

export async function startJobStage(
  jobId: string,
  stage: Stage,
  actor: string,
): Promise<void> {
  await withWriteLock(async () => {
    const snap = await loadJobSnapshot(jobId)
    const parts = snap.idx.partsByJob.get(jobId) ?? []
    const now = new Date().toISOString()
    const date = todayMMDD()
    const updates: PartStageRow[] = []
    for (const part of parts) {
      if (!canStartInSnap(snap, part.id, stage)) continue
      const row = snap.idx.stageByPartStage.get(stageKey(part.id, stage))
      if (!row) continue
      updates.push({
        ...row,
        status: 'in_progress',
        completedAt: undefined,
        startedAt: now,
        by: undefined,
        startedBy: actor,
        doneQty: undefined,
      })
      // Parts are physically here ⇒ close upstream stages that missed their tap.
      updates.push(...cascadeBackStart(snap, part.id, stage, date, now))
    }
    await upsertStages(updates)
  })
}

export async function finishJobStage(
  jobId: string,
  stage: Stage,
  actor: string,
): Promise<void> {
  await withWriteLock(async () => {
    const snap = await loadJobSnapshot(jobId)
    const date = todayMMDD()
    const finishedAt = new Date().toISOString()
    const parts = snap.idx.partsByJob.get(jobId) ?? []
    // 出货 is terminal: ticking it for the JOB means "this order left the
    // building", so it sweeps every not-yet-done part — pending ones included
    // — and cascadeBackFinish closes all their earlier stations (外协-covered
    // ones too). Every other stage keeps the strict rule: finish only what's
    // actually in flight, pending parts wait for their own ▶.
    const isShipping = stage === '出货'
    const updates: PartStageRow[] = []
    for (const part of parts) {
      const row = snap.idx.stageByPartStage.get(stageKey(part.id, stage))
      if (!row) continue
      if (isShipping) {
        if (row.status !== 'done') {
          updates.push({
            ...row,
            status: 'done',
            completedAt: date,
            finishedAt,
            by: actor,
            doneQty: undefined,
          })
        }
        // Cascade for EVERY part — including ones whose 出货 was already
        // ticked earlier — so the invariant holds job-wide: shipped means
        // every station before 出货 is ✓, no stragglers from partial ships.
        updates.push(
          ...cascadeBackFinish(snap, part.id, stage, date, finishedAt, actor),
        )
        continue
      }
      if (row.status !== 'in_progress') continue
      updates.push({
        ...row,
        status: 'done',
        completedAt: date,
        finishedAt,
        by: actor,
        doneQty: undefined,
      })
      updates.push(
        ...cascadeBackFinish(snap, part.id, stage, date, finishedAt, actor),
      )
    }
    await upsertStages(updates)
    // …and settle any vendor lines still open on this job's parts.
    if (isShipping) {
      await closeOpenOutsourceMembersForParts(
        snap,
        parts.map((p) => p.id),
        today(),
      )
    }
  })
}

export async function undoJobStage(jobId: string, stage: Stage): Promise<void> {
  await withWriteLock(async () => {
    const snap = await loadJobSnapshot(jobId)
    const parts = snap.idx.partsByJob.get(jobId) ?? []
    const updates: PartStageRow[] = []
    for (const part of parts) {
      const row = snap.idx.stageByPartStage.get(stageKey(part.id, stage))
      if (!row) continue
      if (row.status !== 'done') continue
      updates.push({
        ...row,
        status: 'in_progress',
        completedAt: undefined,
        by: undefined,
        doneQty: undefined,
      })
    }
    await upsertStages(updates)
  })
}

// === Job/component editing ===

export type JobPatch = {
  jobNo?: string
  customer?: string
  customerId?: string | null
  product?: string
  dueDate?: string
  secondaryDueDate?: string | null
  // 计划交期 (排产) is intentionally NOT a JobPatch field: it is a per-工段 map
  // and is written ONLY through setJobStagePlan (single-key atomic merge), so
  // the generic whole-row updateJob can never clobber sibling stages.
  amountCny?: number | null
  notes?: string | null
  createdBy?: string | null
  contractNo?: string | null
  batchNo?: string | null
  engineer?: string | null
  yuenongBusiness?: string | null
  sourceFile?: string | null
  sourceFileUrl?: string | null
  needsOutsource?: boolean
  outsourceNote?: string | null
  outsourceFlaggedBy?: string | null
  outsourceFlaggedAt?: string | null
  drawingChangeOpen?: boolean
  drawingChangeNote?: string | null
  drawingChangeBy?: string | null
  drawingChangeAt?: string | null
}

export async function updateJob(jobId: string, patch: JobPatch): Promise<void> {
  await withWriteLock(async () => {
    const update: AnyRow = {}
    if (patch.jobNo !== undefined) {
      // Only run the duplicate scan if the value would actually change.
      // Skipping the no-op case avoids a self-collision when fillParsedJob's
      // initial write echoes the placeholder filename-stem jobNo back, and
      // saves a snapshot scan on the master-board's frequent metadata writes.
      const next = patch.jobNo.trim()
      const { data: currentRow, error: currentErr } = await supabase
        .from('jobs')
        .select('job_no')
        .eq('id', jobId)
        .maybeSingle()
      if (currentErr) throw currentErr
      const currentJobNo = ((currentRow?.job_no as string | null) ?? '').trim()
      if (currentRow && currentJobNo !== next) {
        const conflict = await findJobNoConflictByQuery(next, jobId)
        if (conflict) throw new Error(formatJobNoConflictError(conflict))
      }
      update.job_no = patch.jobNo
    }
    if (patch.customer !== undefined) update.customer = patch.customer
    if (patch.customerId !== undefined) update.customer_id = patch.customerId
    if (patch.product !== undefined) update.product = patch.product
    if (patch.dueDate !== undefined) update.due_date = patch.dueDate
    if (patch.secondaryDueDate !== undefined)
      update.secondary_due_date = patch.secondaryDueDate
    if (patch.amountCny !== undefined) update.amount_cny = patch.amountCny
    if (patch.notes !== undefined) update.notes = patch.notes
    if (patch.createdBy !== undefined) update.created_by = patch.createdBy
    if (patch.contractNo !== undefined) update.contract_no = patch.contractNo
    if (patch.batchNo !== undefined) update.batch_no = patch.batchNo
    if (patch.engineer !== undefined) update.engineer = patch.engineer
    if (patch.yuenongBusiness !== undefined)
      update.yuenong_business = patch.yuenongBusiness
    if (patch.sourceFile !== undefined) update.source_file = patch.sourceFile
    if (patch.sourceFileUrl !== undefined) update.source_file_url = patch.sourceFileUrl
    if (patch.needsOutsource !== undefined) update.needs_outsource = patch.needsOutsource
    if (patch.outsourceNote !== undefined) update.outsource_note = patch.outsourceNote
    if (patch.outsourceFlaggedBy !== undefined)
      update.outsource_flagged_by = patch.outsourceFlaggedBy
    if (patch.outsourceFlaggedAt !== undefined)
      update.outsource_flagged_at = patch.outsourceFlaggedAt
    if (patch.drawingChangeOpen !== undefined)
      update.drawing_change_open = patch.drawingChangeOpen
    if (patch.drawingChangeNote !== undefined)
      update.drawing_change_note = patch.drawingChangeNote
    if (patch.drawingChangeBy !== undefined)
      update.drawing_change_by = patch.drawingChangeBy
    if (patch.drawingChangeAt !== undefined)
      update.drawing_change_at = patch.drawingChangeAt
    if (Object.keys(update).length === 0) return
    const { error } = await supabase.from('jobs').update(update).eq('id', jobId)
    if (error) throw error
  })
}

// 计划交期 (排产) — set or clear ONE 工段's planned date, merged into the job's
// holistic stage_plan map. Read-modify-write under the global write lock so
// per-stage edits to the same job never clobber one another: the client sends
// only its own stage (never the whole, possibly-stale map — see
// app/_stage_plan.tsx). A null / empty value DROPS the key (never persists '').
// The jobs UPDATE fires refresh_master_board_jobs, so the board mirror follows.
export async function setJobStagePlan(
  jobId: string,
  stage: PlanKey,
  value: string | null,
): Promise<void> {
  await withWriteLock(async () => {
    const { data, error: readErr } = await supabase
      .from('jobs')
      .select('stage_plan')
      .eq('id', jobId)
      .maybeSingle()
    if (readErr) throw readErr
    if (!data) throw new Error('工单不存在')
    const map = stagePlanFromJson(data.stage_plan)
    if (value && value.length) map[stage] = value
    else delete map[stage]
    const { error } = await supabase
      .from('jobs')
      .update({ stage_plan: map })
      .eq('id', jobId)
    if (error) throw error
  })
}

export type ComponentPatch = {
  name?: string
  qty?: number
  material?: string | null
  surfaceTreatment?: string | null
  notes?: string | null
  unitPriceCny?: number | null
  lineTotalCny?: number | null
  partNo?: string | null
  process?: string | null
  shipmentLog?: string | null
  // 零件进度 的 # (migration 0088). null = back to the derived position number.
  seqLabel?: string | null
}

// 数量 × 单价 → 小计, to 2 decimals (¥0.01 is the smallest thing anyone quotes;
// plain float multiplication otherwise leaves 1.0000000000000002 in the sheet).
const roundMoney = (n: number) => Math.round(n * 100) / 100

// The one rule for keeping 小计 true, given a part's current row and the patch
// about to land on it. Returns the 小计 correction to fold into that patch, or
// {} to leave the stored value alone.
//
//   · 小计 typed explicitly → untouched (a line discount is the user's call)
//   · 数量 or 单价 changed, and both are known → 小计 = 数量 × 单价
//   · 单价 cleared → 小计 goes with it, UNLESS the stored 小计 was never the
//     product of the two (someone quoted the line total on its own — keep it)
//
// The 小计 cell in app/_editable.tsx applies the same rule locally so the
// number appears the instant you leave the 单价 field; this is the authority.
function syncedLineTotal(
  prev: PartRow | undefined,
  patch: ComponentPatch,
): { lineTotalCny?: number | null } {
  if (!prev) return {}
  if (patch.lineTotalCny !== undefined) return {}
  if (patch.qty === undefined && patch.unitPriceCny === undefined) return {}
  const qty = patch.qty ?? prev.qty
  const unit =
    patch.unitPriceCny !== undefined ? patch.unitPriceCny : prev.unitPriceCny
  if (
    typeof unit === 'number' &&
    Number.isFinite(unit) &&
    typeof qty === 'number' &&
    Number.isFinite(qty)
  ) {
    const next = roundMoney(qty * unit)
    return next === prev.lineTotalCny ? {} : { lineTotalCny: next }
  }
  // No 单价 to multiply by. Only an explicit clearing of the price drops the
  // total, and only when that total was this rule's own work.
  if (patch.unitPriceCny !== null) return {}
  if (prev.lineTotalCny === undefined) return {}
  const wasDerived =
    typeof prev.unitPriceCny === 'number' &&
    roundMoney(prev.qty * prev.unitPriceCny) === prev.lineTotalCny
  return wasDerived ? { lineTotalCny: null } : {}
}

export async function updateComponent(
  jobId: string,
  componentId: string,
  patch: ComponentPatch,
): Promise<void> {
  await withWriteLock(async () => {
    const snap = await loadJobSnapshot(jobId)
    const partId = findPartIdInSnap(snap, jobId, componentId)
    if (!partId) return
    // 小计 follows 数量 × 单价. Touching either input rewrites the line total
    // here, server-side, so it holds no matter which surface typed the number
    // (job sheet / 导入 draft / a future one) — nobody does the multiplication
    // by hand. An explicitly-typed 小计 in the same patch always wins; that is
    // the line-discount escape hatch. Mirrored on screen by the 小计 cell in
    // app/_editable.tsx, which must keep telling the same story.
    patch = { ...patch, ...syncedLineTotal(snap.parts.find((p) => p.id === partId), patch) }
    const update: AnyRow = {}
    if (patch.name !== undefined) update.name = patch.name
    if (patch.qty !== undefined) update.qty = patch.qty
    if (patch.material !== undefined) update.material = patch.material
    if (patch.surfaceTreatment !== undefined) update.surface_treatment = patch.surfaceTreatment
    if (patch.process !== undefined) update.process = patch.process
    if (patch.notes !== undefined) update.notes = patch.notes
    if (patch.unitPriceCny !== undefined) update.unit_price_cny = patch.unitPriceCny
    if (patch.lineTotalCny !== undefined) update.line_total_cny = patch.lineTotalCny
    if (patch.partNo !== undefined) update.part_no = patch.partNo
    if (patch.shipmentLog !== undefined) update.shipment_log = patch.shipmentLog
    if (patch.seqLabel !== undefined) update.seq_label = patch.seqLabel
    if (Object.keys(update).length === 0) return
    const { error } = await supabase.from('parts').update(update).eq('id', partId)
    if (error) throw error

    // 零件 → 订单 rollup. When a price-affecting field changes, refresh the
    // job's 金额 from the sum of its component line totals — but ONLY while
    // that 金额 is "auto": empty, or still equal to what the parts summed to
    // before this edit (i.e. it was last set by this same rollup). A 金额 the
    // boss typed by hand differs from the parts total, so it's never clobbered
    // — he can always override, and blanking it (→ null) re-arms the rollup.
    const priceTouched =
      patch.unitPriceCny !== undefined ||
      patch.lineTotalCny !== undefined ||
      patch.qty !== undefined
    if (priceTouched) {
      const lineTotalOf = (p: PartRow): number | undefined => {
        if (typeof p.lineTotalCny === 'number' && Number.isFinite(p.lineTotalCny)) {
          return p.lineTotalCny
        }
        if (typeof p.unitPriceCny === 'number' && Number.isFinite(p.unitPriceCny)) {
          return p.unitPriceCny * p.qty
        }
        return undefined
      }
      let prevTotal = 0
      let newTotal = 0
      for (const p of snap.parts) {
        prevTotal += lineTotalOf(p) ?? 0
        if (p.id === partId) {
          const np: PartRow = { ...p }
          if (patch.qty !== undefined) np.qty = patch.qty
          if (patch.unitPriceCny !== undefined) {
            np.unitPriceCny = patch.unitPriceCny ?? undefined
          }
          if (patch.lineTotalCny !== undefined) {
            np.lineTotalCny = patch.lineTotalCny ?? undefined
          }
          newTotal += lineTotalOf(np) ?? 0
        } else {
          newTotal += lineTotalOf(p) ?? 0
        }
      }
      const currentAmount = snap.idx.jobById.get(jobId)?.amountCny
      const rollupValue = newTotal > 0 ? Math.round(newTotal) : null
      const isAuto =
        currentAmount == null || currentAmount === Math.round(prevTotal)
      if (isAuto && rollupValue !== (currentAmount ?? null)) {
        const { error: jobErr } = await supabase
          .from('jobs')
          .update({ amount_cny: rollupValue })
          .eq('id', jobId)
        if (jobErr) throw jobErr
      }
    }
  })
}

export async function setComponentImage(
  jobId: string,
  componentId: string,
  imageUrl: string | null,
): Promise<void> {
  await withWriteLock(async () => {
    const snap = await loadJobSnapshot(jobId)
    const partId = findPartIdInSnap(snap, jobId, componentId)
    if (!partId) return
    const { error } = await supabase
      .from('parts')
      .update({ image_url: imageUrl })
      .eq('id', partId)
    if (error) throw error
  })
}

// Direct image-url patch that bypasses the snapshot reload + write lock.
// Used by the post-import image-upload pass, which patches ~100 rows back
// to back; routing each through loadSnapshot() (9 selectAll's) would add
// minutes of pointless table scans. The caller already knows the partId
// because fillParsedJob assigns them deterministically as `${jobId}:p${i+1}`.
// A no-op `update` is acceptable if the part was deleted in the meantime.
export async function setPartImageUrlDirect(
  partId: string,
  imageUrl: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('parts')
    .update({ image_url: imageUrl })
    .eq('id', partId)
  if (error) throw error
}

export async function appendComponent(jobId: string): Promise<string | undefined> {
  return withWriteLock(async () => {
    // This write only needs the job to exist and the sibling ids/positions —
    // the full snapshot (stages, shipments, returns) turns 添加零件 into a
    // seconds-long wait on factory networks.
    const [jobR, partsR] = await Promise.all([
      supabase.from('jobs').select('id').eq('id', jobId).maybeSingle(),
      supabase.from('parts').select('id, position').eq('job_id', jobId),
    ])
    if (jobR.error) throw jobR.error
    if (partsR.error) throw partsR.error
    if (!jobR.data) return undefined
    const existing = (partsR.data ?? []) as { id: string; position: number }[]
    const nextPos = existing.reduce((m, p) => Math.max(m, p.position), -1) + 1
    const used = new Set(existing.map((p) => p.id))
    let n = existing.length + 1
    let partId = `${jobId}:p${n}`
    while (used.has(partId)) {
      n += 1
      partId = `${jobId}:p${n}`
    }
    const partRow: PartRow = {
      id: partId,
      jobId,
      position: nextPos,
      name: '',
      qty: 0,
    }
    // Seed every stage as pending; 商务/工程 prune via the chip widget.
    const stageRows: PartStageRow[] = DEFAULT_NEW_PART_STAGES.map((stage) => ({
      id: `${partId}:${stage}`,
      partId,
      stage,
      status: 'pending' as StageStatus,
    }))
    const partR = await supabase.from('parts').insert(toPart(partRow))
    if (partR.error) throw partR.error
    const stagesR = await supabase
      .from('part_stages')
      .insert(stageRows.map(toPartStage))
    if (stagesR.error) throw stagesR.error
    return partId.split(':').slice(1).join(':') || partId
  })
}

// Import order baked into the part id (`${jobId}:p<n>`). Used only as a
// tie-break when two parts somehow carry the same position, so the canonical
// order this function renumbers into is deterministic.
function partIdSeq(id: string): number {
  const m = /:p(\d+)$/.exec(id)
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}

// The # every row is showing right now, in sheet order: the hand-typed override
// where there is one (0088), otherwise the position-derived 01 / 02 / 03.
function displayedSeqLabels(
  ordered: { seq_label?: string | null }[],
): string[] {
  return ordered.map(
    (p, i) => (p.seq_label as string | null) ?? String(i + 1).padStart(2, '0'),
  )
}

// The # a row inserted under `anchor` should carry — a SUB-number of the row
// above it (01 → 1.1 → 1.2), which is the convention the floor already used by
// hand the day the field became editable.
//
// This is what makes the insert non-disruptive. A sub-numbered row is not a new
// entry in the 01/02/03 sequence, so the rows below it keep the numbers they
// already had (frozen by insertComponentAfter) instead of each sliding down one
// — the whole complaint: "原来的号能否可以不变".
function subSeqLabel(anchor: string, taken: Set<string>): string {
  const sub = /^(\d+(?:\.\d+)*)\.(\d+)$/.exec(anchor)
  if (sub) {
    // The anchor is itself a sub-number (1.1) → the next sibling (1.2, 1.3 …).
    const stem = sub[1]
    let n = Number(sub[2])
    for (let i = 0; i < 999; i += 1) {
      n += 1
      const candidate = `${stem}.${n}`
      if (!taken.has(candidate)) return candidate
    }
  }
  // A plain 01 → 1.1, leading zero dropped because that is how it gets written
  // on paper. Anything else (料号-ish text like A2) keeps its text and gains .1.
  const stem = /^\d+$/.test(anchor) ? String(Number(anchor)) : anchor
  for (let n = 1; n < 999; n += 1) {
    const candidate = `${stem}.${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${stem}.${999}`
}

// Insert a fresh part directly AFTER an existing one — the + that lives on a
// row's separator line. Identical seeding to appendComponent; the only
// difference is placement: every part from the anchor's successor onward
// slides down one slot so the new row lands exactly where the user pointed.
//
// The row's # does NOT slide down with its position. Every row the renumber
// touches gets the # it is showing right now written into seq_label in that
// same upsert (a no-op write for rows that already carry one), and the new row
// takes a sub-number of its anchor instead of the anchor's successor's number.
// So 后壳 stays 02 forever, even though a row now sits above it — inserting a
// part no longer rewrites numbers the floor has already read off the sheet.
//
// The write order is what keeps the sheet safe. The renumber goes FIRST, as
// ONE upsert carrying id + job_id + position + seq_label and nothing else
// (PostgREST's ON CONFLICT DO UPDATE only sets the columns present in the
// payload, so no name / qty / price can be clobbered — the payload's keys are
// kept UNIFORM across rows for exactly that reason), and it is a single
// statement — so the master-board statement trigger fires once, not once per
// row. If the process dies between the renumber and the insert, the sheet is
// left with a one-slot
// gap in its position sequence: invisible to every reader (they all sort by
// position, never index into it), and never a duplicate or a scrambled order.
export async function insertComponentAfter(
  jobId: string,
  afterComponentId: string,
): Promise<{ id: string; seqLabel?: string } | undefined> {
  return withWriteLock(async () => {
    // Same lean read as appendComponent — ids + positions + the # override are
    // all this write needs, and the full snapshot would turn a row insert into
    // a multi-second wait on factory networks.
    const [jobR, partsR] = await Promise.all([
      supabase.from('jobs').select('id').eq('id', jobId).maybeSingle(),
      supabase
        .from('parts')
        .select('id, position, seq_label')
        .eq('job_id', jobId),
    ])
    if (jobR.error) throw jobR.error
    if (partsR.error) throw partsR.error
    if (!jobR.data) return undefined
    const existing = (partsR.data ?? []) as {
      id: string
      position: number
      seq_label?: string | null
    }[]
    const ordered = [...existing].sort(
      (a, b) => a.position - b.position || partIdSeq(a.id) - partIdSeq(b.id),
    )
    // What each row reads TODAY. Everything below is about keeping these true.
    const shown = displayedSeqLabels(ordered)

    // Anchor resolution mirrors findPartIdInSnap: prefixed id first, bare
    // legacy id second. An unresolvable anchor (row deleted in another tab)
    // degrades to an append at the end rather than failing the click.
    const direct = `${jobId}:${afterComponentId}`
    let anchorIdx = ordered.findIndex((p) => p.id === direct)
    if (anchorIdx < 0) {
      anchorIdx = ordered.findIndex((p) => p.id === afterComponentId)
    }
    const insertAt = anchorIdx < 0 ? ordered.length : anchorIdx + 1

    const used = new Set(existing.map((p) => p.id))
    let n = existing.length + 1
    let partId = `${jobId}:p${n}`
    while (used.has(partId)) {
      n += 1
      partId = `${jobId}:p${n}`
    }

    // The new row's #: a sub-number of the row it was dropped under. Pinned to
    // the anchor, so it is stable no matter what the rows below are numbered.
    // An unresolvable anchor degraded to an append (nothing below to disturb),
    // which needs no label at all — it just takes the next number.
    const seqLabel =
      anchorIdx < 0 ? undefined : subSeqLabel(shown[anchorIdx], new Set(shown))

    // Normalize the whole column to 0..N with the new row's slot left empty.
    // Only rows whose position actually moves are written — and each carries
    // the # it is showing right now, so sliding down a slot no longer changes
    // the number anyone reads. Rows that already have an override re-write the
    // same value (a no-op); the point of including it on every row is to keep
    // the upsert payload's keys uniform, since a key missing from one object
    // would be sent as NULL and wipe that row's override.
    const shifted: {
      id: string
      job_id: string
      position: number
      seq_label: string
    }[] = []
    ordered.forEach((p, k) => {
      const next = k < insertAt ? k : k + 1
      if (next !== p.position) {
        shifted.push({
          id: p.id,
          job_id: jobId,
          position: next,
          seq_label: shown[k],
        })
      }
    })
    if (shifted.length > 0) {
      const shiftR = await supabase
        .from('parts')
        .upsert(shifted, { onConflict: 'id' })
      if (shiftR.error) throw shiftR.error
    }

    const partRow: PartRow = {
      id: partId,
      jobId,
      position: insertAt,
      name: '',
      qty: 0,
    }
    const stageRows: PartStageRow[] = DEFAULT_NEW_PART_STAGES.map((stage) => ({
      id: `${partId}:${stage}`,
      partId,
      stage,
      status: 'pending' as StageStatus,
    }))
    // seq_label rides alongside toPart rather than inside it: toPart is the
    // shared INSERT shape (导入订单 included) and deliberately does not carry
    // the column, so only this one path — a row slipped between two others —
    // is born with a #.
    const partR = await supabase
      .from('parts')
      .insert({ ...toPart(partRow), ...(seqLabel ? { seq_label: seqLabel } : {}) })
    if (partR.error) throw partR.error
    const stagesR = await supabase
      .from('part_stages')
      .insert(stageRows.map(toPartStage))
    if (stagesR.error) throw stagesR.error
    return { id: partId.split(':').slice(1).join(':') || partId, seqLabel }
  })
}

export async function deleteComponent(
  jobId: string,
  componentId: string,
): Promise<void> {
  await withWriteLock(async () => {
    // Same resolution as findPartIdInSnap (`${jobId}:${componentId}` first,
    // bare legacy id second) without loading the whole job snapshot. The
    // job_id filter keeps a hand-typed bare id scoped to this job.
    const direct = `${jobId}:${componentId}`
    const { data, error } = await supabase
      .from('parts')
      .select('id')
      .eq('job_id', jobId)
      .in('id', [direct, componentId])
    if (error) throw error
    const rows = (data ?? []) as { id: string }[]
    const partId = rows.find((r) => r.id === direct)?.id ?? rows[0]?.id
    if (!partId) return
    // FK cascade on parts → part_stages, outsource_blocks does the rest.
    const del = await supabase.from('parts').delete().eq('id', partId)
    if (del.error) throw del.error
  })
}

// === Per-part routing ===

export type RouteConflict = { stage: Stage; status: 'in_progress' | 'done' }

export type SetPartRouteResult =
  | { ok: true }
  | { ok: false; reason: 'needs_confirm'; conflicts: RouteConflict[] }
  | { ok: false; reason: 'outsourced_locked'; stages: Stage[] }
  | { ok: false; reason: 'not_found' }

// Update the set of stages a part visits. Used by the StageChips widget on
// the import draft page (商务) and the job detail page (工程).
//
// Rules:
//   • 出货 is always in the route — silently injected if missing.
//   • Stages covered by any outsource block (open or closed) are immutable —
//     they're owned by the block, not the chip. Attempting to remove one
//     yields { reason: 'outsourced_locked' }.
//   • Removing a stage whose row is `pending` is free. Removing one that is
//     `in_progress` or `done` requires `force: true` (the caller flips this
//     bit only after the user confirms the dialog).
//   • Adding a stage inserts a fresh `pending` row.
export async function setPartRoute(
  jobId: string,
  componentId: string,
  desired: Stage[],
  options: { force?: boolean } = {},
): Promise<SetPartRouteResult> {
  return withWriteLock(async () => {
    const snap = await loadJobSnapshot(jobId)
    const partId = findPartIdInSnap(snap, jobId, componentId)
    if (!partId) return { ok: false, reason: 'not_found' }

    const desiredSet = new Set<Stage>(resolvePartStages(desired))
    const currentRows = snap.idx.stagesByPart.get(partId) ?? []
    const currentSet = new Set<Stage>(currentRows.map((r) => r.stage as Stage))
    const blocks = partBlocksInSnap(snap, partId)
    const blockedStages = new Set<Stage>()
    for (const b of blocks) for (const s of b.stages) blockedStages.add(s)

    const toAdd: Stage[] = []
    const toRemove: Stage[] = []
    for (const s of STAGES) {
      const want = desiredSet.has(s)
      const have = currentSet.has(s)
      if (want === have) continue
      if (want) toAdd.push(s)
      else toRemove.push(s)
    }

    // An outsourced stage (open or closed block) belongs to the block — the
    // chip widget can't take it out of the route, regardless of force.
    const outsourcedRemovals = toRemove.filter((s) => blockedStages.has(s))
    if (outsourcedRemovals.length > 0) {
      return { ok: false, reason: 'outsourced_locked', stages: outsourcedRemovals }
    }

    // In-flight removals need explicit confirmation. We surface the conflict
    // list so the client can show "this will lose 工时记录 for X, Y" copy.
    const conflicts: RouteConflict[] = []
    for (const s of toRemove) {
      const row = currentRows.find((r) => r.stage === s)
      if (!row) continue
      if (row.status === 'in_progress' || row.status === 'done') {
        conflicts.push({ stage: s, status: row.status })
      }
    }
    if (conflicts.length > 0 && !options.force) {
      return { ok: false, reason: 'needs_confirm', conflicts }
    }

    if (toRemove.length > 0) {
      const { error } = await supabase
        .from('part_stages')
        .delete()
        .eq('part_id', partId)
        .in('stage', toRemove)
      if (error) throw error
    }
    if (toAdd.length > 0) {
      const rows: PartStageRow[] = toAdd.map((stage) => ({
        id: `${partId}:${stage}`,
        partId,
        stage,
        status: 'pending',
      }))
      // upsert + ignoreDuplicates so a click that races against an existing
      // row (cross-process write between snapshot load and insert, or a
      // partial fillParsedJob retry that left rows behind) becomes a no-op
      // instead of throwing the unique-constraint violation that surfaces
      // as "保存失败" in the chip widget.
      const { error } = await supabase
        .from('part_stages')
        .upsert(rows.map(toPartStage), { onConflict: 'id', ignoreDuplicates: true })
      if (error) throw error
    }
    return { ok: true }
  })
}

// === 工单号 uniqueness ===
//
// Enforced at three gates:
//   - fillParsedJob   (extraction returns a real jobNo for a fresh upload)
//   - updateJob       (commerce manually renames a draft/ready job)
//   - confirmJob      (defensive: jobNo could've been edited between fill and
//                      confirm without ever passing through updateJob's check)
//
// Only `draft` + `ready` jobs occupy the namespace. `parsing` rows hold a
// placeholder jobNo (filename stem), and `failed` rows are awaiting recovery
// — neither should block a new upload from claiming that jobNo.
//
// Comparison is whitespace-trimmed but otherwise exact (case-sensitive,
// matches how 工号 is rendered everywhere else in the app).

export type JobNoConflict = {
  id: string
  jobNo: string
  customer: string
  status: JobStatus
}

export async function findJobNoConflict(
  jobNo: string,
  excludeJobId?: string,
): Promise<JobNoConflict | null> {
  return findJobNoConflictByQuery(jobNo, excludeJobId)
}

// Sentinel format used as the thrown Error.message so it round-trips through
// markJobFailed → parse_error → ParsingPoller and through server-action
// rejections. Keep the prefix + pipe layout stable; clients pattern-match it.
export const DUP_JOBNO_PREFIX = 'DUP_JOBNO|'

export function formatJobNoConflictError(c: JobNoConflict): string {
  // Layout: id|status|jobNo|customer. `status` lets the client route the
  // "open existing" link correctly — a `draft` conflict lives at /import/[id],
  // a `ready` one at /jobs/[id]. id/status/jobNo never contain '|'; customer is
  // free text and goes last so it can.
  return `${DUP_JOBNO_PREFIX}${c.id}|${c.status}|${c.jobNo}|${c.customer}`
}

const JOB_STATUSES: readonly JobStatus[] = ['parsing', 'draft', 'ready', 'failed']

export function parseJobNoConflictError(
  message: string | null | undefined,
): { id: string; jobNo: string; customer: string; status: JobStatus } | null {
  if (!message || !message.startsWith(DUP_JOBNO_PREFIX)) return null
  const parts = message.slice(DUP_JOBNO_PREFIX.length).split('|')
  if (parts.length < 3) return null
  // New layout (id|status|jobNo|customer) vs legacy (id|jobNo|customer) stored
  // in pre-deploy `failed` rows. Detect by whether field 2 is a known status;
  // legacy errors default to `ready` (their old link target).
  if (JOB_STATUSES.includes(parts[1] as JobStatus)) {
    const [id, status, jobNo, ...customer] = parts
    return { id, status: status as JobStatus, jobNo, customer: customer.join('|') }
  }
  const [id, jobNo, ...customer] = parts
  return { id, status: 'ready', jobNo, customer: customer.join('|') }
}

// === Job lifecycle ===

export async function createParsingJob(input: { sourceFile: string }): Promise<Job> {
  return withWriteLock(async () => {
    await ensureSeeded()
    const id = uid('J')
    const { data: maxR, error: maxE } = await supabase
      .from('jobs')
      .select('position')
      .order('position', { ascending: false })
      .limit(1)
    if (maxE) throw maxE
    const maxPos =
      maxR && maxR.length > 0 ? Number(maxR[0].position ?? -1) : -1
    const stem = input.sourceFile.replace(/\.[^.]+$/, '')
    const row: JobRow = {
      id,
      jobNo: stem || id,
      customer: '解析中…',
      product: '—',
      dueDate: today(),
      status: 'parsing',
      sourceFile: input.sourceFile,
      createdAt: new Date().toISOString(),
      position: maxPos + 1,
    }
    const { error } = await supabase.from('jobs').insert(toJob(row))
    if (error) throw error
    const snap = await loadJobSnapshot(id)
    const job = snap.idx.jobById.get(id)!
    return composeJob(job, snap)
  })
}

export async function fillParsedJob(jobId: string, input: NewJobInput): Promise<void> {
  await withWriteLock(async () => {
    // 工单号 collision handling.
    //
    // A `draft` sharing this 工号 is an earlier import of the same order that
    // was never confirmed — abandoned half-work. The user is here right now
    // with a fresh upload; that's their real intent, so it becomes the new
    // source of truth: drop the stale draft and let this one take the 工号.
    // (Delete inlined rather than calling deleteJob() — withWriteLock isn't
    // re-entrant; parts / part_stages cascade on the jobs row, same as
    // deleteJob.)
    //
    // A `ready` job is a live, confirmed order on the production board. We used
    // to HARD-FAIL the parse here (throw → markJobFailed → a dead-end duplicate
    // panel that discarded everything the AI just extracted), so the import
    // never even showed. Now the draft persists normally: the import page
    // renders the full review with a red 工号 caution and blocks 确认导入 until
    // the operator renames it. confirmJob is the server-side backstop.
    const conflict = await findJobNoConflictByQuery(input.jobNo, jobId)
    if (conflict && conflict.status === 'draft') {
      const delR = await supabase.from('jobs').delete().eq('id', conflict.id)
      if (delR.error) throw delR.error
    }

    // Update job metadata first but DON'T flip status yet — the import page
    // polls the snapshot and would otherwise see status='draft' before parts
    // and stages are in place, rendering an empty 零件清单. We flip status
    // last so the consumer sees the new state atomically.
    const metaUpdate: AnyRow = {
      job_no: input.jobNo,
      customer: input.customer,
      product: input.product,
      amount_cny: input.amountCny ?? null,
      due_date: input.dueDate,
      notes: input.notes ?? null,
      engineer: input.engineer ?? null,
      parse_error: null,
    }
    if (input.sourceFile !== undefined) metaUpdate.source_file = input.sourceFile
    const upR = await supabase.from('jobs').update(metaUpdate).eq('id', jobId)
    if (upR.error) throw upR.error
    const delR = await supabase.from('parts').delete().eq('job_id', jobId)
    if (delR.error) throw delR.error
    const partRows: PartRow[] = []
    const stageRows: PartStageRow[] = []
    input.components.forEach((c, i) => {
      const partId = `${jobId}:p${i + 1}`
      partRows.push({
        id: partId,
        jobId,
        position: i,
        name: c.name,
        qty: c.qty,
        material: c.material,
        surfaceTreatment: c.surfaceTreatment,
        notes: c.notes,
        unitPriceCny: c.unitPriceCny,
        lineTotalCny: c.lineTotalCny,
        imageUrl: c.imageUrl,
        partNo: c.partNo,
        process: c.process,
      })
      // Hard guarantee on initial seed: every fresh part starts with the
      // full default route (all stages except the opt-in 采购/表处) so the
      // chip widget renders filled and 商务 prunes
      // by clicking off the ones that don't apply. We deliberately ignore
      // c.stages here — the LLM is instructed not to emit it, but this
      // protects against drift (partial list → some chips hollow → "click
      // hollow chip → save failed" because the route diff would try to
      // add+remove against a stale current set).
      for (const stage of DEFAULT_NEW_PART_STAGES) {
        stageRows.push({
          id: `${partId}:${stage}`,
          partId,
          stage,
          status: 'pending',
        })
      }
    })
    if (partRows.length) {
      const r = await supabase.from('parts').insert(partRows.map(toPart))
      if (r.error) throw r.error
    }
    if (stageRows.length) {
      const r = await supabase.from('part_stages').insert(stageRows.map(toPartStage))
      if (r.error) throw r.error
    }
    // Final atomic flip — only now is the draft view safe to render.
    const flipR = await supabase
      .from('jobs')
      .update({ status: 'draft' })
      .eq('id', jobId)
    if (flipR.error) throw flipR.error
  })
}

export async function markJobFailed(jobId: string, error: string): Promise<void> {
  await withWriteLock(async () => {
    const { error: e } = await supabase
      .from('jobs')
      .update({ status: 'failed', parse_error: error.slice(0, 500) })
      .eq('id', jobId)
    if (e) throw e
  })
}

// Bypass AI extraction — flip a stuck/failed job straight into draft so
// commerce can hand-enter the parts via the existing import editor. Any
// parts that did get persisted before the stall are kept; commerce can
// delete them and start fresh if the partial extraction is unusable.
export async function markJobAsDraft(jobId: string): Promise<void> {
  await withWriteLock(async () => {
    const { error } = await supabase
      .from('jobs')
      .update({ status: 'draft', parse_error: null })
      .eq('id', jobId)
    if (error) throw error
  })
}

// Reset a stuck/failed job to 'parsing' before kicking off another extraction
// pass. Clears parse_error so the import page drops the failure UI and the
// poller resumes.
export async function markJobAsParsing(jobId: string): Promise<void> {
  await withWriteLock(async () => {
    const { error } = await supabase
      .from('jobs')
      .update({ status: 'parsing', parse_error: null })
      .eq('id', jobId)
    if (error) throw error
  })
}

// Mark every pending in-route stage strictly before `startAt` as done across
// all parts of the job — used by the "确认导入 → 发往 X" affordance so a
// fresh job lands in the chosen station's queue with its upstream stages
// already showing ✓ on the rollup (rather than disappearing from the route).
//
// Only `pending` rows are touched; in_progress / done rows are left alone, so
// the same operation is safe to run mid-flight (it just no-ops on stages that
// already had real work). Stages that are not in a part's route at all stay
// absent (no row created), which is correct — those stages don't apply.
export async function markJobStartedAt(
  jobId: string,
  startAt: Stage,
  actor: string,
): Promise<void> {
  const startIdx = STAGES.indexOf(startAt)
  if (startIdx <= 0) return
  const earlier = STAGES.slice(0, startIdx)
  await withWriteLock(async () => {
    const { data: parts, error: pErr } = await supabase
      .from('parts')
      .select('id')
      .eq('job_id', jobId)
    if (pErr) throw pErr
    const partIds = (parts ?? []).map((p) => (p as AnyRow).id as string)
    if (partIds.length === 0) return
    await inChunks(partIds, (chunk) =>
      supabase
        .from('part_stages')
        .update({
          status: 'done',
          completed_at: today(),
          finished_at: new Date().toISOString(),
          by_actor: actor,
        })
        .in('part_id', chunk)
        .in('stage', earlier)
        .eq('status', 'pending'),
    )
  })
}

export async function confirmJob(jobId: string): Promise<void> {
  await withWriteLock(async () => {
    // Defensive recheck: jobNo could have been inline-edited between the
    // initial fill and this confirm, or two drafts could have been edited
    // toward the same number in parallel.
    const { data: jobRow, error: jobErr } = await supabase
      .from('jobs')
      .select('job_no, due_date, job_type')
      .eq('id', jobId)
      .maybeSingle()
    if (jobErr) throw jobErr
    const jobNo = (jobRow?.job_no as string | null) ?? ''
    if (jobNo) {
      // Same policy as fillParsedJob: a live `ready` order blocks; a stale
      // `draft` sharing this 工号 (only reachable via an inline rename collision)
      // is abandoned half-work and yields to the draft being confirmed now.
      const conflict = await findJobNoConflictByQuery(jobNo, jobId)
      if (conflict) {
        if (conflict.status !== 'draft') {
          throw new Error(formatJobNoConflictError(conflict))
        }
        const delR = await supabase.from('jobs').delete().eq('id', conflict.id)
        if (delR.error) throw delR.error
      }
    }
    // Auto-default the global classification from due-date math iff the
    // boss didn't manually pick one during the draft phase. 加急 is never
    // auto — escalation is always a human gesture. Mirrors
    // inferJobTypeFromDueDate() in lib/data.ts.
    const update: AnyRow = { status: 'ready' }
    const existingType = (jobRow?.job_type as string | null) ?? null
    const dueDate = (jobRow?.due_date as string | null) ?? null
    if (!existingType && dueDate) {
      const today = new Date().toISOString().slice(0, 10)
      const days =
        Math.round(
          (Date.parse(dueDate + 'T00:00:00Z') -
            Date.parse(today + 'T00:00:00Z')) /
            86_400_000,
        )
      update.job_type = days <= 7 ? 'short' : days <= 30 ? 'medium' : 'long'
    }
    const { error } = await supabase
      .from('jobs')
      .update(update)
      .eq('id', jobId)
      .eq('status', 'draft')
    if (error) throw error
  })
}

export async function deleteJob(jobId: string): Promise<void> {
  await withWriteLock(async () => {
    const { error } = await supabase.from('jobs').delete().eq('id', jobId)
    if (error) throw error
  })
}

// Row-level boss pin for the master grid. Independent of setJobStagePin.
// pin=true stamps pinned_at = now() so the most recently starred row floats
// to the top of the pinned bucket; pin=false clears both columns. Safe to
// call repeatedly; idempotent on each side.
export async function setJobPin(
  jobId: string,
  pinned: boolean,
  actor?: string,
): Promise<void> {
  await withWriteLock(async () => {
    const { error } = await supabase
      .from('jobs')
      .update(
        pinned
          ? {
              pinned_at: new Date().toISOString(),
              pinned_by: actor ?? null,
            }
          : { pinned_at: null, pinned_by: null },
      )
      .eq('id', jobId)
    if (error) throw error
  })
}

// Sets the job's global classification (短期/中期/长期/加急) or clears it.
// When promoting to 'rush' we also stamp pinned_at = now() so the rush
// bucket's sub-sort (most-recently-flagged first) lights up the just-clicked
// row at the top of every view — same recency instinct the old star had.
// Demoting away from 'rush' clears pinned_at so the row stops occupying
// rush-bucket sub-sort weight.
export async function setJobType(
  jobId: string,
  jobType: JobType | null,
  actor?: string,
): Promise<void> {
  await withWriteLock(async () => {
    const update: AnyRow = { job_type: jobType }
    if (jobType === 'rush') {
      update.pinned_at = new Date().toISOString()
      update.pinned_by = actor ?? null
    } else {
      update.pinned_at = null
      update.pinned_by = null
    }
    const { error } = await supabase.from('jobs').update(update).eq('id', jobId)
    if (error) throw error
  })
}

// Independent 产品 tag — toggles `is_product` without touching job_type or
// the pin timestamps. The chip popover lets commerce/工程 stack 产品 on top
// of any duration bucket (or no bucket at all).
export async function setJobIsProduct(
  jobId: string,
  isProduct: boolean,
): Promise<void> {
  await withWriteLock(async () => {
    const { error } = await supabase
      .from('jobs')
      .update({ is_product: isProduct })
      .eq('id', jobId)
    if (error) throw error
  })
}

// Independent 暂停 (on-hold) tag — toggles paused_at / pause_reason without
// touching job_type, is_product, or the pin timestamps. Open to anyone logged
// in (the floor flags blockers, not just commerce). Pausing stamps paused_at =
// now() + actor; resuming clears all three. The reason is optional.
//
// Read-modify-write so editing the reason on an already-paused job does NOT
// reset paused_at — the "blocked since" timer must reflect when work actually
// stopped, not when the note was last touched.
export async function setJobPaused(
  jobId: string,
  paused: boolean,
  reason?: string | null,
  actor?: string,
): Promise<void> {
  await withWriteLock(async () => {
    if (!paused) {
      const { error } = await supabase
        .from('jobs')
        .update({ paused_at: null, pause_reason: null, paused_by: null })
        .eq('id', jobId)
      if (error) throw error
      return
    }
    const { data: cur, error: readErr } = await supabase
      .from('jobs')
      .select('paused_at')
      .eq('id', jobId)
      .single()
    if (readErr) throw readErr
    const update: AnyRow = { pause_reason: reason ?? null }
    // Only stamp the anchor when the job wasn't already paused.
    if (!cur?.paused_at) {
      update.paused_at = new Date().toISOString()
      update.paused_by = actor ?? null
    }
    const { error } = await supabase.from('jobs').update(update).eq('id', jobId)
    if (error) throw error
  })
}

// Boss's per-station star/unstar toggle. Idempotent — upserts on pin=true,
// deletes on pin=false. No-op if the requested state already matches.
// Foreign key `on delete cascade` from jobs handles automatic cleanup when
// a job is deleted; the pin row otherwise persists across days until the
// boss explicitly unstars it.
export async function setJobStagePin(
  jobId: string,
  stage: Stage,
  pinned: boolean,
  actor?: string,
): Promise<void> {
  await withWriteLock(async () => {
    if (pinned) {
      const { error } = await supabase
        .from('job_stage_pins')
        .upsert(
          {
            job_id: jobId,
            stage,
            pinned_at: new Date().toISOString(),
            pinned_by: actor ?? null,
          },
          { onConflict: 'job_id,stage' },
        )
      if (error) throw error
    } else {
      const { error } = await supabase
        .from('job_stage_pins')
        .delete()
        .eq('job_id', jobId)
        .eq('stage', stage)
      if (error) throw error
    }
  })
}

export async function resetDb(): Promise<void> {
  await withWriteLock(async () => {
    const a = await supabase.from('jobs').delete().neq('id', '__none__')
    if (a.error) throw a.error
    // outsource_blocks have no job FK (they attach to a job only via member
    // parts), so deleting jobs leaves block rows behind — and they still
    // reference vendors. Clear them before vendors or the vendor delete trips
    // outsource_blocks_vendor_id_fkey.
    const ab = await supabase.from('outsource_blocks').delete().neq('id', '__none__')
    if (ab.error) throw ab.error
    const b = await supabase.from('vendors').delete().neq('id', '__none__')
    if (b.error) throw b.error
    const c = await supabase.from('customers').delete().neq('id', '__none__')
    if (c.error) throw c.error
    seedingPromise = null
    await ensureSeeded()
  })
}

// Default route for a fresh part — every NON-opt-in stage is seeded as
// pending, and 商务/工程 toggle from there via the chip widget. 采购/表处
// are opt-in (lib/data OPT_IN_STAGES): most parts never buy material or
// leave for surface treatment, so their columns rest as n/a slashes until
// 工程 switches them on per part.
export const DEFAULT_NEW_PART_STAGES: Stage[] = [...DEFAULT_ROUTE_STAGES]

// Sanitize an incoming stage list: dedupe, force 出货 in (every part ships),
// and return them in canonical STAGES order so writes are deterministic. An
// empty/missing list falls back to DEFAULT_NEW_PART_STAGES.
function resolvePartStages(input: Stage[] | undefined): Stage[] {
  const set = new Set<Stage>()
  if (input && input.length > 0) {
    for (const s of input) {
      if ((STAGES as readonly Stage[]).includes(s)) set.add(s)
    }
  }
  if (set.size === 0) {
    for (const s of DEFAULT_NEW_PART_STAGES) set.add(s)
  }
  set.add('出货')
  return STAGES.filter((s) => set.has(s))
}

export type NewJobInput = {
  jobNo: string
  customer: string
  product: string
  amountCny?: number
  dueDate: string
  notes?: string
  engineer?: string
  sourceFile?: string
  components: {
    name: string
    qty: number
    material?: string
    surfaceTreatment?: string
    notes?: string
    stages?: Stage[]
    unitPriceCny?: number
    lineTotalCny?: number
    imageUrl?: string
    partNo?: string
    process?: string
  }[]
}

export async function createJob(input: NewJobInput): Promise<Job> {
  return withWriteLock(async () => {
    await ensureSeeded()
    const id = uid('J')
    const { data: maxR, error: maxE } = await supabase
      .from('jobs')
      .select('position')
      .order('position', { ascending: false })
      .limit(1)
    if (maxE) throw maxE
    const maxPos =
      maxR && maxR.length > 0 ? Number(maxR[0].position ?? -1) : -1
    const jobRow: JobRow = {
      id,
      jobNo: input.jobNo,
      customer: input.customer,
      product: input.product,
      amountCny: input.amountCny,
      dueDate: input.dueDate,
      notes: input.notes,
      engineer: input.engineer,
      status: 'draft',
      sourceFile: input.sourceFile,
      createdAt: new Date().toISOString(),
      position: maxPos + 1,
    }
    const partRows: PartRow[] = []
    const stageRows: PartStageRow[] = []
    input.components.forEach((c, i) => {
      const partId = `${id}:p${i + 1}`
      partRows.push({
        id: partId,
        jobId: id,
        position: i,
        name: c.name,
        qty: c.qty,
        material: c.material,
        surfaceTreatment: c.surfaceTreatment,
        notes: c.notes,
        unitPriceCny: c.unitPriceCny,
        lineTotalCny: c.lineTotalCny,
        imageUrl: c.imageUrl,
        partNo: c.partNo,
        process: c.process,
      })
      // Same default-route invariant as fillParsedJob — see comment there.
      for (const stage of DEFAULT_NEW_PART_STAGES) {
        stageRows.push({
          id: `${partId}:${stage}`,
          partId,
          stage,
          status: 'pending',
        })
      }
    })
    const j = await supabase.from('jobs').insert(toJob(jobRow))
    if (j.error) throw j.error
    if (partRows.length) {
      const r = await supabase.from('parts').insert(partRows.map(toPart))
      if (r.error) throw r.error
    }
    if (stageRows.length) {
      const r = await supabase.from('part_stages').insert(stageRows.map(toPartStage))
      if (r.error) throw r.error
    }
    const snap = await loadJobSnapshot(id)
    const job = snap.idx.jobById.get(id)!
    return composeJob(job, snap)
  })
}

// === Station queues ===

export type StationItem = {
  jobId: string
  jobNo: string
  customer: string
  product: string
  componentId: string
  componentName: string
  qty: number
  dueDate: string
  componentNote?: string
  jobNote?: string
  status: StageStatus
  completedAt?: string
  completedBy?: string
}

// A stage is effectively "done" for queueing purposes if either the in-house
// status is done, or this part has fully returned from a block covering it.
// While any unit of the part is still at the vendor (returnedQty < qty), the
// vendor stage is not yet done — partial returns don't unblock downstream
// stages. 出货 is always in-house — block coverage of 出货 is ignored.
// A stage that isn't in the part's route is treated as already-done (it never
// has to happen, so it never blocks downstream stages).
function stageEffectivelyDone(c: Component, stage: Stage): boolean {
  const st = c.stages[stage]
  if (!st) return true
  if (stage === '出货') return st.status === 'done'
  const blocks = c.outsourceBlocks ?? []
  for (const b of blocks) {
    if (!b.stages.includes(stage)) continue
    const m = b.members.find((x) => x.componentId === c.id)
    if (!m) continue
    return isMemberFullyReturned(m)
  }
  return st.status === 'done'
}

function priorStagesAllDone(c: Component, stage: Stage): boolean {
  const idx = STAGES.indexOf(stage)
  for (let i = 0; i < idx; i++) {
    if (!stageEffectivelyDone(c, STAGES[i])) return false
  }
  return true
}

export async function getStationQueue(stage: Stage): Promise<StationItem[]> {
  const jobs = await getJobs()
  const items: StationItem[] = []
  for (const job of jobs) {
    if (job.status && job.status !== 'ready') continue
    for (const c of job.components) {
      const blocks = c.outsourceBlocks ?? []
      // Per-part: this part is still at the vendor if any block where it's a
      // member is not yet fully returned (returnedQty < qty). Partial returns
      // keep the part "at vendor" for queueing — workers shouldn't pull a
      // half-returned part from the queue and split the receive book.
      const stillAtVendor = blocks.some((b) => {
        const m = b.members.find((x) => x.componentId === c.id)
        return m !== undefined && !isMemberFullyReturned(m)
      })
      if (stillAtVendor) continue
      // Stage covered by a block this part has already returned from → vendor
      // already did it; don't re-surface the part for that station. 出货
      // always remains in-house, so coverage of 出货 is ignored (the part
      // just came back from outsource and now needs to be shipped to the
      // customer).
      if (
        stage !== '出货' &&
        blocks.some((b) => {
          if (!b.stages.includes(stage)) return false
          const m = b.members.find((x) => x.componentId === c.id)
          return m !== undefined && isMemberFullyReturned(m)
        })
      ) {
        continue
      }
      // Stage not in this part's route — never queue at this station.
      const cur = c.stages[stage]
      if (!cur) continue
      // Sequential flow: only surface a part once every earlier stage is
      // effectively done. While 喷漆 is still pending or in_progress the part
      // stays out of 丝印's queue; once 喷漆 is finished it appears here as
      // a fresh pending item ready to begin.
      if (!priorStagesAllDone(c, stage)) continue
      items.push({
        jobId: job.id,
        jobNo: job.jobNo,
        customer: job.customer,
        product: job.product,
        componentId: c.id,
        componentName: c.name,
        qty: c.qty,
        dueDate: job.dueDate,
        componentNote: c.notes,
        jobNote: job.notes,
        status: cur.status,
        completedAt: cur.completedAt,
        completedBy: cur.by,
      })
    }
  }
  const rank: Record<StageStatus, number> = { in_progress: 0, pending: 1, done: 2 }
  items.sort((a, b) => {
    const ra = rank[a.status]
    const rb = rank[b.status]
    if (ra !== rb) return ra - rb
    if (a.status === 'done') {
      return (b.completedAt ?? '').localeCompare(a.completedAt ?? '')
    }
    return a.dueDate.localeCompare(b.dueDate)
  })
  return items
}

export type StationJob = {
  jobId: string
  jobNo: string
  customer: string
  product: string
  dueDate: string
  jobNote?: string
  total: number
  inProgress: number
  pending: number
  done: number
  rowStatus: 'in_progress' | 'pending' | 'done'
  latestCompletedAt?: string
}

export async function getStationJobs(stage: Stage): Promise<StationJob[]> {
  const items = await getStationQueue(stage)
  const map = new Map<string, StationJob>()
  for (const it of items) {
    let j = map.get(it.jobId)
    if (!j) {
      j = {
        jobId: it.jobId,
        jobNo: it.jobNo,
        customer: it.customer,
        product: it.product,
        dueDate: it.dueDate,
        jobNote: it.jobNote,
        total: 0,
        inProgress: 0,
        pending: 0,
        done: 0,
        rowStatus: 'done',
      }
      map.set(it.jobId, j)
    }
    j.total++
    if (it.status === 'in_progress') j.inProgress++
    else if (it.status === 'pending') j.pending++
    else {
      j.done++
      if (it.completedAt && (!j.latestCompletedAt || it.completedAt > j.latestCompletedAt)) {
        j.latestCompletedAt = it.completedAt
      }
    }
  }
  for (const j of map.values()) {
    j.rowStatus = j.inProgress > 0 ? 'in_progress' : j.pending > 0 ? 'pending' : 'done'
  }
  const arr = Array.from(map.values())
  const rowRank = { in_progress: 0, pending: 1, done: 2 } as const
  arr.sort((a, b) => {
    const r = rowRank[a.rowStatus] - rowRank[b.rowStatus]
    if (r !== 0) return r
    if (a.rowStatus === 'done') {
      return (b.latestCompletedAt ?? '').localeCompare(a.latestCompletedAt ?? '')
    }
    return a.dueDate.localeCompare(b.dueDate)
  })
  return arr
}

// === Vendors ===

export async function getVendors(): Promise<Vendor[]> {
  await ensureSeeded()
  const { data, error } = await supabase.from('vendors').select('*')
  if (error) throw error
  return (data ?? []).map(fromVendor).map((v) => ({
    id: v.id,
    name: v.name,
    notes: v.notes,
    address: v.address,
    portalToken: v.portalToken,
  }))
}

// === 外协厂商门户 (vendor portal, /w/<token>) ===
//
// One stable unguessable token per vendor. The 外协台 mints tokens lazily on
// render (ensureVendorPortalTokens); the public portal resolves them back to
// a vendor with getVendorByPortalToken. Vendor-reported state writes go
// through setBlockVendorState, which scopes every UPDATE by vendor_id so a
// leaked token can never touch another vendor's blocks.

// Mint portal tokens for any vendor that doesn't have one yet. Runs on the
// 外协台 page load — 43 vendors today, one UPDATE each the first time, then
// no-ops forever. Race-safe: the guarded `is('portal_token', null)` update
// means concurrent renders can't double-mint; we re-read the row afterwards
// so whichever token won is the one we hand back. On a pre-migration DB
// (column missing) this swallows the error and returns vendors unchanged, so
// the 外协台 still renders — the share buttons just stay hidden.
export async function ensureVendorPortalTokens(
  vendors: Vendor[],
): Promise<Vendor[]> {
  const missing = vendors.filter((v) => !v.portalToken)
  if (missing.length === 0) return vendors
  const minted = new Map<string, string>()
  try {
    for (const v of missing) {
      const token = crypto.randomUUID().replace(/-/g, '')
      const upd = await supabase
        .from('vendors')
        .update({ portal_token: token })
        .eq('id', v.id)
        .is('portal_token', null)
      if (upd.error) throw upd.error
      const sel = await supabase
        .from('vendors')
        .select('portal_token')
        .eq('id', v.id)
        .limit(1)
      if (sel.error) throw sel.error
      const won = (sel.data?.[0]?.portal_token as string | null) ?? undefined
      if (won) minted.set(v.id, won)
    }
  } catch {
    return vendors
  }
  return vendors.map((v) =>
    v.portalToken ? v : { ...v, portalToken: minted.get(v.id) },
  )
}

export async function getVendorByPortalToken(
  token: string,
): Promise<Vendor | undefined> {
  const t = token.trim()
  // Tokens are 32-hex UUIDs; anything shorter is junk — refuse early so a
  // scanner probing /w/x doesn't cost a DB roundtrip per guess shape.
  if (!/^[0-9a-f]{32}$/i.test(t)) return undefined
  const { data, error } = await supabase
    .from('vendors')
    .select('*')
    .eq('portal_token', t)
    .limit(1)
  if (error) throw error
  const r = data?.[0]
  if (!r) return undefined
  const v = fromVendor(r)
  return {
    id: v.id,
    name: v.name,
    notes: v.notes,
    address: v.address,
    portalToken: v.portalToken,
  }
}

// Every outsource block ever sent to this vendor, composed to the same
// OutsourceBlock shape the 外协台 uses — but deliberately WITHOUT the owning
// job's customer/product/jobNo. The vendor sees their own work (parts,
// photos, quantities, dates, their prices) and nothing about whose end
// customer it is.
export async function getVendorPortalBlocks(
  vendorId: string,
): Promise<OutsourceBlock[]> {
  const PAGE = 1000
  const blocksRows: AnyRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('outsource_blocks')
      .select('*')
      .eq('vendor_id', vendorId)
      .range(from, from + PAGE - 1)
    if (error) throw error
    blocksRows.push(...((data ?? []) as AnyRow[]))
    if (!data || data.length < PAGE) break
  }
  if (blocksRows.length === 0) return []

  const blockIds = blocksRows.map((b) => b.id as string)
  const blockPartsRows = (await selectAllIn(
    'outsource_block_parts',
    'block_id',
    blockIds,
  )) as AnyRow[]
  const partIds = Array.from(
    new Set(blockPartsRows.map((bp) => bp.part_id as string)),
  )
  const partsRows = (await selectAllIn('parts', 'id', partIds)) as AnyRow[]
  const partById = new Map<string, AnyRow>()
  for (const p of partsRows) partById.set(p.id as string, p)
  const blockPartsByBlock = new Map<string, AnyRow[]>()
  for (const bp of blockPartsRows) {
    const arr = blockPartsByBlock.get(bp.block_id as string) ?? []
    arr.push(bp)
    blockPartsByBlock.set(bp.block_id as string, arr)
  }

  return blocksRows.map((b) => {
    const members = (blockPartsByBlock.get(b.id as string) ?? [])
      .slice()
      .sort((a, c) => Number(a.position ?? 0) - Number(c.position ?? 0))
      .map((bp) => {
        const part = partById.get(bp.part_id as string)
        const pid = (bp.part_id as string) ?? ''
        const componentId = part
          ? (part.id as string).split(':').slice(1).join(':') || (part.id as string)
          : `__orphan__:${pid}`
        return {
          componentId,
          name: part ? ((part.name as string) ?? '') : '零件',
          qty:
            bp.qty != null
              ? Number(bp.qty)
              : part
                ? Number(part.qty ?? 0)
                : 0,
          material: part ? ((part.material as string | null) ?? undefined) : undefined,
          imageUrl: part ? ((part.image_url as string | null) ?? undefined) : undefined,
          returnedQty: bp.returned_qty == null ? 0 : Number(bp.returned_qty),
          returnedAt: (bp.returned_at as string | null) ?? undefined,
          unitPriceCny:
            bp.unit_price_cny == null ? undefined : Number(bp.unit_price_cny),
        }
      })
    const block = fromBlock(b)
    return { ...block, members }
  })
}

// Stamp "the vendor's portal rendered these open blocks just now" — the 已读
// signal the 外协台 shows. Only the open blocks the page actually displayed;
// archived history doesn't need read-receipts.
export async function stampVendorBlocksSeen(
  vendorId: string,
  blockIds: string[],
): Promise<void> {
  if (blockIds.length === 0) return
  const now = new Date().toISOString()
  const CHUNK = 100
  for (let i = 0; i < blockIds.length; i += CHUNK) {
    const { error } = await supabase
      .from('outsource_blocks')
      .update({ vendor_seen_at: now })
      .eq('vendor_id', vendorId)
      .in('id', blockIds.slice(i, i + CHUNK))
    if (error) throw error
  }
}

// Stamp "the 外协员 copied the WeChat message for this dispatch" (0077).
// Best-effort: on a pre-migration DB the column is missing — swallow the
// error so the copy itself (the thing she actually cares about) never fails.
export async function stampBlockWechatSent(blockId: string): Promise<void> {
  try {
    await supabase
      .from('outsource_blocks')
      .update({ wechat_sent_at: new Date().toISOString() })
      .eq('id', blockId)
  } catch {
    // pre-0077 DB — the 待发微信 cell just stays derived from vendor_seen_at
  }
}

export type VendorBlockStatePatch = {
  // true → stamp now(); false → clear. Undefined leaves the field alone.
  acked?: boolean
  shipped?: boolean
  // 'YYYY-MM-DD' promise, or null to clear (back to 按期).
  promisedDate?: string | null
  delayReason?: string | null
}

// The ONLY write path for vendor_* columns. Scoped by vendor_id in the WHERE
// so a request can never state-stamp a block belonging to a different vendor,
// even if it guesses block ids.
export async function setBlockVendorState(
  vendorId: string,
  blockId: string,
  patch: VendorBlockStatePatch,
): Promise<void> {
  const update: AnyRow = {}
  const now = new Date().toISOString()
  if (patch.acked !== undefined) update.vendor_ack_at = patch.acked ? now : null
  if (patch.shipped !== undefined)
    update.vendor_shipped_at = patch.shipped ? now : null
  if (patch.promisedDate !== undefined)
    update.vendor_promised_date = patch.promisedDate
  if (patch.delayReason !== undefined) {
    const trimmed = patch.delayReason?.trim()
    update.vendor_delay_reason = trimmed ? trimmed : null
  }
  if (Object.keys(update).length === 0) return
  const { error } = await supabase
    .from('outsource_blocks')
    .update(update)
    .eq('id', blockId)
    .eq('vendor_id', vendorId)
  if (error) throw error
}

export async function createVendor(input: {
  name: string
  notes?: string
  address?: string
}): Promise<Vendor | undefined> {
  return withWriteLock(async () => {
    await ensureSeeded()
    const name = input.name.trim()
    if (!name) return undefined
    const { data: existing, error: exE } = await supabase
      .from('vendors')
      .select('*')
      .ilike('name', name)
    if (exE) throw exE
    const match = (existing ?? []).find(
      (v) => (v.name as string).trim().toLowerCase() === name.toLowerCase(),
    )
    if (match) {
      const v = fromVendor(match)
      return { id: v.id, name: v.name, notes: v.notes, address: v.address }
    }
    const row: VendorRow = {
      id: uid('v'),
      name,
      notes: input.notes?.trim() || undefined,
      address: input.address?.trim() || undefined,
    }
    const { error } = await supabase.from('vendors').insert(toVendor(row))
    if (error) throw error
    return {
      id: row.id,
      name: row.name,
      notes: row.notes,
      address: row.address,
    }
  })
}

export type VendorPatch = {
  name?: string
  notes?: string | null
  address?: string | null
}

export async function updateVendor(
  vendorId: VendorId,
  patch: VendorPatch,
): Promise<void> {
  await withWriteLock(async () => {
    const update: AnyRow = {}
    if (patch.name !== undefined) update.name = patch.name
    if (patch.notes !== undefined) update.notes = patch.notes
    if (patch.address !== undefined) update.address = patch.address
    if (Object.keys(update).length === 0) return
    const { error } = await supabase
      .from('vendors')
      .update(update)
      .eq('id', vendorId)
    if (error) throw error
  })
}

// === Customers ===

export async function getCustomers(): Promise<Customer[]> {
  await ensureSeeded()
  const { data, error } = await supabase.from('customers').select('*')
  if (error) throw error
  return (data ?? []).map(fromCustomer).map((c) => ({
    id: c.id,
    name: c.name,
    contact: c.contact,
    address: c.address,
    phone: c.phone,
  }))
}

export type CustomerPatch = {
  name?: string
  contact?: string | null
  address?: string | null
  phone?: string | null
}

export async function updateCustomer(
  customerId: CustomerId,
  patch: CustomerPatch,
): Promise<void> {
  await withWriteLock(async () => {
    const update: AnyRow = {}
    if (patch.name !== undefined) update.name = patch.name
    if (patch.contact !== undefined) update.contact = patch.contact
    if (patch.address !== undefined) update.address = patch.address
    if (patch.phone !== undefined) update.phone = patch.phone
    if (Object.keys(update).length === 0) return
    const { error } = await supabase
      .from('customers')
      .update(update)
      .eq('id', customerId)
    if (error) throw error
  })
}

// Resolve a typed-or-picked name to a customer row, creating one if absent.
// Case-insensitive name match means "傅" and "傅 " both land on the same row.
export async function upsertCustomerByName(
  rawName: string,
): Promise<Customer | undefined> {
  return withWriteLock(async () => {
    await ensureSeeded()
    const name = rawName.trim()
    if (!name) return undefined
    const { data: existing, error: exE } = await supabase
      .from('customers')
      .select('*')
      .ilike('name', name)
    if (exE) throw exE
    const match = (existing ?? []).find(
      (c) => (c.name as string).trim().toLowerCase() === name.toLowerCase(),
    )
    if (match) {
      const c = fromCustomer(match)
      return { id: c.id, name: c.name, contact: c.contact, address: c.address, phone: c.phone }
    }
    const row: CustomerRow = { id: uid('c'), name }
    const { error } = await supabase.from('customers').insert(toCustomer(row))
    if (error) throw error
    return { id: row.id, name: row.name }
  })
}

// === Outsource blocks ===

export type NewBlockInput = {
  vendorId: VendorId
  // Named activity (外发氧化, 外发CNC, …). Optional on the wire so legacy
  // callers don't break — the form passes it on every new block.
  activity?: string
  stages: Stage[]
  // Null on rush creates — commerce backfills via updateOutsourceBlock once
  // the vendor confirms the quote.
  amountCny: number | null
  sentDate: string
  expectedReturn: string
  notes?: string
  isRush?: boolean
  // Per-member vendor unit prices, keyed by the same componentId strings
  // passed in `componentIds`. Missing keys (or null values) mean "no price
  // yet" — the PDF prints a dash and the line total is hidden until set.
  unitPricesCny?: Record<string, number | null>
  // Per-member outsource quantity, keyed by componentId. Missing keys mean
  // "send all" (inherit parts.qty). A positive integer is the explicit count
  // the boss chose to send to the vendor for that part.
  qtysByComponent?: Record<string, number | null>
  // Confirm-through for the open-overlap warning: true = the operator saw
  // "零件 X 的 {stage} 仍在外协中" and chose to dispatch anyway (split
  // quantities across vendors are a real case).
  force?: boolean
}

// One part-stage that is still out at a vendor and would be covered again by
// the new/edited block. vendorId (not name) — every caller already holds the
// vendors list.
export type BlockOverlapConflict = {
  componentId: string
  name: string
  stages: Stage[]
  vendorId: VendorId
}

export type CreateBlockResult =
  | { ok: true; id: string; docNo?: string }
  | { ok: false; reason: 'overlap'; conflicts: BlockOverlapConflict[] }
  | { ok: false; reason: 'invalid' }

// 外协单号: `{jobNo}-WF-{NN}` — derived from the 销售单号 so finance can join
// outsource spend back to the order in any export, with a -WF-01/-WF-02
// suffix per dispatch (the numbering the boss asked for verbatim). Max-scan
// over live sibling doc_nos; legacy `{jobNo}-{N}` and daily-counter numbers
// simply don't match the pattern and are ignored.
function nextWfDocNo(jobNo: string, existingDocNos: (string | undefined)[]): string {
  const prefix = `${jobNo}-WF-`
  let max = 0
  for (const dn of existingDocNos) {
    if (!dn || !dn.startsWith(prefix)) continue
    const n = Number.parseInt(dn.slice(prefix.length), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(2, '0')}`
}

// The open-overlap check shared by create / stage-edit / add-members: for
// each candidate part, find stages that are covered by ANOTHER block whose
// member hasn't fully returned. Closed coverage never blocks — re-outsourcing
// a returned stage (rework, second batch) is legitimate, and the open block
// wins in effectiveStageState so the cell flips back to 外协 correctly.
function openOverlapConflicts(
  snap: DbSnapshot,
  partIds: string[],
  stages: Stage[],
  excludeBlockId?: string,
): BlockOverlapConflict[] {
  const conflicts: BlockOverlapConflict[] = []
  for (const partId of partIds) {
    const part = snap.idx.partById.get(partId)
    if (!part) continue
    const overlap = new Set<Stage>()
    let vendorId: VendorId | undefined
    for (const b of partBlocksInSnap(snap, partId)) {
      if (excludeBlockId && b.id === excludeBlockId) continue
      const shared = b.stages.filter((s) => stages.includes(s))
      if (shared.length === 0) continue
      const bp = (snap.idx.blockPartsByBlock.get(b.id) ?? []).find(
        (x) => x.partId === partId,
      )
      if (!bp) continue
      const memberQty = bp.qty ?? part.qty
      const open = (bp.returnedQty ?? 0) < memberQty
      if (!open) continue
      for (const s of shared) overlap.add(s)
      vendorId = vendorId ?? b.vendorId
    }
    if (overlap.size > 0 && vendorId) {
      conflicts.push({
        componentId: part.id.split(':').slice(1).join(':') || part.id,
        name: part.name,
        stages: STAGES.filter((s) => overlap.has(s)),
        vendorId,
      })
    }
  }
  return conflicts
}

// Insert pending part_stages rows for covered stages missing from a member's
// route. Without this a block stage that isn't in the route renders n/a and
// the vendor coverage is invisible — the rigid range picker used to mask
// this; free multi-select exposes it. Same upsert+ignoreDuplicates posture
// as setPartRoute's add path.
async function ensureStageRowsForParts(
  snap: DbSnapshot,
  partIds: string[],
  stages: Stage[],
): Promise<void> {
  const rows: PartStageRow[] = []
  for (const partId of partIds) {
    for (const s of stages) {
      if (snap.idx.stageByPartStage.get(stageKey(partId, s))) continue
      rows.push({ id: `${partId}:${s}`, partId, stage: s, status: 'pending' })
    }
  }
  if (rows.length === 0) return
  const { error } = await supabase
    .from('part_stages')
    .upsert(rows.map(toPartStage), { onConflict: 'id', ignoreDuplicates: true })
  if (error) throw error
}

export async function createOutsourceBlockAt(
  jobId: string,
  componentIds: string[],
  input: NewBlockInput,
): Promise<CreateBlockResult> {
  return withWriteLock(async () => {
    const invalid = { ok: false, reason: 'invalid' } as const
    if (componentIds.length === 0) return invalid
    if (!input.stages.length) return invalid
    // 工程 is the in-house routing-planning stage and 采购 is buying, not
    // vendor work — neither ever belongs to a block. Reject up front so a
    // stale or hand-crafted client can't sneak them through.
    if (input.stages.includes('工程') || input.stages.includes('采购'))
      return invalid
    // Stage sets are free-form now (the 从/到 range was a form affordance the
    // floor found too rigid) — just dedupe and order canonically.
    const indexSet = new Set(input.stages.map((s) => STAGES.indexOf(s)).filter((i) => i >= 0))
    const indices = [...indexSet].sort((a, b) => a - b)
    if (indices.length === 0) return invalid
    const orderedStages = indices.map((i) => STAGES[i])
    // Vendor existence is a tiny indexed lookup — no need to drag the whole
    // vendors table through loadJobSnapshot.
    if (!(await vendorExistsByQuery(input.vendorId))) return invalid
    const snap = await loadJobSnapshot(jobId)

    // Resolve every requested component to a part_id in this job, refusing
    // duplicates. Keep the componentId in parallel so we can match it back to
    // a per-member price from input.unitPricesCny.
    const partIds: string[] = []
    const partIdToComponentId = new Map<string, string>()
    for (const componentId of componentIds) {
      const partId = findPartIdInSnap(snap, jobId, componentId)
      if (!partId || partIds.includes(partId)) return invalid
      partIds.push(partId)
      partIdToComponentId.set(partId, componentId)
    }

    // A part can be outsourced any number of times over its life — the only
    // thing worth flagging is units that are STILL OUT for one of the same
    // stages. That's a warn-and-confirm, not a hard block.
    if (!input.force) {
      const conflicts = openOverlapConflicts(snap, partIds, orderedStages)
      if (conflicts.length > 0) {
        return { ok: false, reason: 'overlap', conflicts }
      }
    }

    const id = uid('ob')
    // Allocate the 外协单号 eagerly (not lazily at print time) so the number
    // shows on the row and in exports the moment the block exists.
    const jobNo = snap.jobs[0]?.jobNo?.trim() ?? ''
    const docNo = jobNo
      ? nextWfDocNo(jobNo, snap.outsourceBlocks.map((b) => b.docNo))
      : undefined
    const trimmedActivity = input.activity?.trim()
    const block: OutsourceBlockRow = {
      id,
      vendorId: input.vendorId,
      activity: trimmedActivity ? trimmedActivity : undefined,
      stages: orderedStages,
      amountCny: input.amountCny,
      sentDate: input.sentDate,
      expectedReturn: input.expectedReturn,
      notes: input.notes,
      docNo,
      isRush: input.isRush,
    }
    const r = await supabase.from('outsource_blocks').insert(toBlock(block))
    if (r.error) throw r.error
    const prices = input.unitPricesCny ?? {}
    const qtys = input.qtysByComponent ?? {}
    const partRows: OutsourceBlockPartRow[] = partIds.map((partId, position) => {
      const componentId = partIdToComponentId.get(partId)
      const raw = componentId ? prices[componentId] : undefined
      const unitPriceCny =
        raw != null && Number.isFinite(Number(raw)) && Number(raw) >= 0
          ? Number(raw)
          : undefined
      // Explicit qty only when a positive integer was passed; otherwise leave
      // NULL so the member inherits parts.qty ("send all").
      const rawQty = componentId ? qtys[componentId] : undefined
      const qty =
        rawQty != null && Number.isFinite(Number(rawQty)) && Number(rawQty) >= 1
          ? Math.floor(Number(rawQty))
          : undefined
      return { blockId: id, partId, position, qty, unitPriceCny }
    })
    const r2 = await supabase
      .from('outsource_block_parts')
      .insert(partRows.map(toBlockPart))
    if (r2.error) throw r2.error

    // Pause any in-progress stage on every member that the block now covers.
    const stageUpdates: PartStageRow[] = []
    for (const partId of partIds) {
      for (const s of orderedStages) {
        const row = snap.idx.stageByPartStage.get(stageKey(partId, s))
        if (row && row.status === 'in_progress') {
          stageUpdates.push({
            ...row,
            status: 'pending',
            completedAt: undefined,
            by: undefined,
          })
        }
      }
    }
    await upsertStages(stageUpdates)
    // Covered stages missing from a member's route get pending rows so the
    // vendor coverage is visible (not n/a) in the progress grid.
    await ensureStageRowsForParts(snap, partIds, orderedStages)
    // 商务 just acted on the engineer's 待外协 flag by creating the vendor
    // block — the job moves from 待外协 to 外协中. Consume the pending flag so
    // it drops off the 商务 "待外协" filter and the master-grid badge yields
    // to the existing 外协 (open-block) chip. The note is left intact as
    // historical context.
    await supabase.from('jobs').update({ needs_outsource: false }).eq('id', jobId)
    return { ok: true, id, docNo }
  })
}

// Replace a block's covered stage set after creation — the fix for "选错就
// 只能重新做外协登记". Newly covered stages pause in-flight in-house work and
// get pending route rows (same as create); removed stages need no writes —
// effectiveStageState derives coverage live from block.stages.
export async function setOutsourceBlockStages(
  blockId: string,
  stages: Stage[],
  force?: boolean,
): Promise<CreateBlockResult> {
  return withWriteLock(async () => {
    const invalid = { ok: false, reason: 'invalid' } as const
    if (!stages.length || stages.includes('工程') || stages.includes('采购'))
      return invalid
    const indexSet = new Set(stages.map((s) => STAGES.indexOf(s)).filter((i) => i >= 0))
    const indices = [...indexSet].sort((a, b) => a - b)
    if (indices.length === 0) return invalid
    const orderedStages = indices.map((i) => STAGES[i])

    const jobId = await resolveBlockJobId(blockId)
    if (!jobId) return invalid
    const snap = await loadJobSnapshot(jobId)
    const block = snap.idx.blockById.get(blockId)
    if (!block) return invalid
    const partIds = (snap.idx.blockPartsByBlock.get(blockId) ?? []).map(
      (bp) => bp.partId,
    )

    const added = orderedStages.filter((s) => !block.stages.includes(s))
    if (!force && added.length > 0) {
      const conflicts = openOverlapConflicts(snap, partIds, added, blockId)
      if (conflicts.length > 0) {
        return { ok: false, reason: 'overlap', conflicts }
      }
    }

    const { error } = await supabase
      .from('outsource_blocks')
      .update({ stages: orderedStages })
      .eq('id', blockId)
    if (error) throw error

    if (added.length > 0) {
      const stageUpdates: PartStageRow[] = []
      for (const partId of partIds) {
        for (const s of added) {
          const row = snap.idx.stageByPartStage.get(stageKey(partId, s))
          if (row && row.status === 'in_progress') {
            stageUpdates.push({
              ...row,
              status: 'pending',
              completedAt: undefined,
              by: undefined,
            })
          }
        }
      }
      await upsertStages(stageUpdates)
      await ensureStageRowsForParts(snap, partIds, added)
    }
    return { ok: true, id: blockId, docNo: block.docNo }
  })
}

export type AddBlockMemberInput = {
  componentId: string
  // Explicit outsource qty (positive int) or undefined = send all.
  qty?: number
  unitPriceCny?: number
}

// Add parts to an existing block — the "遇到多件" fix: the operator who
// forgot a part no longer deletes and re-registers the whole dispatch.
export async function addOutsourceBlockMembers(
  blockId: string,
  items: AddBlockMemberInput[],
  force?: boolean,
): Promise<CreateBlockResult> {
  return withWriteLock(async () => {
    const invalid = { ok: false, reason: 'invalid' } as const
    if (items.length === 0) return invalid
    const jobId = await resolveBlockJobId(blockId)
    if (!jobId) return invalid
    const snap = await loadJobSnapshot(jobId)
    const block = snap.idx.blockById.get(blockId)
    if (!block) return invalid
    const existing = snap.idx.blockPartsByBlock.get(blockId) ?? []
    const existingPartIds = new Set(existing.map((bp) => bp.partId))

    const resolved: { partId: string; item: AddBlockMemberInput }[] = []
    for (const item of items) {
      const partId = findPartIdInSnap(snap, jobId, item.componentId)
      if (!partId || existingPartIds.has(partId)) return invalid
      if (resolved.some((r) => r.partId === partId)) return invalid
      resolved.push({ partId, item })
    }

    if (!force) {
      const conflicts = openOverlapConflicts(
        snap,
        resolved.map((r) => r.partId),
        block.stages,
        blockId,
      )
      if (conflicts.length > 0) {
        return { ok: false, reason: 'overlap', conflicts }
      }
    }

    let position = existing.reduce((max, bp) => Math.max(max, bp.position), -1) + 1
    const partRows: OutsourceBlockPartRow[] = resolved.map(({ partId, item }) => {
      const qty =
        item.qty != null && Number.isFinite(item.qty) && item.qty >= 1
          ? Math.floor(item.qty)
          : undefined
      const unitPriceCny =
        item.unitPriceCny != null &&
        Number.isFinite(item.unitPriceCny) &&
        item.unitPriceCny >= 0
          ? item.unitPriceCny
          : undefined
      return { blockId, partId, position: position++, qty, unitPriceCny }
    })
    const { error } = await supabase
      .from('outsource_block_parts')
      .insert(partRows.map(toBlockPart))
    if (error) throw error

    const newPartIds = resolved.map((r) => r.partId)
    const stageUpdates: PartStageRow[] = []
    for (const partId of newPartIds) {
      for (const s of block.stages) {
        const row = snap.idx.stageByPartStage.get(stageKey(partId, s))
        if (row && row.status === 'in_progress') {
          stageUpdates.push({
            ...row,
            status: 'pending',
            completedAt: undefined,
            by: undefined,
          })
        }
      }
    }
    await upsertStages(stageUpdates)
    await ensureStageRowsForParts(snap, newPartIds, block.stages)
    return { ok: true, id: blockId, docNo: block.docNo }
  })
}

export type BlockPatch = {
  vendorId?: VendorId
  // null clears the activity back to the derived stage-range fallback;
  // a non-empty string renames it. Empty string is treated as null.
  activity?: string | null
  // null clears the price (returns the block to 待补金额); a number sets/updates it.
  amountCny?: number | null
  sentDate?: string
  expectedReturn?: string
  notes?: string | null
  createdBy?: string | null
  recipientAddress?: string | null
  recipientContactName?: string | null
  recipientContactPhone?: string | null
  // 外协单号. null clears it back to "" so the next view regenerates a fresh
  // jobNo-derived number; a string pins a manual override.
  docNo?: string | null
  isRush?: boolean
}

export async function updateOutsourceBlock(
  blockId: string,
  patch: BlockPatch,
): Promise<void> {
  await withWriteLock(async () => {
    const update: AnyRow = {}
    if (patch.vendorId !== undefined) update.vendor_id = patch.vendorId
    if (patch.activity !== undefined) {
      const trimmed = patch.activity?.trim()
      update.activity = trimmed ? trimmed : null
    }
    if (patch.amountCny !== undefined) update.amount_cny = patch.amountCny
    if (patch.sentDate !== undefined) update.sent_date = patch.sentDate
    if (patch.expectedReturn !== undefined) update.expected_return = patch.expectedReturn
    if (patch.notes !== undefined) update.notes = patch.notes
    if (patch.createdBy !== undefined) update.created_by = patch.createdBy
    if (patch.recipientAddress !== undefined) update.recipient_address = patch.recipientAddress
    if (patch.recipientContactName !== undefined) update.recipient_contact_name = patch.recipientContactName
    if (patch.recipientContactPhone !== undefined) update.recipient_contact_phone = patch.recipientContactPhone
    if (patch.docNo !== undefined) {
      const trimmed = patch.docNo?.trim()
      update.doc_no = trimmed ? trimmed : null
    }
    if (patch.isRush !== undefined) update.is_rush = patch.isRush
    if (Object.keys(update).length === 0) return
    const { error } = await supabase
      .from('outsource_blocks')
      .update(update)
      .eq('id', blockId)
    if (error) throw error
  })
}

// Resolve a UI componentId to the snapshot part_id within a given block.
function resolveBlockMemberPartId(
  snap: DbSnapshot,
  blockId: string,
  componentId: string,
): string | undefined {
  const bps = snap.idx.blockPartsByBlock.get(blockId) ?? []
  for (const bp of bps) {
    const part = snap.idx.partById.get(bp.partId)
    if (!part) continue
    const suffix = part.id.split(':').slice(1).join(':')
    if (part.id === componentId || suffix === componentId) return bp.partId
  }
  return undefined
}

// Set one member's absolute returned quantity. `qty` is the running total
// (e.g. "6 of 11 are now back"), not a delta. Pass 0 to un-return; pass the
// member's qty (or higher; we clamp) to mark fully returned. When qty > 0,
// `date` stamps the latest receive event; when qty = 0, returnedAt is cleared.
// Set the per-unit vendor price for one member of an outsource block.
// Pass null to clear (returns the line to "—" on the PDF). The block's
// own amount_cny is untouched — that's the manually-entered grand
// total, kept independent so commerce can override the line-subtotal
// rollup if needed.
export async function setBlockMemberUnitPrice(
  blockId: string,
  componentId: string,
  unitPriceCny: number | null,
): Promise<void> {
  await withWriteLock(async () => {
    const jobId = await resolveBlockJobId(blockId)
    if (!jobId) return
    const snap = await loadJobSnapshot(jobId)
    if (!snap.idx.blockById.get(blockId)) return
    const partId = resolveBlockMemberPartId(snap, blockId, componentId)
    if (!partId) return
    const next =
      unitPriceCny == null || !Number.isFinite(unitPriceCny) || unitPriceCny < 0
        ? null
        : unitPriceCny
    const { error } = await supabase
      .from('outsource_block_parts')
      .update({ unit_price_cny: next })
      .eq('block_id', blockId)
      .eq('part_id', partId)
    if (error) throw error
  })
}

// Set the explicit per-member outsource quantity. A positive integer pins the
// count sent to the vendor for this part; null clears it back to "send all"
// (inherit parts.qty). If the new qty is below what's already been received,
// we clamp returned_qty down so the member never reads 已回 8/5 — and if that
// brings it to 0, also clear the returned_at stamp.
export async function setBlockMemberQty(
  blockId: string,
  componentId: string,
  qty: number | null,
): Promise<void> {
  await withWriteLock(async () => {
    const jobId = await resolveBlockJobId(blockId)
    if (!jobId) return
    const snap = await loadJobSnapshot(jobId)
    if (!snap.idx.blockById.get(blockId)) return
    const partId = resolveBlockMemberPartId(snap, blockId, componentId)
    if (!partId) return
    const nextQty =
      qty == null || !Number.isFinite(qty) || qty < 1 ? null : Math.floor(qty)
    const update: {
      qty: number | null
      returned_qty?: number
      returned_at?: string | null
    } = { qty: nextQty }
    // Re-clamp the running return total against the new ceiling.
    if (nextQty != null) {
      const bp = (snap.idx.blockPartsByBlock.get(blockId) ?? []).find(
        (x) => x.partId === partId,
      )
      const returned = bp?.returnedQty ?? 0
      if (returned > nextQty) {
        update.returned_qty = nextQty
        if (nextQty === 0) update.returned_at = null
      }
    }
    const { error } = await supabase
      .from('outsource_block_parts')
      .update(update)
      .eq('block_id', blockId)
      .eq('part_id', partId)
    if (error) throw error
  })
}

export async function setMemberReturnedQty(
  blockId: string,
  componentId: string,
  qty: number,
  date: string | null,
): Promise<void> {
  await withWriteLock(async () => {
    const jobId = await resolveBlockJobId(blockId)
    if (!jobId) return
    const snap = await loadJobSnapshot(jobId)
    const block = snap.idx.blockById.get(blockId)
    if (!block) return
    const partId = resolveBlockMemberPartId(snap, blockId, componentId)
    if (!partId) return
    const part = snap.idx.partById.get(partId)
    // Cap against the EFFECTIVE outsource qty (explicit per-member qty when
    // set, else parts.qty) — never more than what was actually sent out.
    const bp = (snap.idx.blockPartsByBlock.get(blockId) ?? []).find(
      (x) => x.partId === partId,
    )
    const memberQty = bp?.qty != null ? bp.qty : (part?.qty ?? 0)
    const next = Math.max(0, Math.min(memberQty, Math.floor(qty)))
    const update: { returned_qty: number; returned_at: string | null } = {
      returned_qty: next,
      returned_at: next > 0 ? (date ?? today()) : null,
    }
    const { error } = await supabase
      .from('outsource_block_parts')
      .update(update)
      .eq('block_id', blockId)
      .eq('part_id', partId)
    if (error) throw error
  })
}

// Bulk variant for the 收件 button — set absolute returned_qty per member,
// all stamped with the same date. Items list (componentId, qty) pairs in any
// order; missing members are left untouched.
export async function setBlockMembersReturnedQty(
  blockId: string,
  items: { componentId: string; qty: number }[],
  date: string,
): Promise<void> {
  if (items.length === 0) return
  await withWriteLock(async () => {
    const jobId = await resolveBlockJobId(blockId)
    if (!jobId) return
    const snap = await loadJobSnapshot(jobId)
    const block = snap.idx.blockById.get(blockId)
    if (!block) return
    type Update = { partId: string; qty: number }
    const updates: Update[] = []
    for (const it of items) {
      const partId = resolveBlockMemberPartId(snap, blockId, it.componentId)
      if (!partId) continue
      const part = snap.idx.partById.get(partId)
      const bp = (snap.idx.blockPartsByBlock.get(blockId) ?? []).find(
        (x) => x.partId === partId,
      )
      const memberQty = bp?.qty != null ? bp.qty : (part?.qty ?? 0)
      const clamped = Math.max(0, Math.min(memberQty, Math.floor(it.qty)))
      updates.push({ partId, qty: clamped })
    }
    if (updates.length === 0) return
    // Supabase has no easy multi-row "different value per row" update; issue
    // one update per row but inside the same write lock so the snapshot is
    // consistent. The N here is small (one block's members).
    for (const u of updates) {
      const update: { returned_qty: number; returned_at: string | null } = {
        returned_qty: u.qty,
        returned_at: u.qty > 0 ? date : null,
      }
      const { error } = await supabase
        .from('outsource_block_parts')
        .update(update)
        .eq('block_id', blockId)
        .eq('part_id', u.partId)
      if (error) throw error
    }
  })
}

export async function deleteOutsourceBlock(blockId: string): Promise<void> {
  await withWriteLock(async () => {
    const { error } = await supabase.from('outsource_blocks').delete().eq('id', blockId)
    if (error) throw error
  })
}

// Drop one component from a block (撤销 one component, instead of the whole
// 外协 order). If the removed member was the last one in the block, delete
// the block itself — an empty block has no meaning. The caller is responsible
// for any user-facing confirmation; this is a hard delete (no soft state).
export async function removeOutsourceBlockMember(
  blockId: string,
  componentId: string,
): Promise<void> {
  await withWriteLock(async () => {
    const jobId = await resolveBlockJobId(blockId)
    if (!jobId) return
    const snap = await loadJobSnapshot(jobId)
    if (!snap.idx.blockById.get(blockId)) return
    const partId = resolveBlockMemberPartId(snap, blockId, componentId)
    if (!partId) return
    const members = snap.idx.blockPartsByBlock.get(blockId) ?? []
    // If this is the last remaining member, deleting the row would leave an
    // empty block. Cascade up — delete the whole block (which FK-cascades the
    // member row anyway).
    if (members.length <= 1) {
      const { error } = await supabase
        .from('outsource_blocks')
        .delete()
        .eq('id', blockId)
      if (error) throw error
      return
    }
    const { error } = await supabase
      .from('outsource_block_parts')
      .delete()
      .eq('block_id', blockId)
      .eq('part_id', partId)
    if (error) throw error
  })
}

export async function getOutsourceBlock(blockId: string): Promise<
  | {
      jobId: string
      jobNo: string
      customer: string
      product: string
      block: OutsourceBlock
    }
  | undefined
> {
  const jobId = await resolveBlockJobId(blockId)
  if (!jobId) return undefined
  const snap = await loadJobSnapshot(jobId)
  const row = snap.idx.blockById.get(blockId)
  if (!row) return undefined
  const memberPartIds = (snap.idx.blockPartsByBlock.get(blockId) ?? []).map(
    (bp) => bp.partId,
  )
  const firstPart = memberPartIds
    .map((id) => snap.idx.partById.get(id))
    .find((p): p is PartRow => Boolean(p))
  if (!firstPart) return undefined
  const job = snap.idx.jobById.get(firstPart.jobId)
  if (!job) return undefined
  return {
    jobId: job.id,
    jobNo: job.jobNo,
    customer: job.customer,
    product: job.product,
    block: {
      id: row.id,
      vendorId: row.vendorId,
      activity: row.activity,
      stages: row.stages,
      amountCny: row.amountCny,
      sentDate: row.sentDate,
      expectedReturn: row.expectedReturn,
      notes: row.notes,
      docNo: row.docNo,
      createdBy: row.createdBy,
      recipientAddress: row.recipientAddress,
      recipientContactName: row.recipientContactName,
      recipientContactPhone: row.recipientContactPhone,
      isRush: row.isRush,
      members: blockMembers(snap, blockId),
    },
  }
}


// === Doc-number allocator ===
//
// Lazy-allocates a YNMX-yy-m-d-NNN string the first time a doc is rendered.
// NNN is per (kind, day): we look at every existing doc number on that day
// across the relevant table and take max+1. Persisted on the row so re-prints
// stay stable. Cross-instance races are MVP-acceptable (same trade-off as
// withWriteLock above).
async function nextSeqForPrefix(
  table: 'jobs' | 'outsource_blocks' | 'shipments',
  column: 'shipping_doc_no' | 'doc_no',
  prefix: string,
): Promise<number> {
  const { data, error } = await supabase
    .from(table)
    .select(column)
    .like(column, `${prefix}%`)
  if (error) throw error
  let max = 0
  for (const row of data ?? []) {
    const v = (row as AnyRow)[column] as string | null | undefined
    if (!v) continue
    const tail = v.slice(prefix.length)
    const n = Number.parseInt(tail, 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max + 1
}

export async function ensureShippingDocNo(jobId: string): Promise<string> {
  return withWriteLock(async () => {
    const { data, error } = await supabase
      .from('jobs')
      .select('shipping_doc_no')
      .eq('id', jobId)
      .maybeSingle()
    if (error) throw error
    const existing = (data?.shipping_doc_no as string | null) ?? null
    if (existing) return existing
    const now = new Date()
    const prefix = docNoDayPrefix(now)
    const seq = await nextSeqForPrefix('jobs', 'shipping_doc_no', prefix)
    const docNo = formatDocNo(now, seq)
    const upd = await supabase
      .from('jobs')
      .update({ shipping_doc_no: docNo })
      .eq('id', jobId)
    if (upd.error) throw upd.error
    return docNo
  })
}

export async function ensureOutsourceDocNo(blockId: string): Promise<string> {
  return withWriteLock(async () => {
    const { data, error } = await supabase
      .from('outsource_blocks')
      .select('doc_no')
      .eq('id', blockId)
      .maybeSingle()
    if (error) throw error
    const existing = (data?.doc_no as string | null) ?? null
    if (existing) return existing

    // 外协单号 is ported from the owning job's 工号 (the YNMX number, e.g.
    // YNMX-26-4-9-094) as `{jobNo}-WF-{NN}` — see nextWfDocNo. New blocks get
    // this eagerly at create time; this lazy path is the safety net for
    // legacy blocks with NULL doc_no and the "clear to regenerate" flow
    // (BlockPatch.docNo = null). The number is also editable on the 外协单
    // view (manual overrides outside the pattern are simply ignored by the
    // allocator).
    const jobId = await resolveBlockJobId(blockId)
    const snap = jobId ? await loadJobSnapshot(jobId) : null
    const jobNo = snap?.jobs[0]?.jobNo?.trim() ?? ''

    let docNo: string
    if (jobNo && snap) {
      docNo = nextWfDocNo(jobNo, snap.outsourceBlocks.map((b) => b.docNo))
    } else {
      // Free-text / legacy 工号 with no usable number — fall back to the daily
      // YNMX-yy-m-d-NNN counter so the doc still gets a unique number.
      const now = new Date()
      const prefix = docNoDayPrefix(now)
      const seq = await nextSeqForPrefix('outsource_blocks', 'doc_no', prefix)
      docNo = formatDocNo(now, seq)
    }

    const upd = await supabase
      .from('outsource_blocks')
      .update({ doc_no: docNo })
      .eq('id', blockId)
    if (upd.error) throw upd.error
    return docNo
  })
}

// === Users ===

export type Role = 'commerce' | 'production'

export type AppUser = {
  id: string
  name: string
  role: Role
  defaultStage?: Stage
  active: boolean
  // 财务可见性 — gates the 支出/月度 tabs (payroll amounts are sensitive).
  // Pre-migration-0051 DBs omit the column from `select *`, so this reads
  // false until the SQL is applied; the boss row is granted in code
  // regardless (lib/auth canSeeExpenses).
  isFinance: boolean
  createdAt: string
}

type UserRow = AppUser & { pinHash: string }

function fromUser(r: AnyRow): UserRow {
  return {
    id: r.id as string,
    name: r.name as string,
    pinHash: r.pin_hash as string,
    role: r.role as Role,
    defaultStage: (r.default_stage as Stage | null) ?? undefined,
    active: r.active as boolean,
    isFinance: (r.is_finance as boolean | null) ?? false,
    createdAt: r.created_at as string,
  }
}

function toUserRow(r: UserRow): AnyRow {
  return {
    id: r.id,
    name: r.name,
    pin_hash: r.pinHash,
    role: r.role,
    default_stage: r.defaultStage ?? null,
    active: r.active,
  }
}

// The 老板 (boss) account is the single, always-present admin. UI gates
// employee management behind this user's PIN; the row cannot be deactivated
// (see updateUser) and is recreated on demand if missing from the DB. The
// PIN seed comes from BOOTSTRAP_PIN env var on first creation only — once
// the row exists, the boss owns the PIN via /login → 管理员工 → 重置 PIN.
export const BOSS_USER_ID = 'u-bootstrap-commerce'
export const BOSS_NAME = '老板'

// Accounts that hold 老板-level authority: the 管理员工 admin panel, plus the
// same protection the bootstrap 老板 row gets (cannot be deactivated, demoted,
// stripped of 财务, or deleted). BOSS_USER_ID is the singleton bootstrap row
// (self-healed in ensureBootstrapUser, labelled 老板); any additional IDs here
// are individuals promoted to boss powers in code — kept as a reviewable
// constant rather than a silently-toggleable DB flag.
//   u-mosbgpwr-pczcze — Harry (owner)
const ADMIN_USER_IDS = new Set<string>([BOSS_USER_ID, 'u-mosbgpwr-pczcze'])

// True for any account with 老板-level powers (see ADMIN_USER_IDS). Distinct
// from `id === BOSS_USER_ID`, which still uniquely identifies the bootstrap
// row for labelling and self-healing.
export function isAdminUser(id: string): boolean {
  return ADMIN_USER_IDS.has(id)
}

let bootstrapPromise: Promise<void> | null = null

export async function ensureBootstrapUser(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise
  const p = (async () => {
    const { data, error } = await supabase
      .from('users')
      .select('id, active, role, name')
      .eq('id', BOSS_USER_ID)
      .maybeSingle()
    if (error) throw error
    if (data) {
      // Defensive: heal anything that would lock the boss out (deactivated,
      // role accidentally flipped, name drifted from canonical).
      const patch: AnyRow = {}
      if (data.active === false) patch.active = true
      if (data.role !== 'commerce') patch.role = 'commerce'
      if (data.name !== BOSS_NAME) patch.name = BOSS_NAME
      if (Object.keys(patch).length > 0) {
        const { error: upErr } = await supabase
          .from('users')
          .update(patch)
          .eq('id', BOSS_USER_ID)
        if (upErr) throw upErr
      }
      return
    }
    const bcrypt = await import('bcryptjs')
    const pin = process.env.BOOTSTRAP_PIN ?? '0000'
    const pinHash = await bcrypt.hash(pin, 10)
    const row: UserRow = {
      id: BOSS_USER_ID,
      name: BOSS_NAME,
      pinHash,
      role: 'commerce',
      active: true,
      isFinance: true,
      createdAt: new Date().toISOString(),
    }
    const { error: insErr } = await supabase
      .from('users')
      .insert(toUserRow(row))
    // Race: another instance just inserted. Treat as success.
    if (insErr && insErr.code !== '23505') throw insErr
  })()
  bootstrapPromise = p
  try {
    await p
  } catch (e) {
    bootstrapPromise = null
    throw e
  }
}

export async function getBossUser(): Promise<AppUser> {
  await ensureBootstrapUser()
  const u = await getUserById(BOSS_USER_ID)
  if (!u) throw new Error('老板 user missing after ensureBootstrapUser')
  return u
}

export async function getActiveUsers(): Promise<AppUser[]> {
  await ensureBootstrapUser()
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('active', true)
    .order('role', { ascending: true })
    .order('name', { ascending: true })
  if (error) throw error
  return (data ?? []).map(fromUser).map(stripPinHash)
}

export async function getAllUsers(): Promise<AppUser[]> {
  await ensureBootstrapUser()
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .order('active', { ascending: false })
    .order('role', { ascending: true })
    .order('name', { ascending: true })
  if (error) throw error
  return (data ?? []).map(fromUser).map(stripPinHash)
}

function stripPinHash(row: UserRow): AppUser {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    defaultStage: row.defaultStage,
    active: row.active,
    isFinance: row.isFinance,
    createdAt: row.createdAt,
  }
}

export async function getUserById(id: string): Promise<AppUser | null> {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return stripPinHash(fromUser(data as AnyRow))
}

export async function verifyUserPin(id: string, pin: string): Promise<AppUser | null> {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', id)
    .eq('active', true)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const row = fromUser(data as AnyRow)
  const bcrypt = await import('bcryptjs')
  const ok = await bcrypt.compare(pin, row.pinHash)
  if (!ok) return null
  return stripPinHash(row)
}

export type NewUserInput = {
  name: string
  pin: string
  role: Role
  defaultStage?: Stage
}

export async function createUser(input: NewUserInput): Promise<AppUser> {
  return withWriteLock(async () => {
    const name = input.name.trim()
    if (!name) throw new Error('用户姓名不能为空')
    if (!/^\d{4}$/.test(input.pin)) throw new Error('PIN 必须为 4 位数字')
    if (input.role === 'production' && !input.defaultStage) {
      throw new Error('生产用户必须指定工段')
    }
    if (input.role === 'commerce' && input.defaultStage) {
      throw new Error('商务用户不能绑定工段')
    }
    const bcrypt = await import('bcryptjs')
    const pinHash = await bcrypt.hash(input.pin, 10)
    const row: UserRow = {
      id: uid('u'),
      name,
      pinHash,
      role: input.role,
      defaultStage: input.defaultStage,
      active: true,
      isFinance: false,
      createdAt: new Date().toISOString(),
    }
    const { error } = await supabase.from('users').insert(toUserRow(row))
    if (error) throw error
    return stripPinHash(row)
  })
}

export type UserPatch = {
  name?: string
  role?: Role
  defaultStage?: Stage | null
  active?: boolean
  isFinance?: boolean
}

export async function updateUser(id: string, patch: UserPatch): Promise<void> {
  if (isAdminUser(id)) {
    if (patch.active === false) throw new Error('老板账号不可停用')
    if (patch.role !== undefined && patch.role !== 'commerce') {
      throw new Error('老板角色不可更改')
    }
    // The boss qualifies in code anyway (canSeeExpenses), so a stored false
    // would be a confusing no-op — reject it outright.
    if (patch.isFinance === false) throw new Error('老板始终可见财务')
  }
  await withWriteLock(async () => {
    const update: AnyRow = {}
    if (patch.name !== undefined) update.name = patch.name.trim()
    if (patch.role !== undefined) update.role = patch.role
    if (patch.defaultStage !== undefined) {
      update.default_stage = patch.defaultStage
    }
    if (patch.active !== undefined) update.active = patch.active
    if (patch.isFinance !== undefined) update.is_finance = patch.isFinance
    if (Object.keys(update).length === 0) return
    const { error } = await supabase.from('users').update(update).eq('id', id)
    if (error) throw error
  })
}

export async function deleteUser(id: string): Promise<void> {
  if (isAdminUser(id)) throw new Error('老板账号不可删除')
  await withWriteLock(async () => {
    const { error } = await supabase.from('users').delete().eq('id', id)
    if (error) throw error
  })
}

export async function resetUserPin(id: string, pin: string): Promise<void> {
  await withWriteLock(async () => {
    if (!/^\d{4}$/.test(pin)) throw new Error('PIN 必须为 4 位数字')
    const bcrypt = await import('bcryptjs')
    const pinHash = await bcrypt.hash(pin, 10)
    const { error } = await supabase
      .from('users')
      .update({ pin_hash: pinHash })
      .eq('id', id)
    if (error) throw error
  })
}

// === 退货 (returns) ===

const RETURN_REASONS_DB = [
  '尺寸不符',
  '表面瑕疵',
  '装配问题',
  '客户要求修改',
  '其他',
] as const

export type CreateReturnInput = {
  jobId: string
  parts: { componentId: string; qty: number }[]
  reason: ReturnReason
  reasonText?: string
  dueDate: string
  byUserId?: string
}

// Open a return on a shipped job. Re-opens every in-route stage on the named
// parts so the job re-enters the floor at 工程; the 工程 head trims unneeded
// stages via the existing setPartRoute editor. The unique partial index in
// 0011_returns.sql guarantees at most one open return per job — we still
// pre-check for a clean error message.
export async function createReturn(input: CreateReturnInput): Promise<JobReturn> {
  return withWriteLock(async () => {
    if (input.parts.length === 0) throw new Error('请至少选择一个组件')
    for (const p of input.parts) {
      if (!Number.isInteger(p.qty) || p.qty <= 0) {
        throw new Error('退货数量必须为正整数')
      }
    }
    if (!RETURN_REASONS_DB.includes(input.reason)) {
      throw new Error('无效的退货原因')
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) {
      throw new Error('请选择有效的到期日期')
    }
    if (input.dueDate < today()) throw new Error('到期日期不能早于今天')

    const snap = await loadJobSnapshot(input.jobId)
    const jobRow = snap.idx.jobById.get(input.jobId)
    if (!jobRow) throw new Error('工单不存在')
    const job = composeJob(jobRow, snap)
    // jobIsShipped is from data.ts but not imported as value yet — inline.
    const allShipped = job.components.every((c) => {
      const st = c.stages['出货']
      if (!st) return true // 出货 not in route — n/a
      return st.status === 'done'
    })
    if (!allShipped) throw new Error('工单尚未出货,无法退货')
    if (job.activeReturn) throw new Error('该工单已有进行中的退货')

    // Resolve componentId → part_id; reject unknown ids early.
    const resolvedParts: { partId: string; qty: number }[] = []
    for (const p of input.parts) {
      const partId = findPartIdInSnap(snap, input.jobId, p.componentId)
      if (!partId) throw new Error(`组件 ${p.componentId} 不属于该工单`)
      const component = job.components.find((c) => c.id === p.componentId)
      if (!component) throw new Error(`组件 ${p.componentId} 不属于该工单`)
      if (p.qty > component.qty) {
        throw new Error(`${component.name} 退货数量超过原数量`)
      }
      resolvedParts.push({ partId, qty: p.qty })
    }

    const id = uid('r')
    const row: ReturnRow = {
      id,
      jobId: input.jobId,
      reason: input.reason,
      reasonText: input.reasonText?.trim() || undefined,
      dueDate: input.dueDate,
      status: 'open',
      createdAt: new Date().toISOString(),
      createdBy: input.byUserId,
    }
    const { error: insErr } = await supabase
      .from('returns')
      .insert(toReturn(row))
    if (insErr) throw insErr

    const { error: rpErr } = await supabase
      .from('return_parts')
      .insert(
        resolvedParts.map((rp) => ({
          return_id: id,
          part_id: rp.partId,
          qty: rp.qty,
        })),
      )
    if (rpErr) throw rpErr

    // Re-open every in-route stage on the named parts: status → pending,
    // wipe started_at / finished_at / completed_at / by_actor / done_qty so
    // the timeline doesn't carry stale "done" timestamps from the prior pass.
    const partIds = resolvedParts.map((rp) => rp.partId)
    await inChunks(partIds, (chunk) =>
      supabase
        .from('part_stages')
        .update({
          status: 'pending',
          started_at: null,
          finished_at: null,
          completed_at: null,
          by_actor: null,
          started_by_actor: null,
          done_qty: null,
        })
        .in('part_id', chunk),
    )

    return {
      id,
      jobId: input.jobId,
      reason: row.reason,
      reasonText: row.reasonText,
      dueDate: row.dueDate,
      status: row.status,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      parts: input.parts.map((p) => ({ partId: p.componentId, qty: p.qty })),
    }
  })
}

export async function closeReturn(returnId: string): Promise<void> {
  await withWriteLock(async () => {
    const { error } = await supabase
      .from('returns')
      .update({ status: 'closed', closed_at: new Date().toISOString() })
      .eq('id', returnId)
      .eq('status', 'open')
    if (error) throw error
  })
}

// History across one job — every closed return plus the active one (if any).
// Sorted newest-first. Keeps this simple: one query per job.
export async function listJobReturns(jobId: string): Promise<JobReturn[]> {
  const [{ data: rs, error: rErr }, { data: rps, error: rpErr }] =
    await Promise.all([
      supabase
        .from('returns')
        .select('*')
        .eq('job_id', jobId)
        .order('created_at', { ascending: false }),
      supabase
        .from('return_parts')
        .select('*, returns!inner(job_id)')
        .eq('returns.job_id', jobId),
    ])
  if (rErr) throw rErr
  if (rpErr) throw rpErr
  const partsByReturn = new Map<string, { partId: string; qty: number }[]>()
  for (const rp of rps ?? []) {
    const arr = partsByReturn.get(rp.return_id as string) ?? []
    arr.push({
      partId:
        (rp.part_id as string).split(':').slice(1).join(':') ||
        (rp.part_id as string),
      qty: Number(rp.qty),
    })
    partsByReturn.set(rp.return_id as string, arr)
  }
  return (rs ?? []).map((r) => {
    const row = fromReturn(r as AnyRow)
    return {
      id: row.id,
      jobId: row.jobId,
      reason: row.reason,
      reasonText: row.reasonText,
      dueDate: row.dueDate,
      status: row.status,
      createdAt: row.createdAt,
      closedAt: row.closedAt,
      createdBy: row.createdBy,
      parts: partsByReturn.get(row.id) ?? [],
    }
  })
}

// /退货 已完成 tab. Newest-first across all jobs. Joins job_no/customer/product
// in one round-trip so the page renders without a per-row job lookup.
export type ClosedReturnRow = {
  ret: JobReturn
  jobNo: string
  customer: string
  product: string
}

export async function listClosedReturns(): Promise<ClosedReturnRow[]> {
  const [{ data: rs, error: rErr }, { data: rps, error: rpErr }, jobsR] =
    await Promise.all([
      supabase
        .from('returns')
        .select('*')
        .eq('status', 'closed')
        .order('closed_at', { ascending: false, nullsFirst: false }),
      supabase
        .from('return_parts')
        .select('*, returns!inner(status)')
        .eq('returns.status', 'closed'),
      supabase.from('jobs').select('id, job_no, customer, product'),
    ])
  if (rErr) throw rErr
  if (rpErr) throw rpErr
  if (jobsR.error) throw jobsR.error
  const jobsById = new Map<
    string,
    { jobNo: string; customer: string; product: string }
  >()
  for (const j of jobsR.data ?? []) {
    jobsById.set(j.id as string, {
      jobNo: (j.job_no as string) ?? '',
      customer: (j.customer as string) ?? '',
      product: (j.product as string) ?? '',
    })
  }
  const partsByReturn = new Map<string, { partId: string; qty: number }[]>()
  for (const rp of rps ?? []) {
    const arr = partsByReturn.get(rp.return_id as string) ?? []
    arr.push({
      partId:
        (rp.part_id as string).split(':').slice(1).join(':') ||
        (rp.part_id as string),
      qty: Number(rp.qty),
    })
    partsByReturn.set(rp.return_id as string, arr)
  }
  return (rs ?? []).map((r) => {
    const row = fromReturn(r as AnyRow)
    const meta = jobsById.get(row.jobId) ?? {
      jobNo: row.jobId,
      customer: '',
      product: '',
    }
    return {
      ret: {
        id: row.id,
        jobId: row.jobId,
        reason: row.reason,
        reasonText: row.reasonText,
        dueDate: row.dueDate,
        status: row.status,
        createdAt: row.createdAt,
        closedAt: row.closedAt,
        createdBy: row.createdBy,
        parts: partsByReturn.get(row.id) ?? [],
      },
      jobNo: meta.jobNo,
      customer: meta.customer,
      product: meta.product,
    }
  })
}

// =====================================================================
// 工作交接单 — shift/absence handover sheets. See migration 0041 and
// lib/data.ts#Handover for the model. No write lock needed: handovers are
// independent append-only records with no cross-row invariants (unlike jobs,
// whose stage rollups must stay consistent under concurrent station clicks).
// =====================================================================

type HandoverRow = {
  id: string
  giver: string
  department?: string
  handoverDate: string
  reason?: string
  receiver?: string
  createdBy?: string
  createdAt: string
}

function fromHandover(r: AnyRow): HandoverRow {
  return {
    id: r.id as string,
    giver: (r.giver as string | null) ?? '',
    department: (r.department as string | null) ?? undefined,
    handoverDate: r.handover_date as string,
    reason: (r.reason as string | null) ?? undefined,
    receiver: (r.receiver as string | null) ?? undefined,
    createdBy: (r.created_by as string | null) ?? undefined,
    createdAt: r.created_at as string,
  }
}

export type NewHandoverInput = {
  giver: string
  department?: string
  date: string
  reason?: string
  receiver?: string
  items: Array<{
    orderNo?: string
    jobId?: string
    matter?: string
    owner?: string
    note?: string
  }>
}

// Resolve a free-text 单号 to a real job id so the item can link to
// /jobs/[id]. Exact (trimmed) job_no match only — a partial typo shouldn't
// silently bind to the wrong order. Returns null when nothing matches.
async function resolveJobIdByJobNo(jobNo: string): Promise<string | null> {
  const trimmed = jobNo.trim()
  if (!trimmed) return null
  const { data, error } = await supabase
    .from('jobs')
    .select('id')
    .eq('job_no', trimmed)
    .limit(1)
    .maybeSingle()
  if (error) return null
  return (data?.id as string | null) ?? null
}

async function loadHandoverItems(handoverIds: string[]): Promise<Map<string, HandoverItem[]>> {
  const byHandover = new Map<string, HandoverItem[]>()
  if (handoverIds.length === 0) return byHandover
  const rows = await selectAllIn('handover_items', 'handover_id', handoverIds)
  const sorted = [...rows].sort(
    (a, b) => Number(a.position ?? 0) - Number(b.position ?? 0),
  )
  for (const r of sorted) {
    const hid = r.handover_id as string
    const list = byHandover.get(hid) ?? []
    list.push({
      id: r.id as string,
      orderNo: (r.order_no as string | null) ?? undefined,
      jobId: (r.job_id as string | null) ?? undefined,
      matter: (r.matter as string | null) ?? undefined,
      owner: (r.owner as string | null) ?? undefined,
      note: (r.note as string | null) ?? undefined,
    })
    byHandover.set(hid, list)
  }
  return byHandover
}

function composeHandover(row: HandoverRow, items: HandoverItem[]): Handover {
  return {
    id: row.id,
    giver: row.giver,
    department: row.department,
    date: row.handoverDate,
    reason: row.reason,
    receiver: row.receiver,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    items,
  }
}

// All handover sheets, newest first (by 日期, then created_at). The /handover
// tab is a unified feed, so this is an unfiltered read — the dataset is one
// row per absence event, orders of magnitude smaller than jobs.
export async function getHandovers(): Promise<Handover[]> {
  const { data, error } = await supabase
    .from('handovers')
    .select('id, giver, department, handover_date, reason, receiver, created_by, created_at')
    .order('handover_date', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) {
    // Tolerate a pre-migration-0041 DB: the tab renders empty instead of 500.
    if (isMissingTableError(error)) return []
    throw error
  }
  const rows = (data ?? []).map(fromHandover)
  const itemsByHandover = await loadHandoverItems(rows.map((r) => r.id))
  return rows.map((r) => composeHandover(r, itemsByHandover.get(r.id) ?? []))
}

export async function createHandover(
  input: NewHandoverInput,
  createdBy: string,
): Promise<string> {
  const id = uid('ho')
  const { error } = await supabase.from('handovers').insert({
    id,
    giver: input.giver.trim(),
    department: input.department?.trim() || null,
    handover_date: input.date,
    reason: input.reason?.trim() || null,
    receiver: input.receiver?.trim() || null,
    created_by: createdBy,
  })
  if (error) throw error
  await replaceHandoverItems(id, input.items)
  return id
}

export type HandoverPatch = {
  giver?: string
  department?: string | null
  date?: string
  reason?: string | null
  receiver?: string | null
  items?: NewHandoverInput['items']
}

export async function updateHandover(
  handoverId: string,
  patch: HandoverPatch,
): Promise<void> {
  const update: AnyRow = {}
  if (patch.giver !== undefined) update.giver = patch.giver.trim()
  if (patch.department !== undefined)
    update.department = patch.department?.trim() || null
  if (patch.date !== undefined) update.handover_date = patch.date
  if (patch.reason !== undefined) update.reason = patch.reason?.trim() || null
  if (patch.receiver !== undefined)
    update.receiver = patch.receiver?.trim() || null
  if (Object.keys(update).length > 0) {
    const { error } = await supabase
      .from('handovers')
      .update(update)
      .eq('id', handoverId)
    if (error) throw error
  }
  if (patch.items !== undefined) {
    await replaceHandoverItems(handoverId, patch.items)
  }
}

export async function deleteHandover(handoverId: string): Promise<void> {
  // handover_items cascade-delete via the FK (migration 0041).
  const { error } = await supabase
    .from('handovers')
    .delete()
    .eq('id', handoverId)
  if (error) throw error
}

// Full-replace the line items for a sheet: simplest correct semantics for an
// editable form that adds/removes/reorders rows. Empty rows (no order, matter,
// owner, or note) are dropped so a half-filled trailing row never persists.
async function replaceHandoverItems(
  handoverId: string,
  items: NewHandoverInput['items'],
): Promise<void> {
  const del = await supabase
    .from('handover_items')
    .delete()
    .eq('handover_id', handoverId)
  if (del.error) throw del.error
  const rows: AnyRow[] = []
  let position = 0
  for (const it of items) {
    const orderNo = it.orderNo?.trim() || ''
    const matter = it.matter?.trim() || ''
    const owner = it.owner?.trim() || ''
    const note = it.note?.trim() || ''
    if (!orderNo && !matter && !owner && !note) continue
    // Prefer a client-supplied jobId; otherwise try to resolve the 单号.
    let jobId = it.jobId?.trim() || null
    if (!jobId && orderNo) jobId = await resolveJobIdByJobNo(orderNo)
    rows.push({
      id: uid('hoi'),
      handover_id: handoverId,
      position: position++,
      order_no: orderNo || null,
      job_id: jobId,
      matter: matter || null,
      owner: owner || null,
      note: note || null,
    })
  }
  if (rows.length === 0) return
  const { error } = await supabase.from('handover_items').insert(rows)
  if (error) throw error
}

// Lean job-number index for the 工作交接单 单号 autocomplete: id + 工号 +
// 产品 only, newest first, bounded. Avoids dragging the full master rollup
// into the handover page just to resolve order links.
export async function getJobNoIndex(): Promise<
  Array<{ id: string; jobNo: string; product: string }>
> {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, job_no, product')
    .order('created_at', { ascending: false })
    .limit(2000)
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id as string,
    jobNo: (r.job_no as string | null) ?? '',
    product: (r.product as string | null) ?? '',
  }))
}

// === 采购 (procurement ledger) ===

function asNumber(x: unknown): number | undefined {
  if (x === null || x === undefined || x === '') return undefined
  const n = typeof x === 'number' ? x : Number(x)
  return Number.isFinite(n) ? n : undefined
}

const PROCUREMENT_STATUSES: readonly ProcurementStatus[] = [
  'requested',
  'approved',
  'ordered',
  'arrived',
  'done',
  'rejected',
]

function fromProcurement(r: AnyRow): Procurement {
  // Legacy 'pending' (pre-0089 待下单) reads as 'approved' — same meaning.
  const status: ProcurementStatus = (
    PROCUREMENT_STATUSES as readonly string[]
  ).includes(r.status as string)
    ? (r.status as ProcurementStatus)
    : r.status === 'pending'
      ? 'approved'
      : 'ordered'
  return {
    id: r.id as string,
    item: (r.item as string | null) ?? '',
    productId: (r.product_id as string | null) ?? undefined,
    link: (r.link as string | null) ?? undefined,
    qty: asNumber(r.qty),
    unitPriceCny: asNumber(r.unit_price_cny),
    supplier: (r.supplier as string | null) ?? undefined,
    orderDate: r.order_date as string,
    expectedDate: (r.expected_date as string | null) ?? undefined,
    status,
    arrivedDate: (r.arrived_date as string | null) ?? undefined,
    buyer: (r.buyer as string | null) ?? '',
    notes: (r.notes as string | null) ?? undefined,
    jobId: (r.job_id as string | null) ?? undefined,
    jobNo: (r.job_no as string | null) ?? undefined,
    inspectResult:
      r.inspect_result === 'ok' || r.inspect_result === 'defect'
        ? r.inspect_result
        : undefined,
    inspectNote: (r.inspect_note as string | null) ?? undefined,
    requester: (r.requester as string | null) ?? undefined,
    reqDate: (r.req_date as string | null) ?? undefined,
    picker: (r.picker as string | null) ?? undefined,
    approver: (r.approver as string | null) ?? undefined,
    approveDate: (r.approve_date as string | null) ?? undefined,
    rejectedBy: (r.rejected_by as string | null) ?? undefined,
    rejectDate: (r.reject_date as string | null) ?? undefined,
    rejectNote: (r.reject_note as string | null) ?? undefined,
    pickDate: (r.pick_date as string | null) ?? undefined,
    pickQty: asNumber(r.pick_qty),
    createdBy: (r.created_by as string | null) ?? undefined,
    createdAt: r.created_at as string,
  }
}

export type NewProcurementInput = {
  item: string
  productId?: string
  link?: string
  qty?: number
  unitPriceCny?: number
  supplier?: string
  orderDate: string
  expectedDate?: string
  notes?: string
  // Floor requests are born 'requested'; an approver's own request skips to
  // 'approved' (免审批). 'pending' (pre-0089 clients) reads as 'approved';
  // omitted = 'ordered' (the pre-0082 behavior, so old clients keep working).
  status?: 'requested' | 'approved' | 'pending' | 'ordered'
  jobId?: string
  jobNo?: string
  picker?: string // 领料人 — decided at request time
  reqDate?: string
}

export type ProcurementPatch = {
  item?: string
  link?: string | null
  qty?: number | null
  unitPriceCny?: number | null
  supplier?: string | null
  orderDate?: string
  expectedDate?: string | null
  status?: ProcurementStatus
  arrivedDate?: string | null
  notes?: string | null
  jobId?: string | null
  jobNo?: string | null
  inspectResult?: 'ok' | 'defect' | null
  inspectNote?: string | null
  picker?: string | null
  pickQty?: number | null // 领用数量 — sent with the 领料 transition
  rejectNote?: string | null // stamped with the 驳回 transition
}

// product_id + link land in migration 0043; job/inspect lifecycle in 0082;
// the 请购/审批/领料 trail in 0089. Selecting columns a not-yet-migrated DB
// lacks throws 42703; fall back tier by tier so the tab renders through the
// deploy window instead of 500'ing.
const PROCUREMENT_COLS_FLOW =
  'id, item, qty, unit_price_cny, supplier, order_date, expected_date, status, arrived_date, buyer, notes, product_id, link, job_id, job_no, inspect_result, inspect_note, requester, req_date, picker, approver, approve_date, rejected_by, reject_date, reject_note, pick_date, pick_qty, created_by, created_at'
const PROCUREMENT_COLS_FULL =
  'id, item, qty, unit_price_cny, supplier, order_date, expected_date, status, arrived_date, buyer, notes, product_id, link, job_id, job_no, inspect_result, inspect_note, created_by, created_at'
const PROCUREMENT_COLS_V43 =
  'id, item, qty, unit_price_cny, supplier, order_date, expected_date, status, arrived_date, buyer, notes, product_id, link, created_by, created_at'
const PROCUREMENT_COLS_BASE =
  'id, item, qty, unit_price_cny, supplier, order_date, expected_date, status, arrived_date, buyer, notes, created_by, created_at'

// All purchases. In-transit first (by 预计到货 ascending so the soonest /
// overdue float to the top — that's the queue the floor reads), then arrived
// ones (newest arrival first). Sorting is finalized in TS so a null
// expected_date never jumps a dated row.
export async function getProcurements(): Promise<Procurement[]> {
  type Res = { data: AnyRow[] | null; error: { code?: string } | null }
  const run = (cols: string) =>
    supabase
      .from('procurements')
      .select(cols)
      .order('created_at', { ascending: false }) as unknown as Promise<Res>
  let { data, error } = await run(PROCUREMENT_COLS_FLOW)
  if (error && isMissingColumnError(error)) {
    ;({ data, error } = await run(PROCUREMENT_COLS_FULL))
  }
  if (error && isMissingColumnError(error)) {
    ;({ data, error } = await run(PROCUREMENT_COLS_V43))
  }
  if (error && isMissingColumnError(error)) {
    ;({ data, error } = await run(PROCUREMENT_COLS_BASE))
  }
  if (error) {
    // Tolerate a pre-migration-0042 DB: the tab renders empty instead of 500.
    if (isMissingTableError(error)) return []
    throw error
  }
  return (data ?? []).map(fromProcurement)
}

export async function createProcurement(
  input: NewProcurementInput,
  createdBy: string,
): Promise<string> {
  const id = uid('po')
  const { error } = await supabase.from('procurements').insert({
    id,
    item: input.item.trim(),
    product_id: input.productId || null,
    link: input.link?.trim() || null,
    qty: input.qty ?? null,
    unit_price_cny: input.unitPriceCny ?? null,
    supplier: input.supplier?.trim() || null,
    order_date: input.orderDate,
    expected_date: input.expectedDate || null,
    // Every request is born 待审批 (the mutate route enforces it too) —
    // approval, ordering, arrival, and pickup each stamp their own actor.
    status: 'requested',
    buyer: createdBy,
    notes: input.notes?.trim() || null,
    job_id: input.jobId || null,
    job_no: input.jobNo?.trim() || null,
    requester: createdBy,
    req_date: input.reqDate || input.orderDate,
    picker: input.picker?.trim() || createdBy,
    created_by: createdBy,
  })
  if (error) throw error
  // Bump the picked 物料 so it floats to the top of the next picker. Best-effort:
  // a failure here must not fail the purchase the user already committed to.
  if (input.productId) {
    await supabase
      .from('procurement_products')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', input.productId)
  }
  return id
}

export async function updateProcurement(
  procurementId: string,
  patch: ProcurementPatch,
  actor: string,
): Promise<void> {
  const update: AnyRow = {}
  if (patch.item !== undefined) update.item = patch.item.trim()
  if (patch.qty !== undefined) update.qty = patch.qty
  if (patch.unitPriceCny !== undefined) update.unit_price_cny = patch.unitPriceCny
  if (patch.supplier !== undefined)
    update.supplier = patch.supplier?.trim() || null
  if (patch.link !== undefined) update.link = patch.link?.trim() || null
  if (patch.orderDate !== undefined) update.order_date = patch.orderDate
  if (patch.expectedDate !== undefined)
    update.expected_date = patch.expectedDate || null
  if (patch.notes !== undefined) update.notes = patch.notes?.trim() || null
  if (patch.jobId !== undefined) update.job_id = patch.jobId || null
  if (patch.jobNo !== undefined) update.job_no = patch.jobNo?.trim() || null
  if (patch.picker !== undefined) update.picker = patch.picker?.trim() || null
  if (patch.pickQty !== undefined) update.pick_qty = patch.pickQty
  if (patch.inspectResult !== undefined)
    update.inspect_result = patch.inspectResult
  if (patch.inspectNote !== undefined)
    update.inspect_note = patch.inspectNote?.trim() || null
  if (patch.status !== undefined) {
    update.status = patch.status
    // Each transition stamps its own actor + date, so the row carries its
    // whole story: 谁请购 → 谁批 → 谁下单 → 到货 → 谁领.
    if (patch.status === 'approved') {
      update.approver = actor
      update.approve_date = today()
      update.rejected_by = null
      update.reject_date = null
      update.reject_note = null
    }
    if (patch.status === 'rejected') {
      update.rejected_by = actor
      update.reject_date = today()
      update.reject_note = patch.rejectNote?.trim() || null
    }
    if (patch.status === 'ordered') {
      // Whoever actually places the order becomes the 采购人; the order
      // clock starts NOW (client sends orderDate: today alongside).
      update.buyer = actor
    }
    if (patch.status === 'arrived') {
      update.arrived_date =
        patch.arrivedDate !== undefined ? patch.arrivedDate || null : today()
    }
    if (patch.status === 'done') {
      update.pick_date = today()
    }
    // Moving BACK into the queue (待审批/待下单/在途) clears the arrival and
    // its inspection so the row re-enters clean. 'done' keeps them — the
    // ledger row still tells the arrival + inspection story.
    if (
      patch.status === 'requested' ||
      patch.status === 'approved' ||
      patch.status === 'ordered'
    ) {
      update.arrived_date = null
      update.inspect_result = null
      update.inspect_note = null
      update.pick_date = null
      update.pick_qty = null
    }
  } else if (patch.arrivedDate !== undefined) {
    update.arrived_date = patch.arrivedDate || null
  }
  if (Object.keys(update).length === 0) return
  const { error } = await supabase
    .from('procurements')
    .update(update)
    .eq('id', procurementId)
  if (error) throw error
}

export async function deleteProcurement(procurementId: string): Promise<void> {
  const { error } = await supabase
    .from('procurements')
    .delete()
    .eq('id', procurementId)
  if (error) throw error
}

// 关联工号 picker feed — the last ~400 confirmed jobs, newest first. Job no +
// product only (no customer: the 采购 tab is open to every signed-in role and
// customer names stay off floor-visible surfaces). 400 covers months of
// intake; older jobs don't get new material bought for them.
export type ProcurementJobOption = { id: string; jobNo: string; product: string }

export async function getProcurementJobOptions(): Promise<ProcurementJobOption[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, job_no, product, created_at')
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(400)
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id as string,
    jobNo: (r.job_no as string | null) ?? '',
    product: (r.product as string | null) ?? '',
  }))
}

// === 物料库 (procurement product catalog) ===

function fromProcurementProduct(r: AnyRow): ProcurementProduct {
  return {
    id: r.id as string,
    name: (r.name as string | null) ?? '',
    category: (r.category as string | null) ?? undefined,
    supplier: (r.supplier as string | null) ?? undefined,
    link: (r.link as string | null) ?? undefined,
    unitPriceCny: asNumber(r.unit_price_cny),
    notes: (r.notes as string | null) ?? undefined,
    lastUsedAt: (r.last_used_at as string | null) ?? undefined,
    createdBy: (r.created_by as string | null) ?? undefined,
    createdAt: r.created_at as string,
  }
}

export type NewProcurementProductInput = {
  name: string
  category?: string
  supplier?: string
  link?: string
  unitPriceCny?: number
  notes?: string
}

export type ProcurementProductPatch = {
  name?: string
  category?: string | null
  supplier?: string | null
  link?: string | null
  unitPriceCny?: number | null
  notes?: string | null
}

const PROCUREMENT_PRODUCT_COLS =
  'id, name, category, supplier, link, unit_price_cny, notes, last_used_at, created_by, created_at'

// The whole 物料库, most-recently-used first (then newest). Small table — one
// shop's catalog of repeat buys — so no pagination. Tolerates a pre-migration
// DB (renders an empty picker, "新建物料" still works once 0043 lands).
export async function getProcurementProducts(): Promise<ProcurementProduct[]> {
  const { data, error } = await supabase
    .from('procurement_products')
    .select(PROCUREMENT_PRODUCT_COLS)
    .order('last_used_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
  if (error) {
    if (isMissingTableError(error)) return []
    throw error
  }
  return (data ?? []).map(fromProcurementProduct)
}

// Returns the full row so the picker can select the just-created 物料 inline
// without a round-trip refresh.
export async function createProcurementProduct(
  input: NewProcurementProductInput,
  createdBy: string,
): Promise<ProcurementProduct> {
  const id = uid('prod')
  const { data, error } = await supabase
    .from('procurement_products')
    .insert({
      id,
      name: input.name.trim(),
      category: input.category?.trim() || null,
      supplier: input.supplier?.trim() || null,
      link: input.link?.trim() || null,
      unit_price_cny: input.unitPriceCny ?? null,
      notes: input.notes?.trim() || null,
      created_by: createdBy,
    })
    .select(PROCUREMENT_PRODUCT_COLS)
    .single()
  if (error) throw error
  return fromProcurementProduct(data as AnyRow)
}

export async function updateProcurementProduct(
  productId: string,
  patch: ProcurementProductPatch,
): Promise<void> {
  const update: AnyRow = {}
  if (patch.name !== undefined) update.name = patch.name.trim()
  if (patch.category !== undefined)
    update.category = patch.category?.trim() || null
  if (patch.supplier !== undefined)
    update.supplier = patch.supplier?.trim() || null
  if (patch.link !== undefined) update.link = patch.link?.trim() || null
  if (patch.unitPriceCny !== undefined)
    update.unit_price_cny = patch.unitPriceCny
  if (patch.notes !== undefined) update.notes = patch.notes?.trim() || null
  if (Object.keys(update).length === 0) return
  const { error } = await supabase
    .from('procurement_products')
    .update(update)
    .eq('id', productId)
  if (error) throw error
}

// Past 采购 rows snapshot the 物料's name/supplier/link/price, and the FK is
// `on delete set null`, so removing a 物料 only retires it from the picker — it
// never rewrites purchase history.
export async function deleteProcurementProduct(productId: string): Promise<void> {
  const { error } = await supabase
    .from('procurement_products')
    .delete()
    .eq('id', productId)
  if (error) throw error
}

// === 重点 (daily focus list) ===

function fromDailyFocusItem(r: AnyRow): DailyFocusItem {
  return {
    id: r.id as string,
    day: r.day as string,
    jobId: (r.job_id as string | null) ?? undefined,
    jobNoText: (r.job_no_text as string | null) ?? '',
    productText: (r.product_text as string | null) ?? undefined,
    dueText: (r.due_text as string | null) ?? undefined,
    feedback: (r.feedback as string | null) ?? undefined,
    position: asNumber(r.position) ?? 0,
    createdBy: (r.created_by as string | null) ?? undefined,
    createdAt: r.created_at as string,
  }
}

// product_text + due_text land in migration 0047. Selecting them on a DB
// that's only at 0046 throws 42703; fall back to the base column set so the
// board renders through the deploy window (same pattern as procurement 0043).
const DAILY_FOCUS_COLS_FULL =
  'id, day, job_id, job_no_text, product_text, due_text, feedback, position, created_by, created_at'
const DAILY_FOCUS_COLS_BASE =
  'id, day, job_id, job_no_text, feedback, position, created_by, created_at'

// One day's hand-curated list, in position order (fractional positions —
// drag-reorder and insert-anywhere never renumber the whole sheet).
export async function getDailyFocusItems(day: string): Promise<DailyFocusItem[]> {
  type Res = { data: AnyRow[] | null; error: { code?: string } | null }
  const run = (cols: string) =>
    supabase
      .from('daily_focus_items')
      .select(cols)
      .eq('day', day)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true }) as unknown as Promise<Res>
  let { data, error } = await run(DAILY_FOCUS_COLS_FULL)
  if (error && isMissingColumnError(error)) {
    ;({ data, error } = await run(DAILY_FOCUS_COLS_BASE))
  }
  if (error) {
    // Tolerate a pre-migration-0046 DB: the page renders empty instead of 500.
    if (isMissingTableError(error)) return []
    throw error
  }
  return (data ?? []).map(fromDailyFocusItem)
}

export type NewDailyFocusInput = {
  day: string
  jobId?: string
  jobNoText: string
  productText?: string
  dueText?: string
  feedback?: string
  /** Explicit slot (fractional — insert-anywhere). Omitted ⇒ append at end. */
  position?: number
}

export async function createDailyFocusItem(
  input: NewDailyFocusInput,
  createdBy: string,
): Promise<string> {
  const id = uid('df')
  let position = input.position
  if (position === undefined) {
    // Append after the day's current max position. Two concurrent adds can
    // tie; created_at breaks the tie in the read, so the list stays stable.
    const { data: maxRows } = await supabase
      .from('daily_focus_items')
      .select('position')
      .eq('day', input.day)
      .order('position', { ascending: false })
      .limit(1)
    position = (asNumber(maxRows?.[0]?.position) ?? 0) + 1
  }
  const base: AnyRow = {
    id,
    day: input.day,
    job_id: input.jobId || null,
    job_no_text: input.jobNoText.trim(),
    feedback: input.feedback?.trim() || null,
    position,
    created_by: createdBy,
  }
  let { error } = await supabase.from('daily_focus_items').insert({
    ...base,
    product_text: input.productText?.trim() || null,
    due_text: input.dueText?.trim() || null,
  })
  // Pre-0047 DB: retry without the override columns — but ONLY when they're
  // empty anyway. If the user actually typed an override, dropping it would
  // be silent data loss; fail loudly instead.
  if (
    error &&
    isMissingColumnError(error) &&
    !input.productText?.trim() &&
    !input.dueText?.trim()
  ) {
    ;({ error } = await supabase.from('daily_focus_items').insert(base))
  }
  if (error) throw error
  return id
}

// Excel-cell semantics: null clears an override (the cell falls back to the
// live join); position moves the row (drag / insert reorder).
export type DailyFocusPatch = {
  jobId?: string | null
  jobNoText?: string
  productText?: string | null
  dueText?: string | null
  feedback?: string | null
  position?: number
}

export async function updateDailyFocusItem(
  itemId: string,
  patch: DailyFocusPatch,
): Promise<void> {
  const update: AnyRow = {}
  if (patch.jobId !== undefined) update.job_id = patch.jobId || null
  if (patch.jobNoText !== undefined) update.job_no_text = patch.jobNoText.trim()
  if (patch.productText !== undefined)
    update.product_text = patch.productText?.trim() || null
  if (patch.dueText !== undefined) update.due_text = patch.dueText?.trim() || null
  if (patch.feedback !== undefined)
    update.feedback = patch.feedback?.trim() || null
  if (patch.position !== undefined) update.position = patch.position
  if (Object.keys(update).length === 0) return
  const { error } = await supabase
    .from('daily_focus_items')
    .update(update)
    .eq('id', itemId)
  if (error) throw error
}

export async function deleteDailyFocusItem(itemId: string): Promise<void> {
  const { error } = await supabase
    .from('daily_focus_items')
    .delete()
    .eq('id', itemId)
  if (error) throw error
}

// === 财务 (caiwu — the finance clerk's two spreadsheets) ===

// The free-text columns whose app key maps 1:1 onto a snake_case DB column.
// 工号 (job_no_text) + job_id are handled apart (the linked-job anchor); these
// are the dumb cells. Shared by read / create / patch so the mapping lives in
// exactly one place.
const CAIWU_FIELD_COLS: Record<string, string> = {
  customer: 'customer_text',
  contact: 'contact_text',
  date: 'date_text',
  orderNo: 'order_no_text',
  qty: 'qty_text',
  billable: 'billable_text',
  amount: 'amount_text',
  tax: 'tax_text',
  amountIncl: 'amount_incl_text',
  invoiceNo: 'invoice_no_text',
  log: 'log_text',
}

function fromCaiwuRow(r: AnyRow): CaiwuRow {
  const out: CaiwuRow = {
    id: r.id as string,
    sheet: r.sheet as CaiwuSheet,
    jobId: (r.job_id as string | null) ?? undefined,
    jobNoText: (r.job_no_text as string | null) ?? '',
    position: asNumber(r.position) ?? 0,
    createdAt: r.created_at as string,
  }
  for (const [k, col] of Object.entries(CAIWU_FIELD_COLS)) {
    const v = r[col] as string | null
    if (v != null) (out as Record<string, unknown>)[k] = v
  }
  return out
}

// One sheet's rows, in position order (fractional positions — drag-reorder and
// insert-anywhere never renumber the whole sheet). Tolerates a pre-migration
// DB by rendering empty instead of 500.
export async function getCaiwuRows(sheet: CaiwuSheet): Promise<CaiwuRow[]> {
  const { data, error } = await supabase
    .from('caiwu_rows')
    .select('*')
    .eq('sheet', sheet)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) {
    if (isMissingTableError(error)) return []
    throw error
  }
  return (data ?? []).map((r) => fromCaiwuRow(r as AnyRow))
}

export type NewCaiwuInput = {
  sheet: CaiwuSheet
  jobId?: string
  jobNoText?: string
  customer?: string | null
  contact?: string | null
  date?: string | null
  orderNo?: string | null
  qty?: string | null
  billable?: string | null
  amount?: string | null
  tax?: string | null
  amountIncl?: string | null
  invoiceNo?: string | null
  log?: string | null
  /** Explicit slot (fractional — insert-anywhere). Omitted ⇒ append at end. */
  position?: number
}

export async function createCaiwuRow(
  input: NewCaiwuInput,
  createdBy: string,
): Promise<string> {
  const id = uid('cw')
  let position = input.position
  if (position === undefined) {
    // Append after the sheet's current max position. Concurrent adds can tie;
    // created_at breaks the tie in the read, so the list stays stable.
    const { data: maxRows } = await supabase
      .from('caiwu_rows')
      .select('position')
      .eq('sheet', input.sheet)
      .order('position', { ascending: false })
      .limit(1)
    position = (asNumber(maxRows?.[0]?.position) ?? 0) + 1
  }
  const row: AnyRow = {
    id,
    sheet: input.sheet,
    position,
    job_id: input.jobId || null,
    job_no_text: (input.jobNoText ?? '').trim(),
    created_by: createdBy,
  }
  for (const [k, col] of Object.entries(CAIWU_FIELD_COLS)) {
    const v = (input as Record<string, unknown>)[k]
    if (typeof v === 'string') row[col] = v.trim() || null
  }
  const { error } = await supabase.from('caiwu_rows').insert(row)
  if (error) throw error
  return id
}

// Excel-cell semantics: null clears a cell (an override falls back to the live
// join); position moves the row (drag / insert reorder).
export type CaiwuPatch = {
  jobId?: string | null
  jobNoText?: string
  customer?: string | null
  contact?: string | null
  date?: string | null
  orderNo?: string | null
  qty?: string | null
  billable?: string | null
  amount?: string | null
  tax?: string | null
  amountIncl?: string | null
  invoiceNo?: string | null
  log?: string | null
  position?: number
}

export async function updateCaiwuRow(
  itemId: string,
  patch: CaiwuPatch,
): Promise<void> {
  const update: AnyRow = {}
  if (patch.jobId !== undefined) update.job_id = patch.jobId || null
  if (patch.jobNoText !== undefined) update.job_no_text = patch.jobNoText.trim()
  if (patch.position !== undefined) update.position = patch.position
  for (const [k, col] of Object.entries(CAIWU_FIELD_COLS)) {
    const v = (patch as Record<string, unknown>)[k]
    if (v !== undefined) update[col] = (v as string | null)?.trim() || null
  }
  if (Object.keys(update).length === 0) return
  const { error } = await supabase
    .from('caiwu_rows')
    .update(update)
    .eq('id', itemId)
  if (error) throw error
}

export async function deleteCaiwuRow(itemId: string): Promise<void> {
  const { error } = await supabase.from('caiwu_rows').delete().eq('id', itemId)
  if (error) throw error
}

// === 财务 / 支出台账 (expenses) ===

function fromExpense(r: AnyRow): Expense {
  const cat = r.category as string
  return {
    id: r.id as string,
    expenseDate: r.expense_date as string,
    // Unknown category strings (future additions, hand-edited rows) degrade
    // to 'other' rather than crashing the ledger.
    category: isExpenseCategory(cat) ? cat : 'other',
    amountCny: asNumber(r.amount_cny) ?? 0,
    payee: (r.payee as string | null) ?? undefined,
    note: (r.note as string | null) ?? undefined,
    createdBy: (r.created_by as string | null) ?? undefined,
    createdAt: r.created_at as string,
  }
}

// The whole ledger, newest first. One shop's cash events — a few hundred rows
// a year — so no server-side pagination; the page slices. Tolerates a
// pre-migration-0051 DB (tab renders empty instead of 500'ing).
export async function getExpenses(): Promise<Expense[]> {
  const { data, error } = await supabase
    .from('expenses')
    .select('id, expense_date, category, amount_cny, payee, note, created_by, created_at')
    .order('expense_date', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) {
    if (isMissingTableError(error)) return []
    throw error
  }
  return (data ?? []).map(fromExpense)
}

export type NewExpenseInput = {
  expenseDate: string // YYYY-MM-DD
  category: ExpenseCategory
  amountCny: number
  payee?: string
  note?: string
}

export async function createExpense(
  input: NewExpenseInput,
  createdBy: string,
): Promise<string> {
  const id = uid('exp')
  const { error } = await supabase.from('expenses').insert({
    id,
    expense_date: input.expenseDate,
    category: input.category,
    amount_cny: input.amountCny,
    payee: input.payee?.trim() || null,
    note: input.note?.trim() || null,
    created_by: createdBy,
  })
  if (error) throw error
  return id
}

// Batch insert — powers 复制上月工资 (one request for the whole payroll run).
export async function createExpenses(
  inputs: NewExpenseInput[],
  createdBy: string,
): Promise<string[]> {
  if (inputs.length === 0) return []
  const rows = inputs.map((input) => ({
    id: uid('exp'),
    expense_date: input.expenseDate,
    category: input.category,
    amount_cny: input.amountCny,
    payee: input.payee?.trim() || null,
    note: input.note?.trim() || null,
    created_by: createdBy,
  }))
  const { error } = await supabase.from('expenses').insert(rows)
  if (error) throw error
  return rows.map((r) => r.id)
}

export type ExpensePatch = {
  expenseDate?: string
  category?: ExpenseCategory
  amountCny?: number
  payee?: string | null
  note?: string | null
}

export async function updateExpense(
  expenseId: string,
  patch: ExpensePatch,
): Promise<void> {
  const update: AnyRow = {}
  if (patch.expenseDate !== undefined) update.expense_date = patch.expenseDate
  if (patch.category !== undefined) update.category = patch.category
  if (patch.amountCny !== undefined) update.amount_cny = patch.amountCny
  if (patch.payee !== undefined) update.payee = patch.payee?.trim() || null
  if (patch.note !== undefined) update.note = patch.note?.trim() || null
  if (Object.keys(update).length === 0) return
  const { error } = await supabase
    .from('expenses')
    .update(update)
    .eq('id', expenseId)
  if (error) throw error
}

export async function deleteExpense(expenseId: string): Promise<void> {
  const { error } = await supabase.from('expenses').delete().eq('id', expenseId)
  if (error) throw error
}

// === 笔记 (notes) — the boss's per-author scratchpad ===

function fromNote(r: AnyRow): Note {
  return {
    id: r.id as string,
    authorId: r.author_id as string,
    body: (r.body as string | null) ?? '',
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
}

// A user's own notes, newest-edited first. Tolerates a pre-migration-0066 DB
// (renders an empty board instead of 500'ing).
export async function getNotes(authorId: string): Promise<Note[]> {
  const { data, error } = await supabase
    .from('notes')
    .select('id, author_id, body, created_at, updated_at')
    .eq('author_id', authorId)
    .order('updated_at', { ascending: false })
  if (error) {
    if (isMissingTableError(error)) return []
    throw error
  }
  return (data ?? []).map(fromNote)
}

// Born with its first real text — the notes board keeps drafts local until
// something non-whitespace is typed, so an empty row can never exist.
export async function createNote(authorId: string, body: string): Promise<string> {
  const id = uid('note')
  const { error } = await supabase
    .from('notes')
    .insert({ id, author_id: authorId, body })
  if (error) throw error
  return id
}

// Update/delete scope to the caller's own notes — ids are per-author private,
// so a guessed id from another author is a silent no-op, not a write.
export async function updateNote(
  id: string,
  body: string,
  authorId: string,
): Promise<void> {
  const { error } = await supabase
    .from('notes')
    .update({ body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('author_id', authorId)
  if (error) throw error
}

export async function deleteNote(id: string, authorId: string): Promise<void> {
  const { error } = await supabase
    .from('notes')
    .delete()
    .eq('id', id)
    .eq('author_id', authorId)
  if (error) throw error
}

// === 零件图纸变更 (per-part drawing changes, migration 0067) ===

// Raise a new revision on a part: next = max(existing)+1 (一次/二次/三次…).
// Also flips the job-level 图纸变更 alarm ON, reusing the 0049 machinery so the
// board badge + page banner light up for free. Returns the new revision number.
export async function raisePartDrawingChange(input: {
  componentId: string // the trimmed c.id from the UI (e.g. "p1")
  jobId: string
  note?: string
  imageUrl?: string
  raisedBy: string
}): Promise<number> {
  const { jobId } = input
  // The UI exposes the TRIMMED component id; the parts table (and this table's
  // FK) use the full `${jobId}:${componentId}` row id. Resolve it the same way
  // every component write does — passing the bare id straight through hits a
  // foreign-key violation (the original "[object Object]" bug).
  const snap = await loadJobSnapshot(jobId)
  const partId = findPartIdInSnap(snap, jobId, input.componentId)
  if (!partId) throw new Error('零件不存在')
  const { data: existing, error: exErr } = await supabase
    .from('part_drawing_changes')
    .select('revision')
    .eq('part_id', partId)
    .order('revision', { ascending: false })
    .limit(1)
  if (exErr) throw exErr
  const nextRev =
    ((existing?.[0]?.revision as number | undefined) ?? 0) + 1
  const id = uid('pdc')
  const { error } = await supabase.from('part_drawing_changes').insert({
    id,
    part_id: partId,
    revision: nextRev,
    note: input.note?.trim() || null,
    image_url: input.imageUrl || null,
    raised_by: input.raisedBy,
  })
  if (error) throw error
  // Light the job-level alarm (board badge + banner). Leave the job NOTE
  // untouched so a separately-raised whole-job note survives.
  await updateJob(jobId, {
    drawingChangeOpen: true,
    drawingChangeBy: input.raisedBy,
    drawingChangeAt: new Date().toISOString(),
  })
  return nextRev
}

// Mark every open revision of a part as cleared (floor has the new drawing).
// Then, if NO part on the job still has an open change, drop the job-level
// alarm too.
export async function clearPartDrawingChange(input: {
  componentId: string // trimmed c.id from the UI
  jobId: string
  clearedBy: string
}): Promise<void> {
  const { jobId } = input
  const snap = await loadJobSnapshot(jobId)
  const partId = findPartIdInSnap(snap, jobId, input.componentId)
  if (!partId) return
  const { error } = await supabase
    .from('part_drawing_changes')
    .update({ cleared_at: new Date().toISOString(), cleared_by: input.clearedBy })
    .eq('part_id', partId)
    .is('cleared_at', null)
  if (error) throw error

  // Any other open change on this job's parts? If not, drop the job alarm.
  // snap.parts carry the full ids — reuse them rather than re-querying.
  const partIds = snap.parts.map((p) => p.id)
  if (partIds.length === 0) return
  const stillOpen = await inChunks(partIds, (chunk) =>
    supabase
      .from('part_drawing_changes')
      .select('id')
      .in('part_id', chunk)
      .is('cleared_at', null)
      .limit(1),
  )
  if (stillOpen.length === 0) {
    await updateJob(jobId, {
      drawingChangeOpen: false,
      drawingChangeNote: null,
      drawingChangeBy: null,
      drawingChangeAt: null,
    })
  }
}

// === 出厂检验报告 (inspection reports, migration 0053) ===

function fromInspectionReport(r: AnyRow): InspectionReport {
  const dims = Array.isArray(r.dims) ? (r.dims as unknown[]).filter(isDimRow) : []
  const checks = Array.isArray(r.process_checks)
    ? (r.process_checks as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  const perf = (r.performance ?? {}) as Record<string, unknown>
  const app = (r.appearance ?? {}) as Record<string, unknown>
  const pack = (r.packaging ?? {}) as Record<string, unknown>
  const str = (x: unknown): string => (typeof x === 'string' ? x : '')
  return {
    id: r.id as string,
    partId: r.part_id as string,
    reportNo: (r.report_no as string | null) ?? undefined,
    inspectMethod: (r.inspect_method as string | null) ?? undefined,
    dims,
    processChecks: checks,
    performance: {
      coatingAdhesion: str(perf.coatingAdhesion),
      silkAlcohol: str(perf.silkAlcohol),
      silkAdhesion: str(perf.silkAdhesion),
      nutGauge: str(perf.nutGauge),
      other: str(perf.other),
    },
    appearance: {
      colorDiffMeasured: str(app.colorDiffMeasured),
      defects: str(app.defects),
      defectDesc: str(app.defectDesc),
    },
    packaging: {
      method: str(pack.method),
      boxAppearance: str(pack.boxAppearance),
      boxLabel: str(pack.boxLabel),
      documents: str(pack.documents),
    },
    disposition: (r.disposition as string | null) ?? undefined,
    customerPlan: (r.customer_plan as string | null) ?? undefined,
    finalVerdict: (r.final_verdict as string | null) ?? undefined,
    evaluation: (r.evaluation as string | null) ?? undefined,
    confirmer: (r.confirmer as string | null) ?? undefined,
    inspector: (r.inspector as string | null) ?? undefined,
    approver: (r.approver as string | null) ?? undefined,
    inspectedAt: (r.inspected_at as string | null) ?? undefined,
    createdBy: (r.created_by as string | null) ?? undefined,
    createdAt: (r.created_at as string | null) ?? undefined,
    updatedAt: (r.updated_at as string | null) ?? undefined,
    updatedBy: (r.updated_by as string | null) ?? undefined,
  }
}

// Resolve a UI componentId to the parts.id within one job without dragging
// the whole snapshot — same suffix convention as findPartIdInSnap.
async function resolvePartIdLight(
  jobId: string,
  componentId: string,
): Promise<string | undefined> {
  const { data, error } = await supabase
    .from('parts')
    .select('id')
    .eq('job_id', jobId)
  if (error) throw error
  for (const r of (data ?? []) as AnyRow[]) {
    const id = r.id as string
    const suffix = id.split(':').slice(1).join(':')
    if (id === componentId || suffix === componentId) return id
  }
  return undefined
}

// The part's report, or null when none exists yet (the page renders the
// empty template). Tolerates a pre-0053 DB.
export async function getInspectionReport(
  jobId: string,
  componentId: string,
): Promise<InspectionReport | null> {
  const partId = await resolvePartIdLight(jobId, componentId)
  if (!partId) return null
  const { data, error } = await supabase
    .from('inspection_reports')
    .select('*')
    .eq('part_id', partId)
    .maybeSingle()
  if (error) {
    if (isMissingTableError(error)) return null
    throw error
  }
  if (!data) return null
  return fromInspectionReport(data as AnyRow)
}

// Whole-document upsert — one inspector fills one report; last write wins is
// fine at this scale, and per-field patches would just multiply wire kinds.
export async function upsertInspectionReport(
  jobId: string,
  componentId: string,
  patch: InspectionReportPatch,
  actor: string,
): Promise<void> {
  await withWriteLock(async () => {
    const partId = await resolvePartIdLight(jobId, componentId)
    if (!partId) return
    const { data, error } = await supabase
      .from('inspection_reports')
      .select('id')
      .eq('part_id', partId)
      .maybeSingle()
    if (error) throw error

    const update: AnyRow = {
      updated_at: new Date().toISOString(),
      updated_by: actor,
    }
    if (patch.reportNo !== undefined) update.report_no = patch.reportNo?.trim() || null
    if (patch.inspectMethod !== undefined)
      update.inspect_method = patch.inspectMethod?.trim() || null
    if (patch.dims !== undefined) update.dims = patch.dims
    if (patch.processChecks !== undefined) update.process_checks = patch.processChecks
    if (patch.performance !== undefined) update.performance = patch.performance
    if (patch.appearance !== undefined) update.appearance = patch.appearance
    if (patch.packaging !== undefined) update.packaging = patch.packaging
    if (patch.disposition !== undefined) update.disposition = patch.disposition?.trim() || null
    if (patch.customerPlan !== undefined) update.customer_plan = patch.customerPlan?.trim() || null
    if (patch.finalVerdict !== undefined) update.final_verdict = patch.finalVerdict?.trim() || null
    if (patch.evaluation !== undefined) update.evaluation = patch.evaluation?.trim() || null
    if (patch.confirmer !== undefined) update.confirmer = patch.confirmer?.trim() || null
    if (patch.inspector !== undefined) update.inspector = patch.inspector?.trim() || null
    if (patch.approver !== undefined) update.approver = patch.approver?.trim() || null
    if (patch.inspectedAt !== undefined) update.inspected_at = patch.inspectedAt || null

    if (data) {
      const { error: upErr } = await supabase
        .from('inspection_reports')
        .update(update)
        .eq('id', data.id as string)
      if (upErr) throw upErr
      return
    }
    const { error: insErr } = await supabase.from('inspection_reports').insert({
      id: uid('qr'),
      part_id: partId,
      created_by: actor,
      ...update,
    })
    if (insErr) throw insErr
  })
}
