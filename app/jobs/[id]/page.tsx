import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import {
  STAGES,
  componentShipmentEntries,
  daysFromToday,
  dueState,
  effectiveStageState,
  formatCny,
  formatShipmentLog,
  isBlockClosed,
  jobComponentsTotal,
  jobExternalSpend,
  jobIsShipped,
  jobMargin,
  jobReturnedQtyByPart,
  vendorById,
  type Job,
  type Vendor,
} from '@/lib/data'
import { getJob, getProcessCard, getVendors } from '@/lib/db'
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
  JobNotes,
  JobText,
} from '@/app/_editable'
import { BlockRow, NewBlockForm } from '@/app/_routing'
import { ExternalBadge } from '@/app/_externalbadge'
import { ComponentImageUploader } from '@/app/_image_uploader'
import { StageChips } from '@/app/_stagechips'
import { ComponentsScrollArea } from '@/app/_components_table'
import { ComponentAnchorScroller } from '@/app/_component_anchor'
import { SourceFileRow } from '@/app/_source_file'
import {
  ActiveReturnBadge,
  OpenReturnButton,
  ReturnedComponentChip,
} from '@/app/_returns'
import { ShippingComposerButton } from '@/app/_shipping'
import { JobTypeEditor } from '@/app/_type_chip'
import {
  ProcessCardButton,
  type StoredProcessCard,
} from '@/app/_process_card'
import { normalizeCard } from '@/lib/gemini-card'

// Intentionally not `force-dynamic`. The page still ends up dynamic because
// `requireUser()` reads cookies and `getJob` is uncached, but leaving Next's
// default in place lets the master board's <Link prefetch> warm the static
// shell (loading.tsx) into the router cache. China clients get the skeleton
// rendered instantly on click; the real content streams in behind it.
export default async function JobDetail(props: PageProps<'/jobs/[id]'>) {
  const user = await requireUser()
  const { id } = await props.params
  // Process card is non-critical for first paint — only the toolbar button
  // depends on it. Pull it in via <Suspense> so the page header + parts table
  // can flush as soon as job + vendors resolve, instead of blocking on the
  // slowest of three queries.
  const [rawJob, rawVendors] = await Promise.all([getJob(id), getVendors()])
  if (!rawJob) notFound()

  const isProduction = user.role === 'production'
  // 出货 production users get customer-flavored visibility (customer name +
  // 出货单 print). They still don't edit, manage outsource, or see money.
  const showCustomer = canSeeCustomerData(user)
  const showMoney = canSeeMoney(user)
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

  // Denominator counts only stages that actually apply to each part — a part
  // routed through 5 stages contributes 5, not 9. Otherwise 100% would be
  // unreachable for any job whose parts skip stages.
  let totalCells = 0
  let doneCells = 0
  for (const c of job.components) {
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

  const componentOptions = job.components.map((c) => ({
    id: c.id,
    name: c.name,
    qty: c.qty,
    hasAnyBlock: (c.outsourceBlocks ?? []).length > 0,
  }))

  // Per-component returned-qty lookup for the active return. Empty map when
  // no return is open, so the badge naturally disappears once 关闭 is hit.
  const returnedQtyByPart = jobReturnedQtyByPart(job)

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
            <Suspense fallback={<ProcessCardButtonFallback />}>
              <AsyncProcessCardButton jobId={job.id} jobNo={job.jobNo} />
            </Suspense>
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
                <div className="mt-1">
                  <JobText
                    jobId={job.id}
                    field="product"
                    value={job.product}
                    className="text-[14px] text-[var(--color-ink-2)]"
                    placeholder="产品"
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
                canEdit={canManageOutsource(user)}
              />
            </div>
          </div>
          {showMoney && (
            <div className="col-span-2 md:col-span-3">
              <p className="label mb-2">金额 / 外发 / 毛利</p>
              <div className="flex items-baseline gap-1">
                <span className="mono text-[15px] text-[var(--color-ink-3)]">
                  ¥
                </span>
                <JobAmount
                  jobId={job.id}
                  value={job.amountCny}
                  className="text-[15px] font-medium text-[var(--color-ink)]"
                />
              </div>
              {externalSpend > 0 ? (
                <p className="mono text-[11px] text-[var(--color-ink-3)] mt-0.5">
                  外 {formatCny(externalSpend)}
                  {typeof margin === 'number'
                    ? ` · 利 ${formatCny(margin)}`
                    : ''}
                </p>
              ) : (
                <p className="label text-[var(--color-ink-4)] mt-0.5">无外发</p>
              )}
              {componentsTotal > 0 && (
                <p className="mono text-[11px] text-[var(--color-ink-3)] mt-0.5">
                  零件合计 {formatCny(componentsTotal)}
                </p>
              )}
            </div>
          )}
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
          </div>
          <div className={showMoney ? 'col-span-2 md:col-span-3' : 'col-span-2 md:col-span-6'}>
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
            <SourceFileRow
              jobId={job.id}
              fileName={job.sourceFile}
              url={job.sourceFileUrl}
            />
          )}
        </div>

        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
            零件进度
          </h2>
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
          className="overflow-x-auto rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)]"
        >
          <table className="sheet w-full text-left text-[13px]">
            <colgroup>
              <col style={{ width: 56 }} />
              <col style={{ width: 78 }} />
              <col style={{ width: 200 }} />
              <col style={{ width: 70 }} />
              <col style={{ width: 130 }} />
              <col style={{ width: 180 }} />
              <col style={{ width: 220 }} />
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
              {canEditFields && <col style={{ minWidth: 180 }} />}
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
              {job.components.map((c, i) => (
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
                    <td className="px-3 py-3">
                      {canEditFields ? (
                        <ComponentText
                          jobId={job.id}
                          componentId={c.id}
                          field="material"
                          value={c.material}
                          placeholder="材料"
                          className="text-[12px] text-[var(--color-ink-2)]"
                        />
                      ) : (
                        <span className="text-[12px] text-[var(--color-ink-2)]">
                          {c.material ?? ''}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {canEditFields ? (
                        <ComponentText
                          jobId={job.id}
                          componentId={c.id}
                          field="surfaceTreatment"
                          value={c.surfaceTreatment}
                          placeholder="表面处理"
                          className="text-[12px] text-[var(--color-ink-2)]"
                        />
                      ) : (
                        <span className="text-[12px] text-[var(--color-ink-2)]">
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
                    {canEditFields && (
                      <td className="px-3 py-3">
                        <ComponentNotes
                          jobId={job.id}
                          componentId={c.id}
                          value={c.notes}
                          placeholder="添加备注…"
                          className="text-[12px] text-[var(--color-ink-2)]"
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

        {canManageOutsource(user) && (
          <ExternalSection
            jobId={job.id}
            vendors={vendors}
            componentOptions={componentOptions}
            blockRows={blockRows}
          />
        )}

        <ActorTrail job={job} vendors={vendors} />
      </main>
    </div>
  )
}

async function AsyncProcessCardButton({
  jobId,
  jobNo,
}: {
  jobId: string
  jobNo: string
}) {
  const processCard = await getProcessCard(jobId)
  return (
    <ProcessCardButton
      jobId={jobId}
      jobNo={jobNo}
      initial={
        processCard
          ? ({
              jobId: processCard.jobId,
              card: normalizeCard(processCard.card),
              sourceFiles: processCard.sourceFiles,
              model: processCard.model,
              generatedAt: processCard.generatedAt,
              generatedBy: processCard.generatedBy,
            } satisfies StoredProcessCard)
          : null
      }
    />
  )
}

function ProcessCardButtonFallback() {
  return (
    <span className="px-3 py-1.5 text-[12px] tracking-wider rounded-sm border border-[var(--color-border)] text-[var(--color-ink-3)]">
      工艺卡 …
    </span>
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
    hasAnyBlock: boolean
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
