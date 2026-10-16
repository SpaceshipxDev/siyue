import { redirect } from 'next/navigation'
import { TopBar } from '@/app/_ui'
import {
  canFilePayRequest,
  canSeeOthersPayRequests,
  canSeeOrderLedger,
  canSeeReport,
  isPayReviewer,
  landingPathFor,
  requireUser,
} from '@/lib/auth'
import { isAdminUser } from '@/lib/db'
import { getPayRequests } from '@/lib/pay-request'
import { PayRequestBoard } from '@/app/_pay_requests'

export const dynamic = 'force-dynamic'

// 付款 —— 商务这头的付款申请 (人事那头在 /hr?v=pay)。填 → 商务审核 → 老板批
// → 落进 财务 · 应付。谁填的谁看; 审批的人和管钱的人在这里看得到两头的申请,
// 一个地方批完。
export default async function PayPage({
  searchParams,
}: {
  searchParams: Promise<{ open?: string }>
}) {
  const user = await requireUser()
  const seeAll = canSeeOthersPayRequests(user)
  if (user.role !== 'commerce' && !seeAll) redirect(landingPathFor(user))
  const sp = await searchParams
  const all = await getPayRequests()
  // 谁填的谁看; 老板、财务、于海伟 (还有审核的黄优兰香) 看全部。
  const requests = seeAll
    ? all
    : all.filter((r) => r.dept === '商务' && r.appliedBy === user.name)
  return (
    <div className="min-h-dvh bg-[var(--color-bg)]">
      <TopBar
        title="付款"
        subtitle="申请 · 商务审核 · 老板批 · 转财务应付"
        currentTab="付款"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="px-4 py-8 md:px-10">
        <PayRequestBoard
          requests={requests}
          dept="商务"
          canFile={canFilePayRequest(user, '商务')}
          userName={user.name}
          isReviewer={isPayReviewer(user)}
          isBoss={isAdminUser(user.id)}
          showDept={seeAll}
          openId={sp.open}
        />
      </main>
    </div>
  )
}
