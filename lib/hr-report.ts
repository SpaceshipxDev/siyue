// 考勤表 —— 一个月一张: 一人一行, 1 号到月底一天一格, 后面合计。
//
// 只看两样东西, 别的一概不管 (跟人事考勤记录、跟工资核算都不挂钩):
//   导入的打卡 —— 每天第一次、最后一次打卡, 按部门折成上班时长;
//   人事手填的实际上班时长 —— 填了的那一格以它为准。
// 当天没打卡、也没手填的就是 0。今天以后的日子空着 (还没到)。
//
// 纯函数: 页签、打印页、导出共用一份, 三处是同一张表。

// 打卡时间折成上班时长 ——
//   操机 (塑料操机 / 金属操机 / 老的操机): 下班 − 上班, 不扣;
//   其他部门: 下班 − 上班, 再扣中午 1.5 小时 (11:30–13:00) 和傍晚半小时
//   (17:30–18:00) —— 只扣落在上下班之间的那一段, 没待到 17:30 就不扣那半小时。
// 下班比上班早的是夜班, 跨到第二天。
const BREAKS: [number, number][] = [
  [11.5, 13],
  [17.5, 18],
]

function clock(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h + m / 60
}

export function isOperatorDept(dept: string): boolean {
  return dept.includes('操机')
}

export type Punch = number | { in: string; out: string }

export function punchToHours(p: Punch, dept: string): number {
  if (typeof p === 'number') return p
  const start = clock(p.in)
  let end = clock(p.out)
  if (end <= start) end += 24
  let h = end - start
  if (!isOperatorDept(dept)) {
    for (const [a, b] of BREAKS) {
      for (const shift of [0, 24]) {
        const lo = Math.max(start, a + shift)
        const hi = Math.min(end, b + shift)
        if (hi > lo) h -= hi - lo
      }
    }
  }
  return Math.max(0, Math.round(h * 10) / 10)
}

export type AttendanceRow = {
  name: string
  dept: string
  /** 第 i 格 = (i+1) 号那天的上班时长; 今天以后、还没数的是 null */
  hours: (number | null)[]
  /** 第 i 格是人事手填的 (不是打卡算的)。 */
  filled: boolean[]
  /** 出勤那几列, 跟 report.attendHeaders 一一对应。 */
  attend: number[]
}

export type AttendanceReport = {
  month: string
  dayCount: number
  /** 每一天是星期几 (0 = 周日) —— 周日那一列淡一点 */
  weekdays: number[]
  rows: AttendanceRow[]
  attendHeaders: string[]
}

export function buildAttendanceReport(
  month: string,
  input: {
    /** 导入的打卡 { 姓名: { 几号: 上下班时间 / 工时 } } */
    punch: Record<string, Record<number, Punch>>
    /** 打卡表上写的部门 */
    punchDept: Record<string, string>
    /** 人事手填的实际上班时长 { 姓名: { 几号: 小时 } } */
    actual: Record<string, Record<number, number>>
    /** 打卡表上没写部门时, 按账号的部门 */
    accountDept: Record<string, string>
    today: string
  },
): AttendanceReport {
  const [y, m] = month.split('-').map(Number)
  const dayCount = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const weekdays = Array.from({ length: dayCount }, (_, i) =>
    new Date(Date.UTC(y, m - 1, i + 1)).getUTCDay(),
  )

  const names = [...new Set([...Object.keys(input.punch), ...Object.keys(input.actual)])]
  const rows: AttendanceRow[] = names.map((name) => {
    const dept = input.punchDept[name] || input.accountDept[name] || ''
    const punch = input.punch[name] ?? {}
    const actual = input.actual[name] ?? {}
    const filled = Array.from({ length: dayCount }, (_, i) => actual[i + 1] !== undefined)
    const hours = Array.from({ length: dayCount }, (_, i) => {
      const day = i + 1
      if (actual[day] !== undefined) return actual[day]
      if (punch[day] !== undefined) return punchToHours(punch[day], dept)
      const ymd = `${month}-${String(day).padStart(2, '0')}`
      return ymd > input.today ? null : 0
    })
    const worked = hours.filter((h): h is number => h !== null)
    return {
      name,
      dept,
      hours,
      filled,
      attend: [
        worked.filter((h) => h > 0).length,
        Math.round(worked.reduce((s, h) => s + h, 0) * 10) / 10,
      ],
    }
  })
  // 按部门, 部门里按名字 —— 纸上找人是按部门找的。
  rows.sort(
    (a, b) =>
      (a.dept || '~').localeCompare(b.dept || '~', 'zh') || a.name.localeCompare(b.name, 'zh'),
  )
  return { month, dayCount, weekdays, rows, attendHeaders: ['出勤(天)', '工时(h)'] }
}
