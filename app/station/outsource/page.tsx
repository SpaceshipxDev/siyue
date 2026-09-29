import {
  ensureVendorPortalTokens,
  getOutsourceBlockRows,
  getVendors,
} from '@/lib/db'
import { requireOutsourceManager, canSeeReport, canSeeOrderLedger } from '@/lib/auth'
import { getPayables } from '@/lib/payable'
import { settleOutstanding } from '@/lib/settle-shared'
import { TopBar } from '@/app/_ui'
import { today } from '@/lib/today'
import { OutsourceLedger } from './_ledger'

export const dynamic = 'force-dynamic'

export default async function OutsourcePage() {
  const user = await requireOutsourceManager()
  const [rows, rawVendors, payables] = await Promise.all([
    getOutsourceBlockRows(),
    getVendors(),
    // 应付单 —— 外协对账单确认过的 (供应商 × 月份)。外协单后面那两个字
    // (已对账 / 已付款) 从这里来; 读不到就当没有, 外协台照样出来。
    getPayables().catch(() => []),
  ])
  // 外协是勾着对的: 应付单上记着认了哪几张外协单 (blockIds), 就标那几张。
  // 早先整月认的应付单没记单号, 退回按「供应商|月份」标那一整个月。
  const settled: Record<string, 'reconciled' | 'paid'> = {}
  const settledBlocks: Record<string, 'reconciled' | 'paid'> = {}
  for (const p of payables) {
    if (p.voidedAt) continue
    const st = settleOutstanding(p) <= 0 ? 'paid' : 'reconciled'
    if (p.blockIds) for (const id of p.blockIds) settledBlocks[id] = st
    else settled[`${p.vendor}|${p.period}`] = st
  }
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
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <OutsourceLedger
        rows={rows}
        vendors={vendors}
        today={today()}
        settled={settled}
        settledBlocks={settledBlocks}
      />
    </div>
  )
}
