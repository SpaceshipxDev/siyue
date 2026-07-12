import { Suspense } from 'react'
import Link from 'next/link'
import {
  STAGES,
  formatCny,
  type Stage,
} from '@/lib/data'
import { componentBoardRows, todaySummary } from '@/lib/packets'
import { ComponentSheet } from './_components_sheet'
import { today } from '@/lib/today'
import { APP_TITLE } from '@/lib/brand'
import {
  getDailyFocusItems,
  getMasterAggregates,
  getMasterRowsByIds,
  getOrderMoneyLightByJob,
  getStageFlowMinutes,
} from '@/lib/db'
import { requireUser, canSeeFactoryPulse, canSeeMoney, canSeeReport } from '@/lib/auth'
import { logBoardView } from '@/lib/access-log'
import { scrubMasterRow } from '@/lib/dto'
import { getStationWip, getWorkerSelfStats } from '@/lib/pulse'
import { Pause, Pill, TopBar, type TabKey } from './_ui'
import { MyToday } from './_my_today'
import { MasterSheetLoader, StationWorkbenchLoader } from './_master_loaders'
import { DailyFocusStrip, type FocusStripRow } from './_focus_strip'
import { StationSummary } from './_station_summary'
import {
  StationReportAsync,
  StationReportFallback,
} from './_station_report'

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

  // Board-view telemetry: dashboard (stage null) vs per-station view, per
  // user. Non-blocking (runs post-response); prefetches are filtered inside.
  await logBoardView({
    userName: user.name,
    role: user.role,
    defaultStage: user.defaultStage,
    path: '/',
    stage: stageFilter,
  })

  // 工程 stage filter routes through MasterSheet (overview shape); other
  // stage filters route through StationWorkbench. Both paths render off the
  // same lightweight rollup — workbench used to need full Job[] for per-
  // component drill-down, but the cells carry enough now for its mine /
  // upstream / downstream / timer logic. Component-level data lives on the
  // job-detail page (/jobs/[id]) which still loads a single-job snapshot.
  const useMasterSheet = !stageFilter || stageFilter === '工程'

  const [stageFlowMinutes, selfStats, focusItems, aggregates, moneyLite] =
    await Promise.all([
      getStageFlowMinutes(),
      // The worker's own today/this-week numbers — fetched alongside the board so
      // the headline paints in the same shot. Only production users get a row.
      showMyToday ? getWorkerSelfStats(user.name) : Promise.resolve(null),
      // 今日重点 — the boss's daily must-do list, mirrored onto every view.
      getDailyFocusItems(today()),
      getMasterAggregates(),
      // 应收 headline — commerce only (the floor + 工程 head see no money).
      user.role === 'commerce'
        ? getOrderMoneyLightByJob()
        : Promise.resolve(null),
    ])

  // Total 应收余额 across the order book + whether anything is overdue — the
  // boss's one money number on the board's top bar (the rest of the money story
  // lives in the 收款 column below).
  let arOutstanding = 0
  let arOverdueCount = 0
  if (moneyLite) {
    for (const m of moneyLite.values()) {
      arOutstanding += m.outstandingCny
      if (m.status === 'overdue') arOverdueCount += 1
    }
  }

  const focusJobIds = focusItems
    .map((it) => it.jobId)
    .filter((id): id is string => Boolean(id))
  const rawFocusRows = await getMasterRowsByIds(focusJobIds)
  const focusMasterRows = isProduction
    ? rawFocusRows.map((r) => scrubMasterRow(r, user))
    : rawFocusRows

  // Join today's focus rows against the (scrubbed) master read so the strip
  // shows live jobNo / product / due state. Free-text rows pass through
  // unlinked. Same list for everyone — boss and floor read identical state.
  const rowById = new Map(focusMasterRows.map((r) => [r.id, r]))
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

  const overdue = aggregates.overdue
  const dueToday = aggregates.dueToday
  const inProgressCount = aggregates.inProgress
  const pausedCount = aggregates.paused
  const totalAmount = aggregates.totalAmountCny
  const totalExternal = aggregates.totalExternalSpendCny
  const totalMargin = aggregates.totalMarginCny

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
  // stage tabs light up the same way when drilling into any station. Scoped
  // floor users highlight their current stage tab, or 全部 (key 工单) when
  // they've zoomed out to the bare master grid.
  const currentTab: TabKey | undefined = isProduction
    ? isEngineering
      ? (stageFilter as TabKey | undefined) ?? '工程'
      : (stageFilter as TabKey | undefined) ?? '工单'
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

  // The component board — the product's home view. One row per live 零件
  // (photo-ingested packets AND xlsx-imported orders), stages read
  // 编程 → OPs → 后处理 → 出货. Station drill-downs (?stage=) keep the
  // original workbench below.
  const isComponentBoard = !stageFilter
  const [boardRows, reportToday] = isComponentBoard
    ? await Promise.all([componentBoardRows(), todaySummary()])
    : [[], undefined]

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title={title}
        subtitle={subtitle}
        currentTab={currentTab}
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        right={
          isEngineeringOverview ? (
            // 工程 head sees the same flow signals (overdue / today / 在产)
            // as commerce, just without the money pills.
            <div className="flex items-center gap-2">
              <Pill tone="overdue" label="逾期" value={overdue} />
              <Pill tone="warning" label="今日" value={dueToday} />
              <Pill tone="neutral" label="在产" value={inProgressCount} />
              <Pill tone="neutral" label="暂停/取消" value={pausedCount} />
            </div>
          ) : isProduction ? null : (
            // Yingma: flow signals only — no money pills on the board.
            <div className="flex items-center gap-2">
              <Pill tone="overdue" label="逾期" value={overdue} />
              <Pill tone="warning" label="今日" value={dueToday} />
              <Pill tone="neutral" label="在产" value={inProgressCount} />
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
          <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="label mb-1">
                {isEngineeringOverview ? '工程视图' : '生产总览'}
              </p>
              <h2 className="text-[28px] font-semibold tracking-tight text-[var(--color-ink)]">
                全部零件
              </h2>
              <p className="mt-1 text-[13px] text-[var(--color-ink-2)]">
                编程拍照录入 · 工人拍照报工 · 点零件名进入详情
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/ingest"
                className="h-10 px-4 inline-flex items-center text-[13px] font-semibold bg-[var(--color-ink)] text-[var(--color-surface)] rounded-[3px]"
              >
                📷 拍照录入
              </Link>
              <Link
                href="/p"
                className="h-10 px-4 inline-flex items-center text-[13px] font-medium border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)]"
              >
                拍照报工
              </Link>
            </div>
          </div>
        )}

        {isComponentBoard && reportToday && reportToday.reports > 0 ? (
          <section className="mb-4 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-[3px] px-4 py-3 flex flex-wrap items-baseline gap-x-5 gap-y-1">
            <span className="text-[11px] tracking-[0.15em] text-[var(--color-ink-3)]">
              今日报工
            </span>
            <span className="text-[15px] font-semibold font-mono">
              {reportToday.pieces} 件
              <span className="text-[12px] font-normal text-[var(--color-ink-2)] ml-1">
                · {reportToday.reports} 次
              </span>
            </span>
            <span className="flex flex-wrap gap-x-4 gap-y-1">
              {reportToday.workers.slice(0, 8).map((w) => (
                <span key={w.actor} className="text-[12px] text-[var(--color-ink-2)]">
                  {w.actor}{' '}
                  <span className="font-mono font-semibold text-[var(--color-ink)]">
                    {w.pieces}
                  </span>
                </span>
              ))}
            </span>
          </section>
        ) : null}

        {/* No xlsx/manual order entry at Yingma — the programmer's photo
            ingestion (/ingest) IS the input. MasterUploader/InboxList stay
            out of the tree deliberately. */}

        {summaryStage && (
          <StationSummary
            here={aggregates.byStage[summaryStage]?.here ?? 0}
            dueToday={aggregates.byStage[summaryStage]?.dueToday ?? 0}
            overdue={aggregates.byStage[summaryStage]?.overdue ?? 0}
            avgMinutes={stageFlowMinutes.get(summaryStage) ?? null}
            wipCny={wipForStation}
          />
        )}

        {isComponentBoard ? (
          <ComponentSheet rows={boardRows} />
        ) : useMasterSheet ? (
          // Rows are fetched client-side from /api/master/rows (see
          // _master_loaders) rather than serialized into this RSC payload —
          // that 660-row tree was the ~2.4s render bottleneck.
          <MasterSheetLoader
            role={user.role}
            defaultStage={user.defaultStage}
            stageFilter={stageFilter}
          />
        ) : (
          <StationWorkbenchLoader
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

        {stageFilter === '工程' && <Legend showMoney={false} />}
      </main>

      <footer className="border-t border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="px-4 md:px-10 py-4 flex items-baseline justify-between text-[var(--color-ink-3)]">
          <span className="label">{APP_TITLE} v0.1</span>
          <span className="label">基准日 {today()}</span>
        </div>
      </footer>
    </div>
  )
}

function Legend({ showMoney = false }: { showMoney?: boolean }) {
  return (
    <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-3 text-[var(--color-ink-2)]">
      <span className="label">图例</span>
      <LegendItem
        swatch={
          <span className="text-[13px] text-[var(--color-ink-3)]">▶</span>
        }
        text="未开始 · 点击开始整单"
      />
      <LegendItem
        swatch={<Pause size={11} className="text-[var(--color-warning)]" />}
        text="进行中 · 点击完成 (数字 = 已完成/总数)"
      />
      <LegendItem
        swatch={
          <span className="text-[12px] font-semibold tracking-wider text-[var(--color-success)]">
            ✓
          </span>
        }
        text="该工段所有零件已完成"
      />
      <LegendItem
        swatch={<Pause size={11} className="text-[var(--color-warning)]" />}
        text="外协 · 零件在外协厂加工中 (出货打勾自动结清)"
      />
      <LegendItem
        swatch={<span className="block h-3 w-1 bg-[var(--color-overdue)]" />}
        text="逾期"
      />
      <LegendItem
        swatch={<span className="block h-3 w-1 bg-[var(--color-warning)]" />}
        text="今日"
      />
      {/* 收款 column legend — only where the money light renders (商务 overview). */}
      {showMoney && (
        <>
          <span className="label text-[var(--color-ink-3)]">收款</span>
          <LegendItem
            swatch={
              <span className="text-[11px] font-semibold text-[var(--color-overdue)]">逾期</span>
            }
            text="已开票逾期未回款"
          />
          <LegendItem
            swatch={
              <span className="text-[11px] font-medium text-[var(--color-warning)]">待回款</span>
            }
            text="已开票 · 待回款"
          />
          <LegendItem
            swatch={
              <span className="text-[11px] font-medium text-[var(--color-info)]">待开票</span>
            }
            text="已出货 · 未开票"
          />
          <LegendItem
            swatch={
              <span className="text-[12px] font-semibold text-[var(--color-success)]">✓</span>
            }
            text="已结清"
          />
        </>
      )}
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
