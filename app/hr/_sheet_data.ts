import 'server-only'
import { hrDeptOf } from '@/lib/auth'
import { getActiveUsers } from '@/lib/db'
import { getDailyHours, getPunchDepts, getPunchHours } from '@/lib/hr-daily'
import { today } from '@/lib/today'
import { buildAttendanceReport } from '@/lib/hr-report'

// 考勤表要的那几样 —— 页签、打印页、导出三处共用, 取法一样, 数才一样。
//
// 只读导入的打卡和人事手填的时长; 不读人事考勤记录, 不读工资名单和工资制度
// —— 考勤表跟它们不挂钩。部门 (扣不扣午休) 看打卡表上写的, 没写看账号。
export async function loadAttendanceReport(month: string) {
  const [punch, punchDept, actual, users] = await Promise.all([
    getPunchHours(month).catch(() => ({})),
    getPunchDepts(month).catch(() => ({})),
    getDailyHours(month).catch(() => ({})),
    getActiveUsers(),
  ])
  const accountDept: Record<string, string> = {}
  for (const u of users) accountDept[u.name] = hrDeptOf(u)
  return buildAttendanceReport(month, { punch, punchDept, actual, accountDept, today: today() })
}
