// 考勤报表 —— 一个月一张: 一人一行, 1 号到月底一天一格, 后面几列合计。
//
// 每一格是那天的出勤小时 (含加班, 没出勤写 0, 怎么核见下面), 下面小字是那
// 天记了什么, 一个字代表一种 (加 / 事 / 病 / 伤 / 迟 / 旷 / 违 / 质), 有时长
// 的跟着小时数 ("加2" = 加班 2 小时)。
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
//   这一天一条考勤记录都没有 —— 就是 0 (不替人假设满勤; 实际上了多少, 人事
//   在格子里填)。有记录的才按上面算 (迟到、加班说明人在, 请假按小时扣)。
//   每天的出勤时间 = 这天出勤的小时 + 这天的加班; 没出勤就是 0。
//   跟发工资不挂钩 —— 工资那边照它自己的口径算, 这张表只是考勤。
//   今天以后的日子不核 (还没到)。
// 打卡机汇总导进来了的人, 实出勤和工时以打卡机为准 (工资也是这么取的)。
const MISS: readonly HrType[] = ['事假', '病假', '工伤', '旷工']

export type AttendanceCalc = {
  rules: PayrollRules
  /** 每个人归哪个部门 (定每天工时用)。 */
  deptOf: Record<string, string>
  /** 今天 YYYY-MM-DD —— 之后的日子不核。 */
  today: string
  /** 人事手填的实际上班时长 { 姓名: { 几号: 小时 } } —— 填了的那一格以它为准。 */
  actual?: Record<string, Record<number, number>>
  /**
   * 导入的打卡时长 { 姓名: { 几号: 小时 } } —— 这个月导过打卡的人, 每天就是
   * 打卡的时长, 没打卡的日子是 0 (手填的还压在它上面)。
   */
  punch?: Record<string, Record<number, number>>
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
  /** 第 i 格 = (i+1) 号 —— 那天记了什么 (加2 / 事4 / 迟…) */
  days: string[]
  /** 第 i 格那天的出勤时间 (小时, 含加班); 没核 (今天以后 / 没给制度) 是 null */
  hours: (number | null)[]
  /** 第 i 格是人事手填的实际时长 (不是系统算的)。 */
  filled: boolean[]
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
    const overtime: number[] = Array.from({ length: dayCount }, () => 0)
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
      if (r.type === '加班') overtime[d - 1] += h
    }

    // 逐天核: 这天出勤几小时 (含加班), 没出勤是 0。
    let attendedDays = 0
    let attendedHours = 0
    const cells = days.map((codes) => codes.join(' '))
    const actual = calc?.actual?.[name] ?? {}
    const punch = calc?.punch?.[name]
    const filled = days.map((_, i) => actual[i + 1] !== undefined)
    const hours = days.map((_, i) => {
      const ymd = `${month}-${String(i + 1).padStart(2, '0')}`
      const std = stdOf(i)
      // 人事填过实际上班时长的 —— 就是它 (今天以后的也认, 有人提前排好)。
      if (calc && actual[i + 1] !== undefined) {
        const v = actual[i + 1]
        if (std > 0) attendedDays += Math.min(v, std) / std
        attendedHours += v
        return v
      }
      if (!calc) return null
      // 导过打卡的人: 打卡是几小时就是几小时, 没打卡就是 0。
      if (punch) {
        const v = punch[i + 1] ?? 0
        if (std > 0) attendedDays += Math.min(v, std) / std
        attendedHours += v
        return v
      }
      if (ymd > calc.today) return null
      if (days[i].length === 0) return 0
      const worked = std > 0 ? Math.max(0, std - missing[i]) : 0
      if (std > 0) attendedDays += worked / std
      const total = Math.round((worked + overtime[i]) * 10) / 10
      attendedHours += total
      return total
    })

    const sum = summary[name]
    const attend: (number | '')[] = calc
      ? [
          workdays,
          // 逐天有数 (手填过 / 导过打卡明细) 的, 合计按逐天的算; 都没有才认
          // 打卡机月度汇总。
          (filled.some(Boolean) || punch ? undefined : sum?.workedDays) ??
            Math.round(attendedDays * 10) / 10,
          (filled.some(Boolean) || punch ? undefined : sum?.workedHours) ??
            Math.round(attendedHours * 10) / 10,
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
      hours,
      filled,
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
