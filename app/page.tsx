import { Suspense } from 'react'
import {
  STAGES,
  dueState,
  formatCny,
  type Stage,
} from '@/lib/data'
import { today } from '@/lib/today'
import { getDailyFocusItems, getMasterRows, getStageFlowMinutes } from '@/lib/db'
import { requireUser, canSeeFactoryPulse, canSeeMoney } from '@/lib/auth'
import { scrubMasterRow } from '@/lib/dto'
import { getStationWip, getWorkerSelfStats } from '@/lib/pulse'
import { Pill, TopBar, type TabKey } from './_ui'
import { MyToday } from './_my_today'
import { MasterUploader } from './_uploader'
import { InboxList } from './_inbox_list'
import { MasterSheet } from './_master_filter'
import { DailyFocusStrip, type FocusStripRow } from './_focus_strip'
import { StationSummary } from './_station_summary'
import {
  StationReportAsync,
  StationReportFallback,
} from './_station_report'
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
  // Every production user — anyone who ticks stages — gets the personal 今日
  // 产出 headline on their home view; only 商务 don't. Note most of the floor
  // carries defaultStage='工程' (broad-access workers, not just the planning
  // head), so this deliberately includes them — gating on a single station
  // would hide the headline from the bulk of the people it's for.
  const showMyToday = isProduction

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

  // 工程 stage filter routes through MasterSheet (overview shape); other
  // stage filters route through StationWorkbench. Both paths render off the
  // same lightweight rollup — workbench used to need full Job[] for per-
  // component drill-down, but the cells carry enough now for its mine /
  // upstream / downstream / timer logic. Component-level data lives on the
  // job-detail page (/jobs/[id]) which still loads a single-job snapshot.
  const useMasterSheet = !stageFilter || stageFilter === '工程'

  const [rawRows, stageFlowMinutes, selfStats, focusItems] = await Promise.all([
    getMasterRows(),
    getStageFlowMinutes(),
    // The worker's own today/this-week numbers — fetched alongside the board so
    // the headline paints in the same shot. Only production users get a row.
    showMyToday ? getWorkerSelfStats(user.name) : Promise.resolve(null),
    // 今日重点 — the boss's daily must-do list, mirrored onto every view.
    getDailyFocusItems(today()),
  ])

  const rows = isProduction ? rawRows.map((r) => scrubMasterRow(r, user)) : rawRows

  // Join today's focus rows against the (scrubbed) master read so the strip
  // shows live jobNo / product / due state. Free-text rows pass through
  // unlinked. Same list for everyone — boss and floor read identical state.
  const rowById = new Map(rows.map((r) => [r.id, r]))
  const focusRows: FocusStripRow[] = focusItems.map((it) => {
    const job = it.jobId ? rowById.get(it.jobId) : undefined
    return {
      id: it.id,
      jobId: job?.id,
      jobNo: job?.jobNo ?? it.jobNoText,
      // Board-local 产品/交期 overrides win over the live join — the strip
      // broadcasts exactly what the curator typed on /daily.
      product: it.productText ?? job?.product,
      dueDate: it.dueText ?? job?.effectiveDueDate,
      feedback: it.feedback,
      isShipped: job?.isShipped,
    }
  })
  const [, fm, fd] = today().split('-')
  const focusDayLabel = `${parseInt(fm, 10)}月${parseInt(fd, 10)}日`

  // 工程 head runs imports too, so they get the same draft/parsing inbox
  // commerce sees. Pure-floor production users (焊接, 喷塑, etc.) still
  // get an empty inbox — they don't own the import flow.
  const inbox =
    isProduction && !isEngineering
      ? []
      : rows.filter(
          (r) =>
            r.status === 'parsing' || r.status === 'draft' || r.status === 'failed',
        )
  // Effective due date is precomputed on the row; just sort by it.
  const live = rows.filter(
    (r) => r.status !== 'parsing' && r.status !== 'draft' && r.status !== 'failed',
  )
  const sorted = [...live].sort((a, b) =>
    a.effectiveDueDate.localeCompare(b.effectiveDueDate),
  )
  // 在产 / 逾期 / 今日 pills are "needs attention" signals — shipped jobs
  // (every in-route part done at 出货) are off the floor, so they don't
  // count even if their dueDate is in the past. Paused (暂停) jobs are
  // deliberately on hold, so they're carved out into their own pill and don't
  // skew 在产 / 逾期 / 今日. Mirrors the MasterSheet 在产 / 暂停 / 已出货 split
  // (see _master_filter.tsx liveCount).
  const inProgress = sorted.filter((r) => !r.isShipped && !r.pausedAt)
  const pausedCount = sorted.filter((r) => !r.isShipped && r.pausedAt).length
  const overdue = inProgress.filter(
    (r) => dueState(r.effectiveDueDate) === 'overdue',
  ).length
  const dueToday = inProgress.filter(
    (r) => dueState(r.effectiveDueDate) === 'today',
  ).length
  const totalAmount = sorted.reduce((sum, r) => sum + (r.amountCny ?? 0), 0)
  const totalExternal = sorted.reduce((sum, r) => sum + r.externalSpendCny, 0)
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
  // 工程 head's nav mirrors commerce — home tab is 工程 (not 商务), and the
  // stage tabs light up the same way when drilling into any station.
  // Other production stations have no tabs to highlight.
  const currentTab: TabKey | undefined = isProduction
    ? isEngineering
      ? (stageFilter as TabKey | undefined) ?? '工程'
      : undefined
    : (stageFilter as TabKey | undefined) ?? '商务'
  // useMasterSheet was computed above (before the data fetch) so we know
  // which read shape to load. Workbench-path renders below.
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

  // Boss-only station extras: ¥WIP (small, inline) and a per-station audit
  // strip (larger, streamed). Skipped for workers (no money visibility) and
  // skipped on the overview view (factory-wide chrome there instead).
  //
  // WIP is one tiny view read (9 rows) → fetched alongside the master pull
  // so the StationSummary band paints in one shot. Activity is its own
  // round-trip behind <Suspense> below so the workbench/sheet flushes
  // immediately and the boss audit strip streams in after — workers never
  // wait on it, boss never blocks on it.
  const showBossStationExtras = canSeeMoney(user) && !!summaryStage
  const stationWipRows = showBossStationExtras ? await getStationWip() : undefined
  const wipForStation = stationWipRows?.find((r) => r.stage === summaryStage)?.wipCny

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
              <Pill tone="neutral" label="暂停" value={pausedCount} />
            </div>
          ) : isProduction ? null : (
            <div className="flex items-center gap-2">
              <Pill tone="overdue" label="逾期" value={overdue} />
              <Pill tone="warning" label="今日" value={dueToday} />
              <Pill tone="neutral" label="在产" value={inProgress.length} />
              <Pill tone="neutral" label="暂停" value={pausedCount} />
              <Pill tone="info" label="总额" value={formatCny(totalAmount)} />
              <Pill tone="info" label="外发" value={formatCny(totalExternal)} />
              <Pill tone="success" label="毛利" value={formatCny(totalMargin)} />
            </div>
          )
        }
      />

      <main className="w-full px-4 md:px-10 py-6 md:py-10 flex-1">
        {selfStats && (
          <MyToday name={user.name} stats={selfStats} todayStr={today()} />
        )}

        {/* 今日重点 — rendered on EVERY view of this page (商务 overview,
            工程 holistic, every worker's ?stage= station view) so the whole
            floor reads the same daily list without a WeChat blast. */}
        <DailyFocusStrip
          rows={focusRows}
          dayLabel={focusDayLabel}
          canManage={canSeeFactoryPulse(user)}
        />


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
                点击任意单元格进入工单 · 点击工段表头漏斗按状态筛选
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
              componentCount: d.componentCount,
            }))}
          />
        ) : null}

        {summaryStage && (
          <StationSummary
            rows={sorted}
            stage={summaryStage}
            avgMinutes={stageFlowMinutes.get(summaryStage) ?? null}
            wipCny={wipForStation}
          />
        )}

        {useMasterSheet ? (
          <MasterSheet
            rows={sorted}
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
            rows={sorted}
            stage={stageFilter!}
            role={user.role}
            defaultStage={user.defaultStage}
          />
        )}

        {showBossStationExtras && summaryStage && (
          <Suspense fallback={<StationReportFallback stage={summaryStage} />}>
            <StationReportAsync
              stage={summaryStage}
              showMoney={canSeeMoney(user)}
            />
          </Suspense>
        )}

        {showOverviewChrome && <Legend />}
      </main>

      <footer className="border-t border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="px-4 md:px-10 py-4 flex items-baseline justify-between text-[var(--color-ink-3)]">
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
