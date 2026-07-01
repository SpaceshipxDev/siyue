import { TopBar } from '@/app/_ui'
import { requireUser, canSeeReport } from '@/lib/auth'
import { getProcurements, getProcurementProducts } from '@/lib/db'
import { today } from '@/lib/today'
import { ProcurementBoard } from './_procurement'

export const dynamic = 'force-dynamic'

// 采购 — the standalone purchasing ledger. Open to anyone signed in (no role
// gate beyond requireUser): the floor, 工程, and 商务 all buy things and all
// need to see what's on the way. Pick the part, the price, the supplier, the
// date ordered, and the date it should come back — then read one calm ordered
// queue of what's in transit and what's landed.
export default async function ProcurementPage() {
  const user = await requireUser()
  const [procurements, products] = await Promise.all([
    getProcurements(),
    getProcurementProducts(),
  ])

  return (
    <div className="min-h-dvh bg-[var(--color-bg)]">
      <TopBar
        title="采购"
        subtitle="所需 · 在途 · 到货"
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
          currentUser={user.name}
          today={today()}
        />
      </main>
    </div>
  )
}
