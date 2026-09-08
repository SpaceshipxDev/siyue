import {
  getJobsComponents,
  getMasterRows,
  listClosedReturns,
  listOpenReturns,
} from '@/lib/db'
import {
  canEditPartRoute,
  canRunReturnRework,
  canSeeOrderLedger,
  canSeeCustomerData,
  canSeeReport,
  canWriteReturnCause,
  canWriteReturnPlan,
  canEditShipment,
  requireReturnsDesk,
} from '@/lib/auth'
import { getReturnFlows } from '@/lib/return-flow-store'
import { TopBar } from '@/app/_ui'
import { ReturnsView, type ReturnsListJob } from './_view'
import type { MasterRow } from '@/lib/master'

export const dynamic = 'force-dynamic'

// 退货台。门开给四方 —— 商务开单、工程出方案、质量查原因、商务再出货, 所以
// 质量的账号也进得来 (以前只有商务和工程)。进来之后能动哪一格, 按各人那一档
// 走, 见 lib/auth 的 canWriteReturnPlan / canWriteReturnCause。
export default async function ReturnsPage() {
  const user = await requireReturnsDesk()
  const canOpen = canEditPartRoute(user)

  const [rows, openReturns, closed, flows] = await Promise.all([
    getMasterRows(),
    listOpenReturns(),
    listClosedReturns(),
    getReturnFlows(),
  ])

  const live = rows.filter(
    (r) => r.status !== 'parsing' && r.status !== 'draft' && r.status !== 'failed',
  )
  const candidateRows = canOpen
    ? live.filter((r) => r.isShipped && !r.activeReturn)
    : []

  // Only candidates need components for the composer; 进行中 rows carry their
  // own part detail from listOpenReturns.
  const componentsByJob = await getJobsComponents(candidateRows.map((r) => r.id))

  return (
    <div className="flex flex-1 flex-col">
      <TopBar
        title="退货"
        subtitle="开单 · 方案 · 调查 · 返工 · 再出货"
        currentTab="退货"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-6 md:px-10 md:py-10">
        <ReturnsView
          openRows={openReturns.map((r) => ({
            ...r,
            flow: flows.get(r.ret.id),
          }))}
          candidates={candidateRows.map((r) =>
            serializeRow(r, componentsByJob.get(r.id)),
          )}
          closed={closed}
          perms={{
            plan: canWriteReturnPlan(user),
            cause: canWriteReturnCause(user),
            rework: canRunReturnRework(user),
            ship: canEditShipment(user),
            open: canOpen,
            showCustomer: canSeeCustomerData(user),
          }}
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
