import { daysFromToday, formatCny, isBlockClosed } from '@/lib/data'
import { getOutsourceBlockRows, getVendors } from '@/lib/db'
import { requireOutsourceManager, canSeeReport } from '@/lib/auth'
import { Pill, TopBar } from '@/app/_ui'
import { OutsourceBoard } from './_board'

export const dynamic = 'force-dynamic'

export default async function OutsourcePage() {
  const user = await requireOutsourceManager()
  const [all, vendors] = await Promise.all([getOutsourceBlockRows(), getVendors()])
  const open = all.filter((r) => !isBlockClosed(r.block))
  const archived = all.filter((r) => isBlockClosed(r.block))

  // Rush blocks may not have a price yet — skip nulls so they don't poison
  // the sum into NaN. Backfill comes via the BlockRow edit flow.
  const totalAmount = open.reduce((s, r) => s + (r.block.amountCny ?? 0), 0)
  const overdueCount = open.filter(
    (r) => daysFromToday(r.block.expectedReturn) < 0,
  ).length
  const pendingPriceCount = open.filter((r) => r.block.amountCny == null).length

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="外协台"
        subtitle="送出 · 在外 · 回厂"
        currentTab="外协"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        right={
          <div className="flex items-center gap-2">
            <Pill tone="overdue" label="逾期" value={overdueCount} />
            {pendingPriceCount > 0 ? (
              <Pill tone="warning" label="待补金额" value={pendingPriceCount} />
            ) : null}
            <Pill tone="warning" label="在外" value={open.length} />
            <Pill tone="info" label="外发" value={formatCny(totalAmount)} />
            <Pill tone="neutral" label="已归档" value={archived.length} />
          </div>
        }
      />

      <OutsourceBoard open={open} archived={archived} vendors={vendors} />
    </div>
  )
}
