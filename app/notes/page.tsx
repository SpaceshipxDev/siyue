import { redirect } from 'next/navigation'
import { requireUser, landingPathFor } from '@/lib/auth'
import { getNotes } from '@/lib/db'
import { TopBar } from '@/app/_ui'
import { NotesBoard } from './_notes'

export const dynamic = 'force-dynamic'

// 笔记 — the boss's freeform scratchpad, right before 重点. 商务 surface (the
// boss is 商务); notes are per-author so each user only sees their own. Floor
// users bounce home.
export default async function NotesPage() {
  const user = await requireUser()
  if (user.role !== 'commerce') redirect(landingPathFor(user))
  const notes = await getNotes(user.id)
  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="笔记"
        subtitle="随手记"
        currentTab="笔记"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
      />
      <main className="mx-auto w-full max-w-[760px] px-5 md:px-10 py-10 md:py-14 flex-1">
        <NotesBoard initial={notes} />
      </main>
    </div>
  )
}
