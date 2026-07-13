import { notFound, redirect } from 'next/navigation'
import { withBase } from '@/lib/base-path'
import {
  TRACKING_STAGES as STAGES,
  daysFromToday,
  dueState,
  effectiveStageState,
  formatActivityTimestamp,
  formatCny,
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
  canEditPartRoute,
  canEditProductionFields,
  canManageOutsource,
  canSeeCustomerData,
  canSeeMoney,
  canSeeReport,
  requireUser,
} from '@/lib/auth'
import { scrubJob, scrubVendors } from '@/lib/dto'
import { StageHeader, TopBar, type TabKey } from '@/app/_ui'
import { EffectiveStageCell } from '@/app/_stagecell'
import { BackButton } from '@/app/_back'
import {
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
import { HeaderEdit } from './_header_edit'
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
import { jobSourceImageGroups, listJobReportEvents } from '@/lib/packets'
import { supabase } from '@/lib/supabase'
import { BaogongPanel } from './_baogong'
import { JobSourceImages } from './_source_images'

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
  const [rawJob, fetchedVendors, contractFiles, reportEvents, sourceImageGroups] = await Promise.all([
    getJob(id),
    getVendors(),
    showMoney ? getContractFiles(id) : Promise.resolve([]),
    listJobReportEvents(id).catch(() => []),
    jobSourceImageGroups(id).catch(() => []),
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

  // Only the stages this job's parts actually route through become columns.
  // A 2-OP part shows OP1 · OP2 · 后处理 — never a crossed-out OP3..OP6.
  const visibleStages = STAGES.filter((s) =>
    job.components.some((c) => c.stages[s] !== undefined),
  )

  // Header identity facts — 数量 straight off the parts; 图纸号 lives in the
  // new drawing_no column (0083), which the snapshot layer predates, so one
  // narrow read here.
  const headerQtyTotal = job.components.reduce((s, c) => s + (c.qty || 0), 0)
  let headerDrawingNo: string | undefined
  let headerPartRowId: string | undefined
  {
    const { data } = await supabase
      .from('parts')
      .select('id, drawing_no')
      .eq('job_id', job.id)
      .limit(5)
    headerDrawingNo =
      (data?.find((r) => r.drawing_no)?.drawing_no as string | null) ?? undefined
    headerPartRowId = (data?.[0]?.id as string | null) ?? undefined
  }

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
  void openOutsourceCount
  // Yingma job page = 零件 (progress) + 报工 (who did how many, the full
  // timeline). The parent's 外协/财务 tabs are deliberately not offered —
  // their sections below stay hidden.
  const jobTabs = [
    { key: 'parts', label: '零件' },
    {
      key: 'baogong',
      label: '报工',
      badge: reportEvents.length > 0 ? String(reportEvents.length) : undefined,
    },
  ]

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title={job.product}
        subtitle="零件详情"
        currentTab={currentTab}
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
      />

      <main className="mx-auto w-full max-w-[1500px] px-4 md:px-10 py-6 md:py-10 flex-1">
        <ComponentAnchorScroller />
        <div className="mb-6">
          <BackButton fallback={backFallback} />
        </div>

        {/* Component identity header — the six facts on the stamped paper,
            nothing else. No invented work ids, no commerce metadata; the
            customer's own 货号/图纸号 is the reference everyone speaks.
            Every fact is editable in place — the card is AI-extracted from
            photos and a scribbled stamp can misread (数量 32 → 2). */}
        <div className="mb-8 border-b border-[var(--color-border)] pb-6">
          {job.components[0] ? (
            <HeaderEdit
              jobId={job.id}
              componentId={job.components[0].id}
              partId={headerPartRowId}
              initial={{
                name: job.product,
                customer: job.customer,
                partNo: job.components[0].partNo ?? '',
                drawingNo: headerDrawingNo ?? '',
                qty: headerQtyTotal,
                dueDate: job.dueDate ?? '',
                material: job.components[0].material ?? '',
              }}
              dueState={ds}
              dueDays={days}
              progress={{ percent: pct, done: doneCells, total: totalCells }}
            />
          ) : null}
        </div>

        <JobSourceImages groups={sourceImageGroups} />

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

        <ComponentsScrollArea
          myStage={myStage}
          className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]"
        >
          <table className="sheet w-full text-left text-[13px]">
            <colgroup>
              <col style={{ width: 56 }} />
              <col style={{ width: 200 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 130 }} />
              <col style={{ width: 180 }} />
              <col style={{ width: 220 }} />
              {/* 工序 (StageChips) — sits between 表面处理 and the stage grid.
                  Without its own <col> every column to the right inherits the
                  wrong width and 备注/单价 fall off the end of the
                  colgroup. */}
              <col style={{ width: 150 }} />
              {visibleStages.map((s) => (
                <col key={s} style={{ width: 90 }} />
              ))}
              <col style={{ width: 170 }} />
              {canEditFields && <col style={{ width: 170 }} />}
              {showMoney && <col style={{ width: 110 }} />}
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
                  data-sticky-edge
                  className="sticky-col sticky-col-edge px-4 py-3 label whitespace-nowrap"
                  style={{ left: 56 }}
                >
                  零件
                </th>
                <th className="px-4 py-3 label whitespace-nowrap">料号</th>
                <th className="px-4 py-3 text-right label whitespace-nowrap">
                  数量
                </th>
                <th className="px-4 py-3 label whitespace-nowrap">材料</th>
                <th className="px-4 py-3 label whitespace-nowrap">表面处理</th>
                <th className="px-4 py-3 label whitespace-nowrap">工序</th>
                {visibleStages.map((s) => (
                  <th
                    key={s}
                    data-stage-col={s}
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
                      <JobPartStageFunnel stage={s} />
                    </span>
                  </th>
                ))}
                <th className="px-3 py-3 label whitespace-nowrap">动态</th>
                {canEditFields && (
                  <th className="px-4 py-3 label whitespace-nowrap">备注</th>
                )}
                {showMoney && (
                  <th className="px-4 py-3 text-right label whitespace-nowrap">
                    单价
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {/* 排产 plan row — a slim pinned first row carrying each stage's
                  job-level planned finish date, optically aligned over the stage
                  column it governs. Has no data-part-id, so the part filter
                  never hides or counts it. Blank under stages this job doesn't
                  plan (检验 / 出货 / off-route). */}
              {planStages.length > 0 && (
                <tr className="align-middle">
                  <td
                    colSpan={8}
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
                  {visibleStages.map((stage) => {
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
                      2 + (canEditFields ? 1 : 0) + (showMoney ? 1 : 0)
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
                <tr
                  key={c.id}
                  id={`c-${c.id}`}
                  data-part-id={c.id}
                  data-st={partStageCodes[c.id]}
                  className="align-middle"
                >
                    <td
                      className="sticky-col px-3 py-3 text-center mono text-[var(--color-ink-3)] text-[12px]"
                      style={{ left: 0 }}
                    >
                      {String(i + 1).padStart(2, '0')}
                    </td>
                    <td
                      className="sticky-col sticky-col-edge px-3 py-3"
                      style={{ left: 56 }}
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
                    {visibleStages.map((stage) => {
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
                  </tr>
              ))}
            </tbody>
          </table>
        </ComponentsScrollArea>
        </JobPartFilterProvider>
          </div>
          {/* /零件 tab */}

          <div data-jobtab="baogong" hidden>
            <BaogongPanel
              events={reportEvents}
              partQtyById={Object.fromEntries(job.components.map((c) => [c.id, c.qty]))}
              partNameById={Object.fromEntries(job.components.map((c) => [c.id, c.name]))}
              multiPart={job.components.length > 1}
            />
          </div>

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
          ，单价可在「零件」逐件填写。
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
