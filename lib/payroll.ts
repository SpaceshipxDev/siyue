// 财务 / 工资核算 (payroll) domain logic.
//
// The shop pays a 月薪 and rests 月休4天. Everything else in a month's pay is
// a consequence of that one sentence:
//
//   应出勤天数 = 当月天数 − 月休天数          (8月 31 天 − 4 = 27 天)
//   应出勤工时 = 应出勤天数 × 每天工时         (27 × 8 = 216 小时)
//   时薪       = 月薪 ÷ 应出勤工时             (¥6000 ÷ 216 = ¥27.8)
//
// From there the 人事 log (lib/hr.ts) — which is already the shop's 考勤 book —
// is the only other input: 事假/病假/工伤/旷工 come in hours, 迟到/违纪/质量
// come as counts. 事假 costs the person the hours; 病假 costs part of them;
// 工伤 costs nothing and is the factory's own; 旷工 costs more than it took.
// 违纪 and 重大质量异常 are NOT priced here — no rate schedule is honest for
// them, so they surface on the row as a mark and the boss types the 奖罚.
//
// The two things the log can't know — 加班小时 and 奖罚 — are typed per person
// per month. Everything else derives, so payday is reading, not arithmetic.
//
// Pure functions only — no DB, no React — mirroring lib/expenses.ts, so the
// /finance page (server), the 发放 write path and the client board all compute
// the same number.

import type { HrRecord } from './data'

// === 制度 ===
//
// The shop's rulebook, six numbers. Defaults are 月休4天 / 8 小时 and the
// conventional split for the rest; 迟到 defaults to ¥0 because fining for it
// is a decision, not an assumption. All six are editable on the 工资 page —
// the sentence at the top of it IS this object.
export type PayrollRules = {
  restDays: number // 月休天数
  hoursPerDay: number // 每天工时
  sickPct: number // 病假扣薪比例 %（0 = 病假照发, 100 = 全扣）
  absentPct: number // 旷工扣薪比例 %（200 = 旷工一小时扣两小时）
  latePerTime: number // 迟到每次扣款, 元
  otRate: number // 加班倍率
}

export const DEFAULT_PAYROLL_RULES: PayrollRules = {
  restDays: 4,
  hoursPerDay: 8,
  sickPct: 50,
  absentPct: 200,
  latePerTime: 0,
  otRate: 1.5,
}

// Bounds are sanity rails, not policy: they stop a slipped keystroke (80 hours
// a day, a 500x overtime rate) from turning into a payroll run.
const RULE_LIMITS: Record<keyof PayrollRules, [number, number]> = {
  restDays: [0, 15],
  hoursPerDay: [1, 16],
  sickPct: [0, 100],
  absentPct: [0, 300],
  latePerTime: [0, 1000],
  otRate: [1, 5],
}

export const RULE_KEYS = Object.keys(RULE_LIMITS) as (keyof PayrollRules)[]

export function isRuleKey(x: unknown): x is keyof PayrollRules {
  return typeof x === 'string' && (RULE_KEYS as string[]).includes(x)
}

export function isValidRuleValue(key: keyof PayrollRules, v: unknown): boolean {
  const [lo, hi] = RULE_LIMITS[key]
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
}

// A stored rulebook that's missing a key (written before the key existed, or
// hand-edited) reads as the default for that key — never as NaN.
export function normalizeRules(raw: unknown): PayrollRules {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >
  const out = { ...DEFAULT_PAYROLL_RULES }
  for (const k of RULE_KEYS) {
    if (isValidRuleValue(k, o[k])) out[k] = o[k] as number
  }
  return out
}

// === 考勤汇总 ===

export type Attendance = {
  leaveHours: number // 事假
  sickHours: number // 病假
  injuryHours: number // 工伤
  absentHours: number // 旷工
  lateTimes: number // 迟到
  disciplineTimes: number // 违纪
  qualityTimes: number // 重大质量异常
}

export const EMPTY_ATTENDANCE: Attendance = {
  leaveHours: 0,
  sickHours: 0,
  injuryHours: 0,
  absentHours: 0,
  lateTimes: 0,
  disciplineTimes: 0,
  qualityTimes: 0,
}

// One month of 人事 lines → one summary per person. The four hour-kinds add
// their 时长; the rest count. Records filed before 时长 was required carry no
// hours and contribute none — they still show up in 人事 as an event, but
// nothing can be deducted from a length nobody wrote down.
export function summarizeAttendance(
  records: HrRecord[],
): Record<string, Attendance> {
  const out: Record<string, Attendance> = {}
  for (const r of records) {
    const a = (out[r.name] ??= { ...EMPTY_ATTENDANCE })
    const h = typeof r.hours === 'number' && r.hours > 0 ? r.hours : 0
    if (r.type === '事假') a.leaveHours += h
    else if (r.type === '病假') a.sickHours += h
    else if (r.type === '工伤') a.injuryHours += h
    else if (r.type === '旷工') a.absentHours += h
    else if (r.type === '迟到') a.lateTimes += 1
    else if (r.type === '违纪') a.disciplineTimes += 1
    else if (r.type === '重大质量异常') a.qualityTimes += 1
  }
  return out
}

// === 每人每月的手工两项 ===

export type PayrollLine = {
  otHours?: number // 加班小时
  adjustCny?: number // 奖罚, 正为奖 负为扣
  note?: string
}

export function isValidOtHours(v: unknown): v is number {
  // A month of 12h days on top of a full roster is ~200 extra hours; past that
  // it's a typo.
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 400
}

export function isValidAdjust(v: unknown): v is number {
  return (
    typeof v === 'number' && Number.isFinite(v) && v >= -100000 && v <= 100000
  )
}

export function isValidMonthlyCny(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 200000
}

export function isPayrollMonth(x: unknown): x is string {
  return typeof x === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(x)
}

// === 工资条 ===
//
// Every number the person could ask about, in the order the arithmetic runs.
// Each money field is whole 元 and 实发 is exactly their sum — so the payslip
// on screen adds up, which is the only way it settles an argument.
export type Payslip = {
  name: string
  monthlyCny: number // 月薪
  standardDays: number // 应出勤天数
  standardHours: number // 应出勤工时
  hourlyCny: number // 时薪（未取整, 展示用一位小数）
  attendance: Attendance
  otHours: number // 加班小时
  workedHours: number // 实际工时 = 应出勤 − 缺勤 + 加班
  leaveCut: number // 事假扣
  sickCut: number // 病假扣
  absentCut: number // 旷工扣
  lateCut: number // 迟到扣
  otPay: number // 加班费
  adjustCny: number // 奖罚
  netCny: number // 实发
  note?: string
}

export function daysInMonth(month: string): number {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export function standardDaysOf(month: string, rules: PayrollRules): number {
  return Math.max(1, daysInMonth(month) - rules.restDays)
}

export function computePayslip(
  name: string,
  monthlyCny: number,
  attendance: Attendance,
  line: PayrollLine,
  rules: PayrollRules,
  month: string,
): Payslip {
  const standardDays = standardDaysOf(month, rules)
  const standardHours = standardDays * rules.hoursPerDay
  const hourlyCny = monthlyCny / standardHours
  const otHours = line.otHours ?? 0
  const adjustCny = Math.round(line.adjustCny ?? 0)

  const leaveCut = Math.round(attendance.leaveHours * hourlyCny)
  const sickCut = Math.round(
    attendance.sickHours * hourlyCny * (rules.sickPct / 100),
  )
  // 工伤 is deliberately absent: the hours are lost to the factory, not to the
  // person. It still shows on the payslip so nobody thinks it was forgotten.
  const absentCut = Math.round(
    attendance.absentHours * hourlyCny * (rules.absentPct / 100),
  )
  const lateCut = Math.round(attendance.lateTimes * rules.latePerTime)
  const otPay = Math.round(otHours * hourlyCny * rules.otRate)

  const workedHours =
    standardHours -
    attendance.leaveHours -
    attendance.sickHours -
    attendance.injuryHours -
    attendance.absentHours +
    otHours

  return {
    name,
    monthlyCny,
    standardDays,
    standardHours,
    hourlyCny,
    attendance,
    otHours,
    workedHours: Math.max(0, Math.round(workedHours * 10) / 10),
    leaveCut,
    sickCut,
    absentCut,
    lateCut,
    otPay,
    adjustCny,
    netCny:
      monthlyCny - leaveCut - sickCut - absentCut - lateCut + otPay + adjustCny,
    note: line.note,
  }
}

// The month's run: one 工资条 per person who has a 月薪. Somebody with no 月薪
// yet isn't on payroll — typing their 月薪 is what puts them on it.
export function buildPayslips(
  base: Record<string, number>,
  attendance: Record<string, Attendance>,
  lines: Record<string, PayrollLine>,
  rules: PayrollRules,
  month: string,
): Payslip[] {
  return Object.entries(base)
    .filter(([, m]) => m > 0)
    .map(([name, m]) =>
      computePayslip(
        name,
        m,
        attendance[name] ?? EMPTY_ATTENDANCE,
        lines[name] ?? {},
        rules,
        month,
      ),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

export function payrollTotal(slips: Payslip[]): number {
  return slips.reduce((s, p) => s + p.netCny, 0)
}

export function monthLabel(month: string): string {
  return `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`
}

// === 工资表导出 ===
//
// The sheet they print and pass around on payday — last column is left blank
// on purpose, it's where people sign.
export const PAYROLL_EXPORT_HEADERS = [
  '姓名',
  '月薪',
  '应出勤天',
  '应出勤工时',
  '事假h',
  '病假h',
  '工伤h',
  '旷工h',
  '迟到次',
  '加班h',
  '实际工时',
  '事假扣',
  '病假扣',
  '旷工扣',
  '迟到扣',
  '加班费',
  '奖罚',
  '实发',
  '备注',
  '签字',
] as const

export const PAYROLL_EXPORT_COL_WIDTHS = [
  10, 10, 10, 12, 8, 8, 8, 8, 8, 8, 10, 9, 9, 9, 9, 9, 9, 11, 18, 12,
]

export function buildPayrollExportAoa(
  slips: Payslip[],
): (string | number)[][] {
  const aoa: (string | number)[][] = [PAYROLL_EXPORT_HEADERS.slice() as string[]]
  for (const p of slips) {
    aoa.push([
      p.name,
      p.monthlyCny,
      p.standardDays,
      p.standardHours,
      p.attendance.leaveHours,
      p.attendance.sickHours,
      p.attendance.injuryHours,
      p.attendance.absentHours,
      p.attendance.lateTimes,
      p.otHours,
      p.workedHours,
      p.leaveCut,
      p.sickCut,
      p.absentCut,
      p.lateCut,
      p.otPay,
      p.adjustCny,
      p.netCny,
      p.note ?? '',
      '',
    ])
  }
  aoa.push([
    '合计',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    payrollTotal(slips),
    '',
    '',
  ])
  return aoa
}
