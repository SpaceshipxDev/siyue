import 'server-only'
import { cookies } from 'next/headers'
import { canSeeAllHr, hrDeptOf, type AuthUser } from './auth'

/*
 * 录入人员按自己的部门选 —— 人事 · 考勤。
 *
 * 部门原来只认账号的工段 (hrDeptOf)。可库里半个车间的账号都种在「工程」上,
 * 共用账号也一个号几个部门的人在用 —— 质量的人登着一个工程号, 只能看、只能
 * 记工程的人, 自己部门的人反倒记不上。
 *
 * 于海伟 2026-10-12 定: 录入的人自己选自己的部门。选的是"我在替哪个部门记",
 * 存在这台机器上 (cookie) —— 共用账号在哪个工位的电脑上开, 就是哪个部门。
 * 被记的那个人归哪个部门照旧按他自己的账号算, 这里只换录入的人这一头。
 *
 * 看全厂的那一档 (商务、采购站) 不受影响; 商务是办公室那一档, 不在可选里。
 */

export const HR_DEPT_COOKIE = 'hr-dept'

export async function filerDeptOf(u: AuthUser): Promise<string> {
  const own = hrDeptOf(u)
  if (canSeeAllHr(u)) return own
  const jar = await cookies()
  const picked = decodeURIComponent(jar.get(HR_DEPT_COOKIE)?.value ?? '').trim()
  if (!picked || picked === '商务' || picked.length > 20) return own
  return picked
}
