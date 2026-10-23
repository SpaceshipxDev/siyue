import {
  ensureVendorPortalTokens,
  getOutsourceBlockRows,
  getVendors,
} from '@/lib/db'
import {
  canSeeOrderLedger,
  canSeeOutsourceMoney,
  canSeeReport,
  requireOutsourceManager,
} from '@/lib/auth'
import { getPayables } from '@/lib/payable'
import { getPayRequests } from '@/lib/pay-request'
import { payStage } from '@/lib/pay-request-shared'
import { getOutsourceReceipts } from '@/lib/outsource-receipt'
import { settleOutstanding } from '@/lib/settle-shared'
import { TopBar } from '@/app/_ui'
import { today } from '@/lib/today'
import { OutsourceLedger } from './_ledger'

export const dynamic = 'force-dynamic'

export default async function OutsourcePage() {
  const user = await requireOutsourceManager()
  const showMoney = canSeeOutsourceMoney(user)
  const [allRows, rawVendors, payables, receipts, payRequests] = await Promise.all([
    getOutsourceBlockRows(),
    getVendors(),
    // 应付单 —— 外协对账单确认过的 (供应商 × 月份)。外协单后面那两个字
    // (已对账 / 已付款) 从这里来; 读不到就当没有, 外协台照样出来。
    getPayables().catch(() => []),
    // 收货确认单 —— 按订单挂的图, 读不到就当都还没传。
    getOutsourceReceipts().catch(() => ({})),
    // 对账确认了、还在付款申请上走的 —— 也算已对账。
    getPayRequests().catch(() => []),
  ])
  // 不该看价钱的, 价钱压根不往浏览器里发。
  const rows = showMoney
    ? allRows
    : allRows.map((r) => ({
        ...r,
        block: {
          ...r.block,
          amountCny: null,
          members: r.block.members.map((m) => ({ ...m, unitPriceCny: undefined })),
        },
      }))
  // 外协是勾着对的: 应付单上记着认了哪几张外协单 (blockIds), 就标那几张。
  // 早先整月认的应付单没记单号, 退回按「供应商|月份」标那一整个月。
  const settled: Record<string, 'reconciled' | 'paid'> = {}
  const settledBlocks: Record<string, 'reconciled' | 'paid'> = {}
  for (const r of payRequests) {
    if (!r.recon) continue
    const st = payStage(r)
    if (st === 'rejected' || st === 'done') continue // 批下来的看应付单
    for (const id of r.recon.blockIds) settledBlocks[id] = 'reconciled'
  }
  for (const p of payables) {
    // 补录的老账、普通付款申请不标任何外协单; 外协对账走付款申请落的那张照标。
    if (p.voidedAt || p.manual || (p.request && !p.blockIds)) continue
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
        receipts={receipts}
        showMoney={showMoney}
      />
    </div>
  )
}
