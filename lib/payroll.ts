// 财务 / 工资核算 (payroll) domain logic.
//
// Everybody rests 月休4天; how long a day is depends on which 部门 you're in —
// 商务 10 小时, 车间 11, 操机 12, 人事/采购 8. So a month's pay is a
// consequence of two numbers, the shop-wide 月休 and the 部门's 每天工时:
//
//   应出勤天数 = 当月天数 − 月休天数            (8月 31 天 − 4 = 27 天)
//   应出勤工时 = 应出勤天数 × 本部门每天工时     (27 × 11 = 297 小时)
//   时薪       = 月薪 ÷ 应出勤工时               (¥6000 ÷ 297 = ¥20.2)
//
// The 部门 is therefore part of a person's pay, not a label: the same 月薪 in
// 操机 and in 商务 buys different hours, and every deduction is priced off the
// 时薪 that falls out of it.
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

import { STAGES } from './data'
import type { HrRecord } from './data'

// === 部门 ===
//
// The shop's org chart is its 工段 list plus the two office desks that aren't
// one: 商务 (which is what every office account reads as, see hrDeptOf) and
// 人事, which sits in the office but keeps office hours of its own. Derived
// from STAGES rather than a hand-copied literal — the 喷漆丝印 split showed
// how a parallel stage list silently drifts.
export const DEPARTMENTS = ['商务', '人事', ...STAGES] as const

export const NO_DEPARTMENT = '未分部门'

export function isDepartment(x: unknown): x is string {
  return typeof x === 'string' && (DEPARTMENTS as readonly string[]).includes(x)
}

// 每天工时 per 部门 — the boss's own list. 商务 10, 工程/编程/手工/打磨/喷漆
// 11, 操机 12, 人事/采购 8. The stages he didn't name (检验/表处/丝印/质量/
// 出货) are shop floor too and start at 11 alongside their neighbours; every
// one of them is editable on the 工资 page, so a default is a starting point,
// never a claim.
export const DEFAULT_HOURS_BY_DEPT: Record<string, number> = {
  商务: 10,
  人事: 8,
  工程: 11,
  采购: 8,
  编程: 11,
  操机: 12,
  检验: 11,
  手工: 11,
  打磨: 11,
  表处: 11,
  喷漆: 11,
  丝印: 11,
  质量: 11,
  出货: 11,
}

// Somebody whose 部门 nobody has said yet works the commonest day in the shop.
export const FALLBACK_HOURS = 11

// === 制度 ===
//
// The shop's rulebook: 月休 is one number for everybody, 每天工时 is one per
// 部门, and the rest price what an absent hour costs. 迟到 defaults to ¥0
// because fining for it is a decision, not an assumption. Every number is
// editable on the 工资 page — the block at the top of it IS this object.
export type PayrollRules = {
  restDays: number // 月休天数 — 全厂一个数
  hoursByDept: Record<string, number> // 每天工时 — 一个部门一个数
  sickPct: number // 病假扣薪比例 %（0 = 病假照发, 100 = 全扣）
  absentPct: number // 旷工扣薪比例 %（200 = 旷工一小时扣两小时）
  latePerTime: number // 迟到每次扣款, 元
  otRate: number // 加班倍率
  // === 工资条上的工资构成 ===
  //
  // 综合工资是这个人一个月的总盘子 (系统里原来叫"月薪")。工资条上要把它拆
  // 开写: 一份固定的基本工资, 加上几项按比例算的补贴。这几个数只是**构成的
  // 拆法**, 不额外加钱 —— 实发仍然从综合工资算起, 所以拆法改了实发一分不变。
  baseSalaryCny: number // 基本工资 — 全厂一个数
  splitThresholdCny: number // 综合工资高过这个数才拆分
  postPct: number // 岗位补贴 %
  secretPct: number // 保密费 %
  safetyPct: number // 安全费 %
  perfPct: number // 绩效工资 %
}

export const DEFAULT_PAYROLL_RULES: PayrollRules = {
  restDays: 4,
  hoursByDept: DEFAULT_HOURS_BY_DEPT,
  sickPct: 50,
  absentPct: 200,
  latePerTime: 0,
  otRate: 1.5,
  baseSalaryCny: 2660,
  splitThresholdCny: 6000,
  postPct: 10,
  secretPct: 15,
  safetyPct: 10,
  perfPct: 35,
}

// Bounds are sanity rails, not policy: they stop a slipped keystroke (a 500x
// overtime rate, a 40-day month off) from turning into a payroll run.
const RULE_LIMITS: Record<string, [number, number]> = {
  restDays: [0, 15],
  sickPct: [0, 100],
  absentPct: [0, 300],
  latePerTime: [0, 1000],
  otRate: [1, 5],
  baseSalaryCny: [0, 100000],
  splitThresholdCny: [0, 100000],
  postPct: [0, 100],
  secretPct: [0, 100],
  safetyPct: [0, 100],
  perfPct: [0, 100],
}

export type ScalarRuleKey =
  | 'restDays'
  | 'sickPct'
  | 'absentPct'
  | 'latePerTime'
  | 'otRate'
  | 'baseSalaryCny'
  | 'splitThresholdCny'
  | 'postPct'
  | 'secretPct'
  | 'safetyPct'
  | 'perfPct'

export const RULE_KEYS = Object.keys(RULE_LIMITS) as ScalarRuleKey[]

export function isRuleKey(x: unknown): x is ScalarRuleKey {
  return typeof x === 'string' && (RULE_KEYS as string[]).includes(x)
}

export function isValidRuleValue(key: ScalarRuleKey, v: unknown): boolean {
  const [lo, hi] = RULE_LIMITS[key]
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
}

// A day is at least an hour and at most sixteen — past that it's a typo.
export function isValidDeptHours(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 16
}

// A stored rulebook that's missing a key (written before the key existed, or
// hand-edited) reads as the default for that key — never as NaN.
export function normalizeRules(raw: unknown): PayrollRules {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >
  const out: PayrollRules = {
    ...DEFAULT_PAYROLL_RULES,
    hoursByDept: { ...DEFAULT_HOURS_BY_DEPT },
  }
  for (const k of RULE_KEYS) {
    if (isValidRuleValue(k, o[k])) out[k] = o[k] as number
  }
  const h = o.hoursByDept
  if (typeof h === 'object' && h !== null) {
    for (const [dept, v] of Object.entries(h as Record<string, unknown>)) {
      if (isValidDeptHours(v)) out.hoursByDept[dept] = v
    }
  }
  return out
}

export function hoursForDept(rules: PayrollRules, dept?: string): number {
  const h = dept ? rules.hoursByDept[dept] : undefined
  return isValidDeptHours(h) ? h : FALLBACK_HOURS
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

// 每月每人手填的那一行。上面几项是加的, 下面几项是减的 —— 工资条上就按这
// 个顺序排, 跟厂里发的那张纸一样。全部按整元存。
export type PayrollLine = {
  otHours?: number // 加班小时
  adjustCny?: number // 奖罚, 正为奖 负为扣
  // —— 补助 (加) ——
  socialSubsidyCny?: number // 社保补贴
  housingCny?: number // 房补
  mealCny?: number // 餐补
  nightShiftCny?: number // 夜班补贴
  holidayCny?: number // 节假日补贴
  bonusCny?: number // 奖金
  // —— 扣款 (减) ——
  advanceCny?: number // 预支工资
  otherDeductCny?: number // 其他扣款
  perfDeductCny?: number // 绩效扣款
  safetyDeductCny?: number // 安全扣款
  socialInsuranceCny?: number // 社保 (个人部分)
  taxCny?: number // 个税
  note?: string
}

/** 手填的钱格子 —— 一份清单管住校验、录入界面和工资条的顺序。 */
export const PAYROLL_ADD_FIELDS = [
  ['socialSubsidyCny', '社保补贴'],
  ['housingCny', '房补'],
  ['mealCny', '餐补'],
  ['nightShiftCny', '夜班补贴'],
  ['holidayCny', '节假日补贴'],
  ['bonusCny', '奖金'],
] as const

export const PAYROLL_CUT_FIELDS = [
  ['advanceCny', '预支工资'],
  ['perfDeductCny', '绩效扣款'],
  ['safetyDeductCny', '安全扣款'],
  ['otherDeductCny', '其他扣款'],
  ['socialInsuranceCny', '社保'],
  ['taxCny', '个税'],
] as const

export type PayrollMoneyKey =
  | (typeof PAYROLL_ADD_FIELDS)[number][0]
  | (typeof PAYROLL_CUT_FIELDS)[number][0]

export const PAYROLL_MONEY_KEYS: PayrollMoneyKey[] = [
  ...PAYROLL_ADD_FIELDS.map((f) => f[0]),
  ...PAYROLL_CUT_FIELDS.map((f) => f[0]),
]

export function isPayrollMoneyKey(x: unknown): x is PayrollMoneyKey {
  return typeof x === 'string' && (PAYROLL_MONEY_KEYS as string[]).includes(x)
}

/** 一格钱: 整元, 不为负, 有上限 —— 手滑多打一个零不会变成一次发薪事故。 */
export function isValidPayrollMoney(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000
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
  dept: string // 部门 — 决定这个人一天算几个小时
  monthlyCny: number // 月薪
  hoursPerDay: number // 本部门每天工时
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
  // === 工资构成 (只是把综合工资拆开写, 不额外加钱) ===
  baseSalaryCny: number // 基本工资
  postSubsidyCny: number // 岗位补贴
  secretFeeCny: number // 保密费
  safetyFeeCny: number // 安全费
  perfPayCny: number // 绩效工资
  /** 综合工资减掉上面五项之后剩下的 —— 拆不干净的部分照实摆出来, 不藏。 */
  otherPartCny: number
  /** 综合工资没过门槛就不拆 (工资条上那几行留空)。 */
  splitApplies: boolean
  // === 出勤 ===
  workedDays: number // 实际出勤天数
  attendancePayCny: number // 出勤工资 = 综合工资 − 各项缺勤扣
  // === 手填的加减项 ===
  socialSubsidyCny: number
  housingCny: number
  mealCny: number
  nightShiftCny: number
  holidayCny: number
  bonusCny: number
  advanceCny: number
  otherDeductCny: number
  perfDeductCny: number
  safetyDeductCny: number
  socialInsuranceCny: number
  taxCny: number
  /** 应发合计 = 出勤工资 + 加班费 + 补助 + 奖金 + 奖罚 */
  grossCny: number
  /** 扣款合计 */
  deductCny: number
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
  dept: string,
  monthlyCny: number,
  attendance: Attendance,
  line: PayrollLine,
  rules: PayrollRules,
  month: string,
): Payslip {
  const standardDays = standardDaysOf(month, rules)
  const hoursPerDay = hoursForDept(rules, dept)
  const standardHours = standardDays * hoursPerDay
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

  // 出勤工资 —— 综合工资扣掉缺勤的那几笔。加班和补助不在里面 (它们是另外
  // 加的), 所以这一格回答的是"这个月按出勤该拿多少底"。
  const attendancePayCny = monthlyCny - leaveCut - sickCut - absentCut - lateCut

  // 工资构成 —— 把综合工资拆开写在条子上。只有过了门槛才拆; 拆完剩下的那点
  // 照实摆在"其他"里, 不硬凑。这几行**不参与实发计算**, 改拆法钱不会变。
  const splitApplies = monthlyCny > rules.splitThresholdCny
  const pct = (p: number) => (splitApplies ? Math.round(monthlyCny * (p / 100)) : 0)
  const baseSalaryCny = splitApplies ? Math.round(rules.baseSalaryCny) : 0
  const postSubsidyCny = pct(rules.postPct)
  const secretFeeCny = pct(rules.secretPct)
  const safetyFeeCny = pct(rules.safetyPct)
  const perfPayCny = pct(rules.perfPct)
  const otherPartCny = splitApplies
    ? monthlyCny -
      baseSalaryCny -
      postSubsidyCny -
      secretFeeCny -
      safetyFeeCny -
      perfPayCny
    : 0

  const money = (v: number | undefined) => Math.round(v ?? 0)
  const socialSubsidyCny = money(line.socialSubsidyCny)
  const housingCny = money(line.housingCny)
  const mealCny = money(line.mealCny)
  const nightShiftCny = money(line.nightShiftCny)
  const holidayCny = money(line.holidayCny)
  const bonusCny = money(line.bonusCny)
  const advanceCny = money(line.advanceCny)
  const otherDeductCny = money(line.otherDeductCny)
  const perfDeductCny = money(line.perfDeductCny)
  const safetyDeductCny = money(line.safetyDeductCny)
  const socialInsuranceCny = money(line.socialInsuranceCny)
  const taxCny = money(line.taxCny)

  const grossCny =
    attendancePayCny +
    otPay +
    socialSubsidyCny +
    housingCny +
    mealCny +
    nightShiftCny +
    holidayCny +
    bonusCny +
    adjustCny
  const deductCny =
    advanceCny +
    otherDeductCny +
    perfDeductCny +
    safetyDeductCny +
    socialInsuranceCny +
    taxCny

  return {
    name,
    dept,
    monthlyCny,
    hoursPerDay,
    standardDays,
    standardHours,
    hourlyCny,
    attendance,
    otHours,
    workedHours: Math.max(0, Math.round(workedHours * 10) / 10),
    // 实际出勤天数 —— 由工时折回天, 一位小数 (半天假是常事)。加班不算进出勤
    // 天数, 它自己有一行。
    workedDays:
      Math.round(
        (Math.max(0, workedHours - otHours) / (hoursPerDay || 1)) * 10,
      ) / 10,
    leaveCut,
    sickCut,
    absentCut,
    lateCut,
    otPay,
    adjustCny,
    baseSalaryCny,
    postSubsidyCny,
    secretFeeCny,
    safetyFeeCny,
    perfPayCny,
    otherPartCny,
    splitApplies,
    attendancePayCny,
    socialSubsidyCny,
    housingCny,
    mealCny,
    nightShiftCny,
    holidayCny,
    bonusCny,
    advanceCny,
    otherDeductCny,
    perfDeductCny,
    safetyDeductCny,
    socialInsuranceCny,
    taxCny,
    grossCny,
    deductCny,
    netCny: grossCny - deductCny,
    note: line.note,
  }
}

// 名册的一行：月薪 + 部门。部门决定一天算几个小时，所以它跟月薪一样是工资的
// 一部分，不是个标签。
export type PayrollPerson = {
  monthlyCny: number
  dept: string
}

// === 调薪记录 ===
//
// 调薪不是另外要填的一张表。工资表上把一个人的月薪从 6000 改成 6500，这一改
// 本身就是一次调薪，系统当场记下来——所以记录和实发工资永远对得上，没有第二
// 个地方要维护，也不会出现"记了但没改"或"改了但没记"。
//
// 第一次给一个人定月薪不记：那是建档，不是调整（否则头一天配置名册就会刷出
// 几十条假调薪）。清空月薪、把人移出名册记一条，因为那是停发。
//
// 原因是事后补的：改数字的时候不打断人问为什么，来这页补一句就行。
export type SalaryChange = {
  id: string
  name: string
  dept: string
  fromCny: number // 调整前月薪
  toCny: number // 调整后月薪；0 = 移出名册
  date: string // YYYY-MM-DD — 调整当天
  by: string // 操作人
  reason?: string
  createdAt: string
}

export function salaryDelta(c: SalaryChange): number {
  return c.toCny - c.fromCny
}

// 涨幅 %，看的是相对自己涨了多少 — 移出名册没有涨幅。
export function salaryPct(c: SalaryChange): number | null {
  if (c.fromCny <= 0 || c.toCny <= 0) return null
  return ((c.toCny - c.fromCny) / c.fromCny) * 100
}

export function matchesSalaryChange(c: SalaryChange, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return [c.name, c.dept, c.reason, c.by]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(needle)
}

// The month's run: one 工资条 per person who has a 月薪. Somebody with no 月薪
// yet isn't on payroll — typing their 月薪 is what puts them on it. Sorted by
// 部门 then name, so the sheet reads the way the floor is laid out.
export function buildPayslips(
  base: Record<string, PayrollPerson>,
  attendance: Record<string, Attendance>,
  lines: Record<string, PayrollLine>,
  rules: PayrollRules,
  month: string,
): Payslip[] {
  return Object.entries(base)
    .filter(([, p]) => p.monthlyCny > 0)
    .map(([name, p]) =>
      computePayslip(
        name,
        p.dept,
        p.monthlyCny,
        attendance[name] ?? EMPTY_ATTENDANCE,
        lines[name] ?? {},
        rules,
        month,
      ),
    )
    .sort((a, b) =>
      a.dept !== b.dept
        ? deptOrder(a.dept) - deptOrder(b.dept)
        : a.name.localeCompare(b.name, 'zh'),
    )
}

// 商务 first, then the floor in stage order, unknowns last — DEPARTMENTS' own
// order, which is STAGES' order.
function deptOrder(dept: string): number {
  const i = (DEPARTMENTS as readonly string[]).indexOf(dept)
  return i === -1 ? DEPARTMENTS.length : i
}

// Which 部门 actually have somebody on the payroll — the 每天工时 strip only
// shows these, so it starts at three or four numbers instead of fourteen.
export function deptsInUse(slips: Payslip[]): string[] {
  return [...new Set(slips.map((s) => s.dept))].sort(
    (a, b) => deptOrder(a) - deptOrder(b),
  )
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
// 导出的表头 = 工资条上的项目, 顺序一样 —— 屏幕上、纸上、Excel 里读到的是
// 同一张表, 不用在三份东西之间对字段。
export const PAYROLL_EXPORT_HEADERS = [
  '姓名',
  '部门',
  '综合工资',
  '基本工资',
  '岗位补贴',
  '保密费',
  '安全费',
  '绩效工资',
  '应出勤天',
  '实际出勤天',
  '每天工时',
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
  '出勤工资',
  '加班费',
  '社保补贴',
  '房补',
  '餐补',
  '夜班补贴',
  '节假日补贴',
  '奖金',
  '奖罚',
  '应发合计',
  '预支工资',
  '绩效扣款',
  '安全扣款',
  '其他扣款',
  '社保',
  '个税',
  '扣款合计',
  '实发',
  '备注',
  '领款人签名',
] as const

// 列宽跟着表头走 —— 名字和备注宽一点, 钱和工时一律窄的。列一多, 手动数着排
// 宽度必错一次, 所以按表头名字算。
export const PAYROLL_EXPORT_COL_WIDTHS = PAYROLL_EXPORT_HEADERS.map((h) =>
  h === '备注' ? 18 : h === '领款人签名' ? 12 : h === '姓名' || h === '部门' ? 10 : 9,
)

export function buildPayrollExportAoa(
  slips: Payslip[],
): (string | number)[][] {
  const aoa: (string | number)[][] = [PAYROLL_EXPORT_HEADERS.slice() as string[]]
  for (const p of slips) {
    aoa.push([
      p.name,
      p.dept,
      p.monthlyCny,
      p.splitApplies ? p.baseSalaryCny : '',
      p.splitApplies ? p.postSubsidyCny : '',
      p.splitApplies ? p.secretFeeCny : '',
      p.splitApplies ? p.safetyFeeCny : '',
      p.splitApplies ? p.perfPayCny : '',
      p.standardDays,
      p.workedDays,
      p.hoursPerDay,
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
      p.attendancePayCny,
      p.otPay,
      p.socialSubsidyCny,
      p.housingCny,
      p.mealCny,
      p.nightShiftCny,
      p.holidayCny,
      p.bonusCny,
      p.adjustCny,
      p.grossCny,
      p.advanceCny,
      p.perfDeductCny,
      p.safetyDeductCny,
      p.otherDeductCny,
      p.socialInsuranceCny,
      p.taxCny,
      p.deductCny,
      p.netCny,
      p.note ?? '',
      '',
    ])
  }
  // 合计 sits under 实发; everything else in the row is blank.
  const totalRow: (string | number)[] = PAYROLL_EXPORT_HEADERS.map(() => '')
  totalRow[0] = '合计'
  totalRow[PAYROLL_EXPORT_HEADERS.indexOf('实发')] = payrollTotal(slips)
  aoa.push(totalRow)
  return aoa
}
