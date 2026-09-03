import { redirect } from 'next/navigation'
import { TopBar } from '@/app/_ui'
import {
  canSeeOrderLedger,
  canSeeReport,
  landingPathFor,
  requireUser,
} from '@/lib/auth'
import { getQuoteRates } from '@/lib/quote-store'
import { QuoteBoard } from './_quote'

export const dynamic = 'force-dynamic'

// 报价 — 客户发来图纸问多少钱, 这一页给出数。
//
// 一套费率 (机时费 / 毛利率 / 材料单价 / 表面处理单价 / 喷涂 / 丝印) 是长期
// 的, 存在服务器上, 设一次全厂通用。报的那几行零件是当下的, 留在浏览器里 ——
// 报价是还没接的单, 同一个零件一天可能按三个数量各报一次, 存下来只会越积越
// 乱; 真接了单, 数就落到工单上去了。
//
// 谁能报价 = 谁能看订单金额 (canSeeOrderLedger): 商务全员, 加上于海伟。报价
// 里含成本和毛利, 不是车间该看的东西。
export default async function QuotePage() {
  const user = await requireUser()
  if (!canSeeOrderLedger(user)) redirect(landingPathFor(user))
  const rates = await getQuoteRates()

  return (
    <div className="min-h-dvh bg-[var(--color-bg)]">
      <TopBar
        title="报价"
        subtitle="材料 · 加工 · 表面处理 · 喷涂丝印"
        currentTab="报价"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="px-4 md:px-10 py-8">
        <QuoteBoard rates={rates} />
      </main>
    </div>
  )
}
