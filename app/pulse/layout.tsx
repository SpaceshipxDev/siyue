import { requireCommerce } from '@/lib/auth'

// /pulse = 现场. Boss-only — production users (including the 工程 head, who
// runs the floor but has no money visibility) get bounced. Money figures
// would otherwise leak via the ¥ WIP column on the station strip. The proxy
// already redirects production sessions away from /pulse; this is defense
// in depth.
export default async function PulseLayout({
  children,
}: {
  children: React.ReactNode
}) {
  await requireCommerce()
  return <>{children}</>
}
