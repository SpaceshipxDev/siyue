import { requireCommerce } from '@/lib/auth'

// /backend is the XLSX parser tool — commerce-only. User management lives
// at /users (top-level tab in the boss's nav). This layout-level check is
// defense in depth — the proxy already redirects production users.
export default async function BackendLayout({
  children,
}: {
  children: React.ReactNode
}) {
  await requireCommerce()
  return <>{children}</>
}
