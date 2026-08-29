import { TopBar } from '@/app/_ui'
import {
  requireUser,
  canSeeReport,
  canSeeOrderLedger,
  canApproveProcurement,
  canEditPartRoute,
} from '@/lib/auth'
import {
  getProcurements,
  getProcurementProducts,
  getProcurementJobOptions,
  getProcurementNeeds,
  getActiveUsers,
} from '@/lib/db'
import { today } from '@/lib/today'
import { ProcurementBoard } from './_procurement'

export const dynamic = 'force-dynamic'

// 采购 — the standalone purchasing conveyor. Open to anyone signed in (no role
// gate beyond requireUser): the floor asks (请购), an approver clears it (审批),
// 采购 places the order, the material lands, its 领料人 collects it. Six tabs,
// one table each: 需求 → 待审批 → 待采购 → 待到货 → 待领料 → 已领料.
//
// 需求 is the mouth of the conveyor and the only derived one: parts 工程 routed
// through 采购 that nobody has bought yet (getProcurementNeeds). Everything
// downstream of it is a real procurements row.
export default async function ProcurementPage() {
  const user = await requireUser()
  const [procurements, products, jobOptions, needs, users] = await Promise.all([
    getProcurements(),
    getProcurementProducts(),
    getProcurementJobOptions(),
    getProcurementNeeds(),
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
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="px-4 md:px-10 py-8">
        <ProcurementBoard
          procurements={procurements}
          products={products}
          jobOptions={jobOptions}
          needs={needs}
          roster={users.map((u) => u.name)}
          currentUser={user.name}
          canApprove={canApproveProcurement(user)}
          canEditRoute={canEditPartRoute(user)}
          today={today()}
        />
      </main>
    </div>
  )
}
