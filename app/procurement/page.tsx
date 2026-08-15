import { TopBar } from '@/app/_ui'
import { requireUser, canSeeReport, canApproveProcurement } from '@/lib/auth'
import {
  getProcurements,
  getProcurementProducts,
  getProcurementJobOptions,
  getActiveUsers,
} from '@/lib/db'
import { today } from '@/lib/today'
import { ProcurementBoard } from './_procurement'

export const dynamic = 'force-dynamic'

// 采购 — the standalone purchasing conveyor. Open to anyone signed in (no role
// gate beyond requireUser): the floor asks (请购), an approver clears it (审批),
// 采购 places the order, the material lands, its 领料人 collects it. Five tabs,
// one table each: 待审批 → 待采购 → 待到货 → 待领料 → 已领料.
export default async function ProcurementPage() {
  const user = await requireUser()
  const [procurements, products, jobOptions, users] = await Promise.all([
    getProcurements(),
    getProcurementProducts(),
    getProcurementJobOptions(),
    getActiveUsers(),
  ])

  return (
    <div className="min-h-dvh bg-[var(--color-bg)]">
      <TopBar
        title="采购"
        subtitle="请购 · 审批 · 采购 · 到货 · 领料"
        currentTab="采购"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
      />
      <main className="px-4 md:px-10 py-8">
        <ProcurementBoard
          procurements={procurements}
          products={products}
          jobOptions={jobOptions}
          roster={users.map((u) => u.name)}
          currentUser={user.name}
          canApprove={canApproveProcurement(user)}
          today={today()}
        />
      </main>
    </div>
  )
}
