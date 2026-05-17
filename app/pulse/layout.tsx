import { requirePulseViewer } from '@/lib/auth'

// /pulse = 现场. Commerce + 工程 head can view. Other production stations
// get bounced. The ¥ columns on the page itself are gated behind
// canSeeMoney separately (commerce only) — 工程 sees the same layout with
// the parts-count headline standing in for the money figure.
export default async function PulseLayout({
  children,
}: {
  children: React.ReactNode
}) {
  await requirePulseViewer()
  return <>{children}</>
}
