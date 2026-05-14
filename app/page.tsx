import {
  STAGES,
  dueState,
  formatCny,
  jobEffectiveDueDate,
  jobExternalSpend,
  jobIsShipped,
  type Stage,
} from '@/lib/data'
import { today } from '@/lib/today'
import { getJobs } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { scrubJob } from '@/lib/dto'
import { Pill, TopBar, type TabKey } from './_ui'
import { MasterUploader } from './_uploader'
import { InboxList } from './_inbox_list'
import { MasterSheet } from './_master_filter'
import { StationSummary } from './_station_summary'
import { StationWorkbench } from './_workbench'

export const dynamic = 'force-dynamic'

export default async function MasterBoard(
  props: PageProps<'/'>,
) {
  const user = await requireUser()
  const isProduction = user.role === 'production'
  // 工程 head sees the holistic master view (same UI as commerce) minus
  // customer + money. They land at bare /, never auto-pinned to ?stage=工程.
  const isEngineering = isProduction && user.defaultStage === '工程'

  // Workers land on `/?stage=<their-stage>` via the post-login proxy redirect
  // so the URL itself encodes the filter — refresh-stable and shareable.
  // We deliberately do NOT auto-redirect here on missing `?stage=`: that would
  // re-apply the filter the moment a worker clicks "查看全部" (which pushes
  // bare `/`), making the toggle un-clickable.
  const sp = await props.searchParams
  const rawStage = typeof sp?.stage === 'string' ? sp.stage : undefined

  const stageFilter: Stage | undefined =
    rawStage && (STAGES as readonly string[]).includes(rawStage)
      ? (rawStage as Stage)
      : undefined

  const rawJobs = await getJobs()
  const jobs = isProduction
    ? rawJobs.map((j) => scrubJob(j, user))
    : rawJobs

  // 工程 head runs imports too, so they get the same draft/parsing inbox
  // commerce sees. Pure-floor production users (焊接, 喷塑, etc.) still
  // get an empty inbox — they don't own the import flow.
  const inbox =
    isProduction && !isEngineering
      ? []
      : jobs.filter(
          (j) =>
            j.status === 'parsing' || j.status === 'draft' || j.status === 'failed',
        )
  const live = jobs.filter(
    (j) => j.status !== 'parsing' && j.status !== 'draft' && j.status !== 'failed',
  )
  // Effective due date: returning jobs sort by their internal rework deadline,
  // not the long-past original ship date. Top-bar overdue/今日 pills follow
  // the same effective date so the counters match what the user sees on the
  // grid. See jobEffectiveDueDate.
  const sorted = [...live].sort((a, b) =>
    jobEffectiveDueDate(a).localeCompare(jobEffectiveDueDate(b)),
  )
  // 在产 / 逾期 / 今日 pills are "needs attention" signals — shipped jobs
  // (every in-route part done at 出货) are off the floor, so they don't
  // count even if their dueDate is in the past. Mirrors the MasterSheet
  // 进行中 / 已出货 split (see _master_filter.tsx liveCount).
  const inProgress = sorted.filter((j) => !jobIsShipped(j))
  const overdue = inProgress.filter(
    (j) => dueState(jobEffectiveDueDate(j)) === 'overdue',
  ).length
  const dueToday = inProgress.filter(
    (j) => dueState(jobEffectiveDueDate(j)) === 'today',
  ).length
  const totalAmount = sorted.reduce((sum, job) => sum + (job.amountCny ?? 0), 0)
  const totalExternal = sorted.reduce((sum, job) => sum + jobExternalSpend(job), 0)
  const totalMargin = totalAmount - totalExternal

  // Production users see just their station name as the title — no "工单" /
  // "我的工单" subtitle clutter; the StationSummary card below carries the
  // weight that subtitle used to. 工程 head's holistic landing borrows the
  // commerce chrome (title + subtitle) since they're looking at the whole
  // floor, not just their own queue.
  // 工程 stage anywhere — bare /, /?stage=工程, by 工程 head or by commerce
  // — gets the same "工程总览" framing, since the underlying view is the
  // same flat master grid in every case. Other stages keep the per-station
  // workbench framing.
  const title = isProduction
    ? isEngineering && !stageFilter
      ? '工程总览'
      : stageFilter ?? '全厂工单'
    : stageFilter === '工程'
      ? '工程总览'
      : stageFilter
        ? `${stageFilter} 工段`
        : '商务总览'
  const subtitle = isProduction
    ? isEngineering && !stageFilter
      ? '全部在产工单'
      : undefined
    : stageFilter === '工程'
      ? '全部在产工单'
      : stageFilter
        ? `查看 · ${stageFilter}`
        : '全部在产工单'
  // 工程 head's nav has a 工程 tab pointing at their master view — light it
  // up whenever they're on /, /?stage=工程, or any URL that renders the
  // engineering view. Other production stations have no tabs to highlight.
  const currentTab: TabKey | undefined = isProduction
    ? isEngineering && (!stageFilter || stageFilter === '工程')
      ? '工程'
      : undefined
    : (stageFilter as TabKey | undefined) ?? '商务'
  // 工程 stage no longer has a per-stage StationWorkbench surface — the
  // whole "工程 view" is the holistic 商务-style master sheet, just with
  // the 工程 column highlighted + actionable. So /?stage=工程 (the URL the
  // 工程 tab routes to) renders the same MasterSheet as bare /.
  const useMasterSheet = !stageFilter || stageFilter === '工程'
  // "Overview" = commerce hovering over the whole factory (no station picked).
  // The 商务视图 header / MasterUploader / inbox / Legend chrome is for that
  // landing only — when commerce drills into a station they get the same
  // station-floor view a worker sees, with no overview clutter.
  const isOverview = !isProduction && !stageFilter
  // 工程 head shares the commerce-style holistic chrome at bare /, but
  // without the master uploader (commerce-only) or import inbox (commerce
  // owns initial confirmation). Money pills are also stripped — they don't
  // see prices anywhere else.
  const isEngineeringOverview = isEngineering && !stageFilter
  // Anything that should render the commerce-style header/legend on the
  // master view — pure commerce overview OR 工程 holistic view.
  const showOverviewChrome = isOverview || isEngineeringOverview
  // The stage we treat as "this station" for the StationSummary + MasterSheet
  // highlight: URL stage if present, else the user's home station. Commerce
  // gets the summary only when they've navigated to a station; the bare
  // overview keeps its existing 6-pill TopBar. 工程 head's holistic landing
  // mirrors commerce — no StationSummary card on the overview, since the
  // master grid IS the overview.
  const summaryStage: Stage | undefined =
    stageFilter ??
    (isProduction && !isEngineeringOverview ? user.defaultStage : undefined)

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title={title}
        subtitle={subtitle}
        currentTab={currentTab}
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        right={
          isEngineeringOverview ? (
            // 工程 head sees the same flow signals (overdue / today / 在产)
            // as commerce, just without the money pills.
            <div className="flex items-center gap-2">
              <Pill tone="overdue" label="逾期" value={overdue} />
              <Pill tone="warning" label="今日" value={dueToday} />
              <Pill tone="neutral" label="在产" value={inProgress.length} />
            </div>
          ) : isProduction ? null : (
            <div className="flex items-center gap-2">
              <Pill tone="overdue" label="逾期" value={overdue} />
              <Pill tone="warning" label="今日" value={dueToday} />
              <Pill tone="neutral" label="在产" value={inProgress.length} />
              <Pill tone="info" label="总额" value={formatCny(totalAmount)} />
              <Pill tone="info" label="外发" value={formatCny(totalExternal)} />
              <Pill tone="success" label="毛利" value={formatCny(totalMargin)} />
            </div>
          )
        }
      />

      <main className="mx-auto w-full max-w-[1500px] px-4 md:px-10 py-6 md:py-10 flex-1">
        {showOverviewChrome && (
          <div className="mb-6 flex items-baseline justify-between">
            <div>
              <p className="label mb-1">
                {isEngineeringOverview ? '工程视图' : '商务视图'}
              </p>
              <h2 className="text-[28px] font-semibold tracking-tight text-[var(--color-ink)]">
                全部工单
              </h2>
              <p className="mt-1 text-[13px] text-[var(--color-ink-2)]">
                点击任意单元格进入工单 · 点击工段表头进入工段台
              </p>
            </div>
            <p className="label">{sorted.length} 个工单</p>
          </div>
        )}

        {showOverviewChrome && <MasterUploader />}

        {showOverviewChrome && inbox.length > 0 ? (
          <InboxList
            inbox={inbox.map((d) => ({
              id: d.id,
              jobNo: d.jobNo,
              customer: d.customer,
              product: d.product,
              status: d.status as 'parsing' | 'draft' | 'failed',
              componentCount: d.components.length,
            }))}
          />
        ) : null}

        {summaryStage && <StationSummary jobs={sorted} stage={summaryStage} />}

        {useMasterSheet ? (
          <MasterSheet
            jobs={sorted}
            role={user.role}
            defaultStage={user.defaultStage}
            stageFilter={stageFilter}
            // The highlighted column gets per-cell start/pause buttons whenever
            // the viewer can actually act on that stage:
            //   • commerce drilling into any stage (commerce can act everywhere),
            //   • 工程 head on the holistic / or /?stage=工程 view (their home stage),
            //   • any production user whose home stage matches the highlight.
            // Without this, the 工程 tab as commerce or admin renders static
            // rollup counts and the start/pause control disappears.
            actionableHighlight={
              isProduction
                ? Boolean(user.defaultStage)
                : Boolean(stageFilter)
            }
          />
        ) : (
          <StationWorkbench
            jobs={sorted}
            stage={stageFilter!}
            role={user.role}
            defaultStage={user.defaultStage}
          />
        )}

        {showOverviewChrome && <Legend />}
      </main>

      <footer className="border-t border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto max-w-[1500px] px-4 md:px-10 py-4 flex items-baseline justify-between text-[var(--color-ink-3)]">
          <span className="label">越侬模型 · 思跃 MES v0.1</span>
          <span className="label">基准日 {today()}</span>
        </div>
      </footer>
    </div>
  )
}

function Legend() {
  return (
    <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-3 text-[var(--color-ink-2)]">
      <span className="label">图例</span>
      <LegendItem
        swatch={
          <span className="text-[12px] font-semibold tracking-wider text-[var(--color-success)]">
            ✓
          </span>
        }
        text="该工段所有零件已完成"
      />
      <LegendItem
        swatch={
          <span className="mono text-[12px] text-[var(--color-warning)] font-medium">
            3/5
          </span>
        }
        text="进行中 (已完成/总数)"
      />
      <LegendItem
        swatch={<span className="mono text-[12px] text-[var(--color-ink-4)]">—</span>}
        text="未开始"
      />
      <LegendItem
        swatch={<span className="block h-3 w-1 bg-[var(--color-overdue)]" />}
        text="逾期"
      />
      <LegendItem
        swatch={<span className="block h-3 w-1 bg-[var(--color-warning)]" />}
        text="今日"
      />
    </div>
  )
}

function LegendItem({
  swatch,
  text,
}: {
  swatch: React.ReactNode
  text: string
}) {
  return (
    <span className="flex items-center gap-2">
      <span className="inline-flex h-5 min-w-[28px] items-center justify-center">
        {swatch}
      </span>
      <span className="text-[12px] text-[var(--color-ink-2)]">{text}</span>
    </span>
  )
}
