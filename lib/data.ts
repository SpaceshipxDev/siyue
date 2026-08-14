export const STAGES = [
  '工程',
  '采购',
  '编程',
  '操机',
  '检验',
  '手工',
  '打磨',
  '表处',
  '喷漆',
  '丝印',
  '质量',
  '出货',
] as const

export const SCHEMA_VERSION = 10

export type Stage = (typeof STAGES)[number]

// 采购 (material in) and 表处 (outsourced surface treatment) are OPT-IN
// stages: a fresh part's route excludes them and the board renders the
// columns as n/a slashes — exactly like 丝印 on a part that doesn't silk-
// print. 工程 switches them on per part in the route picker. Their position
// follows when the work actually STARTS: buying begins the moment 工程 has
// analyzed the part (material lead time is the long pole, so it runs first
// and in parallel with 编程), and 表处 sits between 打磨 and 喷漆 (the part
// leaves the building after polishing and must be back before paint).
export const OPT_IN_STAGES: Stage[] = ['采购', '表处']

// Starting a stage cascades every upstream stage closed (lib/db
// cascadeBackStart) — "if I'm working on it, everything before me is done"
// holds for in-house work, where each stage is a person here touching the
// part. 采购 is the exception: it means material physically ARRIVED, a fact
// from outside the building. 编程 is desk work on a computer that needs no
// material at all, so a programmer pressing ▶ must never claim the steel
// landed. Everything from 操机 on does touch the metal, so those still
// cascade 采购 closed for free.
export function stageStartImpliesUpstreamDone(
  atStage: Stage,
  upstream: Stage,
): boolean {
  return !(upstream === '采购' && atStage === '编程')
}

// The route every new part is born with — everything except the opt-ins.
// Single source of truth for server seeding (lib/db DEFAULT_NEW_PART_STAGES)
// and the client's optimistic new-row mirror.
export const DEFAULT_ROUTE_STAGES: Stage[] = STAGES.filter(
  (s) => !OPT_IN_STAGES.includes(s),
)

// 出货 is always an in-house terminal stage: vendors never ship to the
// customer directly — they ship parts back to us, then we ship to the
// customer. Outsource blocks therefore cover production stages only.
export const PRODUCTION_STAGES: Stage[] = STAGES.filter((s) => s !== '出货')

// 工程 is the in-house routing-planning stage: engineering decides which
// stages each part runs through before production starts. Vendors execute
// routings, they don't author them — so 工程 is never part of an outsource
// block. 采购 is buying, not vendor work — a block can't "cover" it either.
// The picker hides both and the server rejects any block that includes
// them. Legacy data may still contain 工程 in older blocks; we don't mutate
// those, only block new ones. (表处 IS outsourceable — outsourced surface
// treatment is the whole reason the stage exists.)
export const OUTSOURCEABLE_STAGES: Stage[] = PRODUCTION_STAGES.filter(
  (s) => s !== '工程' && s !== '采购',
)

// 计划交期 / 排产 — the stages a job can carry a PLANNED finish date for. 检验
// is a verdict gate with no in-house duration and 出货's plan would just be the
// contract 交期, so neither is plannable. 采购's "plan" is 预计到货, which
// already lives on the procurement row — a second date here would be a second
// truth. Order follows STAGES so a plan strip reads left-to-right the way
// parts actually flow.
export const PLANNABLE_STAGES: Stage[] = PRODUCTION_STAGES.filter(
  (s) => s !== '检验' && s !== '采购',
)

// 外协 carries one job-level planned return date alongside the in-house 工段
// plans — same stage_plan map, one extra key. Deliberately NOT a Stage: it has
// no station, no queue, no rollup column; only the 排产 band and the master
// board's 外协 badge read it.
export type PlanKey = Stage | '外协'

export type StageStatus = 'pending' | 'in_progress' | 'done'

// 检验 verdicts — the inspector's four buttons. OK finishes the stage and the
// part flows to 手工; the other three are BLOCKING: the part stays at 检验
// with a red tag until someone eventually clicks OK. Stored as the literal
// Chinese strings (same convention as stage names / OUTSOURCE_ACTIVITIES).
export type Verdict = '重做' | '返修' | '外修' | 'OK'
export const VERDICTS: Verdict[] = ['重做', '返修', '外修', 'OK']
export const BLOCKING_VERDICTS: Verdict[] = ['重做', '返修', '外修']

export function isBlockingVerdict(v: Verdict | undefined): v is Verdict {
  return v !== undefined && v !== 'OK'
}

export type StageState = {
  status: StageStatus
  // MM-DD display string stamped at finish — kept for the historic "✓ 04-25"
  // checkmark label all over the UI.
  completedAt?: string
  // ISO timestamp captured when the stage went pending → in_progress.
  // Powers the live "在做 N 分钟" station timer; preserved through
  // undo/finish as an audit trace.
  startedAt?: string
  // ISO timestamp captured when the stage went in_progress → done. Pairs
  // with startedAt to drive the per-stage avg flow time in StationSummary.
  finishedAt?: string
  by?: string
  // Who clicked ▶ 起步 (pending → in_progress). `by` records the ✓ 收件
  // finisher; startedBy records the starter, so the 动态 column can name the
  // actor of an in-progress stage that has no finisher yet.
  startedBy?: string
  // Partial-completion count while status='in_progress': how many of the
  // part's qty have been finished at this stage. Undefined = none yet (or
  // status='done' which implies all of qty). Status only flips to 'done'
  // once the count reaches qty — we never persist a 'done' row with a
  // doneQty < qty (the finish path clears it).
  doneQty?: number
  // 检验-only: the inspector's latest verdict on this part. A blocking
  // verdict (重做/返修/外修) holds the part at 检验 (status stays
  // in_progress) and paints the red tag; 'OK' rides along with the normal
  // done transition. Other stages never set these.
  verdict?: Verdict
  verdictAt?: string
  verdictBy?: string
  // 不良原因 / 责任人 — free text the inspector attaches to a blocking
  // verdict (migration 0052). OK never clears them: the record of why the
  // part bounced survives the release.
  verdictReason?: string
  verdictOwner?: string
  // 备注 — free-text note the inspector can attach to a PASSING (OK) verdict
  // (migration 0064). Distinct from 不良原因: it's a remark on a released part,
  // not a defect cause. 责任人 (verdictOwner) is shared with the blocking path.
  verdictNote?: string
}

export type VendorId = string
export type Vendor = {
  id: VendorId
  name: string
  notes?: string
  address?: string
  // Stable unguessable token behind the vendor's portal link
  // (siyue.ai/w/<token>). Generated lazily server-side the first time the
  // 外协台 renders (ensureVendorPortalTokens); undefined until then.
  portalToken?: string
}

export type CustomerId = string
export type Customer = {
  id: CustomerId
  name: string
  contact?: string
  address?: string
  phone?: string
}

export type OutsourceBlockMember = {
  componentId: string
  name: string
  qty: number
  material?: string
  // Mirrors the parent component's 料号. Resolved at compose time so the
  // 外协单 always reflects whatever number commerce typed on the job detail
  // page — no denormalization in outsource_block_parts.
  partNo?: string
  imageUrl?: string
  // Per-part return state. `returnedQty` is the running total of units back
  // from the vendor (0 = nothing back, qty = all back). `returnedAt` stamps
  // the date of the most recent return event and doubles as the member's
  // closure date once returnedQty reaches qty.
  returnedQty?: number
  returnedAt?: string
  // Per-unit vendor price for this part on this block — the number the
  // 外协单 PDF prints in the 单价 column. Undefined = not yet quoted.
  // Stored on outsource_block_parts.unit_price_cny.
  unitPriceCny?: number
}

// Helpers — keep the qty-based open/closed semantics in one place so callers
// don't reach into the field directly.
export function memberReturnedQty(m: OutsourceBlockMember): number {
  return m.returnedQty ?? 0
}
export function memberRemainingQty(m: OutsourceBlockMember): number {
  return Math.max(0, m.qty - memberReturnedQty(m))
}
export function isMemberFullyReturned(m: OutsourceBlockMember): boolean {
  return memberRemainingQty(m) === 0
}
// Per-member line subtotal (qty × unit price). Undefined when no price
// has been entered yet — callers render "—" instead of forcing zero.
export function memberLineTotal(m: OutsourceBlockMember): number | undefined {
  const p = m.unitPriceCny
  if (typeof p !== 'number' || !Number.isFinite(p)) return undefined
  return p * m.qty
}

// PDF convenience: single-member blocks that have a block-level
// amountCny but no explicit per-member unitPriceCny should still print
// a 单价 (= amountCny / qty) — they're trivially the same number. This
// is read-only inference; nothing is written back to the row.
export function effectiveUnitPriceCny(
  m: OutsourceBlockMember,
  block: OutsourceBlock,
): number | undefined {
  if (typeof m.unitPriceCny === 'number' && Number.isFinite(m.unitPriceCny)) {
    return m.unitPriceCny
  }
  if (
    block.members.length === 1 &&
    typeof block.amountCny === 'number' &&
    Number.isFinite(block.amountCny) &&
    m.qty > 0
  ) {
    return block.amountCny / m.qty
  }
  return undefined
}

export function effectiveMemberLineTotal(
  m: OutsourceBlockMember,
  block: OutsourceBlock,
): number | undefined {
  const p = effectiveUnitPriceCny(m, block)
  if (p == null) return undefined
  return p * m.qty
}

// Sum of line subtotals across a block. Used as a fallback when the
// block's grand-total amountCny is null (and as the 合计 on the PDF
// when per-line prices are present). Returns undefined when *no*
// member has a price set, so we don't print a misleading ¥0.
export function blockLineTotalsSum(block: OutsourceBlock): number | undefined {
  let sum = 0
  let any = false
  for (const m of block.members) {
    const lt = memberLineTotal(m)
    if (lt == null) continue
    sum += lt
    any = true
  }
  return any ? sum : undefined
}

export function isMemberPartiallyReturned(m: OutsourceBlockMember): boolean {
  const r = memberReturnedQty(m)
  return r > 0 && r < m.qty
}

export type OutsourceBlock = {
  id: string
  vendorId: VendorId
  // What's being outsourced, in the boss's own words: 外发氧化, 外发CNC,
  // 外发电镀, 包胶, 电火花, … Free-text — autocomplete from past entries.
  // The list grows organically; no admin page. Undefined on legacy rows
  // that predate the field (the cell falls back to the stage-range label).
  activity?: string
  stages: Stage[]
  // Null when commerce hasn't priced the shipment yet (加急 path: ship now,
  // quote later). Display as 待补金额 / "—" until backfilled.
  amountCny: number | null
  sentDate: string
  expectedReturn: string
  notes?: string
  docNo?: string
  // 加急 = rush. Bypasses the requirement that 金额 be set at create time.
  isRush?: boolean
  // Per-doc fields for the printed 外协单. Null/undefined = use defaults
  // from the vendor row or the BRAND constants.
  createdBy?: string
  recipientAddress?: string
  recipientContactName?: string
  recipientContactPhone?: string
  // Vendor-reported state from the portal (siyue.ai/w/<token>). All optional —
  // absence means the vendor hasn't said anything yet. See migration 0073.
  vendorSeenAt?: string
  vendorAckAt?: string
  vendorPromisedDate?: string
  vendorDelayReason?: string
  vendorShippedAt?: string
  // When the 外协员 copied the WeChat message for this dispatch (migration
  // 0077). Undefined = vendor was never told — surfaces as 待发微信.
  wechatSentAt?: string
  members: OutsourceBlockMember[]
}

// How many days later than 要求交期 the vendor's own promised date is.
// 0 / negative = on time or early; undefined = vendor hasn't promised.
export function vendorPromiseDelayDays(block: OutsourceBlock): number | undefined {
  if (!block.vendorPromisedDate) return undefined
  return daysFromToday(block.vendorPromisedDate, block.expectedReturn)
}

// The label to render anywhere we used to render `外协 · {stage range}`.
// Prefers the named activity (boss's word) — that's the whole point of the
// new field. Falls back to the derived stage-range label for legacy blocks
// that never had an activity set, so nothing reads as a blank cell.
export function blockActivityLabel(block: OutsourceBlock): string {
  const a = block.activity?.trim()
  if (a) return a
  return outsourceLabel(block.stages)
}

// Named outsource activities — the boss's vocabulary, exactly the list he
// pointed to in the 金蝶 reference screenshots. Selection-only in the form
// so the named list stays consistent across jobs (no typos like "外发CNC"
// vs "CNC外发"). Extending the list = add a string here; one-line change,
// no schema migration. Order matches the boss's screenshots.
export const OUTSOURCE_ACTIVITIES = [
  '外发CNC',
  '外发钣金',
  '外发打印',
  '外发打印半透',
  '外发车',
  '外发线割',
  '电火花',
  '外发其他1',
  '外发氧化',
  '外发电镀',
  '外发喷塑',
  '外发焊接',
  '外发电泳',
  '包胶',
] as const

export type OutsourceActivity = (typeof OUTSOURCE_ACTIVITIES)[number]

// Default in-house stage(s) a given outsource activity stands in for. The boss
// picks the activity (送什么 · 工序); this fills 承接工段 so he never types the
// stage twice. Editable in the composer (改工段) for the rare exception. Pure
// default — the SAME stages array is written to the block, so there is no
// behavior change vs. hand-picking; it just replaces the old arbitrary "first
// outsourceable stage" seed. Tuning the mapping = edit one line here.
//   • machining-class (CNC/钣金/车/线割/电火花/打印) → 操机
//   • surface-finish (氧化/电镀/喷塑/电泳) → 喷漆
//   • assembly-class (焊接/包胶) → 手工
export const ACTIVITY_DEFAULT_STAGES: Record<OutsourceActivity, Stage[]> = {
  外发CNC: ['操机'],
  外发钣金: ['操机'],
  外发打印: ['操机'],
  外发打印半透: ['操机'],
  外发车: ['操机'],
  外发线割: ['操机'],
  电火花: ['操机'],
  外发其他1: ['操机'],
  外发氧化: ['喷漆'],
  外发电镀: ['喷漆'],
  外发喷塑: ['喷漆'],
  外发焊接: ['手工'],
  外发电泳: ['喷漆'],
  包胶: ['手工'],
}

// "Closed" is derived: a block is closed when every member's returned_qty
// has reached its qty. The closure date is the latest member returnedAt —
// that's when the last missing piece finally got back.
export function blockClosedAt(block: OutsourceBlock): string | undefined {
  if (block.members.length === 0) return undefined
  let latest: string | undefined
  for (const m of block.members) {
    if (!isMemberFullyReturned(m)) return undefined
    if (m.returnedAt && (!latest || m.returnedAt > latest)) latest = m.returnedAt
  }
  return latest
}

export function isBlockClosed(block: OutsourceBlock): boolean {
  if (block.members.length === 0) return false
  return block.members.every(isMemberFullyReturned)
}

function memberFor(
  block: OutsourceBlock,
  componentId: string,
): OutsourceBlockMember | undefined {
  return block.members.find((m) => m.componentId === componentId)
}

export type Component = {
  id: string
  name: string
  qty: number
  material?: string
  surfaceTreatment?: string
  notes?: string
  imageUrl?: string
  // 料号 — vendor/customer part number. Manual entry only (never AI-extracted).
  // Surfaced on the printed 出货单 / 外协单 when present.
  partNo?: string
  // 加工工艺 — how this part is made (机加 / 3D打印 / 打印 …). AI-extracted
  // from the production order's 加工方式/工艺要求 columns; editable inline.
  // Informational — never drives the stage route automatically.
  process?: string
  // 出货记录 — a literally-editable free-text shipment record (migration 0069).
  // The 零件进度 column seeds from the derived batch audit-log (see
  // formatShipmentLog / componentShipmentEntries) so existing records show up;
  // once the boss types here, this manual text wins. Never AI-extracted.
  shipmentLog?: string
  // 零件进度 的 # — hand-typed override for the row number (migration 0088).
  // Undefined for every part until someone types over one: the # shown is
  // otherwise DERIVED from the part's position in the job (01 / 02 / 03),
  // which is what the customer's drawing set sometimes disagrees with.
  // Clearing the field stores null, handing the row back to the derived number.
  seqLabel?: string
  // Per-line quote fields. Both stored independently — qty * unitPriceCny is
  // not enforced to equal lineTotalCny, since real 报价单s often line-discount,
  // round, or tax differently per item. Either may be undefined when the AI
  // could not find a number; commerce can hand-correct in the UI.
  unitPriceCny?: number
  lineTotalCny?: number
  // A part's "route" is the set of stages with rows in part_stages. A missing
  // key means the stage doesn't apply (n/a) — never queued, never blocking,
  // never counted in the rollup. 出货 is always present.
  stages: Partial<Record<Stage, StageState>>
  outsourceBlocks?: OutsourceBlock[]
  // 检验照片 — photos uploaded at the inspection station (part_photos table).
  // Deliberately separate from imageUrl, which is the reference image that
  // prints on 外协单 / 出货单 and must never be clobbered by defect shots.
  // Newest last. Undefined ⇒ not loaded in this view (lists); [] ⇒ loaded,
  // none yet (job detail).
  inspectionPhotos?: PartPhoto[]
  // 图纸变更 revisions for this part (migration 0067), sorted by revision asc.
  // Loaded only on the job detail (lists leave it undefined). [] ⇒ loaded,
  // none yet. See drawingChangeCount / openDrawingChange.
  drawingChanges?: PartDrawingChange[]
}

export type PartPhoto = {
  id: string
  url: string
  createdBy?: string
  createdAt: string
}

// 零件图纸变更 — one revision of a part's drawing change (migration 0067).
// revision counts up 1, 2, 3… (一次/二次/三次). `clearedAt` null = still open
// (the floor hasn't caught up to the new drawing yet).
export type PartDrawingChange = {
  id: string
  revision: number
  note?: string
  imageUrl?: string
  raisedBy?: string
  raisedAt: string
  clearedAt?: string
  clearedBy?: string
}

// The latest revision number on a part (history depth) — drives the "N次" tag.
export function drawingChangeCount(c: Component): number {
  const list = c.drawingChanges ?? []
  return list.reduce((m, d) => Math.max(m, d.revision), 0)
}

// The newest still-open (uncleared) change, if any — the red "图纸变更" flag.
export function openDrawingChange(c: Component): PartDrawingChange | undefined {
  let best: PartDrawingChange | undefined
  for (const d of c.drawingChanges ?? []) {
    if (!d.clearedAt && (!best || d.revision > best.revision)) best = d
  }
  return best
}

// 一次 / 二次 / 三次 … (Chinese ordinal for a revision number).
export function revisionLabel(rev: number): string {
  const cn = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
  return rev >= 1 && rev <= 10 ? `${cn[rev]}次` : `${rev}次`
}

// 合同文件 — a signed contract attached to an order by 财务 (migration 0066).
// Many per job; download via the proxied url, metadata shown in the 财务 tab.
export type ContractFile = {
  id: string
  url: string
  filename: string
  filesize?: number
  contentType?: string
  uploadedBy?: string
  createdAt: string
}

// 凭证 / 报销凭证 — the receipt image (or PDF) the finance person attaches to a
// 支出 row as proof. Same shape as a contract file; stored table-free in the
// bucket alongside the expense (see lib/voucher-file.ts).
export type VoucherFile = {
  id: string
  url: string
  filename: string
  filesize?: number
  contentType?: string
  uploadedBy?: string
  createdAt: string
}

// 笔记 — the boss's freeform scratchpad note (Apple-Notes style). Per-author;
// `body` is the whole note (first line doubles as the title in the list).
export type Note = {
  id: string
  authorId: string
  body: string
  createdAt: string
  updatedAt: string
}

// Best-effort line subtotal: prefer the explicitly-quoted lineTotalCny;
// otherwise derive from qty * unitPriceCny when both are present. Returns
// undefined when neither path yields a number, so callers can render "—"
// instead of forcing zero into a rollup.
export function componentLineTotal(c: Component): number | undefined {
  if (typeof c.lineTotalCny === 'number' && Number.isFinite(c.lineTotalCny)) {
    return c.lineTotalCny
  }
  if (typeof c.unitPriceCny === 'number' && Number.isFinite(c.unitPriceCny)) {
    return c.unitPriceCny * c.qty
  }
  return undefined
}

// Sum of per-component subtotals across the job — what 商务 sees as the
// breakdown total, separate from the job-level amountCny (which is the
// quoted/contract grand total and may include tax, delivery, etc).
export function jobComponentsTotal(job: Job): number {
  let sum = 0
  for (const c of job.components) sum += componentLineTotal(c) ?? 0
  return sum
}

export function partRoute(component: Component): Stage[] {
  return STAGES.filter((s) => component.stages[s] !== undefined)
}

// How many of this component's qty have been finished at this stage,
// for display. 'done' counts as full, 'in_progress' returns the running
// partial count (0 if the worker hasn't entered one yet). Anything
// else returns 0.
export function stageDoneCount(component: Component, stage: Stage): number {
  const st = component.stages[stage]
  if (!st) return 0
  if (st.status === 'done') return component.qty
  if (st.status === 'in_progress') {
    const n = st.doneQty ?? 0
    if (!Number.isFinite(n) || n < 0) return 0
    return Math.min(n, component.qty)
  }
  return 0
}

export function isStageInRoute(component: Component, stage: Stage): boolean {
  return component.stages[stage] !== undefined
}

export type JobStatus = 'parsing' | 'draft' | 'ready' | 'failed'

// 退货 — customer returns. Modeled outside STAGES on purpose; see
// supabase/migrations/0011_returns.sql for the rationale. An open return
// re-opens 工程 on the named parts; the 工程 head trims/restores the route
// from there.
export const RETURN_REASONS = [
  '尺寸不符',
  '表面瑕疵',
  '装配问题',
  '客户要求修改',
  '其他',
] as const
export type ReturnReason = (typeof RETURN_REASONS)[number]

export type ReturnPart = { partId: string; qty: number }

export type ReturnStatus = 'open' | 'closed'

export type JobReturn = {
  id: string
  jobId: string
  reason: ReturnReason
  reasonText?: string
  dueDate: string
  status: ReturnStatus
  createdAt: string
  closedAt?: string
  createdBy?: string
  parts: ReturnPart[]
}

// One printed 出货单 = one Shipment row. Each shipment is an immutable batch
// audit-log; cumulative shipped per part = sum across all the job's shipments
// for that componentId. Mostly grown via the 制作出货单 picker, which writes
// a row here per submission. createdAt is ISO so we can render local time
// down to the minute on the 出货记录 column.
export type ShipmentEntry = { componentId: string; qty: number }

export type Shipment = {
  id: string
  docNo?: string
  createdAt: string
  createdBy?: string
  parts: ShipmentEntry[]
}

// 工作交接单 — a shift/absence handover sheet. Created when someone stops
// working for a stretch (break, leave, day off) and hands their open work to
// whoever covers. Mirrors the paper form one-to-one: a header plus N line
// items. Deliberately NOT tied to a single job — one sheet spans every
// pending matter the person is carrying, so items reference jobs loosely by
// 单号 (orderNo) with an optional resolved jobId link.
export type HandoverItem = {
  id: string
  // 单号 — free text. May match a real 工号; when it does, jobId is resolved
  // so the row can link to /jobs/[id]. Kept as text too so non-order matters
  // ("交班前清点刀具") still record cleanly.
  orderNo?: string
  jobId?: string
  matter?: string // 相关事宜
  owner?: string // 责任人
  note?: string // 备注
}

export type Handover = {
  id: string
  giver: string // 交出人
  department?: string // 部门
  date: string // 日期 (YYYY-MM-DD)
  reason?: string // 交出原因
  receiver?: string // 承接人
  createdBy?: string
  createdAt: string
  items: HandoverItem[]
}

// 采购 — a single purchase. The standalone purchasing ledger anyone can write
// to. Lifecycle is a four-step conveyor plus one dead end:
//   'requested' (待审批 — someone on the floor asked for it)
//   'approved'  (待下单 — cleared; 采购 still has to place the order)
//   'ordered'   (在途 — the clock runs against 预计到货)
//   'arrived'   (待领料 — landed, waiting for its 领料人 to collect)
//   'done'      (已领料 — the month ledger)
//   'rejected'  (驳回 — dead, with the reason)
// Requests by an approver themselves skip straight to 'approved' (免审批).
// Flat by design (one row per purchase); see supabase/migrations/
// 0042_procurement.sql + 0082 (lifecycle) + 0089 (approval flow).
export type ProcurementStatus =
  | 'requested'
  | 'approved'
  | 'ordered'
  | 'arrived'
  | 'done'
  | 'rejected'

// 到料检验 — the receiving verdict. null/undefined = not inspected yet.
// 'defect' rows carry the story in inspectNote; per-supplier 良率 derives
// from these later.
export type ProcurementInspectResult = 'ok' | 'defect'

export type Procurement = {
  id: string
  item: string // 采购项 / 所需零件 (snapshot of the 物料 name at purchase time)
  productId?: string // 物料库 reference (lib/db getProcurementProducts) — optional
  link?: string // 链接 snapshot (淘宝 / 1688 / 京东) — clickable from the ledger
  qty?: number // 数量
  unitPriceCny?: number // 单价
  supplier?: string // 供应商
  orderDate: string // 采购日期 (YYYY-MM-DD) — the date ordered from
  expectedDate?: string // 预计到货 (YYYY-MM-DD) — when it should come back
  status: ProcurementStatus
  arrivedDate?: string // 实际到货 (YYYY-MM-DD)
  buyer: string // 采购人
  notes?: string // 备注
  // 关联工单 — which job this buy feeds. jobNo is a display snapshot so the
  // ledger renders without a join; both optional (shop supplies have no job).
  jobId?: string
  jobNo?: string
  // 到料检验 — set after arrival; undefined = not inspected yet.
  inspectResult?: ProcurementInspectResult
  inspectNote?: string // 不良记录 — what was wrong
  // 请购 → 审批 → 领料 trail (0089). Legacy rows carry requester = buyer and
  // no approver (they were self-serve buys, born before approvals existed).
  requester?: string // 请购人
  reqDate?: string // 请购日期 (YYYY-MM-DD)
  picker?: string // 领料人 — decided at request time, stamps the pickup
  approver?: string // 批准人
  approveDate?: string
  rejectedBy?: string
  rejectDate?: string
  rejectNote?: string // 驳回原因 — so the requester knows why
  pickDate?: string // 领料日期 (YYYY-MM-DD) — keys the 已领料 month ledger
  createdBy?: string
  createdAt: string
}

// 物料 — one reusable line in the 物料库 (procurement product catalog). The shop
// saves the things it buys repeatedly here (the 淘宝/1688 链接, the shop, the
// going price) so the next 采购 is pick-don't-retype. See
// supabase/migrations/0043_procurement_products.sql.
export type ProcurementProduct = {
  id: string
  name: string // 品名
  category?: string // 类别
  supplier?: string // 默认供应商 / 店铺
  link?: string // 链接 (淘宝 / 1688 / 京东)
  unitPriceCny?: number // 参考单价
  notes?: string // 规格 / 型号
  lastUsedAt?: string // bumped each time a 采购 picks it; drives picker sort
  createdBy?: string
  createdAt: string
}

// The 类别 a CNC shop actually sorts its buys into. Free text in the DB, but the
// 新建物料 form offers these as one-tap presets so the catalog stays tidy.
export const PROCUREMENT_CATEGORIES = [
  '刀具',
  '量具',
  '夹具',
  '原材料',
  '标准件',
  '耗材',
  '外协',
  '其他',
] as const

// 重点 — one row on a day's hand-curated focus list. The platform version of
// the "today's important jobs" Excel. Only the human facts are stored (which
// job, the 反馈 note); 交期 / 外协 / 客户 / 产品 are joined live from the
// master read at render time so they can never go stale. See
// supabase/migrations/0046_daily_focus.sql.
export type DailyFocusItem = {
  id: string
  day: string // YYYY-MM-DD — which day's list
  jobId?: string // linked job; undefined for free-text rows
  jobNoText: string // 单号 as typed (display text when unlinked; may be '')
  productText?: string // 产品 override — Excel-cell text; undefined ⇒ live join
  dueText?: string // 交期 override — Excel-cell text; undefined ⇒ live join
  feedback?: string // 反馈
  position: number // order within the day (fractional — supports insert/move)
  createdBy?: string
  createdAt: string
}

// 财务 — one row on a finance clerk's spreadsheet. Two sheets share the shape,
// switched by `sheet`: 未开票 (orders awaiting invoice, 海康 type) and 已开票
// (invoices awaiting 收款, 思看 type). Only human-typed facts are stored; 工号 /
// 客户名称 / 联系人 join live from the linked job (undefined ⇒ live). Nothing is
// computed — see supabase/migrations/0070_caiwu_rows.sql.
export type CaiwuSheet = 'weikaipiao' | 'kaipiao'

export type CaiwuRow = {
  id: string
  sheet: CaiwuSheet
  jobId?: string // linked job; undefined for free-text / multi-工号 rows
  jobNoText: string // 单号 / 内部流水号 as typed (display text when unlinked)
  customer?: string // 客户名称 override; undefined ⇒ live join
  contact?: string // 联系人 override; undefined ⇒ live join
  date?: string // 日期 / 开票日期 — free text ("4月15日")
  orderNo?: string // 订单号/物料号
  qty?: string // 下单数量
  billable?: string // 是否收费
  amount?: string // 未开票金额 / 订单金额
  tax?: string // 税金金额
  amountIncl?: string // 含税金额
  invoiceNo?: string // 发票号码
  log?: string // 开票情况 / 收款记录 — the running money log
  position: number // order within the sheet (fractional — supports insert/move)
  createdAt: string
}

export function isCaiwuSheet(x: unknown): x is CaiwuSheet {
  return x === 'weikaipiao' || x === 'kaipiao'
}

// Line total for a purchase: 数量 × 单价. Undefined when either side is
// missing — a half-specified row shows '—' rather than a misleading ¥0.
export function procurementTotalCny(p: {
  qty?: number
  unitPriceCny?: number
}): number | undefined {
  if (typeof p.qty !== 'number' || typeof p.unitPriceCny !== 'number')
    return undefined
  if (!Number.isFinite(p.qty) || !Number.isFinite(p.unitPriceCny)) return undefined
  return p.qty * p.unitPriceCny
}

// Single global classification for every job. Drives BOTH the color
// stripe/chip on the master + station rows AND the float-to-top sort.
//
//   'short'   短期  — ≤ 7 days to 交期 (auto-defaulted on import)
//   'medium'  中期  — 8–30 days (auto-defaulted on import)
//   'long'    长期  — > 30 days (auto-defaulted on import)
//   'rush'    加急  — manual escalation. Floats to the top of EVERY view
//                    (master grid + every station workbench). Replaces
//                    the old jobs.pinned_at row-level pin.
//
// `undefined` is the legacy state (rows imported before this field
// existed). The UI renders no stripe + no chip for these — clean.
export type JobType = 'short' | 'medium' | 'long' | 'rush'

export const JOB_TYPES: JobType[] = ['rush', 'short', 'medium', 'long']

export const JOB_TYPE_LABEL: Record<JobType, string> = {
  rush: '加急',
  short: '短期',
  medium: '中期',
  long: '长期',
}

// Inferred default from due-date math. Manual override on import + job
// detail. Never auto-promotes a row to 'rush' — escalation is always a
// human gesture.
export function inferJobTypeFromDueDate(
  dueDate: string,
  ref: string = new Date().toISOString().slice(0, 10),
): JobType {
  const days = daysBetween(ref, dueDate)
  if (days <= 7) return 'short'
  if (days <= 30) return 'medium'
  return 'long'
}

function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(fromISO + 'T00:00:00Z')
  const b = Date.parse(toISO + 'T00:00:00Z')
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

export type Job = {
  id: string
  jobNo: string
  customer: string
  customerId?: CustomerId
  product: string
  amountCny?: number
  dueDate: string
  // 二次交期 — optional second delivery date. Purely informational: never
  // feeds dueState/color/sort (those stay keyed off dueDate). Blank for every
  // legacy job; the floor adds it by hand. See migration 0044.
  secondaryDueDate?: string
  // 计划交期 (排产) — optional PLANNED finish date for each 工段, holistic for
  // the whole job (one plan for all parts). Keyed by PlanKey (工段 or 外协);
  // value is 'YYYY-MM-DD', or 'YYYY-MM-DDTHH:mm' when a specific hour is
  // pinned. Purely for visibility/planning: it NEVER feeds dueState / color /
  // sort / queue order — the contract dueDate still owns all of that. Keys
  // with no plan are absent from the map. See migration 0071_stage_plan.
  stagePlan?: Partial<Record<PlanKey, string>>
  notes?: string
  status?: JobStatus
  sourceFile?: string
  sourceFileUrl?: string
  parseError?: string
  shippingDocNo?: string
  // Per-doc fields for the printed 出货单.
  createdBy?: string
  contractNo?: string
  batchNo?: string
  // 工程师 — the customer's representative for this order (the floor calls
  // them 工程师; source workbooks also label the same person 联系人/对接人).
  // AI-extracted on import when present, editable inline. One field on
  // purpose — they are the same concept, not two people. Shown as
  // 客户：工程师 in the UI to disambiguate from 越侬商务 (our side).
  engineer?: string
  // 越侬商务 — OUR commercial owner for this order (越侬 = the factory side),
  // the in-house counterpart to engineer. NEVER AI-extracted: humans type it
  // in the job header. Same scrubbing as engineer (customer-facing context).
  yuenongBusiness?: string
  // ISO timestamp the job row was created. Used as the wait-timer anchor on
  // the first stage (工程) where there's no upstream finishedAt to fall back to.
  createdAt?: string
  components: Component[]
  // The single currently-open 退货, if any. Closed returns are history and
  // are fetched separately on demand (e.g. /退货 已完成 tab).
  activeReturn?: JobReturn
  // Audit log of every 出货单 printed for this job. Newest last. Empty (not
  // undefined) when nothing has shipped yet.
  shipments: Shipment[]
  // Global classification — color + priority float. See JobType.
  jobType?: JobType
  // 产品 — independent tag that coexists with jobType (a job can be both
  // 加急 and 产品). Boolean rather than a JobType value so the duration/
  // priority buckets stay mutually exclusive and 产品 stacks on top.
  isProduct?: boolean
  // 暂停 — independent "this job is blocked / on hold" flag. Coexists with
  // jobType AND isProduct (a job can be 加急 and 暂停 at once), so it's its
  // own field, not a JobType value. pausedAt doubles as the flag (undefined
  // ⇒ actively flowing) and the "blocked since" anchor; pauseReason is the
  // optional free-text why; pausedBy stamps who paused it. Carves the job
  // out of 在产 into the 暂停 column without touching the 已出货 split. See
  // migration 0050 + jobIsPaused.
  pausedAt?: string
  pauseReason?: string
  pausedBy?: string
  // 外协预警 (待外协) — 工程's upstream "this needs outsourcing" intent,
  // recorded before any vendor block (outsourceBlocks) exists. The missing
  // first stage of the outsourcing lifecycle; 商务 reads it as a pending
  // action. Cleared the moment 商务 creates the first block (→ 外协中). See
  // jobOutsourceState. outsourceNote is the engineer's free-text spec ("D20
  // 腰部零件 需外发CNC"); flaggedBy/At stamp who raised it and when.
  needsOutsource?: boolean
  outsourceNote?: string
  outsourceFlaggedBy?: string
  outsourceFlaggedAt?: string
  // 图纸变更报警 — the customer revised drawings mid-production. The one true
  // alarm in the system: raised by 商务/工程 head with a note (what changed,
  // which parts), headlines the job detail page + rows everywhere, cleared by
  // the same group once new drawings are confirmed distributed. Inform-only:
  // stations keep working. Single live alarm; clearing wipes the fields.
  drawingChangeOpen?: boolean
  drawingChangeNote?: string
  drawingChangeBy?: string
  drawingChangeAt?: string
  // Legacy fields kept on the type for snapshot compatibility (the DB column
  // still exists; nothing in the UI reads them anymore). Will be dropped
  // once the rollout is verified.
  pinnedStages?: Stage[]
  pinnedAt?: string
  pinnedBy?: string
}

// True when the job is deliberately on hold (暂停). pausedAt is both the flag
// and the "blocked since" anchor — undefined/empty ⇒ the job is flowing. A
// paused job is still not 已出货; it's carved out of 在产 into its own column.
export function jobIsPaused(job: { pausedAt?: string }): boolean {
  return Boolean(job.pausedAt)
}

// True when the boss has starred this job for prioritization at this station.
export function jobIsPinnedAtStage(job: Job, stage: Stage): boolean {
  const arr = job.pinnedStages
  if (!arr || arr.length === 0) return false
  return arr.includes(stage)
}

// True when 商务/工程 starred this row on the master grid.
export function jobIsPinned(job: Job): boolean {
  return Boolean(job.pinnedAt)
}

// === Shipment helpers ===

// Sum of all batches that have shipped this component so far.
export function componentShippedTotal(
  componentId: string,
  shipments: Shipment[],
): number {
  let n = 0
  for (const s of shipments) {
    for (const p of s.parts) if (p.componentId === componentId) n += p.qty
  }
  return n
}

export function componentRemainingQty(
  component: Component,
  shipments: Shipment[],
): number {
  return Math.max(0, component.qty - componentShippedTotal(component.id, shipments))
}

// Per-component shipment history, sorted by createdAt ascending.
export function componentShipmentEntries(
  componentId: string,
  shipments: Shipment[],
): Array<{ qty: number; createdAt: string; docNo?: string }> {
  const rows: Array<{ qty: number; createdAt: string; docNo?: string }> = []
  for (const s of shipments) {
    for (const p of s.parts) {
      if (p.componentId !== componentId) continue
      rows.push({ qty: p.qty, createdAt: s.createdAt, docNo: s.docNo })
    }
  }
  rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  return rows
}

// Single newline-separated string for the 出货记录 column: each line reads
// "YYYY-MM-DD HH:mm N/T" — this batch's shipped qty over the part's total qty
// (the qty column). Empty string when the part has nothing shipped yet so
// callers can branch on falsiness.
export function formatShipmentLog(
  entries: Array<{ qty: number; createdAt: string }>,
  totalQty: number,
): string {
  if (entries.length === 0) return ''
  return entries
    .map((e) => `${formatShipmentTimestamp(e.createdAt)} ${e.qty}/${totalQty}`)
    .join('\n')
}

// Asia/Shanghai-ish local display. The DB stores ISO UTC; the floor reads in
// local time. We don't pull in a tz library — toLocaleString with zh-CN +
// fixed timeZone keeps the print output predictable across server vs. client.
export function formatShipmentTimestamp(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const d = new Date(t)
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  // zh-CN renders as "2026/05/11 21:14"; flip to ISO-style for consistency
  // with the rest of the doc (YYYY-MM-DD HH:mm).
  const parts = fmt.formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

// 动态 column timestamp — "MM-DD HH:mm" in factory-local (Asia/Shanghai) time.
// The DB stores stage timestamps as UTC ISO strings; the floor reads them in
// Beijing time. Drops the year (the 动态 column is always recent) for a tight
// two-line cell. Falls back to the raw string if it isn't parseable ISO (e.g.
// a legacy MM-DD completedAt with no hour — shown date-only by the caller).
export function formatActivityTimestamp(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(t))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

// The single most recent human action on a component, derived purely from its
// stage rows: who clicked, when, and what they did. Powers the 工单详情 动态
// column. "Action" is one of 起步 / 完成 / a 检验 verdict — the gestures a
// worker makes on a stage cell. We pick the event with the latest precise ISO
// timestamp (start/finish/verdict all stamp one); if a part only carries a
// legacy MM-DD completedAt (pre-finishedAt rows), we fall back to that so the
// column is never blank on a part that has clearly moved. `when` is the ISO
// instant when known (→ formatted with hours) or a bare MM-DD legacy date.
export type ComponentActivity = {
  when: string
  hasTime: boolean
  by: string
  action: string
  stage: Stage
}

export function latestComponentActivity(
  component: Component,
): ComponentActivity | null {
  const candidates: { sort: number; ev: ComponentActivity }[] = []
  const consider = (
    iso: string | undefined,
    by: string | undefined,
    action: string,
    stage: Stage,
  ) => {
    if (!iso || !by) return
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return
    candidates.push({
      sort: t,
      ev: { when: iso, hasTime: true, by, action, stage },
    })
  }

  for (const stage of STAGES) {
    const st = component.stages[stage]
    if (!st) continue
    // ▶ 起步 — names the starter (startedBy), distinct from the finisher.
    consider(st.startedAt, st.startedBy, '起步', stage)
    // 检验 verdict — the inspector's gesture. 'OK' shares finishedAt/by with a
    // normal finish, so we render it as the verdict and skip the generic 完成
    // below to avoid a duplicate at the same instant.
    if (st.verdict) {
      // The stage suffix (· 检验) already names the station, so the action is
      // just the verdict — avoids "检验 返修 · 检验".
      const action = st.verdict === 'OK' ? '通过' : st.verdict
      consider(st.verdictAt, st.verdictBy, action, stage)
    }
    // ✓ 收件 / 完成 — the finisher.
    if (st.status === 'done' && !(stage === '检验' && st.verdict)) {
      consider(st.finishedAt, st.by, '完成', stage)
    }
  }
  if (candidates.length > 0) {
    return candidates.reduce((a, b) => (b.sort > a.sort ? b : a)).ev
  }

  // Legacy fallback: no ISO-stamped event anywhere, but a stage finished with
  // only a MM-DD completedAt. Surface the lexically-latest such date so old
  // jobs still show their last move (date-only, no hour).
  let legacy: ComponentActivity | null = null
  for (const stage of STAGES) {
    const st = component.stages[stage]
    if (!st || st.status !== 'done' || !st.completedAt || !st.by) continue
    if (!legacy || st.completedAt > legacy.when) {
      legacy = {
        when: st.completedAt,
        hasTime: false,
        by: st.by,
        action: '完成',
        stage,
      }
    }
  }
  return legacy
}

// Most recent printed batch for a job — drives the read-only 出货单 preview.
export function latestShipment(job: Job): Shipment | undefined {
  if (!job.shipments.length) return undefined
  let best = job.shipments[0]
  for (let i = 1; i < job.shipments.length; i++) {
    if (job.shipments[i].createdAt > best.createdAt) best = job.shipments[i]
  }
  return best
}

// Pick a specific shipment to print. The 出货记录 history deep-links each past
// batch (?shipment=<id>); everything else (制作出货单 / 重新打印) prints the
// latest. Falls back to the latest when the id is absent or no longer exists.
export function selectShipment(
  job: Job,
  id?: string | null,
): Shipment | undefined {
  if (id) {
    const found = job.shipments.find((s) => s.id === id)
    if (found) return found
  }
  return latestShipment(job)
}

// Job has shipped iff every in-route part is done at 出货. Returns can only
// be opened against shipped jobs.
export function jobIsShipped(job: Job): boolean {
  return jobIsDoneAtStage(job, '出货')
}

// Effective due date: while a return is open, the return's internal deadline
// drives master-grid color/sort. Original dueDate resumes once closed.
export function jobEffectiveDueDate(job: Job): string {
  return job.activeReturn?.dueDate ?? job.dueDate
}

// Set of part ids re-opened by the active return. Empty when no open return.
export function jobReturnedPartIds(job: Job): Set<string> {
  if (!job.activeReturn) return new Set()
  return new Set(job.activeReturn.parts.map((p) => p.partId))
}

// Per-part returned qty for the active return. Used to mark each affected
// component row with "退 N / M" so the floor can see how many units of that
// part actually came back — the modal captures the number but nothing
// surfaced it post-submit.
export function jobReturnedQtyByPart(job: Job): Map<string, number> {
  const m = new Map<string, number>()
  if (!job.activeReturn) return m
  for (const p of job.activeReturn.parts) m.set(p.partId, p.qty)
  return m
}

// Parse a YNMX-style 工号 of the form `YNMX-YY-M-D-NNN`. The trailing NNN is
// a monthly cumulative counter; the YY-M-D is the 生产日 (the day production
// was logged for this job), NOT the due date. Returns null for free-text 工号
// so callers can fall back gracefully — legacy rows still display, they just
// don't participate in 按工号 sort or 生产日 filtering.
export type JobNoParts = { intakeDate: string; seq: number }

export function parseJobNo(jobNo: string | undefined): JobNoParts | null {
  if (!jobNo) return null
  const m = jobNo.trim().match(/^[A-Z][A-Z0-9]*-(\d{2})-(\d{1,2})-(\d{1,2})-(\d+)$/i)
  if (!m) return null
  const yy = parseInt(m[1], 10)
  const mm = parseInt(m[2], 10)
  const dd = parseInt(m[3], 10)
  const seq = parseInt(m[4], 10)
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  const iso = `20${String(yy).padStart(2, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
  return { intakeDate: iso, seq }
}

export function jobIntakeDate(job: { jobNo: string | undefined } | Pick<Job, 'jobNo'>): string | undefined {
  return parseJobNo(job.jobNo)?.intakeDate
}

// Sort key for 按工号 mode. Parsed jobs lex-sort by (intakeDate desc, seq desc)
// — newest at top. Unparseable 工号 sink to the bottom, preserving caller order.
export function jobNoSortKey(job: { jobNo: string | undefined } | Pick<Job, 'jobNo'>): string {
  const p = parseJobNo(job.jobNo)
  if (!p) return '￿' // ensures unparseable rows sink below any parsed key
  // Negate by subtracting from a high constant so DESC sorts naturally as ASC
  // string compare. seq capped at 99999 — no factory hits 6 digits in a month.
  const seqInv = 99999 - Math.min(99999, p.seq)
  // Date inversion: epoch days from 9999-12-31 minus the intake date.
  // Cheap inversion via lex-comparable inverted ISO: replace each digit d with (9-d).
  const dateInv = p.intakeDate.replace(/\d/g, (d) => String(9 - parseInt(d, 10)))
  return `${dateInv}-${String(seqInv).padStart(5, '0')}`
}

import { today } from './today'

// No seed jobs. Real data comes from the import flow.
export const JOBS: Job[] = []

export type RollupKind = 'pending' | 'partial' | 'done' | 'na'

export type Rollup = {
  kind: RollupKind
  done: number
  total: number
  latestDate?: string
  /** 经手 — name of the most recent finisher at this stage (master-grid hover). */
  latestBy?: string
  /** Count of parts at this stage currently at a vendor (open outsource block).
   * Folded INTO `done` for the in-house worker's POV (nothing to do here),
   * but tracked separately so the UI can surface a 外协 indicator on the
   * cell — the boss/operator should see at a glance which work is offsite. */
  outsourcedOpen?: number
}

export function canStartStage(component: Component, stage: Stage): boolean {
  // Stage not in this part's route — never startable.
  const st = component.stages[stage]
  if (!st) return false
  const blocks = component.outsourceBlocks ?? []
  // Per-stage gate only — a block covering OTHER stages on this part doesn't
  // block in-house work on stages the vendor isn't handling. Workers click
  // through their own stages as if the part were fully in-house.
  // 出货 is always in-house regardless of any block.
  if (stage !== '出货') {
    for (const b of blocks) {
      if (!b.stages.includes(stage)) continue
      const m = memberFor(b, component.id)
      if (m === undefined) continue
      // Vendor owns this stage — open (still at vendor) or closed (vendor did
      // it on return). Either way, in-house worker doesn't touch it.
      return false
    }
  }
  // Permissive: any pending in-house stage can be started — workers can grab
  // a part at any point. Finish only marks this stage; earlier stages stay
  // pending until their own heads sign off (出货 is the exception — see
  // cascadeBackFinish in lib/db.ts).
  return st.status === 'pending'
}

export function rollupStage(job: Job, stage: Stage): Rollup {
  // Parts where the stage isn't in the route are n/a — excluded from the
  // denominator, so a "no paint" part doesn't show as eternally pending in
  // the 喷漆 column.
  const effs = job.components
    .filter((c) => isStageInRoute(c, stage))
    .map((c) => effectiveStageState(c, stage))
  const total = effs.length
  let done = 0
  let inProgress = 0
  let outsourcedOpen = 0
  const dates: string[] = []
  for (const e of effs) {
    if (e.kind === 'done') {
      done++
      if (e.completedAt) dates.push(e.completedAt)
    } else if (e.kind === 'outsourced') {
      // Vendor is handling it — nothing for the in-house worker to do at this
      // stage. From the rollup's POV, count as done so a job with all parts
      // either finished in-house or sent out reads as ✓ rather than partial.
      // Also tracked separately so the cell can surface a 外协 indicator.
      done++
      outsourcedOpen++
    } else if (e.kind === 'in_progress') {
      inProgress++
    }
  }
  const latestDate = dates.length ? dates.sort().at(-1) : undefined
  // No part in this job needs the stage at all.
  if (total === 0) return { kind: 'na', done: 0, total: 0, latestDate: undefined }
  if (done === 0) {
    return {
      kind: inProgress > 0 ? 'partial' : 'pending',
      done,
      total,
      latestDate,
      outsourcedOpen,
    }
  }
  if (done === total) return { kind: 'done', done, total, latestDate, outsourcedOpen }
  return { kind: 'partial', done, total, latestDate, outsourcedOpen }
}

// True iff at least one part on this job is currently at a vendor (an open
// outsource block exists for some non-出货 stage in the part's route). Used
// by the master board to flag the row with a 外协 chip.
export function jobHasOpenOutsource(job: Job): boolean {
  for (const c of job.components) {
    for (const b of c.outsourceBlocks ?? []) {
      const m = memberFor(b, c.id)
      if (m && !isMemberFullyReturned(m)) return true
    }
  }
  return false
}

// True iff this job has any outsource block at all (open OR fully returned).
// Used to distinguish the engineer's pending 待外协 flag (no block yet) from a
// job that has already entered the operational outsourcing flow.
export function jobHasAnyOutsourceBlock(job: Job): boolean {
  for (const c of job.components) {
    if ((c.outsourceBlocks?.length ?? 0) > 0) return true
  }
  return false
}

export type OutsourceState = '待外协' | '外协中' | '已回'

// The job's position in the outsourcing lifecycle, or null when outsourcing
// doesn't apply to it. This is the single source of truth the boss circled:
// 工程 flags 待外协 → 商务 makes a vendor block (外协中) → vendor returns (已回).
//   待外协 — engineer flagged, no vendor block yet (商务's todo).
//   外协中 — at least one part still at a vendor.
//   已回   — had outsourcing, everything is back.
// Open block wins over the flag so a stale needsOutsource never masks live
// vendor state; in practice createOutsourceBlockAt clears the flag anyway.
export function jobOutsourceState(job: Job): OutsourceState | null {
  if (jobHasOpenOutsource(job)) return '外协中'
  if (jobHasAnyOutsourceBlock(job)) return '已回'
  if (job.needsOutsource) return '待外协'
  return null
}

export type DueState = 'overdue' | 'today' | 'soon' | 'normal'

export function dueState(dueDate: string, ref: string = today()): DueState {
  if (dueDate < ref) return 'overdue'
  if (dueDate === ref) return 'today'
  const [y1, m1, d1] = ref.split('-').map(Number)
  const [y2, m2, d2] = dueDate.split('-').map(Number)
  const t = Date.UTC(y1, m1 - 1, d1)
  const u = Date.UTC(y2, m2 - 1, d2)
  const days = (u - t) / 86_400_000
  if (days <= 2) return 'soon'
  return 'normal'
}

export function daysFromToday(dueDate: string, ref: string = today()): number {
  const [y1, m1, d1] = ref.split('-').map(Number)
  const [y2, m2, d2] = dueDate.split('-').map(Number)
  const t = Date.UTC(y1, m1 - 1, d1)
  const u = Date.UTC(y2, m2 - 1, d2)
  return Math.round((u - t) / 86_400_000)
}

// --- 计划交期 (排产) helpers ------------------------------------------------
// A plan value is 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm'. These split helpers keep
// the day-math (dueState/daysFromToday parse a bare YYYY-MM-DD) safe from the
// optional time suffix.
export function planDatePart(plan: string): string {
  return plan.slice(0, 10)
}

export function planTimePart(plan: string): string | undefined {
  return plan.length >= 16 ? plan.slice(11, 16) : undefined
}

// Human label for a plan value: '5/20' or '5/20 14:00' — no leading zeros on
// the date (matches the DatePop trigger style), HH:mm when an hour is pinned.
export function fmtPlanLabel(plan: string | undefined): string {
  if (!plan) return '—'
  const [, m, d] = planDatePart(plan).split('-').map(Number)
  const base = `${m}/${d}`
  const t = planTimePart(plan)
  return t ? `${base} ${t}` : base
}

export type StagePlanTone = 'slipping' | 'due' | 'soon' | 'onTrack' | 'done'

// A stage's status vs its plan, for tinting. Returns null when there's nothing
// to show — no plan set, or the stage isn't in this job's route (na). 'done'
// means the stage is finished (target met; never a slip regardless of date).
// Otherwise it compares the plan's DATE to today, day-granular on purpose so
// the color matches dueState and a pinned hour never flips the tint mid-day —
// the hour is shown for planning, the day drives urgency.
export function stagePlanState(
  plan: string | undefined,
  rollupKind: RollupKind,
  ref: string = today(),
): { tone: StagePlanTone; daysOff: number } | null {
  if (!plan) return null
  if (rollupKind === 'na') return null
  if (rollupKind === 'done') return { tone: 'done', daysOff: 0 }
  const date = planDatePart(plan)
  const ds = dueState(date, ref)
  const daysOff = daysFromToday(date, ref)
  const tone: StagePlanTone =
    ds === 'overdue'
      ? 'slipping'
      : ds === 'today'
        ? 'due'
        : ds === 'soon'
          ? 'soon'
          : 'onTrack'
  return { tone, daysOff }
}

export function formatCny(amount?: number | null): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—'
  return `¥${new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }).format(amount)}`
}


// Vendors are user-created at runtime. No seed contractors — fresh start.
export const VENDORS: Vendor[] = []

export function vendorById(id: VendorId, vendors: Vendor[] = VENDORS): Vendor | undefined {
  return vendors.find((v) => v.id === id)
}

export function vendorName(id: VendorId | undefined, vendors: Vendor[] = VENDORS): string {
  if (!id) return '—'
  return vendorById(id, vendors)?.name ?? id
}

// Customers — same shape contract as vendors. Created lazily when a name is
// first picked/typed in the 出货单 combobox.
export const CUSTOMERS: Customer[] = []

export function customerById(
  id: CustomerId | undefined,
  customers: Customer[] = CUSTOMERS,
): Customer | undefined {
  if (!id) return undefined
  return customers.find((c) => c.id === id)
}

export function customerByName(
  name: string | undefined,
  customers: Customer[] = CUSTOMERS,
): Customer | undefined {
  if (!name) return undefined
  const target = name.trim().toLowerCase()
  if (!target) return undefined
  return customers.find((c) => c.name.trim().toLowerCase() === target)
}

export type EffectiveStageState =
  | { kind: 'pending'; canStart: boolean }
  | { kind: 'in_progress'; by?: string }
  | { kind: 'done'; completedAt?: string; by?: string }
  | { kind: 'outsourced'; block: OutsourceBlock; vendor?: Vendor }
  | { kind: 'na' }

// Per-part: a block "covers" this part at this stage when the block's stage
// list includes the stage AND this part is in the block's members.
// "Open" = part hasn't returned yet; "closed" = part has its returnedAt set.
function findOpenBlockCovering(
  component: Component,
  stage: Stage,
): { block: OutsourceBlock; member: OutsourceBlockMember } | undefined {
  for (const b of component.outsourceBlocks ?? []) {
    if (!b.stages.includes(stage)) continue
    const m = memberFor(b, component.id)
    if (m && !isMemberFullyReturned(m)) return { block: b, member: m }
  }
  return undefined
}

function findClosedBlockCovering(
  component: Component,
  stage: Stage,
): { block: OutsourceBlock; member: OutsourceBlockMember } | undefined {
  for (const b of component.outsourceBlocks ?? []) {
    if (!b.stages.includes(stage)) continue
    const m = memberFor(b, component.id)
    if (m && isMemberFullyReturned(m)) return { block: b, member: m }
  }
  return undefined
}

export function effectiveStageState(
  component: Component,
  stage: Stage,
  vendors: Vendor[] = VENDORS,
): EffectiveStageState {
  const st = component.stages[stage]
  if (!st) return { kind: 'na' }
  // 出货 is always in-house — block coverage of 出货 is meaningless on legacy
  // full-stage blocks, so we ignore it here and trust the in-house status.
  const open = stage === '出货' ? undefined : findOpenBlockCovering(component, stage)
  if (open) {
    return {
      kind: 'outsourced',
      block: open.block,
      vendor: vendorById(open.block.vendorId, vendors),
    }
  }
  const closed =
    stage === '出货' ? undefined : findClosedBlockCovering(component, stage)
  if (closed) {
    return {
      kind: 'done',
      completedAt: closed.member.returnedAt,
      by: vendorById(closed.block.vendorId, vendors)?.name ?? closed.block.vendorId,
    }
  }
  if (st.status === 'pending') {
    return { kind: 'pending', canStart: canStartStage(component, stage) }
  }
  if (st.status === 'in_progress') {
    return { kind: 'in_progress', by: st.by }
  }
  return { kind: 'done', completedAt: st.completedAt, by: st.by }
}

export function isComponentDone(component: Component): boolean {
  // Stages outside the part's route count as already-done (n/a) — a component
  // with only {工程, 编程, 出货} is "done" once those three are done.
  return STAGES.every((s) => {
    const eff = effectiveStageState(component, s)
    return eff.kind === 'done' || eff.kind === 'na'
  })
}

// === Per-job, per-stage station-view helpers ===
//
// Centralized so the server-rendered StationSummary and the client-rendered
// MasterSheet agree pixel-for-pixel on what counts as "mine," "done," or
// "upstream" at a given station. Drift between the two showed up as the
// dreaded "在此 5" + table only listing 4 rows mismatch.

// "Mine" = the head genuinely owes this work TODAY. A part qualifies when
// it's in_progress here, or pending here AND every prior in-route stage is
// effectively done. Permissive cascade-from-pending starts don't count —
// upstream has to actually hand off first.
export function jobIsMineAtStage(job: Job, stage: Stage): boolean {
  const stageIdx = STAGES.indexOf(stage)
  for (const c of job.components) {
    if (!isStageInRoute(c, stage)) continue
    const me = c.stages[stage]
    if (!me) continue
    const effHere = effectiveStageState(c, stage)
    if (effHere.kind === 'in_progress') return true
    if (effHere.kind === 'pending' && effHere.canStart) {
      let allPriorEffDone = true
      for (let i = 0; i < stageIdx; i++) {
        if (!isStageInRoute(c, STAGES[i])) continue
        const prior = effectiveStageState(c, STAGES[i])
        if (prior.kind === 'done' || prior.kind === 'na') continue
        allPriorEffDone = false
        break
      }
      if (allPriorEffDone) return true
    }
  }
  return false
}

// Done for a station board = no in-house work remains at this station.
// A vendor-owned stage (`outsourced`) is handled from the station head's point
// of view, and `rollupStage` already shows it as done with an 外协 marker.
// Keep this helper aligned with that rollup so rows do not disappear between
// the active queue and the greyed "recently handled" tier.
export function jobIsDoneAtStage(job: Job, stage: Stage): boolean {
  let any = false
  for (const c of job.components) {
    if (!isStageInRoute(c, stage)) continue
    any = true
    const eff = effectiveStageState(c, stage)
    if (eff.kind === 'done' || eff.kind === 'na' || eff.kind === 'outsourced') {
      continue
    }
    return false
  }
  return any
}

// Sort key for the "最近完成" tier — latest finish across in-route components
// at this stage. Prefers ISO finishedAt (precise); falls back to MM-DD
// completedAt for legacy rows / outsourced-as-done. ISO timestamps lex-sort
// after MM-DD, so precise finishes rise to the top — desired.
export function jobMostRecentFinishedAt(job: Job, stage: Stage): string {
  let best = ''
  for (const c of job.components) {
    if (!isStageInRoute(c, stage)) continue
    const st = c.stages[stage]
    if (!st) continue
    const eff = effectiveStageState(c, stage)
    if (eff.kind !== 'done') continue
    const ts = st.finishedAt ?? eff.completedAt ?? st.completedAt ?? ''
    if (ts > best) best = ts
  }
  return best
}

// Upstream = job visits this stage, isn't mine yet, and at least one prior
// in-route stage is still pending / in_progress / outsourced. Done-only
// upstream means it's actually mine (handled above); no upstream activity
// at all means it's just "filed" — exclude.
export function jobIsUpstreamOfStage(job: Job, stage: Stage): boolean {
  const stageIdx = STAGES.indexOf(stage)
  let hasStageInRoute = false
  let anyPriorActive = false
  for (const c of job.components) {
    if (!isStageInRoute(c, stage)) continue
    hasStageInRoute = true
    for (let i = 0; i < stageIdx; i++) {
      if (!isStageInRoute(c, STAGES[i])) continue
      const eff = effectiveStageState(c, STAGES[i])
      if (
        eff.kind === 'in_progress' ||
        eff.kind === 'pending' ||
        eff.kind === 'outsourced'
      ) {
        anyPriorActive = true
        break
      }
    }
    if (anyPriorActive) break
  }
  return hasStageInRoute && anyPriorActive
}

// Per-stage in-house counts — what JobStageActionButton needs to pick its
// pending / in_progress / done aggregate state. Outsourced and n/a parts
// don't contribute (vendor's responsibility / not in route).
export function jobStageCounts(job: Job, stage: Stage): {
  inProgress: number
  pending: number
  done: number
} {
  let inProgress = 0
  let pending = 0
  let done = 0
  for (const c of job.components) {
    if (!isStageInRoute(c, stage)) continue
    const eff = effectiveStageState(c, stage)
    if (eff.kind === 'in_progress') inProgress++
    else if (eff.kind === 'pending') pending++
    else if (eff.kind === 'done') done++
  }
  return { inProgress, pending, done }
}

// Anchor timestamp for the live RowTimer at the station-highlight cell.
// in_progress wins over pending; pending falls back to the latest done
// upstream stage's finishedAt (= when the work physically arrived here).
// At the first stage there is no upstream, so we fall back to the job's
// createdAt — that's when the job landed on the production board and 工程
// became eligible to start. Returns null when there's no work at this stage,
// or when the timestamps pre-date the started_at/finished_at migration.
export function jobTimerAtStage(
  job: Job,
  stage: Stage,
): { since: string; tone: 'pending' | 'in_progress' } | null {
  const stageIdx = STAGES.indexOf(stage)
  let inProgressEarliest: number | null = null
  let pendingArrivedEarliest: number | null = null
  let hasPendingHere = false
  for (const c of job.components) {
    const eff = effectiveStageState(c, stage)
    if (eff.kind === 'in_progress') {
      const st = c.stages[stage]
      if (st?.startedAt) {
        const t = Date.parse(st.startedAt)
        if (Number.isFinite(t)) {
          inProgressEarliest =
            inProgressEarliest === null ? t : Math.min(inProgressEarliest, t)
        }
      }
    } else if (eff.kind === 'pending') {
      hasPendingHere = true
      let arrived: number | null = null
      for (let i = stageIdx - 1; i >= 0; i--) {
        const upstream = c.stages[STAGES[i]]
        if (upstream?.status === 'done' && upstream.finishedAt) {
          const t = Date.parse(upstream.finishedAt)
          if (Number.isFinite(t)) {
            arrived = t
            break
          }
        }
      }
      if (arrived !== null) {
        pendingArrivedEarliest =
          pendingArrivedEarliest === null
            ? arrived
            : Math.min(pendingArrivedEarliest, arrived)
      }
    }
  }
  if (inProgressEarliest !== null) {
    return {
      since: new Date(inProgressEarliest).toISOString(),
      tone: 'in_progress',
    }
  }
  if (pendingArrivedEarliest !== null) {
    return {
      since: new Date(pendingArrivedEarliest).toISOString(),
      tone: 'pending',
    }
  }
  // First-stage fallback: no upstream to anchor against, so use the job's
  // createdAt. Without this, 工程 rows never show a wait timer and the head
  // can't tell at a glance which incoming jobs have been sitting longest.
  if (hasPendingHere && job.createdAt) {
    const t = Date.parse(job.createdAt)
    if (Number.isFinite(t)) {
      return { since: new Date(t).toISOString(), tone: 'pending' }
    }
  }
  return null
}

// Average minutes a JOB spends at this station — from the first start click
// (earliest startedAt across the job's in-route components) to the last
// finish click (latest finishedAt). One sample per job, only when every
// in-route component for the stage is done with both timestamps set;
// cascade-back-filled stages skip startedAt and would skew the number, and
// partial completion would understate the flow time.
//
// Returns null when sample size < 3 — better than rendering noise as a
// load-bearing number on day one of rollout.
export function avgStageFlowMinutes(
  jobs: Job[],
  stage: Stage,
  minSamples = 3,
  windowSize = 50,
): number | null {
  type Sample = { minutes: number; finishedAt: number }
  const samples: Sample[] = []
  for (const job of jobs) {
    let earliestStart = Number.POSITIVE_INFINITY
    let latestFinish = Number.NEGATIVE_INFINITY
    let routed = 0
    let usable = true
    for (const c of job.components) {
      if (!isStageInRoute(c, stage)) continue
      routed++
      const st = c.stages[stage]
      if (!st || st.status !== 'done' || !st.startedAt || !st.finishedAt) {
        usable = false
        break
      }
      const start = Date.parse(st.startedAt)
      const end = Date.parse(st.finishedAt)
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        usable = false
        break
      }
      if (start < earliestStart) earliestStart = start
      if (end > latestFinish) latestFinish = end
    }
    if (!usable || routed === 0) continue
    samples.push({
      minutes: (latestFinish - earliestStart) / 60_000,
      finishedAt: latestFinish,
    })
  }
  if (samples.length < minSamples) return null
  // Most recent first, take the trailing window so the number tracks current
  // shop reality rather than week-old pace.
  samples.sort((a, b) => b.finishedAt - a.finishedAt)
  const recent = samples.slice(0, windowSize)
  const total = recent.reduce((s, r) => s + r.minutes, 0)
  return total / recent.length
}

// Format a minute count as the most natural unit at hour resolution.
// Designed for the StationSummary card: large, scannable, no overprecise
// tail. Sub-hour values round to the nearest hour (with a "<1时" floor so a
// real but tiny average still reads as a number rather than 0).
export function formatMinutes(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return '—'
  const hours = m / 60
  if (hours < 24) {
    const h = Math.round(hours)
    return h < 1 ? '<1时' : `${h} 时`
  }
  const days = hours / 24
  return `${days.toFixed(days < 10 ? 1 : 0)} 天`
}

export function jobExternalSpend(job: Job): number {
  // A block spanning N components is attached to each component's
  // outsourceBlocks list — dedupe by id before summing or a multi-member
  // block gets counted N times. See allOutsourceBlocks() for the same dedupe.
  let total = 0
  const seen = new Set<string>()
  for (const c of job.components) {
    for (const b of c.outsourceBlocks ?? []) {
      if (seen.has(b.id)) continue
      seen.add(b.id)
      // 加急 blocks ship before commerce sets a block-level 金额 — fall back to
      // the per-member line totals (单价 × 数量) so 外/利 reflect rush pricing
      // too. Still 0 (skipped) when neither a block amount nor any line price
      // exists, so the chips never go NaN on a genuinely unpriced block.
      const spend = b.amountCny ?? blockLineTotalsSum(b)
      if (spend != null) total += spend
    }
  }
  return total
}

export function jobMargin(job: Job): number | undefined {
  if (typeof job.amountCny !== 'number') return undefined
  return job.amountCny - jobExternalSpend(job)
}

export type OpenBlockRow = {
  jobId: string
  jobNo: string
  customer: string
  product: string
  block: OutsourceBlock
}

export function openOutsourceBlocks(jobs: Job[]): OpenBlockRow[] {
  return allOutsourceBlocks(jobs).filter((r) => !isBlockClosed(r.block))
}

export function allOutsourceBlocks(jobs: Job[]): OpenBlockRow[] {
  // Dedupe by block.id — a block now spans N components but should appear
  // once in cockpit/aggregations.
  const rows: OpenBlockRow[] = []
  const seen = new Set<string>()
  for (const job of jobs) {
    for (const c of job.components) {
      for (const b of c.outsourceBlocks ?? []) {
        if (seen.has(b.id)) continue
        seen.add(b.id)
        rows.push({
          jobId: job.id,
          jobNo: job.jobNo,
          customer: job.customer,
          product: job.product,
          block: b,
        })
      }
    }
  }
  return rows
}

export function stageRangeLabel(stages: Stage[]): string {
  if (stages.length === 0) return '—'
  if (stages.length === 1) return stages[0]
  // List every covered stage, dot-separated — reads as plain words, no arrows.
  const ordered = STAGES.filter((s) => stages.includes(s))
  return ordered.join(' · ')
}

export function isFullStageCoverage(stages: Stage[]): boolean {
  // Match the current default (OUTSOURCEABLE_STAGES — excludes 工程/采购/出货)
  // plus every older "all of it" shape still in legacy data: 7 (pre-检验
  // OUTSOURCEABLE), 8 (pre-采购/表处 OUTSOURCEABLE), 9/10 (the old
  // PRODUCTION/STAGES lengths). Blocks are per-part stage subsets, so any of
  // these lengths only ever occurs on a genuinely whole-process dispatch.
  return (
    stages.length === OUTSOURCEABLE_STAGES.length ||
    stages.length === PRODUCTION_STAGES.length ||
    stages.length === STAGES.length ||
    stages.length === 7 ||
    stages.length === 8 ||
    stages.length === 10
  )
}

// New outsource blocks cover the full production process — show "全程" for
// those, keep the range label for legacy partial blocks still in the dataset.
export function outsourceLabel(stages: Stage[]): string {
  if (isFullStageCoverage(stages)) return '全程'
  return stageRangeLabel(stages)
}
