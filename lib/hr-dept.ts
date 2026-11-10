import 'server-only'
import { hrDeptOf, type AuthUser } from './auth'
import { getActiveUsers } from './db'
import { getHrMonth } from './hr'
import { getPayrollBase } from './payroll-store'
import { NO_DEPARTMENT } from './payroll'

/*
 * 录入人员的部门 —— 人事 · 考勤。
 *
 * 于海伟 2026-10-12 曾经让录入的人自己选部门 (存在那台机器的 cookie 上)。
 * 于海伟 2026-11-04 改回: 各部门只固定看到自己部门的人, 不能换 —— 部门就是
 * 账号的工段 (hrDeptOf)。账号上的部门不对, 找看全厂的那一档在考勤表上改人的
 * 部门, 或者改账号的工段。
 *
 * 看全厂的那一档 (商务、采购站、于海伟) 不受影响。
 */

export async function filerDeptOf(u: AuthUser): Promise<string> {
  return accountHrDept(u)
}

/*
 * 账号在人事上算哪个部门。一般就是账号的工段 (hrDeptOf), 但早先建号时很多
 * 车间账号都被默认挂在「工程」(lib/auth 零件行权限那一段有说明), 账号的工段
 * 不能当组织架构用。质量这几位就是: 质量倪伟群记刘敏敏的请假, 报「刘敏敏不是
 * 工程的人」(于海伟 2026-11-10)。这里按人名认回她们真正的部门 —— 只在人事上
 * 认, 不动账号的工段, 报工和登录落点都不受影响。以后再发现挂错的, 加一行。
 */
const HR_DEPT_BY_NAME: [string, string][] = [
  ['倪伟群', '质量'],
  ['周中华', '质量'],
  ['刘敏敏', '质量'],
  ['李佳怡', '质量'],
]

/*
 * 挂在「工程」上的车间账号, 名字前面写着它真正的部门 (塑料操机001吴亦能、
 * 编程002李军军、打磨喷漆…) —— 于海伟 2026-11-10: 操机的账号考勤页上写着
 * 「你看到的是工程的人」, 还看得到别的工段记的线。按名字开头认回来; 名字里
 * 看不出部门的 (周江华、工程003) 还是工程。只认挂在工程上的账号, 工段本来就
 * 设对了的账号不受影响。
 */
const HR_DEPT_BY_PREFIX: [string, string][] = [
  ['塑料操机', '塑料操机'],
  ['金属操机', '金属操机'],
  ['车工', '车件部'],
  ['编程', '编程'],
  ['手工', '手工'],
  ['打磨喷漆', '打磨喷漆'],
  ['批量组', '批量组'],
  ['质量', '质量'],
]

export function accountHrDept(
  u: Pick<AuthUser, 'name' | 'role' | 'defaultStage'>,
): string {
  if (u.role === 'commerce') return hrDeptOf(u)
  const byName = HR_DEPT_BY_NAME.find(([n]) => u.name.includes(n))
  if (byName) return byName[1]
  if (u.defaultStage === '工程') {
    const byPrefix = HR_DEPT_BY_PREFIX.find(([p]) => u.name.startsWith(p))
    if (byPrefix) return byPrefix[1]
  }
  return hrDeptOf(u)
}

/*
 * 这个人能不能记在 dept 名下 —— 于海伟 2026-11-10: 工段长记考勤, 下拉里点到
 * 的人报「不是工程的人」记不上。原因是部门有三处说法, 以前只认账号那一处:
 *   账号的工段 (accountHrDept) · 工资名单上定的部门 · 看全厂的人在考勤上把这个人
 *   改到的部门 (setHrPersonDept, 改在记录上)。
 * 现在任一处对上就算这个部门的人; 没账号的 (临时工、共用账号的人) 跟以前一样
 * 谁都能记, 落在记的人的部门。看下拉给谁、能不能记, 都走这一个口子。
 *
 * months —— 看哪几个月的记录 (记的那个月和上个月就够: 部门是按月改的)。
 */
export async function hrMembership(
  months: string[],
): Promise<(name: string, dept: string) => boolean> {
  const [users, base, ...shards] = await Promise.all([
    getActiveUsers(),
    getPayrollBase().catch(() => ({}) as Awaited<ReturnType<typeof getPayrollBase>>),
    ...months.map((m) => getHrMonth(m).catch(() => [])),
  ])
  const account = new Map(users.map((u) => [u.name, accountHrDept(u)]))
  const other = new Map<string, Set<string>>()
  const add = (name: string, dept: string) => {
    const s = other.get(name) ?? new Set<string>()
    s.add(dept)
    other.set(name, s)
  }
  for (const [name, p] of Object.entries(base))
    if (p.dept && p.dept !== NO_DEPARTMENT) add(name, p.dept)
  for (const rows of shards) for (const r of rows) add(r.name, r.dept ?? '商务')
  return (name, dept) => {
    const a = account.get(name)
    if (a === undefined) return true
    return a === dept || !!other.get(name)?.has(dept)
  }
}

// 'YYYY-MM-DD' 或 'YYYY-MM' → 那个月和上个月。
export function monthAndPrev(day: string): string[] {
  const y = Number(day.slice(0, 4))
  const m = Number(day.slice(5, 7))
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
  return [day.slice(0, 7), prev]
}
