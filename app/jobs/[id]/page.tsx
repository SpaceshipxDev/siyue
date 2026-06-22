import { notFound, redirect } from 'next/navigation'
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
  isMemberFullyReturned,
  jobComponentsTotal,
  jobExternalSpend,
  jobIsShipped,
  jobMargin,
  jobOutsourceState,
  jobReturnedQtyByPart,
  latestComponentActivity,
  vendorById,
  type Job,
  type Stage,
  type Vendor,
} from '@/lib/data'
import { getJob, getVendors } from '@/lib/db'
import { getContractFiles } from '@/lib/contract-file'
import { BRAND } from '@/lib/brand'
import {
  canEditPartRoute,
  canEditProductionFields,
  canManageOutsource,
  canSeeCustomerData,
  canSeeMoney,
  requireUser,
} from '@/lib/auth'
import { scrubJob, scrubVendors } from '@/lib/dto'
import { StageHeader, TopBar, type TabKey } from '@/app/_ui'
import { EffectiveStageCell } from '@/app/_stagecell'
import { BackButton } from '@/app/_back'
import { DeleteJobButton } from '@/app/_delete_job'
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
import { BlockRow, NewBlockForm } from '@/app/_routing'
import { OutsourceFlag } from '@/app/_outsource_flag'
import { ExternalBadge } from '@/app/_externalbadge'
import { ComponentImageUploader } from '@/app/_image_uploader'
import { StageChips } from '@/app/_stagechips'
import { ComponentsScrollArea } from '@/app/_components_table'
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
import {
  DrawingChangeBanner,
  DrawingChangeButton,
} from '@/app/_drawing_change'
import { PartDrawingChange } from '@/app/_part_drawing_change'
import { ShippingComposerButton } from '@/app/_shipping'
import { JobTypeEditor } from '@/app/_type_chip'

// Intentionally not `force-dynamic`. The page still ends up dynamic because
// `requireUser()` reads cookies and `getJob` is uncached, but leaving Next's
// default in place lets the master board's <Link prefetch> warm the static
// shell (loading.tsx) into the router cache. China clients get the skeleton
// rendered instantly on click; the real content streams in behind it.
export default async function JobDetail(props: PageProps<'/jobs/[id]'>) {
  const user = await requireUser()
  const { id } = await props.params
  const showMoney = canSeeMoney(user)
  // 合同 attachments live behind the money gate (财务 tab). Fetched IN PARALLEL
  // with the job snapshot — never a sequential round-trip tacked onto the page
  // load (the caiwu tab must add zero latency to the floor's hot path). The
  // 开票/回款 state is lazy-loaded by JobMoneyEditor itself, so it never touches
  // the server critical path at all.
  const [rawJob, rawVendors, contractFiles] = await Promise.all([
    getJob(id),
    getVendors(),
    showMoney ? getContractFiles(id) : Promise.resolve([]),
  ])
  if (!rawJob) notFound()
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
  let totalCells = 0
  let doneCells = 0
  for (const { c } of componentRows) {
    for (const s of STAGES) {
      const eff = effectiveStageState(c, s, vendors)
      if (eff.kind === 'na') continue
      totalCells++
      if (eff.kind === 'done') doneCells++
    }
  }
  const pct = totalCells === 0 ? 0 : Math.round((doneCells / totalCells) * 100)

  const externalSpend = jobExternalSpend(job)
  const margin = jobMargin(job)
  const componentsTotal = jobComponentsTotal(job)

  // New-outsource-block picker. Scoped the same way: while a return is open,
  // only the returned parts are sendable — the rest are at the customer.
  // openStages/openVendorName surface "this part has units still out" as a
  // faint hint beside the checkbox — informational, never a filter; the
  // server's overlap check is the real guard (warn-and-confirm).
  const componentOptions = componentRows.map(({ c }) => {
    const openStageSet = new Set<Stage>()
    let openVendorName: string | undefined
    for (const b of c.outsourceBlocks ?? []) {
      const member = b.members.find((m) => m.componentId === c.id)
      if (!member || isMemberFullyReturned(member)) continue
      for (const s of b.stages) openStageSet.add(s)
      openVendorName =
        openVendorName ?? vendorById(b.vendorId, vendors)?.name ?? b.vendorId
    }
    return {
      id: c.id,
      name: c.name,
      qty: c.qty,
      openStages: STAGES.filter((s) => openStageSet.has(s)),
      openVendorName,
    }
  })

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
      />

      <main className="mx-auto w-full max-w-[1500px] px-4 md:px-10 py-6 md:py-10 flex-1">
        <ComponentAnchorScroller />
        {/* 图纸变更报警 — headlines the page while open. The floor opens this
            page at every station; the alarm has to be the first thing read. */}
        {job.drawingChangeOpen && (
          <DrawingChangeBanner
            jobId={job.id}
            note={job.drawingChangeNote}
            by={job.drawingChangeBy}
            at={job.drawingChangeAt}
            canEdit={canManageOutsource(user)}
          />
        )}
        <div className="mb-6 flex items-center justify-between gap-3">
          <BackButton fallback={backFallback} />
          <div className="flex items-center gap-3 flex-wrap justify-end">
            {/* 图纸变更 raise affordance — quiet outline button; while an
                alarm is open the banner above owns the state (single live
                alarm per job, re-raising is meaningless). */}
            {!job.drawingChangeOpen && canManageOutsource(user) && (
              <DrawingChangeButton jobId={job.id} jobNo={job.jobNo} />
            )}
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
            {!isProduction && (
              <span
                aria-hidden
                className="hidden md:inline-block h-4 w-px bg-[var(--color-border)] mx-1"
              />
            )}
            {!isProduction && (
              <DeleteJobButton
                jobId={job.id}
                jobNo={job.jobNo}
                customer={job.customer}
                product={job.product}
                componentCount={job.components.length}
              />
            )}
          </div>
        </div>
        <div className="mb-8 grid grid-cols-2 md:grid-cols-12 gap-4 md:gap-8 border-b border-[var(--color-border)] pb-8">
          <div className="col-span-1 md:col-span-2">
            <p className="label mb-1">{showCustomer ? '客户' : '产品'}</p>
            {!showCustomer ? (
              canEditFields ? (
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
              )
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
              <div />
            )}
          </div>
        )}

        {/* 工单备注 is the one field everyone owns — production heads add 催单 /
            shop-floor context, commerce reads + writes too. SourceFileRow is
            commerce-only (links to the original 报价单 PDF). */}
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
          {!isProduction && (
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

        {/* 工单明细 tabs — 零件 / 外协 / 财务. Each big section below is wrapped
            in a data-jobtab div that <JobTabs> shows/hides, so nobody scrolls
            past the parts table to reach 外协 or the money summary. */}
        <div id="jobtabs-root">
          <JobTabs tabs={jobTabs} />

          <div data-jobtab="parts">
        <div className="mb-3 flex items-baseline justify-between">
          <div className="flex items-baseline gap-3">
            <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
              零件进度
            </h2>
            {returnScoped && hiddenCount > 0 && (
              <span className="label text-[var(--color-overdue)]">
                退货中 · 仅显示退回零件 · 其余 {hiddenCount} 件已出货,已隐藏
              </span>
            )}
          </div>
          <p className="label">
            {!isProduction || canEditFields
              ? '点 ▶ 起步 · 点 ● 收件 · 60 秒内可撤销 · 外协见下'
              : myStage
                ? `${myStage} 工段可点 ▶ 起步 / ● 收件 · 60 秒内可撤销`
                : '查看进度'}
          </p>
        </div>

        <ComponentsScrollArea
          myStage={myStage}
          className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]"
        >
          <table className="sheet w-full text-left text-[13px]">
            <colgroup>
              <col style={{ width: 56 }} />
              <col style={{ width: 78 }} />
              <col style={{ width: 200 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 130 }} />
              <col style={{ width: 130 }} />
              <col style={{ width: 180 }} />
              <col style={{ width: 220 }} />
              {/* 工序 (StageChips) — sits between 表面处理 and the stage grid.
                  Without its own <col> every column to the right inherits the
                  wrong width and 备注/单价/小计 fall off the end of the
                  colgroup. */}
              <col style={{ width: 150 }} />
              {STAGES.map((s) => (
                <col
                  key={s}
                  style={{
                    width: 90,
                    background:
                      s === myStage
                        ? 'var(--color-warning-soft)'
                        : undefined,
                  }}
                />
              ))}
              <col style={{ width: 160 }} />
              <col style={{ width: 170 }} />
              {canEditFields && <col style={{ width: 170 }} />}
              {showMoney && <col style={{ width: 110 }} />}
              {showMoney && <col style={{ width: 100 }} />}
            </colgroup>
            <thead>
              <tr className="text-[var(--color-ink-2)]">
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
                  data-sticky-edge
                  className="sticky-col sticky-col-edge px-4 py-3 label whitespace-nowrap"
                  style={{ left: 134 }}
                >
                  零件
                </th>
                <th className="px-4 py-3 label whitespace-nowrap">料号</th>
                <th className="px-4 py-3 label whitespace-nowrap">加工工艺</th>
                <th className="px-4 py-3 text-right label whitespace-nowrap">
                  数量
                </th>
                <th className="px-4 py-3 label whitespace-nowrap">材料</th>
                <th className="px-4 py-3 label whitespace-nowrap">表面处理</th>
                <th className="px-4 py-3 label whitespace-nowrap">工序</th>
                {STAGES.map((s) => (
                  <th
                    key={s}
                    data-stage-col={s}
                    className={`px-2 py-3 text-center whitespace-nowrap ${
                      s === myStage ? 'font-semibold text-[var(--color-ink)]' : ''
                    }`}
                  >
                    <StageHeader name={s} />
                  </th>
                ))}
                <th className="px-3 py-3 label whitespace-nowrap">出货记录</th>
                <th className="px-3 py-3 label whitespace-nowrap">动态</th>
                {canEditFields && (
                  <th className="px-4 py-3 label whitespace-nowrap">备注</th>
                )}
                {showMoney && (
                  <th className="px-4 py-3 text-right label whitespace-nowrap">
                    单价
                  </th>
                )}
                {showMoney && (
                  <th className="px-4 py-3 text-right label whitespace-nowrap">
                    小计
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {componentRows.map(({ c, i }) => (
                <tr key={c.id} id={`c-${c.id}`} className="align-middle">
                    <td
                      className="sticky-col px-3 py-3 text-center mono text-[var(--color-ink-3)] text-[12px]"
                      style={{ left: 0 }}
                    >
                      {String(i + 1).padStart(2, '0')}
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
                          href={`/jobs/${job.id}/print/inspection/${encodeURIComponent(c.id)}`}
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
                    <td className="px-3 py-3">
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
                      entries={componentShipmentEntries(c.id, job.shipments)}
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
                  </tr>
              ))}
            </tbody>
          </table>
        </ComponentsScrollArea>

        <ActorTrail job={job} vendors={vendors} />
          </div>
          {/* /零件 tab */}

          {canManageOutsource(user) && (
            <div data-jobtab="waixie" hidden>
              <div className="mb-6 max-w-md">
                <OutsourceFlag
                  jobId={job.id}
                  state={jobOutsourceState(job)}
                  initialNeeds={Boolean(job.needsOutsource)}
                  initialNote={job.outsourceNote}
                />
              </div>
              <ExternalSection
                jobId={job.id}
                vendors={vendors}
                componentOptions={componentOptions}
                blockRows={blockRows}
              />
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

// Per-part shipment history cell — one row per batch shipped, newest at top.
// Empty state renders a single muted dash so the column stays the same width.
function ShipmentLogCell({
  entries,
}: {
  entries: ReturnType<typeof componentShipmentEntries>
}) {
  if (entries.length === 0) {
    return (
      <td className="px-3 py-3 text-[var(--color-ink-4)] mono text-[11px] align-top">
        —
      </td>
    )
  }
  const log = formatShipmentLog([...entries].reverse())
  return (
    <td className="px-3 py-3 align-top">
      <pre className="mono text-[11px] leading-snug text-[var(--color-ink-2)] whitespace-pre-wrap font-normal">
        {log}
      </pre>
    </td>
  )
}

// 动态 — the latest human touch on this part: who clicked, what they did, and
// when (date + hour, factory-local). Three stacked lines wrap inside a fixed
// width so the cell reads like 表面处理 rather than blowing the row wide. Empty
// state is a single muted dash so the column keeps its width.
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
      <div className="leading-snug">
        <div className="text-[13px] font-medium text-[var(--color-ink)] break-words">
          {a.by}
        </div>
        <div className="text-[12px] text-[var(--color-ink-2)] break-words">
          <span className="tracking-wider">{a.action}</span>
          <span className="text-[var(--color-ink-3)]"> · {a.stage}</span>
        </div>
        <div className="mt-0.5 mono text-[11px] text-[var(--color-ink-3)] whitespace-nowrap">
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

function ExternalSection({
  jobId,
  vendors,
  componentOptions,
  blockRows,
}: {
  jobId: string
  vendors: Vendor[]
  componentOptions: {
    id: string
    name: string
    qty: number
    openStages?: Stage[]
    openVendorName?: string
  }[]
  blockRows: {
    block: NonNullable<Job['components'][number]['outsourceBlocks']>[number]
  }[]
}) {
  return (
    <section className="mt-12 grid grid-cols-1 gap-10">
      <div>
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
            外协 · 送出 / 回厂
          </h3>
          <p className="label text-[var(--color-ink-3)]">
            {blockRows.filter((r) => !isBlockClosed(r.block)).length} 在外 ·{' '}
            {blockRows.filter((r) => isBlockClosed(r.block)).length} 已回
          </p>
        </div>
        {blockRows.length === 0 ? (
          <p className="text-[12px] text-[var(--color-ink-3)] py-3 border-y border-[var(--color-border)]">
            尚无外协记录
          </p>
        ) : (
          <div className="border-y border-[var(--color-border)]">
            {blockRows.map((r) => (
              <BlockRow
                key={r.block.id}
                jobId={jobId}
                block={r.block}
                vendor={vendorById(r.block.vendorId, vendors)}
                vendors={vendors}
                componentOptions={componentOptions}
              />
            ))}
          </div>
        )}
        <div className="mt-4">
          <NewBlockForm
            jobId={jobId}
            components={componentOptions}
            vendors={vendors}
          />
        </div>
      </div>
    </section>
  )
}

function ActorTrail({
  job,
  vendors,
}: {
  job: NonNullable<Awaited<ReturnType<typeof getJob>>>
  vendors: Vendor[]
}) {
  const events: { stage: string; component: string; date: string; by: string }[] =
    []
  for (const c of job.components) {
    for (const s of STAGES) {
      const st = c.stages[s]
      if (!st) continue
      if (st.status === 'done' && st.completedAt && st.by) {
        events.push({
          stage: s,
          component: c.name,
          date: st.completedAt,
          by: st.by,
        })
      }
    }
    for (const b of c.outsourceBlocks ?? []) {
      // Per-member return: this component's row in the block carries its own
      // returnedAt. Surface one event per (component, block) when that part
      // came back from the vendor — so partial returns each get a row.
      const m = b.members.find((x) => x.componentId === c.id)
      if (m?.returnedAt) {
        const v = vendorById(b.vendorId, vendors)
        events.push({
          stage: b.stages.join('+'),
          component: c.name,
          date: m.returnedAt.slice(5),
          by: v?.name ?? b.vendorId,
        })
      }
    }
  }
  events.sort((a, b) => b.date.localeCompare(a.date))
  if (events.length === 0) return null
  const recent = events.slice(0, 8)
  return (
    <section className="mt-12 border-t border-[var(--color-border)] pt-8">
      <h3 className="label mb-4">最近完成</h3>
      <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
        {recent.map((e, i) => (
          <li
            key={i}
            className="flex items-baseline gap-6 py-2.5 text-[13px] text-[var(--color-ink-2)]"
          >
            <span className="mono text-[var(--color-ink-3)] w-14 shrink-0">
              {e.date}
            </span>
            <span className="font-medium tracking-wider text-[var(--color-ink)] w-24 shrink-0">
              {e.stage}
            </span>
            <span className="text-[var(--color-ink)] flex-1">{e.component}</span>
            <span className="mono text-[12px] text-[var(--color-ink-3)]">
              {e.by}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
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
          全部开票明细见{' '}
          <a
            href="/finance?tab=ar"
            className="text-[var(--color-ink-2)] underline decoration-[var(--color-border-strong)] underline-offset-2 hover:text-[var(--color-ink)] hover:decoration-[var(--color-ink)]"
          >
            应收账款
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
