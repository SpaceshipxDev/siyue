import { redirect } from 'next/navigation'
import { TopBar } from '@/app/_ui'
import { canSeeFactoryPulse, landingPathFor, requireUser } from '@/lib/auth'
import { getDailyFocusItems, getMasterRows } from '@/lib/db'
import { scrubMasterRow } from '@/lib/dto'
import { today } from '@/lib/today'
import type { MasterRow } from '@/lib/master'
import { DailyFocusBoard, type FocusJobLite } from './_daily'

export const dynamic = 'force-dynamic'

// 重点 — the daily "these must be done today" list the boss used to keep in
// Excel and send over WeChat. One list per day (?day=YYYY-MM-DD, default
// today); history stays browsable. Curated here by the people who run the
// floor (商务 + 工程 head — same gate as 现场/交接); mirrored read-only onto
// the master dashboard and every station view so the floor sees it without
// being told.
export default async function DailyFocusPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requireUser()
  if (!canSeeFactoryPulse(user)) redirect(landingPathFor(user))

  const sp = await searchParams
  const rawDay = typeof sp?.day === 'string' ? sp.day : undefined
  const todayStr = today()
  const day = rawDay && /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : todayStr

  const [items, rawRows] = await Promise.all([
    getDailyFocusItems(day),
    getMasterRows(),
  ])
  // 工程 head reaches this page too — scrub customer/money exactly like the
  // master view does, so the join + autocomplete leak nothing extra.
  const rows =
    user.role === 'production'
      ? rawRows.map((r) => scrubMasterRow(r, user))
      : rawRows

  const toLite = (r: MasterRow): FocusJobLite => ({
    id: r.id,
    jobNo: r.jobNo,
    customer: r.customer,
    product: r.product,
    dueDate: r.effectiveDueDate,
    secondaryDueDate: r.secondaryDueDate,
    hasOpenOutsource: r.hasOpenOutsource,
    needsOutsource: Boolean(r.needsOutsource && !r.hasOpenOutsource),
    isShipped: r.isShipped,
  })

  // Join data for rows already on the list — keyed by job id, shipped jobs
  // included (a focus row stays meaningful after its job ships; it just
  // renders with the 已出货 badge).
  const jobById: Record<string, FocusJobLite> = {}
  const jobIndex: FocusJobLite[] = []
  for (const r of rawRowsToLive(rows)) {
    const lite = toLite(r)
    jobById[r.id] = lite
    // Autocomplete offers only 在产 jobs — you don't put shipped work on
    // tomorrow's must-do list. (Already-linked shipped jobs still join via
    // jobById above.)
    if (!r.isShipped) jobIndex.push(lite)
  }

  return (
    <div className="min-h-dvh bg-[var(--color-bg)]">
      <TopBar
        title="重点"
        subtitle="当日必须完成的工单"
        currentTab="重点"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
      />
      <main className="px-4 md:px-10 py-8">
        <DailyFocusBoard
          // Keyed by day: flipping ‹ › remounts the sheet with that day's
          // server rows instead of merging into the previous day's local state.
          key={day}
          items={items}
          jobById={jobById}
          jobIndex={jobIndex}
          day={day}
          todayStr={todayStr}
          showCustomer={user.role !== 'production'}
        />
      </main>
    </div>
  )
}

// Live rows only — parsing/draft/failed imports have no business on a focus
// list (no due date, no cells yet). Mirrors app/page.tsx's `live` split.
function rawRowsToLive(rows: MasterRow[]): MasterRow[] {
  return rows.filter(
    (r) => r.status !== 'parsing' && r.status !== 'draft' && r.status !== 'failed',
  )
}
