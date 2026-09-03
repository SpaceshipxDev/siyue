import { STAGES, type Stage } from '@/lib/data'
import Link from 'next/link'
import { requireReportViewer, canSeeMoney, canSeeReport, canSeeOrderLedger } from '@/lib/auth'
import { getDefectRows } from '@/lib/db'
import { DefectsBoard } from './_defects'
import { today } from '@/lib/today'
import { ReportClient } from './_cockpit'
import { TopBar } from '../_ui'

export const dynamic = 'force-dynamic'

// /report — 报工. A thin server shell: auth + initial URL state, then the whole
// view is client-driven (app/report/_cockpit.tsx) so switching station/period
// and drilling into a person are instant fetches, never a full-page reload.
// Data comes from /api/report. Commerce-only (requireReportViewer).

type Gran = 'day' | 'week' | 'month'
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{
    stage?: string
    g?: string
    d?: string
    w?: string
    v?: string
  }>
}) {
  const user = await requireReportViewer()
  const todayStr = today()
  const sp = await searchParams

  const stage: Stage | null =
    typeof sp?.stage === 'string' && (STAGES as readonly string[]).includes(sp.stage)
      ? (sp.stage as Stage)
      : null
  const gran: Gran = sp?.g === 'week' || sp?.g === 'month' ? sp.g : 'day'
  const anchor = typeof sp?.d === 'string' && ISO_DATE.test(sp.d) ? sp.d : todayStr
  // 找人 — a pre-selected 经手人 (deep link / refresh), free text like the
  // actor names themselves; the client validates it against the roster.
  const worker = typeof sp?.w === 'string' && sp.w.trim() ? sp.w.trim().slice(0, 60) : null

  // 不良记录 — 同一批人看的第二张表。只有切到它时才去扫全厂的判定。
  const view = sp?.v === 'defects' ? 'defects' : 'work'
  const defects = view === 'defects' ? await getDefectRows() : []

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="报工"
        subtitle="完成工序 · 经手"
        currentTab="报工"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="mx-auto w-full max-w-[1100px] px-4 md:px-10 py-8 md:py-12 flex-1">
        <header className="mb-8">
          <h1 className="text-[28px] md:text-[34px] font-semibold tracking-tight text-[var(--color-ink)]">
            {view === 'defects' ? '不良记录' : '报工'}
          </h1>
          <p className="text-[12px] md:text-[13px] text-[var(--color-ink-3)] mt-1">
            {view === 'defects'
              ? '检验 · 成品检 · 重做 / 返修 / 外修'
              : '按工段 · 完成工序经手'}
          </p>
        </header>
        {/* 报工 / 不良 — 同一批人看的两张表 (谁做了多少 · 坏了多少)。 */}
        <div className="mb-7 flex items-baseline gap-x-6">
          <ViewTab href="/report" label="报工" active={view === 'work'} />
          <ViewTab
            href="/report?v=defects"
            label="不良记录"
            active={view === 'defects'}
          />
        </div>
        {view === 'defects' ? (
          <DefectsBoard rows={defects} todayStr={todayStr} />
        ) : (
        <ReportClient
          initialStage={stage}
          initialGran={gran}
          initialAnchor={anchor}
          initialWorker={worker}
          todayStr={todayStr}
          showMoney={canSeeMoney(user)}
        />
        )}
      </main>
    </div>
  )
}

// 报工 / 不良记录 — same underline-active idiom the 财务 sub-tabs use.
function ViewTab({
  href,
  label,
  active,
}: {
  href: string
  label: string
  active: boolean
}) {
  return (
    <Link
      href={href}
      className={`border-b pb-1 text-[15px] tracking-tight transition-colors ${
        active
          ? 'border-[var(--color-ink)] font-semibold text-[var(--color-ink)]'
          : 'border-transparent font-medium text-[var(--color-ink-3)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-ink-2)]'
      }`}
    >
      {label}
    </Link>
  )
}
