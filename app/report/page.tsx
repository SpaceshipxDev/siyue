import Link from 'next/link'
import { isReportView, type ReportView } from '@/lib/report-view'
import {
  requireReportViewer,
  canSeeMoney,
  canSeeReport,
  canSeeOrderLedger,
  canFixReport,
} from '@/lib/auth'
import { getMasterRows, getOutsourceBlockRows, getStageCellsByJob } from '@/lib/db'
import { blockClosedAt, OPT_IN_STAGES, PLANNABLE_STAGES } from '@/lib/data'
import type { MasterRow } from '@/lib/master'
import { today } from '@/lib/today'
import { computePlanRates, type JobOutsource } from '@/lib/plan-rate'
import { ReportClient } from './_cockpit'
import { PlanRateBoard } from './_plan_board'
import { TopBar } from '../_ui'

export const dynamic = 'force-dynamic'

// /report — 报工. A thin server shell: auth + initial URL state, then the whole
// view is client-driven (app/report/_cockpit.tsx) so switching station/period
// and drilling into a person are instant fetches, never a full-page reload.
// Data comes from /api/report. Commerce-only (requireReportViewer).
//
// 两栏, 同一个模块:
//   报工     (默认) 按工段 · 完成工序经手
//   计划达成 (v=plan) 按工程排的时间节点, 每道工序到了那天做完了没有 ——
//            一个月一张, 口径在 lib/plan-rate.ts。

type Gran = 'day' | 'week' | 'month'
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7)
}

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{
    stage?: string
    g?: string
    d?: string
    w?: string
    v?: string
    m?: string
  }>
}) {
  const user = await requireReportViewer()
  const todayStr = today()
  const sp = await searchParams
  const view = sp?.v === 'plan' ? 'plan' : 'work'

  const stage: ReportView | null = isReportView(sp?.stage) ? sp.stage : null
  const gran: Gran = sp?.g === 'week' || sp?.g === 'month' ? sp.g : 'day'
  const anchor = typeof sp?.d === 'string' && ISO_DATE.test(sp.d) ? sp.d : todayStr
  // 找人 — a pre-selected 经手人 (deep link / refresh), free text like the
  // actor names themselves; the client validates it against the roster.
  const worker = typeof sp?.w === 'string' && sp.w.trim() ? sp.w.trim().slice(0, 60) : null

  // 计划达成 —— 计划日期落在哪个月就是哪个月的账。
  const month = /^\d{4}-\d{2}$/.test(sp?.m ?? '') ? (sp.m as string) : todayStr.slice(0, 7)
  const rates = view === 'plan' ? await loadPlanRates(month) : null

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="报工"
        subtitle={view === 'plan' ? '计划达成' : '完成工序 · 经手'}
        currentTab="报工"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="mx-auto w-full max-w-[1100px] px-4 md:px-10 py-8 md:py-12 flex-1">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-baseline gap-x-7">
              <ViewTab href="/report" label="报工" active={view === 'work'} />
              <ViewTab href="/report?v=plan" label="计划达成" active={view === 'plan'} />
            </div>
            <p className="text-[12px] md:text-[13px] text-[var(--color-ink-3)] mt-2">
              {view === 'plan'
                ? '按工程排的时间节点 · 每道工序到了那天做完了没有'
                : '按工段 · 完成工序经手'}
            </p>
          </div>
          {view === 'plan' && (
            <div className="flex items-center gap-1">
              <Link
                href={`/report?v=plan&m=${shiftMonth(month, -1)}`}
                aria-label="上一月"
                className="px-1.5 text-[15px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                ‹
              </Link>
              <span className="min-w-[92px] text-center text-[13.5px] tabular-nums text-[var(--color-ink)]">
                {month.slice(0, 4)}年{Number(month.slice(5))}月
              </span>
              <Link
                href={`/report?v=plan&m=${shiftMonth(month, 1)}`}
                aria-label="下一月"
                className="px-1.5 text-[15px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                ›
              </Link>
            </div>
          )}
        </header>
        {rates ? (
          <PlanRateBoard rates={rates} />
        ) : (
          <ReportClient
            initialStage={stage}
            initialGran={gran}
            initialAnchor={anchor}
            initialWorker={worker}
            todayStr={todayStr}
            showMoney={canSeeMoney(user)}
            canFix={canFixReport(user)}
          />
        )}
      </main>
    </div>
  )
}

// 报工 / 计划达成 —— 跟 人事 (考勤 · 住宿 · 借款)、财务那一排同一个下划线样子,
// 只是字号跟原来那个大标题一样大。
function ViewTab({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`border-b pb-1 text-[28px] md:text-[34px] tracking-tight transition-colors ${
        active
          ? 'border-[var(--color-ink)] font-semibold text-[var(--color-ink)]'
          : 'border-transparent font-medium text-[var(--color-ink-4)] hover:text-[var(--color-ink-2)]'
      }`}
    >
      {label}
    </Link>
  )
}

// 计划达成的取数 —— 看板那一份, 再补两样看板汇总里没有的:
//   车铣 (点了才有的一道) 那一格, 从零件的工序里数出来;
//   每张单的外协单回齐了没有, 算外协那一行 (于海伟 2026-10-27)。
async function loadPlanRates(month: string) {
  const optIn = OPT_IN_STAGES.filter((s) => PLANNABLE_STAGES.includes(s))
  const [rows, blockRows, ...cellMaps] = await Promise.all([
    getMasterRows(),
    getOutsourceBlockRows().catch(() => []),
    ...optIn.map((s) => getStageCellsByJob(s).catch(() => new Map())),
  ])
  const filled: MasterRow[] = rows.map((m) => {
    let cells = m.cells
    optIn.forEach((s, i) => {
      const c = cellMaps[i].get(m.id)
      if (c && !cells[s]) cells = { ...cells, [s]: c }
    })
    return cells === m.cells ? m : { ...m, cells }
  })
  // 发货那一道的外协单不算 —— 看板上「在外协」也不数它。
  const outsource = new Map<string, JobOutsource>()
  for (const r of blockRows) {
    if (r.block.stages.length > 0 && r.block.stages.every((s) => s === '出货')) continue
    const list = outsource.get(r.jobId) ?? []
    list.push({ closedAt: blockClosedAt(r.block) })
    outsource.set(r.jobId, list)
  }
  return computePlanRates(filled, month, Date.now(), outsource)
}
