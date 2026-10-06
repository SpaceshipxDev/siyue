import 'server-only'
import { hrDeptOf } from '@/lib/auth'
import { getActiveUsers } from '@/lib/db'
import { getDailyHours, getPunchDepts, getPunchHours } from '@/lib/hr-daily'
import { getPayrollBase } from '@/lib/payroll-store'
import { today } from '@/lib/today'
import { buildAttendanceReport } from '@/lib/hr-report'

// 考勤表要的那几样 —— 页签、打印页、导出三处共用, 取法一样, 数才一样。
//
// 只读导入的打卡和人事手填的时长; 不读人事考勤记录, 不碰工资核算 —— 考勤表
// 跟它们不挂钩。部门 (只用来定扣不扣午休) 看打卡表上写的; 没写的 (钉钉报表
// 多半不填) 看工资名单上定的部门, 再没有看账号。只读部门, 不往工资里写。
export async function loadAttendanceReport(month: string) {
  const [punch, punchDept, actual, users, base] = await Promise.all([
    getPunchHours(month).catch(() => ({})),
    getPunchDepts(month).catch(() => ({})),
    getDailyHours(month).catch(() => ({})),
    getActiveUsers(),
    getPayrollBase().catch(() => ({}) as Awaited<ReturnType<typeof getPayrollBase>>),
  ])
  const accountDept: Record<string, string> = {}
  for (const u of users) accountDept[u.name] = hrDeptOf(u)
  for (const [name, p] of Object.entries(base)) if (p.dept) accountDept[name] = p.dept
  return buildAttendanceReport(month, { punch, punchDept, actual, accountDept, today: today() })
}
