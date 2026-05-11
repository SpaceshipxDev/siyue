import { jobIsShipped, type Job } from '@/lib/data'
import { getJobs, listClosedReturns } from '@/lib/db'
import { requirePartRouteEditor } from '@/lib/auth'
import { TopBar } from '@/app/_ui'
import { ReturnsView, type ReturnsListJob } from './_view'

export const dynamic = 'force-dynamic'

export default async function ReturnsPage() {
  const user = await requirePartRouteEditor()
  const [jobs, closed] = await Promise.all([getJobs(), listClosedReturns()])
  // Live = anything that's not stuck in import/parsing — same exclusion the
  // master grid uses. Returns belong to real shipped work, not drafts.
  const live = jobs.filter(
    (j) => j.status !== 'parsing' && j.status !== 'draft' && j.status !== 'failed',
  )
  const open = live.filter((j) => Boolean(j.activeReturn))
  const candidates = live.filter((j) => jobIsShipped(j) && !j.activeReturn)

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="退货"
        subtitle="出货后回厂的零件 · 进入工程返工"
        currentTab="退货"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
      />
      <main className="mx-auto w-full max-w-[1500px] px-4 md:px-10 py-6 md:py-10 flex-1">
        <ReturnsView
          openJobs={open.map(serializeJob)}
          candidates={candidates.map(serializeJob)}
          closed={closed}
        />
      </main>
    </div>
  )
}

function serializeJob(j: Job): ReturnsListJob {
  // "Ship date" = latest 出货 completedAt across components. Used for sorting
  // candidates (most recently shipped = freshest in customer's hands = most
  // likely to come back next).
  let latest: string | undefined
  for (const c of j.components) {
    const st = c.stages['出货']
    if (st?.completedAt) {
      if (!latest || st.completedAt > latest) latest = st.completedAt
    }
  }
  // completedAt is MM-DD; for "days since" use today vs MM-DD assuming current
  // year. Best-effort, since the column is purposefully short to fit in the
  // row.
  const days = latest ? daysSinceMMDD(latest) : null
  return {
    id: j.id,
    jobNo: j.jobNo,
    customer: j.customer,
    product: j.product,
    shipDate: latest ?? '',
    daysSinceShip: days,
    activeReturn: j.activeReturn,
    components: j.components.map((c) => ({ id: c.id, name: c.name, qty: c.qty })),
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

