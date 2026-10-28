import { TopBar } from '@/app/_ui'
import {
  requireUser,
  canSeeReport,
  canSeeOrderLedger,
  canApproveProcurement,
  canDeleteProcurement,
} from '@/lib/auth'
import {
  getProcurements,
  getProcurementProducts,
  getProcurementJobOptions,
  getProcurementNeeds,
  getActiveUsers,
  getTrashedProcurements,
} from '@/lib/db'
import { getProcurementTrash } from '@/lib/procurement-trash'
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
  // 回收站 —— 只有能删的人看得到, 别人不多读这两份。
  const seeTrash = canDeleteProcurement(user)
  const [procurements, products, jobOptions, needs, users, trashEntries, trashedRows] = await Promise.all([
    getProcurements(),
    getProcurementProducts(),
    getProcurementJobOptions(),
    getProcurementNeeds(),
    getActiveUsers(),
    seeTrash ? getProcurementTrash().catch(() => []) : Promise.resolve([]),
    seeTrash ? getTrashedProcurements().catch(() => []) : Promise.resolve([]),
  ])
  const trashedBy = new Map(trashEntries.filter((e) => e.kind === 'procurement').map((e) => [e.id, e]))
  const trash = seeTrash
    ? {
        procurements: trashedRows.flatMap((p) => {
          const e = trashedBy.get(p.id)
          return e ? [{ ...p, trashedBy: e.by, trashedAt: e.at }] : []
        }),
        needs: trashEntries.flatMap((e) =>
          e.kind === 'need'
            ? [{ partId: e.id, jobId: e.jobId, jobNo: e.jobNo, part: e.part, material: e.material, qty: e.qty, trashedBy: e.by, trashedAt: e.at }]
            : [],
        ),
      }
    : undefined

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
          canDelete={canDeleteProcurement(user)}
          today={today()}
          trash={trash}
        />
      </main>
    </div>
  )
}
