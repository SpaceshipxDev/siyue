import { requireUser } from '@/lib/auth'
import { loadSheetState } from './_server'
import { Sheet } from './_sheet'

// /x — the factory's live sheet. One sheet per deployment; every logged-in
// user (boss, PMC, station workers) opens the SAME grid and taps into it.
// State boots server-side for instant paint, then the client polls /api/x.

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '生产表 · 思跃',
}

export default async function XPage() {
  const user = await requireUser()
  const state = await loadSheetState()
  return <Sheet mode="live" me={user.name} boot={state} />
}
