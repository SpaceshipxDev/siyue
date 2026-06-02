import { TopBar } from '@/app/_ui'
import { requireUser, canSeeFactoryPulse, landingPathFor } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { getHandovers, getJobNoIndex } from '@/lib/db'
import { today } from '@/lib/today'
import { HandoverBoard } from './_handover'

export const dynamic = 'force-dynamic'

// 工作交接单 — the unified handover tab. When a person stops working for a
// stretch (break, leave, day off) they record what's pending here so whoever
// covers has the context. Visible to the people who run the floor: 商务 + 工程
// head (same gate as 现场). No messaging — the sheet IS the handoff.
export default async function HandoverPage() {
  const user = await requireUser()
  if (!canSeeFactoryPulse(user)) redirect(landingPathFor(user))

  const [handovers, jobIndex] = await Promise.all([
    getHandovers(),
    getJobNoIndex(),
  ])

  return (
    <div className="min-h-dvh bg-[var(--color-bg)]">
      <TopBar
        title="工作交接"
        subtitle="交班 · 待办 · 承接"
        currentTab="交接"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
      />
      <main className="px-4 md:px-10 py-8">
        <HandoverBoard
          handovers={handovers}
          jobIndex={jobIndex}
          currentUser={user.name}
          department={user.defaultStage ?? (user.role === 'commerce' ? '商务' : '')}
          today={today()}
        />
      </main>
    </div>
  )
}
