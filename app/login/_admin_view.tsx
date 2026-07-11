import { logoutAction } from './actions'
import { UserAdmin } from './_user_admin'
import type { AppUser } from '@/lib/db'

export function AdminView({
  bossName,
  bossId,
  adminIds,
  users,
  stages,
}: {
  bossName: string
  bossId: string
  adminIds: string[]
  users: AppUser[]
  stages: readonly string[]
}) {
  const active = users.filter((u) => u.active).length
  return (
    <div className="min-h-dvh flex flex-col items-center bg-[var(--color-bg)]">
      <header className="w-full border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto max-w-[1100px] px-4 md:px-10 py-5 flex items-baseline justify-between gap-4">
          <div className="flex items-baseline gap-4">
            <span className="label tracking-[0.22em] text-[var(--color-ink)]">
              思跃 · 管理员工
            </span>
            <span className="text-[12px] text-[var(--color-ink-3)]">
              {active} 活跃 · {users.length} 总数
            </span>
          </div>
          <div className="flex items-baseline gap-5">
            <span className="label mono text-[var(--color-ink)]">{bossName}</span>
            <form action={logoutAction}>
              <button
                type="submit"
                className="label hover:text-[var(--color-ink)] cursor-pointer"
              >
                完成 →
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="w-full max-w-[1100px] px-4 md:px-10 py-8 md:py-12 flex-1">
        <UserAdmin users={users} bossId={bossId} adminIds={adminIds} stages={stages} />
      </main>
    </div>
  )
}
