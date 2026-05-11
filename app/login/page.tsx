import { redirect } from 'next/navigation'
import { STAGES } from '@/lib/data'
import { getActiveUsers, getAllUsers, getBossUser } from '@/lib/db'
import { currentUser, landingPathFor } from '@/lib/auth'
import { LoginClient } from './_login_client'
import { AdminView } from './_admin_view'

export const dynamic = 'force-dynamic'

export default async function LoginPage(props: PageProps<'/login'>) {
  const sp = await props.searchParams
  const wantsAdmin = sp?.admin === '1'
  const u = await currentUser()

  // Boss arriving via the 管理员工 flow gets the admin panel inline on /login
  // — same URL, just a different view.
  if (u && wantsAdmin && u.role === 'commerce') {
    const [allUsers, boss] = await Promise.all([getAllUsers(), getBossUser()])
    return (
      <AdminView
        bossName={u.name}
        bossId={boss.id}
        users={allUsers}
        stages={STAGES as readonly string[]}
      />
    )
  }

  if (u) redirect(landingPathFor(u))

  // Tile grid: 老板 first, then everyone else (商务 + 生产) in the order
  // returned by getActiveUsers (role asc, name asc). Boss is also passed
  // separately so the 管理员工 shortcut button can authenticate against it
  // without an intermediate user-pick.
  const [active, boss] = await Promise.all([getActiveUsers(), getBossUser()])
  const others = active.filter((p) => p.id !== boss.id)
  const tiles = [boss, ...others]
  return <LoginClient users={tiles} boss={boss} />
}
