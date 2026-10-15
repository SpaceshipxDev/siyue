import { redirect } from 'next/navigation'
import { TopBar } from '@/app/_ui'
import {
  canSeeOrderLedger,
  canSeeReport,
  canWriteCommSheet,
  landingPathFor,
  requireUser,
} from '@/lib/auth'
import { cleanJobNo, getCommOrder } from '@/lib/comm-order'
import { CommOrderSheet } from './_sheet'

export const dynamic = 'force-dynamic'

function decode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// 一个工号的沟通确认单。还没有的, 打开就是一张空表, 记第一行时才存下来。
export default async function CommSheetPage({ params }: { params: Promise<{ no: string }> }) {
  const user = await requireUser()
  if (!canWriteCommSheet(user)) redirect(landingPathFor(user))
  const no = cleanJobNo(decode((await params).no))
  if (!no) redirect('/comm')
  const sheet = await getCommOrder(no)
  return (
    <div className="min-h-dvh bg-[var(--color-bg)]">
      <TopBar
        title="沟通单"
        subtitle="工单分析沟通确认单 · 按工号"
        currentTab="沟通单"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="w-full px-4 py-8 md:px-10">
        <CommOrderSheet key={sheet?.updatedAt ?? no} jobNo={sheet?.jobNo ?? no} initial={sheet?.rows ?? []} />
      </main>
    </div>
  )
}
