import 'server-only'
import { hrDeptOf } from '@/lib/auth'
import { getActiveUsers } from '@/lib/db'
import { getAttendanceSummary, getHrMonth, getHrRoster } from '@/lib/hr'
import { getPayrollBase, getPayrollRules } from '@/lib/payroll-store'
import { today } from '@/lib/today'
import type { AttendanceCalc } from '@/lib/hr-report'

// 考勤表要的那几样 —— 页签、打印页、导出三处共用, 取法一样, 数才一样。
//
//   名单: 工资名单上的人 + 人事记过考勤的人 + 近三个月有考勤记录的人, 合在一
//         起 —— 只看工资名单会漏掉没进工资表、这个月又没记录的人。只看本部门
//         的账号不给名单 (只列本部门有记录的人)。
//   部门: 工资名单上定的部门 (定每天工时的就是它) → 账号的部门 → 考勤记录上
//         盖的部门。
//   制度: 工资那页的制度 (各部门每天工时、周六工时)。
//   打卡机汇总: 导过就带上 (只看本部门的不读, 汇总不分部门)。
export async function loadSheetInputs(
  month: string,
  seeAll: boolean,
): Promise<{
  extraNames: string[]
  summary: Awaited<ReturnType<typeof getAttendanceSummary>>
  calc: AttendanceCalc
}> {
  const [y, m] = month.split('-').map(Number)
  const prev = (k: number) => new Date(Date.UTC(y, m - 1 - k, 1)).toISOString().slice(0, 7)
  const [rules, base, users, roster, summary, ...recent] = await Promise.all([
    getPayrollRules(),
    getPayrollBase().catch(() => ({}) as Awaited<ReturnType<typeof getPayrollBase>>),
    getActiveUsers(),
    seeAll ? getHrRoster() : Promise.resolve([] as string[]),
    seeAll ? getAttendanceSummary(month) : Promise.resolve({}),
    ...(seeAll ? [getHrMonth(month), getHrMonth(prev(1)), getHrMonth(prev(2))] : []),
  ])
  const recentRecords = recent.flat()
  const deptOf: Record<string, string> = {}
  for (const r of recentRecords) if (r.dept) deptOf[r.name] = r.dept
  for (const u of users) deptOf[u.name] = hrDeptOf(u)
  for (const [name, p] of Object.entries(base)) if (p.dept) deptOf[name] = p.dept
  const names = new Set([
    ...Object.keys(base),
    ...roster,
    ...recentRecords.map((r) => r.name),
  ])
  return {
    extraNames: seeAll ? [...names].filter((n) => n.trim()) : [],
    summary,
    calc: { rules, deptOf, today: today() },
  }
}
