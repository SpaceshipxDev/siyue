import { Fragment } from 'react'
import { notFound, redirect } from 'next/navigation'
import { withBase } from '@/lib/base-path'
import {
  STAGES,
  componentShipmentEntries,
  daysFromToday,
  dueState,
  effectiveStageState,
  formatActivityTimestamp,
  formatCny,
  formatShipmentLog,
  isBlockClosed,
  isBlockingVerdict,
  jobComponentsTotal,
  jobExternalSpend,
  jobIsShipped,
  jobMargin,
  jobOutsourceState,
  jobReturnedQtyByPart,
  latestComponentActivity,
  openDrawingChange,
  PLANNABLE_STAGES,
  rollupStage,
  type Job,
  type PlanKey,
  type RollupKind,
} from '@/lib/data'
import { ensureVendorPortalTokens, getJob, getVendors } from '@/lib/db'
import { logJobView } from '@/lib/access-log'
import { getContractFiles } from '@/lib/contract-file'
import { BRAND } from '@/lib/brand'
import {
  canCreatePartRow,
  canDeletePartRow,
  canEditPartRoute,
  canEditProductionFields,
  canExportProductionOrder,
  canManageOutsource,
  canSeeCustomerData,
  canSeeMoney,
  canSeeReport,
  canSeeOrderLedger,
  requireUser,
} from '@/lib/auth'
import { scrubJob, scrubVendors } from '@/lib/dto'
import { StageHeader, TopBar, type TabKey } from '@/app/_ui'
import { EffectiveStageCell } from '@/app/_stagecell'
import { BackButton } from '@/app/_back'
import {
  ComponentLineTotal,
  ComponentNotes,
  ComponentQty,
  ComponentText,
  ComponentUnitPrice,
  JobAmount,
  JobDueDate,
  JobSecondaryDueDate,
  JobNotes,
  JobShippingText,
  JobText,
} from '@/app/_editable'
import { WaixieTable } from './_waixie'
import { OutsourceFlag } from '@/app/_outsource_flag'
import { ExternalBadge } from '@/app/_externalbadge'
import { ComponentImageUploader } from '@/app/_image_uploader'
import { StageChips } from '@/app/_stagechips'
import { ComponentsScrollArea } from '@/app/_components_table'
import {
  JobPartFilterProvider,
  JobPartFilterSummary,
  JobPartStageFunnel,
} from '@/app/_part_filter'
import { StagePlanDate } from '@/app/_stage_plan'
import { PART_STAGE_CODE } from '@/lib/part-status'
import { ComponentAnchorScroller } from '@/app/_component_anchor'
import { JobTabs } from './_job_tabs'
import { SourceFileRow } from '@/app/_source_file'
import { ProductionOrderRow } from '@/app/_production_order'
import { ContractFiles } from '@/app/_contract_files'
import { JobMoneyEditor } from '@/app/_money_popover'
import {
  ActiveReturnBadge,
  OpenReturnButton,
  ReturnedComponentChip,
} from '@/app/_returns'
import { DrawingChangeBanner } from '@/app/_drawing_change'
import { PartDrawingChange } from '@/app/_part_drawing_change'
import { ShippingComposerButton } from '@/app/_shipping'
import { ShipmentHistoryButton } from '@/app/_shipment_history'
import { JobTypeEditor } from '@/app/_type_chip'
import { DeletePartButton } from './_part_delete'
import {
  InsertedRows,
  PartInsertProvider,
  PartOrdinal,
  PartsTailRoom,
  RowInsert,
} from './_part_insert'

// Intentionally not `force-dynamic`. The page still ends up dynamic because
// `requireUser()` reads cookies and `getJob` is uncached, but leaving Next's
// default in place lets the master board's <Link prefetch> warm the static
// shell (loading.tsx) into the router cache. China clients get the skeleton
// rendered instantly on click; the real content streams in behind it.
export default async function JobDetail(props: PageProps<'/jobs/[id]'>) {
  const user = await requireUser()
  const { id } = await props.params
  // Which view do people open jobs FROM (dashboard vs their station tab)?
  // Non-blocking: prefetch-filtered, insert runs in after(). See lib/access-log.
  await logJobView({
    userName: user.name,
    role: user.role,
    defaultStage: user.defaultStage,
    jobId: id,
  })
  const showMoney = canSeeMoney(user)
  // 合同 attachments live behind the money gate (财务 tab). Fetched IN PARALLEL
  // with the job snapshot — never a sequential round-trip tacked onto the page
  // load (the caiwu tab must add zero latency to the floor's hot path). The
  // 开票/回款 state is lazy-loaded by JobMoneyEditor itself, so it never touches
  // the server critical path at all.
  const [rawJob, fetchedVendors, contractFiles] = await Promise.all([
    getJob(id),
    getVendors(),
    showMoney ? getContractFiles(id) : Promise.resolve([]),
  ])
  if (!rawJob) notFound()
  // Portal tokens power the 微信 share button on each 委外 row. No-op once
  // every vendor has one (the common case) — see ensureVendorPortalTokens.
  const rawVendors = await ensureVendorPortalTokens(fetchedVendors)
  // Only `ready` jobs live on the production board. A draft/parsing/failed job
  // reached here via a stale link or a 工号-conflict button — send it to the
  // import review screen, the mirror of /import/[id]'s `ready → /jobs` bounce.
  if (rawJob.status !== 'ready') redirect(`/import/${rawJob.id}`)

  const isProduction = user.role === 'production'
  // 出货 production users get customer-flavored visibility (customer name +
  // 出货单 print). They still don't edit, manage outsource, or see money.
  const showCustomer = canSeeCustomerData(user)
  // 工程 head edits the same non-commercial fields commerce does (product,
  // jobNo, dueDate, component name/qty/material/notes, image). Pure-floor
  // production users (焊接, 喷塑, etc.) keep the read-only view they had.
  const canEditFields = canEditProductionFields(user)
  // Structural rights on the 零件 sheet — deliberately narrower than editing a
  // cell, and per-person rather than per-stage (see lib/auth.ts). Adding hides
  // the +; deleting keeps the 删除 icon and swaps its action for a 权限 note.
  const canAddPartRow = canCreatePartRow(user)
  const canDeletePartRowHere = canDeletePartRow(user)
  // 工程's 生产单 export. Commerce gets it in the documents zone up next to
  // 产品; that whole row is customer-gated (showCustomer), which 工程 fails, so
  // theirs rides beside 工单备注 instead. Same sheet, minus 源文件 — that
  // widget's upload API stays commerce-only.
  const showProductionOrderExport =
    isProduction && canExportProductionOrder(user)
  const job = isProduction ? scrubJob(rawJob, user) : rawJob
  const vendors = isProduction ? scrubVendors(rawVendors, user) : rawVendors
  const myStage = user.defaultStage
  // 工程 head's "back" goes to the holistic master view at /, same as
  // commerce — no auto-pinning to ?stage=工程.
  const backFallback = isProduction
    ? myStage && myStage !== '工程'
      ? `/?stage=${encodeURIComponent(myStage)}`
      : '/'
    : '/'
  const currentTab: TabKey = isProduction ? '工单' : '商务'

  const ds = dueState(job.dueDate)
  const days = daysFromToday(job.dueDate)

  // Per-component returned-qty lookup for the active return. Empty map when
  // no return is open, so the badge naturally disappears once 关闭 is hit.
  const returnedQtyByPart = jobReturnedQtyByPart(job)

  // 图纸变更 — derived from the parts themselves (no whole-job flag anymore).
  // Any part with an uncleared revision headlines the page banner.
  const partsWithDrawingChange = job.components.filter((c) =>
    openDrawingChange(c),
  )

  // 退货中 — the carried sheet shows ONLY the returned parts. Everything else
  // already shipped, and re-rendering it is pure scan tax for the floor: the
  // rework round-trip is about the named parts alone. Original row ordinals
  // are kept so "03" still matches the full sheet / source workbook. Falls
  // back to the full list if the return names no resolvable part (defensive
  // — createReturn enforces ≥1). Reverts automatically when 关闭 is hit.
  const returnScoped =
    Boolean(job.activeReturn) &&
    job.components.some((c) => returnedQtyByPart.has(c.id))
  const componentRows = job.components
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !returnScoped || returnedQtyByPart.has(c.id))
  const hiddenCount = job.components.length - componentRows.length

  // Denominator counts only stages that actually apply to each part — a part
  // routed through 5 stages contributes 5, not 9. Otherwise 100% would be
  // unreachable for any job whose parts skip stages. While a 退货 is open the
  // denominator scopes to the returned parts, so 总进度 tracks the rework
  // (0% → 100%) instead of sitting at ~95% on the already-shipped rest.
  // Per-part packed status string (one char per stage, STAGES order) — feeds
  // the in-job part filter (lib/part-status). Built in the same pass as 总进度
  // so the per-cell effectiveStageState walk happens exactly once.
  const partStageCodes: Record<string, string> = {}
  let totalCells = 0
  let doneCells = 0
  for (const { c } of componentRows) {
    let code = ''
    for (const s of STAGES) {
      const eff = effectiveStageState(c, s, vendors)
      code += PART_STAGE_CODE[eff.kind]
      if (eff.kind === 'na') continue
      totalCells++
      if (eff.kind === 'done') doneCells++
    }
    partStageCodes[c.id] = code
  }
  const pct = totalCells === 0 ? 0 : Math.round((doneCells / totalCells) * 100)

  // 排产 — the plannable 工段 this job actually routes through, each with its
  // job-level rollup (for slip-tinting). Drives the pinned 排产 plan row at the
  // top of the 零件进度 table (a plan date is a property of its stage column, so
  // it lives optically aligned over the cells it governs).
  const planStages: { stage: PlanKey; kind: RollupKind }[] = PLANNABLE_STAGES.map(
    (s) => ({ stage: s, kind: rollupStage(job, s).kind }),
  ).filter((x) => x.kind !== 'na')
  // 外协 gets ONE job-level plan slot at the end of the band. Shown once the
  // job touches outsourcing (flagged, in flight, or returned) — or whenever a
  // date is already set, so a saved plan can never silently disappear.
  const outsourceStateForPlan = jobOutsourceState(job)
  if (outsourceStateForPlan || job.stagePlan?.['外协']) {
    planStages.push({
      stage: '外协',
      kind:
        outsourceStateForPlan === '已回'
          ? 'done'
          : outsourceStateForPlan === '外协中'
            ? 'partial'
            : 'pending',
    })
  }
  // Stage → rollup lookup for the plan row: each stage cell renders a plan date
  // only when its stage is plannable AND in this job's route. `外协` is present
  // here exactly when the job qualifies for the outsource plan slot.
  const planByStage = new Map<PlanKey, RollupKind>(
    planStages.map((p) => [p.stage, p.kind]),
  )
  const showOutsourcePlan = planByStage.has('外协')

  const externalSpend = jobExternalSpend(job)
  const margin = jobMargin(job)
  const componentsTotal = jobComponentsTotal(job)

  // A block now spans N components — dedupe by block.id so the per-job list
  // shows one row per shipment with all members.
  type JobBlock = NonNullable<Job['components'][number]['outsourceBlocks']>[number]
  const seenBlocks = new Set<string>()
  const blockRows: { block: JobBlock }[] = []
  for (const c of job.components) {
    for (const b of c.outsourceBlocks ?? []) {
      if (seenBlocks.has(b.id)) continue
      seenBlocks.add(b.id)
      blockRows.push({ block: b })
    }
  }
  blockRows.sort((a, b) => {
    const aClosed = isBlockClosed(a.block)
    const bClosed = isBlockClosed(b.block)
    if (aClosed !== bClosed) return aClosed ? 1 : -1
    return a.block.expectedReturn.localeCompare(b.block.expectedReturn)
  })

  // 工单明细 section tabs — 零件 always; 外协 for the outsource managers; 财务
  // for the money roles. Must match the data-jobtab wrappers rendered below.
  // 外协 carries a count of blocks still at a vendor (在外) so pending outsourcing
  // shows on the tab bar without a click.
  const openOutsourceCount = blockRows.filter(
    (r) => !isBlockClosed(r.block),
  ).length
  const jobTabs = [
    { key: 'parts', label: '零件' },
    ...(canManageOutsource(user)
      ? [
          {
            key: 'waixie',
            label: '外协',
            badge: openOutsourceCount > 0 ? String(openOutsourceCount) : undefined,
            alarm: openOutsourceCount > 0,
          },
        ]
      : []),
    ...(showMoney ? [{ key: 'caiwu', label: '财务' }] : []),
  ]

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title={`${job.jobNo} · ${job.product}`}
        subtitle="工单明细"
        currentTab={currentTab}
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />

      <main className="mx-auto w-full max-w-[1500px] px-4 md:px-10 py-6 md:py-10 flex-1">
        <ComponentAnchorScroller />
        {/* 图纸变更报警 — headlines the page while any part has an open change.
            The floor opens this page at every station; the alarm has to be the
            first thing read. Derived from the parts, raised/cleared per-part. */}
        <DrawingChangeBanner
          parts={partsWithDrawingChange.map((c) => ({ id: c.id, name: c.name }))}
          note={
            job.drawingChangeOpen
              ? job.drawingChangeNote?.trim() || undefined
              : undefined
          }
        />
        <div className="mb-6 flex items-center justify-between gap-3">
          <BackButton fallback={backFallback} />
          <div className="flex items-center gap-3 flex-wrap justify-end">
            {job.activeReturn ? (
              <ActiveReturnBadge
                ret={job.activeReturn}
                canEdit={canEditPartRoute(user)}
              />
            ) : (
              jobIsShipped(job) &&
              canEditPartRoute(user) && (
                <OpenReturnButton
                  jobId={job.id}
                  jobNo={job.jobNo}
                  components={job.components}
                />
              )
            )}
            <ShippingComposerButton
              jobId={job.id}
              components={job.components}
              shipments={job.shipments}
            />
            <ShipmentHistoryButton
              jobId={job.id}
              components={job.components}
              shipments={job.shipments}
            />
          </div>
        </div>
        <div className="mb-8 grid grid-cols-2 md:grid-cols-12 gap-4 md:gap-8 border-b border-[var(--color-border)] pb-8">
          <div className="col-span-1 md:col-span-2">
            <p className="label mb-1">{showCustomer ? '客户' : '产品'}</p>
            {!showCustomer ? (
              // Production without customer visibility still gets 越侬商务 —
              // our own salesperson on this order, and the only person they can
              // call when the drawing or the date is wrong. Internal, not PII.
              <>
                {canEditFields ? (
                  // 工程 head edits the product name (the only customer-side
                  // identifier they get) inline like commerce.
                  <JobText
                    jobId={job.id}
                    field="product"
                    value={job.product}
                    multiline
                    className="text-[24px] font-semibold tracking-tight text-[var(--color-ink)]"
                    placeholder="产品"
                  />
                ) : (
                  <p className="text-[24px] font-semibold tracking-tight text-[var(--color-ink)]">
                    {job.product}
                  </p>
                )}
                <p className="mt-2 text-[14px] text-[var(--color-ink-2)]">
                  <span className="text-[var(--color-ink-3)]">
                    {BRAND.commerceLabel} ·{' '}
                  </span>
                  {job.yuenongBusiness || '—'}
                </p>
              </>
            ) : isProduction ? (
              // 出货 station: read-only customer + product. They see the same
              // header as commerce, but can't edit (commerce owns the master
              // record).
              <>
                <p className="text-[24px] font-semibold tracking-tight text-[var(--color-ink)]">
                  {job.customer}
                </p>
                <p className="mt-1 text-[14px] text-[var(--color-ink-2)]">
                  {job.product}
                </p>
              </>
            ) : (
              <>
                <JobText
                  jobId={job.id}
                  field="customer"
                  value={job.customer}
                  multiline
                  className="text-[24px] font-semibold tracking-tight text-[var(--color-ink)]"
                  placeholder="客户"
                />
                {/* The two people who own this order. No labels — the field
                    name lives in the placeholder, so an empty field reads
                    "客户工程师" / "越侬商务" and your text types straight over it.
                    job.engineer = the customer's rep (AI-extracted on import);
                    job.yuenongBusiness = OUR salesperson (human-filled). */}
                <div className="mt-2 flex items-baseline gap-x-6">
                  <JobShippingText
                    jobId={job.id}
                    field="engineer"
                    value={job.engineer}
                    className="text-[14px] text-[var(--color-ink-2)]"
                    placeholder="客户工程师"
                  />
                  <JobShippingText
                    jobId={job.id}
                    field="yuenongBusiness"
                    value={job.yuenongBusiness}
                    className="text-[14px] text-[var(--color-ink-2)]"
                    placeholder={BRAND.commerceLabel}
                  />
                </div>
              </>
            )}
          </div>
          <div className="col-span-1 md:col-span-2">
            <p className="label mb-2">工号</p>
            <div className="flex items-center gap-2">
              {canEditFields ? (
                <JobText
                  jobId={job.id}
                  field="jobNo"
                  value={job.jobNo}
                  mono
                  className="text-[15px] text-[var(--color-ink)]"
                  placeholder="工号"
                />
              ) : (
                <p className="mono text-[15px] text-[var(--color-ink)]">
                  {job.jobNo}
                </p>
              )}
              <JobTypeEditor
                jobId={job.id}
                jobNo={job.jobNo}
                initialType={job.jobType}
                initialIsProduct={job.isProduct}
                initialPaused={Boolean(job.pausedAt)}
                initialPauseReason={job.pauseReason}
                canEdit={canManageOutsource(user)}
              />
            </div>
          </div>
          {/* 金额 / 外发 / 毛利 moved into the 财务 tab below — keeps the header
              to identity + schedule, and gives 财务 its own editable home. */}
          <div className="col-span-1 md:col-span-2">
            <p className="label mb-2">交期</p>
            <div className="flex flex-col gap-0.5">
              {canEditFields ? (
                <JobDueDate
                  jobId={job.id}
                  value={job.dueDate}
                  className="text-[15px] text-[var(--color-ink)]"
                />
              ) : (
                <p className="mono text-[15px] text-[var(--color-ink)]">
                  {job.dueDate}
                </p>
              )}
              <DueDelta state={ds} days={days} />
            </div>
            {/* 二次交期 — optional second ship date, blank on most jobs. Lives
                in the 交期 column so it reads as a continuation of the same
                fact, never competing with the primary date's urgency delta. */}
            <p className="label mb-1 mt-3">二次交期</p>
            {canEditFields ? (
              <JobSecondaryDueDate
                jobId={job.id}
                value={job.secondaryDueDate}
                className="text-[15px] text-[var(--color-ink)]"
              />
            ) : (
              <p className="mono text-[15px] text-[var(--color-ink)]">
                {job.secondaryDueDate ?? '—'}
              </p>
            )}
          </div>
          <div className="col-span-2 md:col-span-6">
            <p className="label mb-2">总进度</p>
            <div className="flex items-baseline gap-2">
              <span className="mono text-[15px] text-[var(--color-ink)]">{pct}%</span>
              <span className="label">
                {doneCells}/{totalCells}
              </span>
            </div>
            <div className="mt-2 h-[2px] w-full bg-[var(--color-border)]">
              <div
                className="h-full bg-[var(--color-ink)]"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        </div>

        {/* Metadata row — left cell is 工程师 (出货) or 产品 (commerce), right
            cell is 合同号. 工程师 is AI-extracted on import when present in the
            source file; 合同号 is always blank on import and commerce fills it in
            once the customer assigns one. Hidden from pure production users since
            all of these are customer-facing (gated through scrubJob → customerOk). */}
        {showCustomer && (
          <div className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              {/* 出货 (production w/ customer view) keeps 工程师 here — they read
                  the same header as commerce (客户 + 产品) so engineer belongs in
                  this metadata row for them. Commerce/boss moved 工程师 up under
                  the customer name, so they edit 产品 here instead. */}
              {isProduction ? (
                // 出货 reads the same two contacts as commerce, read-only.
                <div className="flex gap-x-10">
                  <div>
                    <p className="label mb-2 whitespace-nowrap">客户工程师</p>
                    <p className="text-[13px] text-[var(--color-ink)]">
                      {job.engineer ?? '—'}
                    </p>
                  </div>
                  <div>
                    <p className="label mb-2 whitespace-nowrap">{BRAND.commerceLabel}</p>
                    <p className="text-[13px] text-[var(--color-ink)]">
                      {job.yuenongBusiness ?? '—'}
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <p className="label mb-2">产品</p>
                  {canEditFields ? (
                    <JobText
                      jobId={job.id}
                      field="product"
                      value={job.product}
                      multiline
                      className="text-[13px] text-[var(--color-ink)]"
                      placeholder="产品"
                    />
                  ) : (
                    <p className="text-[13px] text-[var(--color-ink)]">
                      {job.product}
                    </p>
                  )}
                </>
              )}
            </div>
            {/* 合同号 — commerce now edits it in the 财务 tab, grouped with
                上传合同 (a contract is a number AND a document). 出货 reads it
                here read-only: they print it on the 出货单 and have no 财务 tab. */}
            {isProduction ? (
              <div>
                <p className="label mb-2">合同号</p>
                <p className="mono text-[13px] text-[var(--color-ink)]">
                  {job.contractNo ?? '—'}
                </p>
              </div>
            ) : (
              // 源文件 (file in) + 生产单 (file out) — sits here so the documents
              // zone aligns on the same row as 产品 rather than dropping a row
              // down next to 工单备注.
              <div className="space-y-2">
                <SourceFileRow
                  jobId={job.id}
                  fileName={job.sourceFile}
                  url={job.sourceFileUrl}
                />
                <ProductionOrderRow jobId={job.id} jobNo={job.jobNo} />
              </div>
            )}
          </div>
        )}

        {/* 工单备注 is the one field everyone owns — production heads add 催单 /
            shop-floor context, commerce reads + writes too. Commerce's 源文件 /
            生产单 documents zone moved up next to 产品 so it aligns on that row;
            工程 can't render that row, so their 生产单 export fills the empty
            right cell here. */}
        <div className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <p className="label mb-2">工单备注</p>
            <JobNotes
              jobId={job.id}
              value={job.notes}
              placeholder="添加备注…"
              className="text-[13px] text-[var(--color-ink)]"
            />
          </div>
          {showProductionOrderExport && (
            <div>
              <ProductionOrderRow jobId={job.id} jobNo={job.jobNo} />
            </div>
          )}
        </div>

        {/* 工单明细 tabs — 零件 / 外协 / 财务. Each big section below is wrapped
            in a data-jobtab div that <JobTabs> shows/hides, so nobody scrolls
            past the parts table to reach 外协 or the money summary. */}
        <div id="jobtabs-root">
          <JobTabs tabs={jobTabs} />

          <div data-jobtab="parts">
        <JobPartFilterProvider codes={partStageCodes}>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
              零件进度
            </h2>
            {returnScoped && hiddenCount > 0 && (
              <span className="label text-[var(--color-overdue)]">
                退货中 · 仅显示退回零件 · 其余 {hiddenCount} 件已出货,已隐藏
              </span>
            )}
            <JobPartFilterSummary />
          </div>
          <p className="label">
            {!isProduction || canEditFields
              ? '点 ▶ 起步 · 点 ● 收件 · 60 秒内可撤销 · 外协见下'
              : myStage
                ? `${myStage} 工段可点 ▶ 起步 / ● 收件 · 60 秒内可撤销`
                : '查看进度'}
          </p>
        </div>

        {/* Client island around the sheet: owns the rows added this visit (the
            + on each separator line) and their #. A row already on the sheet
            keeps its number when one is inserted above it — the new row takes a
            sub-number of its anchor (1.1) instead of the next slot. */}
        <PartInsertProvider
          jobId={job.id}
          serverRows={componentRows.map(({ c, i }) => ({
            id: c.id,
            base: i + 1,
          }))}
          canEdit={canEditFields}
          canAddRow={canAddPartRow}
          canDeleteRow={canDeletePartRowHere}
          showMoney={showMoney}
        >
        <ComponentsScrollArea
          myStage={myStage}
          className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]"
          /* 冻结表头 — the same <colgroup> + <thead>, rendered a second time
             into the strip that pins to the top of the window once the real
             header scrolls off. Column names have to stay readable at row 60
             the way they are at row 1. */
          pinnedHeader={
            <>
              <PartsSheetCols canEditFields={canEditFields} showMoney={showMoney} />
              <PartsSheetHead
                myStage={myStage}
                canEditFields={canEditFields}
                showMoney={showMoney}
                pinned
              />
            </>
          }
        >
          <table className="sheet w-full text-left text-[13px]">
            <PartsSheetCols canEditFields={canEditFields} showMoney={showMoney} />
            <PartsSheetHead
              myStage={myStage}
              canEditFields={canEditFields}
              showMoney={showMoney}
            />
            <tbody>
              {/* 排产 plan row — a slim pinned first row carrying each stage's
                  job-level planned finish date, optically aligned over the stage
                  column it governs. Has no data-part-id, so the part filter
                  never hides or counts it. Blank under stages this job doesn't
                  plan (检验 / 出货 / off-route). */}
              {planStages.length > 0 && (
                <tr className="align-middle">
                  <td
                    colSpan={9}
                    className="px-4"
                    style={{
                      background: 'var(--color-lane)',
                      borderBottom: '1px solid var(--color-border-strong)',
                      height: 38,
                      overflow: 'visible',
                    }}
                  >
                    <div className="flex items-center gap-4">
                      <span className="text-[11px] font-medium tracking-[0.18em] text-[var(--color-ink-2)]">
                        排产
                      </span>
                      {showOutsourcePlan && (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="text-[11px] tracking-wide text-[var(--color-ink-3)]">
                            外协回
                          </span>
                          <StagePlanDate
                            jobId={job.id}
                            stage="外协"
                            value={job.stagePlan?.['外协']}
                            rollupKind={planByStage.get('外协')!}
                            canEdit={canEditFields}
                            triggerClass="text-[12.5px] font-medium"
                          />
                        </span>
                      )}
                    </div>
                  </td>
                  {STAGES.map((stage) => {
                    const kind = planByStage.get(stage)
                    return (
                      <td
                        key={stage}
                        className="text-center"
                        style={{
                          background: 'var(--color-lane)',
                          borderBottom: '1px solid var(--color-border-strong)',
                          height: 38,
                          overflow: 'visible',
                        }}
                      >
                        {kind ? (
                          <StagePlanDate
                            jobId={job.id}
                            stage={stage}
                            value={job.stagePlan?.[stage]}
                            rollupKind={kind}
                            canEdit={canEditFields}
                            triggerClass="text-[12.5px] font-medium"
                          />
                        ) : null}
                      </td>
                    )
                  })}
                  <td
                    colSpan={
                      2 + (canEditFields ? 2 : 0) + (showMoney ? 2 : 0)
                    }
                    style={{
                      background: 'var(--color-lane)',
                      borderBottom: '1px solid var(--color-border-strong)',
                      height: 38,
                    }}
                  />
                </tr>
              )}
              {componentRows.map(({ c, i }) => (
                <Fragment key={c.id}>
                <tr
                  id={`c-${c.id}`}
                  data-part-id={c.id}
                  data-st={partStageCodes[c.id]}
                  className="group align-middle"
                >
                    {/* # doubles as the insert gutter: the + straddling this
                        row's bottom border drops a new 零件 directly beneath
                        it. overflow must be visible — the .sheet rule clips —
                        and globals.css lifts the hovered row's frozen cells so
                        the row below can't paint over the button.
                        px-1 rather than px-3 because # is editable: the field
                        fills the cell, so the hover target reads as a cell and
                        not as two digits. The + is positioned off the cell's
                        border box, so its 18px offset is unaffected. */}
                    <td
                      className="sticky-col px-1 py-3 text-center mono text-[var(--color-ink-3)] text-[12px]"
                      style={{ left: 0, overflow: 'visible' }}
                    >
                      <PartOrdinal id={c.id} base={i + 1} label={c.seqLabel} />
                      <RowInsert afterId={c.id} />
                    </td>
                    <td className="sticky-col px-3 py-2" style={{ left: 56 }}>
                      <ComponentImageUploader
                        jobId={job.id}
                        componentId={c.id}
                        imageUrl={c.imageUrl}
                        size={56}
                        readOnly={!canEditFields}
                      />
                    </td>
                    <td
                      className="sticky-col sticky-col-edge px-3 py-3"
                      style={{ left: 134 }}
                    >
                      {canEditFields ? (
                        <ComponentText
                          jobId={job.id}
                          componentId={c.id}
                          field="name"
                          value={c.name}
                          placeholder="零件名称"
                          className="text-[14px] font-medium text-[var(--color-ink)]"
                        />
                      ) : (
                        <span className="text-[14px] font-medium text-[var(--color-ink)]">
                          {c.name}
                        </span>
                      )}
                      {!isProduction && (
                        <ExternalBadge component={c} vendors={vendors} />
                      )}
                      {isProduction && (c.outsourceBlocks ?? []).length > 0 && (
                        <span className="block mt-0.5 text-[10px] tracking-wider text-[var(--color-warning)]">
                          外协中
                        </span>
                      )}
                      {/* 检验 blocking verdict — the part is held at inspection.
                          Mirrors the red cell so the tag reads off the 零件
                          column without scrolling right to the 检验 column. */}
                      {c.stages['检验'] &&
                        c.stages['检验'].status !== 'done' &&
                        isBlockingVerdict(c.stages['检验'].verdict) && (
                          <span className="block mt-1">
                            <span
                              className="inline-flex items-center rounded-[2px] border border-[var(--color-overdue)] bg-[var(--color-overdue-soft)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-[var(--color-overdue)]"
                              title={[
                                c.stages['检验'].verdictReason
                                  ? `不良原因 · ${c.stages['检验'].verdictReason}`
                                  : null,
                                c.stages['检验'].verdictOwner
                                  ? `责任人 · ${c.stages['检验'].verdictOwner}`
                                  : null,
                              ]
                                .filter(Boolean)
                                .join('  ')}
                            >
                              检验 · {c.stages['检验'].verdict}
                              {c.stages['检验'].verdictReason ? (
                                <span className="ml-1 font-normal normal-case max-w-[120px] truncate">
                                  {c.stages['检验'].verdictReason}
                                </span>
                              ) : null}
                            </span>
                          </span>
                        )}
                      {returnedQtyByPart.has(c.id) && (
                        <span className="block mt-1">
                          <ReturnedComponentChip
                            qty={returnedQtyByPart.get(c.id) ?? 0}
                            total={c.qty}
                          />
                        </span>
                      )}
                      {/* 出厂检验报告 — the 质量 step's standard template.
                          One faint link per part; the report page itself
                          gates editing. */}
                      {/* 检验报告 + 图纸变更 share one line — keeps the row from
                          growing taller. 图纸变更 is per-part (一次/二次/三次);
                          floor reads it, 商务/工程 head raise + clear. */}
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                        <a
                          href={withBase(`/jobs/${job.id}/print/inspection/${encodeURIComponent(c.id)}`)}
                          target="_blank"
                          rel="noopener"
                          className="text-[10px] tracking-wider text-[var(--color-ink-4)] hover:text-[var(--color-ink)] transition-colors whitespace-nowrap"
                        >
                          检验报告 ↗
                        </a>
                        <PartDrawingChange
                          jobId={job.id}
                          partId={c.id}
                          partName={c.name}
                          imageUrl={c.imageUrl}
                          changes={c.drawingChanges ?? []}
                          canEdit={canEditFields}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      {canEditFields ? (
                        <ComponentText
                          jobId={job.id}
                          componentId={c.id}
                          field="partNo"
                          value={c.partNo}
                          placeholder="—"
                          className="mono text-[12px] text-[var(--color-ink-2)]"
                        />
                      ) : (
                        <span className="mono text-[12px] text-[var(--color-ink-2)]">
                          {c.partNo ?? ''}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top">
                      {canEditFields ? (
                        <ComponentText
                          jobId={job.id}
                          componentId={c.id}
                          field="process"
                          value={c.process}
                          placeholder="—"
                          multiline
                          className="text-[12px] text-[var(--color-ink-2)] leading-snug"
                        />
                      ) : (
                        <span className="text-[12px] text-[var(--color-ink-2)] leading-snug whitespace-pre-wrap break-words">
                          {c.process ?? ''}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top">
                      {canEditFields ? (
                        <ComponentQty
                          jobId={job.id}
                          componentId={c.id}
                          value={c.qty}
                          className="text-[13px] text-[var(--color-ink)]"
                        />
                      ) : (
                        <span className="mono text-[13px] text-[var(--color-ink)]">
                          {c.qty}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top">
                      {canEditFields ? (
                        <ComponentText
                          jobId={job.id}
                          componentId={c.id}
                          field="material"
                          value={c.material}
                          placeholder="材料"
                          multiline
                          className="text-[12px] text-[var(--color-ink-2)] leading-snug"
                        />
                      ) : (
                        <span className="text-[12px] text-[var(--color-ink-2)] leading-snug whitespace-pre-wrap break-words">
                          {c.material ?? ''}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top">
                      {canEditFields ? (
                        <ComponentText
                          jobId={job.id}
                          componentId={c.id}
                          field="surfaceTreatment"
                          value={c.surfaceTreatment}
                          placeholder="表面处理"
                          multiline
                          className="text-[12px] text-[var(--color-ink-2)] leading-snug"
                        />
                      ) : (
                        <span className="text-[12px] text-[var(--color-ink-2)] leading-snug whitespace-pre-wrap break-words">
                          {c.surfaceTreatment ?? ''}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <StageChips
                        jobId={job.id}
                        component={c}
                        readOnly={!canEditPartRoute(user)}
                      />
                    </td>
                    {STAGES.map((stage) => {
                      // 工程 + commerce can flip any stage cell from anywhere
                      // on the job detail page — 工程 routinely fixes routing
                      // mistakes by stepping parts forward/back across stages.
                      // Pure-floor production users (焊接, 喷塑, etc.) still
                      // only get their own stage column.
                      const interactive =
                        !isProduction || canEditFields || stage === myStage
                      return (
                        <td key={stage} className="p-0 h-[60px]">
                          <EffectiveStageCell
                            jobId={job.id}
                            component={c}
                            stage={stage}
                            interactive={interactive}
                          />
                        </td>
                      )
                    })}
                    <ShipmentLogCell
                      jobId={job.id}
                      componentId={c.id}
                      value={c.shipmentLog}
                      entries={componentShipmentEntries(c.id, job.shipments)}
                      totalQty={c.qty}
                      canEdit={canEditFields}
                    />
                    <ActivityCell component={c} />
                    {canEditFields && (
                      <td className="px-3 py-3 align-top">
                        <ComponentNotes
                          jobId={job.id}
                          componentId={c.id}
                          value={c.notes}
                          placeholder="添加备注…"
                          multiline
                          className="text-[12px] text-[var(--color-ink-2)] leading-snug"
                        />
                      </td>
                    )}
                    {showMoney && (
                      <td className="px-3 py-3">
                        <ComponentUnitPrice
                          jobId={job.id}
                          componentId={c.id}
                          value={c.unitPriceCny}
                          className="text-[13px] text-[var(--color-ink)]"
                        />
                      </td>
                    )}
                    {showMoney && (
                      <td className="px-3 py-3">
                        <ComponentLineTotal
                          jobId={job.id}
                          componentId={c.id}
                          value={c.lineTotalCny}
                          className="text-[13px] text-[var(--color-ink)]"
                        />
                      </td>
                    )}
                    {canEditFields && (
                      <td className="px-2 py-3 text-center align-middle">
                        <DeletePartButton
                          jobId={job.id}
                          componentId={c.id}
                          componentName={c.name}
                          allowed={canDeletePartRowHere}
                        />
                      </td>
                    )}
                  </tr>
                  {/* Rows inserted under this one this visit — client island,
                      on screen the instant the 30-byte mutate response lands
                      instead of an RSC refresh the GFW chokes on. */}
                  <InsertedRows afterId={c.id} />
                </Fragment>
              ))}
              {/* Room under the last row for its + (which straddles the final
                  separator line), and the only visible add affordance on a
                  sheet with no rows to hover. */}
              <PartsTailRoom />
            </tbody>
          </table>
        </ComponentsScrollArea>
        </PartInsertProvider>
        </JobPartFilterProvider>
          </div>
          {/* /零件 tab */}

          {canManageOutsource(user) && (
            <div data-jobtab="waixie" hidden>
              {blockRows.length === 0 && (
                <div className="mb-6 max-w-md">
                  <OutsourceFlag
                    jobId={job.id}
                    state={jobOutsourceState(job)}
                    initialNeeds={Boolean(job.needsOutsource)}
                    initialNote={job.outsourceNote}
                  />
                </div>
              )}
              <section className="mt-8">
                <div className="mb-3 flex items-baseline justify-between">
                  <h3 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
                    外协
                  </h3>
                  <p className="label text-[var(--color-ink-3)]">
                    {blockRows.filter((r) => !isBlockClosed(r.block)).length} 在外 ·{' '}
                    {blockRows.filter((r) => isBlockClosed(r.block)).length} 已回
                  </p>
                </div>
                <WaixieTable
                  jobId={job.id}
                  vendors={vendors}
                  components={job.components.map((c) => ({
                    id: c.id,
                    name: c.name,
                    qty: c.qty,
                    material: c.material,
                    imageUrl: c.imageUrl,
                    blocks: c.outsourceBlocks ?? [],
                  }))}
                />
              </section>
            </div>
          )}

          {showMoney && (
            <div data-jobtab="caiwu" hidden>
              <JobFinancePanel
                job={job}
                externalSpend={externalSpend}
                margin={margin}
                componentsTotal={componentsTotal}
              />
              <ContractFiles
                jobId={job.id}
                initial={contractFiles}
                contractNo={job.contractNo}
                canEdit={canEditFields}
              />
            </div>
          )}
        </div>
        {/* /jobtabs-root */}
      </main>
    </div>
  )
}

// Column widths of the 零件进度 sheet. Extracted because the sheet renders its
// header TWICE — once in the table, once in the strip that pins to the top of
// the window (ComponentsScrollArea) — and the two copies only line up if they
// share one <colgroup>. Column count must also track _part_insert.tsx.
function PartsSheetCols({
  canEditFields,
  showMoney,
}: {
  canEditFields: boolean
  showMoney: boolean
}) {
  return (
    <colgroup>
      <col style={{ width: 56 }} />
      <col style={{ width: 78 }} />
      <col style={{ width: 200 }} />
      <col style={{ width: 120 }} />
      <col style={{ width: 130 }} />
      {/* 数量 / 材料 / 表面处理 are short values (a count, "6061-T6",
          "阳极氧化黑"). Kept narrow so the stage grid starts closer to
          the frozen 零件 column; the two text cells wrap. */}
      <col style={{ width: 78 }} />
      <col style={{ width: 110 }} />
      <col style={{ width: 132 }} />
      {/* 工序 (StageChips) — sits between 表面处理 and the stage grid.
          Without its own <col> every column to the right inherits the
          wrong width and 备注/单价/小计 fall off the end of the
          colgroup. */}
      <col style={{ width: 150 }} />
      {STAGES.map((s) => (
        <col key={s} style={{ width: 90 }} />
      ))}
      <col style={{ width: 160 }} />
      <col style={{ width: 170 }} />
      {canEditFields && <col style={{ width: 170 }} />}
      {showMoney && <col style={{ width: 110 }} />}
      {showMoney && <col style={{ width: 100 }} />}
      {canEditFields && <col style={{ width: 64 }} />}
    </colgroup>
  )
}

// The sheet's column names. `pinned` renders the copy that lives in the frozen
// strip: identical cells and widths (it has to overlay the sheet pixel for
// pixel), minus the two things that only make sense in the live table — the
// status funnels (their menus would be clipped by the strip) and the
// data-attributes ComponentsScrollArea uses to find the real header.
function PartsSheetHead({
  myStage,
  canEditFields,
  showMoney,
  pinned = false,
}: {
  myStage: string | null | undefined
  canEditFields: boolean
  showMoney: boolean
  pinned?: boolean
}) {
  return (
    <thead>
      <tr className="text-[var(--color-ink-2)]">
        {/* Frozen identifier block. 零件 is what the eye tracks while
            the stage grid scrolls, and it can only sit at the left edge
            if # and 图 freeze with it (left offsets = their col widths).
            data-sticky-edge doubles as ComponentsScrollArea's anchor. */}
        <th
          className="sticky-col px-3 py-3 text-center label whitespace-nowrap"
          style={{ left: 0 }}
        >
          #
        </th>
        <th
          className="sticky-col px-3 py-3 label whitespace-nowrap"
          style={{ left: 56 }}
        >
          图
        </th>
        <th
          data-sticky-edge={pinned ? undefined : ''}
          className="sticky-col sticky-col-edge px-4 py-3 label whitespace-nowrap"
          style={{ left: 134 }}
        >
          零件
        </th>
        <th className="px-4 py-3 label whitespace-nowrap">料号</th>
        <th className="px-4 py-3 label whitespace-nowrap">加工工艺</th>
        <th className="px-4 py-3 text-right label whitespace-nowrap">数量</th>
        <th className="px-4 py-3 label whitespace-nowrap">材料</th>
        <th className="px-4 py-3 label whitespace-nowrap">表面处理</th>
        <th className="px-4 py-3 label whitespace-nowrap">工序</th>
        {STAGES.map((s) => (
          <th
            key={s}
            data-stage-col={pinned ? undefined : s}
            // overflow visible so the funnel dropdown isn't clipped by
            // .sheet th { overflow:hidden } — same override the master
            // board uses for its column filters.
            style={{ overflow: 'visible' }}
            className={`relative px-2 py-3 text-center whitespace-nowrap ${
              s === myStage ? 'font-semibold text-[var(--color-ink)]' : ''
            }`}
          >
            <span className="inline-flex items-center justify-center gap-1">
              <StageHeader name={s} />
              {!pinned && <JobPartStageFunnel stage={s} />}
            </span>
          </th>
        ))}
        <th className="px-3 py-3 label whitespace-nowrap">出货记录</th>
        <th className="px-3 py-3 label whitespace-nowrap">动态</th>
        {canEditFields && (
          <th className="px-4 py-3 label whitespace-nowrap">备注</th>
        )}
        {showMoney && (
          <th className="px-4 py-3 text-right label whitespace-nowrap">单价</th>
        )}
        {showMoney && (
          <th className="px-4 py-3 text-right label whitespace-nowrap">小计</th>
        )}
        {canEditFields && (
          <th className="px-3 py-3 text-center label whitespace-nowrap" />
        )}
      </tr>
    </thead>
  )
}

// Per-part 出货记录 (migration 0069). ONE surface, by design: the system
// generates the batch log (制作出货单 → Shipment rows, newest first, each line
// "YYYY-MM-DD HH:mm N/T" — shipped over part total) and that generated text IS
// the editable field. Click
// it, type, fix it.
//   - Untouched (component.shipmentLog == null) the cell shows the LIVE derived
//     log and stays live as new 出货单 batches land.
//   - The moment the user edits, their text is stored as the override.
//   - Clearing the field (empty → null) drops the override and the live log
//     returns.
// Floor users (no edit rights) read the same text, read-only. Empty state (no
// override, no shipments) is a single muted dash so the column keeps its width.
function ShipmentLogCell({
  jobId,
  componentId,
  value,
  entries,
  totalQty,
  canEdit,
}: {
  jobId: string
  componentId: string
  value: string | undefined
  entries: ReturnType<typeof componentShipmentEntries>
  totalQty: number
  canEdit: boolean
}) {
  const derived = formatShipmentLog([...entries].reverse(), totalQty)
  // The displayed/editable text: the hand-edited override if present, otherwise
  // the live system log.
  const display = value ?? derived
  if (!canEdit) {
    return (
      <td className="px-3 py-3 align-top">
        {display ? (
          <pre className="mono text-[11px] leading-snug text-[var(--color-ink-2)] whitespace-pre-wrap font-normal">
            {display}
          </pre>
        ) : (
          <span className="text-[var(--color-ink-4)] mono text-[11px]">—</span>
        )}
      </td>
    )
  }
  return (
    <td className="px-3 py-3 align-top">
      <ComponentText
        jobId={jobId}
        componentId={componentId}
        field="shipmentLog"
        value={display}
        placeholder="出货记录…"
        multiline
        className="mono text-[11px] leading-snug text-[var(--color-ink-2)]"
      />
    </td>
  )
}

// 动态 — the latest human touch on this part: who clicked, what they did, and
// when (date + hour, factory-local). Kept flat — one small type size, no bold —
// so it reads like any other cell in the sheet instead of a name shouting out
// of the row. The person is anchored only by being first and the darkest tone;
// action/stage recede one step, timestamp recedes another. Empty state is a
// single muted dash so the column keeps its width.
function ActivityCell({ component }: { component: import('@/lib/data').Component }) {
  const a = latestComponentActivity(component)
  if (!a) {
    return (
      <td className="px-3 py-3 text-[var(--color-ink-4)] mono text-[11px] align-top">
        —
      </td>
    )
  }
  return (
    <td className="px-3 py-3 align-top">
      <div className="leading-snug text-[12px]">
        <div className="break-words">
          <span className="text-[var(--color-ink-2)]">{a.by}</span>
          <span className="text-[var(--color-ink-3)]">
            {' · '}
            {a.action} · {a.stage}
          </span>
        </div>
        <div className="mt-0.5 mono text-[11px] text-[var(--color-ink-4)] whitespace-nowrap">
          {a.hasTime ? formatActivityTimestamp(a.when) : a.when}
        </div>
      </div>
    </td>
  )
}

function DueDelta({
  state,
  days,
}: {
  state: import('@/lib/data').DueState
  days: number
}) {
  if (state === 'overdue') {
    return (
      <span className="label text-[var(--color-overdue)]">
        逾期 {Math.abs(days)} 天
      </span>
    )
  }
  if (state === 'today') {
    return <span className="label text-[var(--color-warning)]">今日</span>
  }
  return <span className="label text-[var(--color-ink-3)]">{days} 天后</span>
}

// 财务 tab — one order's money, end to end: the position (金额 / 毛利 / 外发 /
// 零件合计), then 开票 / 回款 captured in one tap right here (the same light the
// board reads), then 合同号 + 上传合同 grouped below. No link-outs to a dead
// ledger; this IS the per-order caiwu workspace.
function JobFinancePanel({
  job,
  externalSpend,
  margin,
  componentsTotal,
}: {
  job: NonNullable<Awaited<ReturnType<typeof getJob>>>
  externalSpend: number
  margin: number | undefined
  componentsTotal: number
}) {
  return (
    <div className="max-w-3xl">
      {/* Position — 金额 leads (boss edits it in place); 毛利 is the number he
          actually reads; 外发 / 零件合计 are supporting context. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-10 gap-y-8">
        <Money label="金额">
          <span className="mono text-[24px] text-[var(--color-ink-3)]">¥</span>
          <JobAmount
            jobId={job.id}
            value={job.amountCny}
            className="text-[24px] font-semibold tracking-tight text-[var(--color-ink)]"
          />
        </Money>
        <Money label="毛利">
          <span
            className={`mono text-[24px] font-semibold tracking-tight ${
              typeof margin === 'number' && margin < 0
                ? 'text-[var(--color-overdue)]'
                : 'text-[var(--color-ink)]'
            }`}
          >
            {typeof margin === 'number' ? formatCny(margin) : '—'}
          </span>
        </Money>
        <Money label="外发金额">
          <span className="mono text-[24px] font-semibold tracking-tight text-[var(--color-ink-2)]">
            {externalSpend > 0 ? formatCny(externalSpend) : '—'}
          </span>
        </Money>
        <Money label="零件合计">
          <span className="mono text-[24px] font-semibold tracking-tight text-[var(--color-ink-2)]">
            {componentsTotal > 0 ? formatCny(componentsTotal) : '—'}
          </span>
        </Money>
      </div>

      {/* 开票 / 回款 — one tap per 出货单, the same capture as the board's 收款
          light. Full per-单 ledger (单价/小计) stays in 应收账款 for the clerk. */}
      <div className="mt-12 border-t border-[var(--color-border)] pt-8">
        <p className="label mb-4">开票 / 回款</p>
        <JobMoneyEditor jobId={job.id} amountCny={job.amountCny} />
        <p className="mt-6 text-[12px] text-[var(--color-ink-4)]">
          全部开票 / 收款记录见{' '}
          <a
            href={withBase('/finance?tab=kaipiao')}
            className="text-[var(--color-ink-2)] underline decoration-[var(--color-border-strong)] underline-offset-2 hover:text-[var(--color-ink)] hover:decoration-[var(--color-ink)]"
          >
            财务
          </a>
          ，单价 / 小计 可在「零件」逐件填写。
        </p>
      </div>
    </div>
  )
}

// One position stat — label over a single value line, baseline-aligned.
function Money({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="label mb-2">{label}</p>
      <div className="flex items-baseline gap-1 leading-none">{children}</div>
    </div>
  )
}
