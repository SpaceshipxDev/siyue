// 考勤报表 —— 一个月一张: 一人一行, 1 号到月底一天一格, 后面几列合计。
//
// 格子里写的就是那天记了什么, 一个字代表一种 (加 / 事 / 病 / 伤 / 迟 / 旷 /
// 违 / 质), 有时长的跟着小时数 ("加2" = 加班 2 小时)。一天记了几笔就并排写。
// 什么都没记的格子空着 —— 系统里没有打卡记录, 不替人编"出勤"。
//
// 纯函数: 页面 (app/hr/report) 和导出 (app/hr/export) 共用一份, 屏幕上和表格
// 里是同一张。

import { HR_TYPES, hrHasHours, type HrRecord, type HrType } from './data'

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
}

export type AttendanceReport = {
  month: string
  dayCount: number
  /** 每一天是星期几 (0 = 周日) —— 周日那一列淡一点 */
  weekdays: number[]
  rows: AttendanceRow[]
}

function trim(n: number): string {
  return String(Math.round(n * 10) / 10)
}

export function buildAttendanceReport(
  month: string,
  records: HrRecord[],
  /** 没有记录也要上表的人 (人事记过的名单)。 */
  extraNames: string[] = [],
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

  const rows: AttendanceRow[] = []
  for (const [name, list] of byName) {
    const days: string[][] = Array.from({ length: dayCount }, () => [])
    const totals = Object.fromEntries(HR_TYPES.map((t) => [t, 0])) as Record<HrType, number>
    for (const r of [...list].sort((a, b) => a.date.localeCompare(b.date))) {
      const d = Number(r.date.slice(8, 10))
      if (!(d >= 1 && d <= dayCount)) continue
      const h = hrHasHours(r.type) && r.hours ? r.hours : 0
      days[d - 1].push(`${HR_SHORT[r.type]}${h ? trim(h) : ''}`)
      totals[r.type] += hrHasHours(r.type) ? h : 1
    }
    rows.push({
      name,
      dept: list.find((r) => r.dept)?.dept ?? '',
      days: days.map((d) => d.join(' ')),
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
  return { month, dayCount, weekdays, rows }
}

/** 合计那几列的表头: 有时长的写 (h), 别的写 (次)。 */
export function totalHeader(t: HrType): string {
  const label = t === '重大质量异常' ? '质量异常' : t
  return `${label}${hrHasHours(t) ? '(h)' : '(次)'}`
}
