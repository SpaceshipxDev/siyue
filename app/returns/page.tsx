import { getJobsComponents, getMasterRows, listClosedReturns } from '@/lib/db'
import { requirePartRouteEditor, canSeeReport, canSeeOrderLedger } from '@/lib/auth'
import { TopBar } from '@/app/_ui'
import { ReturnsView, type ReturnsListJob } from './_view'
import type { MasterRow } from '@/lib/master'

export const dynamic = 'force-dynamic'

export default async function ReturnsPage() {
  const user = await requirePartRouteEditor()

  // Lightweight first pass — same shape the master grid uses. The candidate
  // set (shipped, no active return) gets its components hydrated separately
  // so the inline 开退货 composer has the picker rows ready. Open-return
  // rows don't need components for this view's chrome.
  const [rows, closed] = await Promise.all([getMasterRows(), listClosedReturns()])

  const live = rows.filter(
    (r) => r.status !== 'parsing' && r.status !== 'draft' && r.status !== 'failed',
  )
  const openRows = live.filter((r) => Boolean(r.activeReturn))
  const candidateRows = live.filter((r) => r.isShipped && !r.activeReturn)

  // Only candidates need components for the composer; open returns are
  // already attached to specific parts via JobReturn.parts in lib/db.
  const componentsByJob = await getJobsComponents(candidateRows.map((r) => r.id))

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="退货"
        subtitle="出货后回厂的零件 · 进入工程返工"
        currentTab="退货"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="mx-auto w-full max-w-[1500px] px-4 md:px-10 py-6 md:py-10 flex-1">
        <ReturnsView
          openJobs={openRows.map((r) => serializeRow(r, undefined))}
          candidates={candidateRows.map((r) => serializeRow(r, componentsByJob.get(r.id)))}
          closed={closed}
        />
      </main>
    </div>
  )
}

function serializeRow(
  r: MasterRow,
  components?: Array<{ id: string; name: string; qty: number }>,
): ReturnsListJob {
  // "Ship date" = the latest 出货 completion date on the row's 出货 cell.
  // Precomputed by the job_stage_rollup view as latest_completed_at.
  const shipDate = r.cells['出货']?.latestCompletedAt ?? ''
  const daysSinceShip = shipDate ? daysSinceMMDD(shipDate) : null
  return {
    id: r.id,
    jobNo: r.jobNo,
    customer: r.customer,
    product: r.product,
    shipDate,
    daysSinceShip,
    activeReturn: r.activeReturn,
    components,
  }
}

function daysSinceMMDD(mmdd: string): number | null {
  const m = mmdd.match(/^(\d{2})-(\d{2})$/)
  if (!m) return null
  const now = new Date()
  const candidate = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]))
  // If the MM-DD is in the future for this year, assume it was last year.
  if (candidate > now) candidate.setFullYear(candidate.getFullYear() - 1)
  const ms = now.getTime() - candidate.getTime()
  return Math.floor(ms / (1000 * 60 * 60 * 24))
}
