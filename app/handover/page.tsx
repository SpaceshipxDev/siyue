import { TopBar } from '@/app/_ui'
import { requireUser, canSeeFactoryPulse, landingPathFor, canSeeReport, canSeeOrderLedger } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { getAllUsers, getHandovers, getJobNoIndex } from '@/lib/db'
import { today } from '@/lib/today'
import { HandoverBoard } from './_handover'

export const dynamic = 'force-dynamic'

// 交接 — one job, handed by one person, to a department and/or a specific
// person, with a note. Read as a sentence: 「小明 交给 财务 小李 · 工号 240511」.
// No shift / 移交 / 接班 jargon; the targets are a 部门 you tap and a 谁 you
// pick. Visible to the people who run the floor (same gate as 现场). No
// messaging — the record IS the handoff.
export default async function HandoverPage() {
  const user = await requireUser()
  if (!canSeeFactoryPulse(user)) redirect(landingPathFor(user))

  const [handovers, jobIndex, users] = await Promise.all([
    getHandovers(),
    getJobNoIndex(),
    getAllUsers(),
  ])
  const people = users.filter((u) => u.active).map((u) => u.name)

  return (
    <div className="min-h-dvh bg-[var(--color-bg)]">
      <TopBar
        title="交接"
        subtitle="谁 · 交给哪个部门 / 谁 · 哪个工号"
        currentTab="交接"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="px-4 md:px-10 py-8">
        <HandoverBoard
          handovers={handovers}
          jobIndex={jobIndex}
          people={people}
          currentUser={user.name}
          today={today()}
        />
      </main>
    </div>
  )
}
