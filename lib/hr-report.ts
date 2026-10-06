// 考勤报表 —— 一个月一张: 一人一行, 1 号到月底一天一格, 后面几列合计。
//
// 格子里写的就是那天记了什么, 一个字代表一种 (加 / 事 / 病 / 伤 / 迟 / 旷 /
// 违 / 质), 有时长的跟着小时数 ("加2" = 加班 2 小时)。一天记了几笔就并排写。
// 什么都没记的格子空着 —— 系统里没有打卡记录, 不替人编"出勤"。
//
// 纯函数: 页面 (app/hr/report) 和导出 (app/hr/export) 共用一份, 屏幕上和表格
// 里是同一张。

import { HR_TYPES, hrHasHours, type HrRecord, type HrType } from './data'
import { hoursForDept, saturdayHoursForDept, type PayrollRules } from './payroll'

// 每天出勤怎么核 —— 跟工资同一套制度 (lib/payroll):
//   周日休息; 周六按本部门的周六工时, 平日按本部门每天工时 —— 这是这一天该上
//   的小时;
//   减掉当天记的事假 / 病假 / 工伤 / 旷工 (没写时长的当一整天);
//   剩下的就是这天出勤的小时, 占该上小时的几成就算几成天 (半天假 = 0.5 天)。
//   一条都没记的工作日算全勤 —— 跟工资"没记就是满勤"一个口径。
//   今天以后的日子不核 (还没到)。
// 打卡机汇总导进来了的人, 实出勤和工时以打卡机为准 (工资也是这么取的)。
const MISS: readonly HrType[] = ['事假', '病假', '工伤', '旷工']

export type AttendanceCalc = {
  rules: PayrollRules
  /** 每个人归哪个部门 (定每天工时用)。 */
  deptOf: Record<string, string>
  /** 今天 YYYY-MM-DD —— 之后的日子不核。 */
  today: string
}

export const HR_SHORT: Record<HrType, string> = {
  加班: '加',
  事假: '事',
  病假: '病',
  工伤: '伤',
  迟到: '迟',
  旷工: '旷',
  违纪: '违',
  重大质量异常: '质',
}

export type AttendanceRow = {
  name: string
  dept: string
  /** 第 i 格 = (i+1) 号 */
  days: string[]
  /** 每种的合计: 有时长的是小时, 别的是次数 */
  totals: Record<HrType, number>
  /** 出勤那几列的值, 跟 report.attendHeaders 一一对应。 */
  attend: (number | '')[]
}

export type AttendanceReport = {
  month: string
  dayCount: number
  /** 每一天是星期几 (0 = 周日) —— 周日那一列淡一点 */
  weekdays: number[]
  rows: AttendanceRow[]
  /** 这个月导过打卡机汇总。 */
  hasSummary: boolean
  /** 出勤那几列的表头 (核了出勤才有; 导过打卡机汇总再多两列加班)。 */
  attendHeaders: string[]
}

function trim(n: number): string {
  return String(Math.round(n * 10) / 10)
}

export function buildAttendanceReport(
  month: string,
  records: HrRecord[],
  /** 没有记录也要上表的人 (人事记过的名单)。 */
  extraNames: string[] = [],
  /** 打卡机月度汇总, 按姓名 (lib/hr getAttendanceSummary)。 */
  summary: Record<
    string,
    { workedDays?: number; workedHours?: number; otWeekdayHours: number; otWeekendHours: number }
  > = {},
  /** 给了就逐天核出勤 (格子里打 √ / 休, 后面多出勤那几列)。 */
  calc?: AttendanceCalc,
): AttendanceReport {
  const [y, m] = month.split('-').map(Number)
  const dayCount = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const weekdays = Array.from({ length: dayCount }, (_, i) =>
    new Date(Date.UTC(y, m - 1, i + 1)).getUTCDay(),
  )

  const byName = new Map<string, HrRecord[]>()
  for (const r of records) {
    if (r.date.slice(0, 7) !== month) continue
    byName.set(r.name, [...(byName.get(r.name) ?? []), r])
  }
  for (const n of extraNames) if (!byName.has(n)) byName.set(n, [])
  // 打卡机上有、人事没记过的人也上表 (他有出勤)。
  for (const n of Object.keys(summary)) if (!byName.has(n)) byName.set(n, [])

  const hasSummary = Object.keys(summary).length > 0
  const attendHeaders = calc
    ? [
        '应出勤(天)',
        '实出勤(天)',
        '出勤工时(h)',
        ...(hasSummary ? ['平时加班(h)', '周末加班(h)'] : []),
      ]
    : []
  const workdays = weekdays.filter((w) => w !== 0).length

  const rows: AttendanceRow[] = []
  for (const [name, list] of byName) {
    const days: string[][] = Array.from({ length: dayCount }, () => [])
    const missing: number[] = Array.from({ length: dayCount }, () => 0)
    const totals = Object.fromEntries(HR_TYPES.map((t) => [t, 0])) as Record<HrType, number>
    const dept = calc?.deptOf[name] || list.find((r) => r.dept)?.dept || ''
    const weekdayHours = calc ? hoursForDept(calc.rules, dept || undefined) : 0
    const satHours = calc ? saturdayHoursForDept(calc.rules, dept || undefined) : 0
    const stdOf = (i: number) =>
      weekdays[i] === 0 ? 0 : weekdays[i] === 6 ? satHours : weekdayHours
    for (const r of [...list].sort((a, b) => a.date.localeCompare(b.date))) {
      const d = Number(r.date.slice(8, 10))
      if (!(d >= 1 && d <= dayCount)) continue
      const h = hrHasHours(r.type) && r.hours ? r.hours : 0
      days[d - 1].push(`${HR_SHORT[r.type]}${h ? trim(h) : ''}`)
      totals[r.type] += hrHasHours(r.type) ? h : 1
      if (MISS.includes(r.type)) missing[d - 1] += h > 0 ? h : stdOf(d - 1) || 0
    }

    // 逐天核: 格子前面打 √ (出勤 / 出勤一部分) 或 休, 后面跟当天的记录。
    let attendedDays = 0
    let attendedHours = 0
    const cells = days.map((codes, i) => {
      const ymd = `${month}-${String(i + 1).padStart(2, '0')}`
      const text = codes.join(' ')
      if (!calc || ymd > calc.today) return text
      const std = stdOf(i)
      if (std <= 0) return text ? text : '休'
      const worked = Math.max(0, std - missing[i])
      attendedHours += worked
      attendedDays += worked / std
      if (worked <= 0) return text
      return text ? `√ ${text}` : '√'
    })

    const sum = summary[name]
    const attend: (number | '')[] = calc
      ? [
          workdays,
          sum?.workedDays ?? Math.round(attendedDays * 10) / 10,
          sum?.workedHours ?? Math.round(attendedHours * 10) / 10,
          ...(hasSummary
            ? ([sum ? sum.otWeekdayHours || '' : '', sum ? sum.otWeekendHours || '' : ''] as (
                | number
                | ''
              )[])
            : []),
        ]
      : []
    rows.push({
      name,
      dept,
      days: cells,
      attend,
      totals: Object.fromEntries(
        HR_TYPES.map((t) => [t, Math.round(totals[t] * 10) / 10]),
      ) as Record<HrType, number>,
    })
  }
  // 按部门, 部门里按名字 —— 纸上找人是按部门找的。
  rows.sort(
    (a, b) =>
      (a.dept || '~').localeCompare(b.dept || '~', 'zh') || a.name.localeCompare(b.name, 'zh'),
  )
  return { month, dayCount, weekdays, rows, hasSummary, attendHeaders }
}

/** 合计那几列的表头: 有时长的写 (h), 别的写 (次)。 */
export function totalHeader(t: HrType): string {
  const label = t === '重大质量异常' ? '质量异常' : t
  return `${label}${hrHasHours(t) ? '(h)' : '(次)'}`
}
