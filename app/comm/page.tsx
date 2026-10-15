import { redirect } from 'next/navigation'
import { TopBar } from '@/app/_ui'
import {
  canSeeOrderLedger,
  canSeeReport,
  canWriteCommSheet,
  landingPathFor,
  requireUser,
} from '@/lib/auth'
import { getMasterRows } from '@/lib/db'
import { cleanJobNo, dueOf, listCommOrders } from '@/lib/comm-order'
import { CommOrderList } from './_list'

export const dynamic = 'force-dynamic'

// 沟通单 —— 工单分析沟通确认单, 一个工号一张 (lib/comm-order)。工程、商务用。
export default async function CommPage() {
  const user = await requireUser()
  if (!canWriteCommSheet(user)) redirect(landingPathFor(user))
  const [sheets, rows] = await Promise.all([listCommOrders(), getMasterRows()])
  const jobDue = new Map(rows.filter((r) => r.jobNo && r.dueDate).map((r) => [cleanJobNo(r.jobNo).toLowerCase(), r.dueDate]))
  const jobNos = rows
    .filter((r) => r.status !== 'draft' && r.status !== 'failed' && r.status !== 'parsing')
    .map((r) => r.jobNo)
    .filter(Boolean)
  return (
    <div className="min-h-dvh bg-[var(--color-bg)]">
      <TopBar
        title="沟通单"
        subtitle="工单分析沟通确认单 · 按工号"
        currentTab="沟通单"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="mx-auto w-full max-w-[960px] px-4 py-8 md:px-10">
        <CommOrderList
          sheets={sheets.map((s) => ({
            jobNo: s.jobNo,
            due: dueOf(s.jobNo, s.dueDate, jobDue),
            rounds: s.rows.length,
            by: s.updatedBy ?? '',
            at: s.updatedAt,
          }))}
          jobNos={jobNos}
        />
      </main>
    </div>
  )
}
