import {
  ensureVendorPortalTokens,
  getOutsourceBlockRows,
  getVendors,
} from '@/lib/db'
import { requireOutsourceManager, canSeeReport } from '@/lib/auth'
import { TopBar } from '@/app/_ui'
import { today } from '@/lib/today'
import { OutsourceLedger } from './_ledger'

export const dynamic = 'force-dynamic'

export default async function OutsourcePage() {
  const user = await requireOutsourceManager()
  const [rows, rawVendors] = await Promise.all([
    getOutsourceBlockRows(),
    getVendors(),
  ])
  // Mint portal tokens for any vendor still missing one, so every 微信 cell on
  // the ledger has a link ready. One-time backfill, then no-ops.
  const vendors = await ensureVendorPortalTokens(rawVendors)

  // Every number this page shows (在外 / 逾期 / 外发金额 / 待补金额 / 待发微信)
  // is derived client-side from the rows in view — the ledger's own filters
  // decide what "in view" means, so a duplicate set of pills up here would
  // just disagree with the sheet below.
  return (
    <div className="flex flex-1 flex-col">
      <TopBar
        title="外协台"
        subtitle="送出 · 在外 · 回厂"
        currentTab="外协"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
      />
      <OutsourceLedger rows={rows} vendors={vendors} today={today()} />
    </div>
  )
}
