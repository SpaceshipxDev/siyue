import 'server-only'
import { canGai, currentUser } from './auth'

// Who may use 改一下 (the self-serve mirror + 上线). The only per-app piece of the hook:
// here it is users.can_gai (migration 0095), granted by the boss in 管理员工; the boss always qualifies.
export type GaiAccess = { user: boolean; allowed: boolean }

export async function gaiAccess(): Promise<GaiAccess> {
  const u = await currentUser()
  if (!u) return { user: false, allowed: false }
  return { user: true, allowed: canGai(u) }
}
