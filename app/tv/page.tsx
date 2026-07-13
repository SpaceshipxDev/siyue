import { requireUser } from '@/lib/auth'
import { TvBoard } from './_board'

export const dynamic = 'force-dynamic'

// /tv — 老板大屏. A thin server shell: same session gate as the master board
// (requireUser → /login redirect), then the whole view is client-driven
// (app/tv/_board.tsx) polling /api/tv every 30s. The TV logs in once with the
// boss PIN and stays on this page all day.
export default async function TvPage() {
  await requireUser()
  return <TvBoard />
}
