import { requireNotesUser } from '@/lib/auth'
import { getNotes } from '@/lib/db'
import { TopBar } from '@/app/_ui'
import { NotesBoard } from './_notes'

export const dynamic = 'force-dynamic'

// 笔记 — the freeform scratchpad, right before 重点. 商务 + 工程 surface
// (canUseNotes); notes are per-author so each user only sees their own.
// Other floor stations bounce home.
export default async function NotesPage() {
  const user = await requireNotesUser()
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
