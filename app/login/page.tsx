import { redirect } from 'next/navigation'
import { STAGES } from '@/lib/data'
import { getActiveUsers, getAllUsers, getBossUser, isAdminUser } from '@/lib/db'
import {
  canManageUsers,
  canManageUsersById,
  currentUser,
  landingPathFor,
  permissionDigest,
} from '@/lib/auth'
import { LoginClient } from './_login_client'
import { AdminView } from './_admin_view'

export const dynamic = 'force-dynamic'

export default async function LoginPage(props: PageProps<'/login'>) {
  const sp = await props.searchParams
  const wantsAdmin = sp?.admin === '1'
  const u = await currentUser()

  // 管理员工 gets rendered inline on /login — same URL, just a different view.
  // 门是 canManageUsers (老板 + 于海伟的商务号), 不再是"任何商务号"。
  if (u && wantsAdmin && canManageUsers(u)) {
    const [allUsers, boss] = await Promise.all([getAllUsers(), getBossUser()])
    return (
      <AdminView
        bossName={u.name}
        bossId={boss.id}
        adminIds={allUsers.filter((x) => isAdminUser(x.id)).map((x) => x.id)}
        users={allUsers}
        digests={Object.fromEntries(
          allUsers.map((x) => [x.id, permissionDigest(x)]),
        )}
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
  const admins = tiles.filter((u) => canManageUsersById(u.id))
  return <LoginClient users={tiles} boss={boss} admins={admins} />
}
