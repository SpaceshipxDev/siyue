// 财务 / 工资核算 (payroll) domain logic.
//
// Everybody rests 月休4天; how long a day is depends on which 部门 you're in —
// 商务 10 小时, 车间 11, 操机 12, 人事/采购 8. So a month's pay is a
// consequence of two numbers, the shop-wide 月休 and the 部门's 每天工时:
//
//   应出勤天数 = 当月天数 − 月休天数            (9月 30 天 − 4 = 26 天)
//   其中周六   = 当月日历上的周六, 一天只算 8 小时 (半天班)
//   应出勤工时 = 平日 × 本部门每天工时 + 周六 × 8 (22×11 + 4×8 = 274 小时)
//   时薪       = 综合工资 ÷ 应出勤工时           (¥6000 ÷ 274 = ¥21.9)
//
// 加班费 = 时薪 × 加班小时 × 加班倍率 — 加班小时不在这页填, 它来自 人事 的
// 「加班」记录 (谁哪天加了几个小时), 汇总到当月。
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
  /**
   * 周六一天算几个小时 — 全厂一个数。周六是半天班, 不分部门, 所以它不在
   * hoursByDept 里: 应出勤工时 = 平日 × 本部门每天工时 + 周六 × 这个数。
   */
  saturdayHours: number
  sickPct: number // 病假扣薪比例 %（0 = 病假照发, 100 = 全扣）
  absentPct: number // 旷工扣薪比例 %（200 = 旷工一小时扣两小时）
  latePerTime: number // 迟到每次扣款, 元
  // === 加班费 ===
  //
  // 一小时多少钱是厂里定死的价, 不再从月薪折算 —— 同一个小时, 谁加都是这个
  // 数。周六周日一个价, 平时一个价; 是哪种, 系统看加班那天是星期几, 人事记
  // 的时候不用选。
  otWeekdayCny: number // 平时加班, 元/小时
  otWeekendCny: number // 周六周日加班, 元/小时
  // === 工资条上的工资构成 ===
  //
  // 综合工资是这个人一个月的总盘子。工资条上要把它拆开写, 顺序就是老板给的
  // 那张清单:
  //
  //   基本工资(定额) · 加班费 · 餐补 · 岗位补助 · 话费补助 · 交通补助 ·
  //   绩效工资 · 安全补贴 · 保密补贴 · 内宿补贴 · 全勤 · 社保补贴 · 福利
  //
  //   岗位补助 = (综合工资 − 加班费 − 餐补) × 8%
  //   绩效工资 = (综合工资 − 加班费 − 餐补) × 30%
  //   安全补贴 = 综合工资 × 8%
  //   保密补贴 = 综合工资 × 8%
  //   话费/餐补/内宿/交通 = 按综合工资落在哪一档 (500 / 800 / 1000)
  //   社保补贴 = 综合工资 × 9.6%
  //   福利     = 综合工资 − 以上所有项目      ← 兜底, 所以永远加得回综合工资
  //
  // 话费 / 交通 / 内宿 / 餐补按档自动给, 工资条上也能一人一个数地改。
  //
  // 这几个数只是**构成的拆法**, 不额外加钱 —— 实发仍然从综合工资算起, 所以
  // 拆法改了实发一分不变。
  baseSalaryCny: number // 基本工资 — 全厂一个数, 唯一的定额
  splitThresholdCny: number // 综合工资高过这个数才拆分
  postRatePct: number // 岗位补助 %（乘「综合 − 加班费 − 餐补」）
  perfRatePct: number // 绩效工资 %（同上）
  safetyRatePct: number // 安全补贴 %（乘综合工资）
  secretRatePct: number // 保密补贴 %（乘综合工资）
  // === 补助档 ===
  //
  // 话费补助 / 餐补 / 内宿补贴 / 交通补助 —— 四项一张表, 按这个人的综合工资
  // 落在哪一档给多少。够不到第一档的没有。
  //
  // 工资条上这四格照样点得动: 填了就以填的为准 (有人跑客户跑得多、有人不住
  // 厂里), 清空就回到按档给。
  tier1MinCny: number // 第一档起点, 元
  tier1Cny: number // 第一档补多少
  tier2MinCny: number
  tier2Cny: number
  tier3MinCny: number
  tier3Cny: number
  socialRatePct: number // 社保补贴 %（乘综合工资）
  fullAttendanceCny: number // 全勤, 元 — 当月无事假/病假/旷工/迟到才给
}

export const DEFAULT_PAYROLL_RULES: PayrollRules = {
  restDays: 4,
  hoursByDept: DEFAULT_HOURS_BY_DEPT,
  saturdayHours: 8,
  sickPct: 50,
  absentPct: 200,
  latePerTime: 0,
  otWeekdayCny: 22.94,
  otWeekendCny: 30.57,
  baseSalaryCny: 2660,
  splitThresholdCny: 6000,
  postRatePct: 8,
  perfRatePct: 30,
  safetyRatePct: 8,
  secretRatePct: 8,
  tier1MinCny: 8000,
  tier1Cny: 200,
  tier2MinCny: 12000,
  tier2Cny: 800,
  tier3MinCny: 16000,
  tier3Cny: 1000,
  socialRatePct: 9.6,
  fullAttendanceCny: 500,
}

// Bounds are sanity rails, not policy: they stop a slipped keystroke (a 500x
// overtime rate, a 40-day month off) from turning into a payroll run.
const RULE_LIMITS: Record<string, [number, number]> = {
  restDays: [0, 15],
  saturdayHours: [0, 16],
  sickPct: [0, 100],
  absentPct: [0, 300],
  latePerTime: [0, 1000],
  otWeekdayCny: [0, 500],
  otWeekendCny: [0, 500],
  baseSalaryCny: [0, 100000],
  splitThresholdCny: [0, 100000],
  postRatePct: [0, 100],
  perfRatePct: [0, 100],
  safetyRatePct: [0, 100],
  secretRatePct: [0, 100],
  tier1MinCny: [0, 200000],
  tier1Cny: [0, 100000],
  tier2MinCny: [0, 200000],
  tier2Cny: [0, 100000],
  tier3MinCny: [0, 200000],
  tier3Cny: [0, 100000],
  socialRatePct: [0, 100],
  fullAttendanceCny: [0, 10000],
}

export type ScalarRuleKey =
  | 'restDays'
  | 'saturdayHours'
  | 'sickPct'
  | 'absentPct'
  | 'latePerTime'
  | 'otWeekdayCny'
  | 'otWeekendCny'
  | 'baseSalaryCny'
  | 'splitThresholdCny'
  | 'postRatePct'
  | 'perfRatePct'
  | 'safetyRatePct'
  | 'secretRatePct'
  | 'tier1MinCny'
  | 'tier1Cny'
  | 'tier2MinCny'
  | 'tier2Cny'
  | 'tier3MinCny'
  | 'tier3Cny'
  | 'socialRatePct'
  | 'fullAttendanceCny'

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
  otWeekdayHours: number // 平时加班
  otWeekendHours: number // 周六周日加班
  leaveHours: number // 事假
  sickHours: number // 病假
  injuryHours: number // 工伤
  absentHours: number // 旷工
  lateTimes: number // 迟到
  disciplineTimes: number // 违纪
  qualityTimes: number // 重大质量异常
}

export const EMPTY_ATTENDANCE: Attendance = {
  otWeekdayHours: 0,
  otWeekendHours: 0,
  leaveHours: 0,
  sickHours: 0,
  injuryHours: 0,
  absentHours: 0,
  lateTimes: 0,
  disciplineTimes: 0,
  qualityTimes: 0,
}

/** 这一天是不是周六或周日 —— 加班算哪个价, 就看它。 */
export function isWeekend(ymd: string): boolean {
  const y = Number(ymd.slice(0, 4))
  const m = Number(ymd.slice(5, 7))
  const d = Number(ymd.slice(8, 10))
  if (!y || !m || !d) return false
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return w === 0 || w === 6
}

/**
 * 全勤 —— 当月一次事假、病假、旷工、迟到都没有。
 *
 * 工伤不算破全勤: 那是厂里的事, 不是这个人的。违纪和重大质量异常也不在这里
 * 判 —— 它们没有时长, 老板在奖罚那一格自己定, 不该由一条 500 元的规则替他
 * 做决定。
 */
export function isFullAttendance(a: Attendance): boolean {
  return (
    a.leaveHours === 0 &&
    a.sickHours === 0 &&
    a.absentHours === 0 &&
    a.lateTimes === 0
  )
}

// One month of 人事 lines → one summary per person. 加班 and the four absence
// kinds add their 时长; the rest count. Records filed before 时长 was required carry no
// hours and contribute none — they still show up in 人事 as an event, but
// nothing can be deducted from a length nobody wrote down.
export function summarizeAttendance(
  records: HrRecord[],
): Record<string, Attendance> {
  const out: Record<string, Attendance> = {}
  for (const r of records) {
    const a = (out[r.name] ??= { ...EMPTY_ATTENDANCE })
    const h = typeof r.hours === 'number' && r.hours > 0 ? r.hours : 0
    // 加班分两个价, 靠的是那天是星期几 —— 人事记的时候不用选, 记的是哪天
    // 就是哪天的价。
    if (r.type === '加班') {
      if (isWeekend(r.date)) a.otWeekendHours += h
      else a.otWeekdayHours += h
    }
    else if (r.type === '事假') a.leaveHours += h
    else if (r.type === '病假') a.sickHours += h
    else if (r.type === '工伤') a.injuryHours += h
    else if (r.type === '旷工') a.absentHours += h
    else if (r.type === '迟到') a.lateTimes += 1
    else if (r.type === '违纪') a.disciplineTimes += 1
    else if (r.type === '重大质量异常') a.qualityTimes += 1
  }
  return out
}

// === 每人每月手填的那一行 ===

// 工资条上要一个人一个数、系统又算不出来的格子。全部按整元存。
//
// 分两类, 因为它们在条子上的身份不一样:
//   · 工资构成里的 (话费 · 交通 · 房补 · 餐补) —— 综合工资拆开之后的一块,
//     **不额外加钱**;
//   · 应发里的 (夜班 · 节假日 · 奖金) —— 综合工资之外真发下去的钱。
export type PayrollLine = {
  adjustCny?: number // 奖罚, 正为奖 负为扣
  // —— 工资构成里手填的四项 (一人一个数) ——
  phoneAllowanceCny?: number // 话费补助
  transportAllowanceCny?: number // 交通补助
  housingCny?: number // 房补
  mealCny?: number // 餐补
  // —— 应发 (加) ——
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

/** 应发那一栏里手填的钱 —— 综合工资之外, 真加上去的。 */
export const PAYROLL_ADD_FIELDS = [
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

/**
 * 工资构成里手填的四项 —— 一人一个数, 每月能改。它们不在"应发"那两栏里,
 * 因为它们不是额外加的钱, 而是综合工资拆开之后的一块 (见 computePayslip):
 * 填多了福利那一格就少, 加起来永远还是综合工资。
 */
export const PAYROLL_ALLOWANCE_FIELDS = [
  ['phoneAllowanceCny', '话费补助'],
  ['transportAllowanceCny', '交通补助'],
  ['housingCny', '内宿补贴'],
  ['mealCny', '餐补'],
] as const

export type PayrollMoneyKey =
  | (typeof PAYROLL_ADD_FIELDS)[number][0]
  | (typeof PAYROLL_CUT_FIELDS)[number][0]
  | (typeof PAYROLL_ALLOWANCE_FIELDS)[number][0]

export const PAYROLL_MONEY_KEYS: PayrollMoneyKey[] = [
  ...PAYROLL_ADD_FIELDS.map((f) => f[0]),
  ...PAYROLL_CUT_FIELDS.map((f) => f[0]),
  ...PAYROLL_ALLOWANCE_FIELDS.map((f) => f[0]),
]

export function isPayrollMoneyKey(x: unknown): x is PayrollMoneyKey {
  return typeof x === 'string' && (PAYROLL_MONEY_KEYS as string[]).includes(x)
}

/** 一格钱: 整元, 不为负, 有上限 —— 手滑多打一个零不会变成一次发薪事故。 */
export function isValidPayrollMoney(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000
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
  monthlyCny: number // 综合工资 (名册上定的月总盘子)
  hoursPerDay: number // 本部门每天工时
  standardDays: number // 应出勤天数
  saturdays: number // 其中周六几天（一天按 saturdayHours 算）
  saturdayHours: number // 周六一天算几小时
  standardHours: number // 应出勤工时 = 平日×每天工时 + 周六×周六工时
  hourlyCny: number // 时薪 = 综合工资 ÷ 应出勤工时 — 缺勤扣按它算
  attendance: Attendance
  // === 加班 ===
  otWeekdayHours: number // 平时加班小时 —— 来自人事
  otWeekendHours: number // 周六周日加班小时 —— 来自人事
  otHours: number // 两者之和
  otWeekdayCny: number // 平时加班单价
  otWeekendCny: number // 周末加班单价
  otPay: number // 加班费 = 平时h×平时价 + 周末h×周末价
  workedHours: number // 实际工时 = 应出勤 − 缺勤 + 加班
  leaveCut: number // 事假扣
  sickCut: number // 病假扣
  absentCut: number // 旷工扣
  lateCut: number // 迟到扣
  adjustCny: number // 奖罚
  // === 工资构成 (只是把综合工资拆开写, 不额外加钱) ===
  //
  // 顺序就是工资条上那一列的顺序, 加起来正好是综合工资。
  baseSalaryCny: number // 基本工资 (定额)
  mealCny: number // 餐补 (手填)
  postSubsidyCny: number // 岗位补助 = (综合 − 加班费 − 餐补) × postRatePct
  phoneAllowanceCny: number // 话费补助 (手填)
  transportAllowanceCny: number // 交通补助 (手填)
  perfPayCny: number // 绩效工资 = (综合 − 加班费 − 餐补) × perfRatePct
  safetyFeeCny: number // 安全补贴 = 综合工资 × safetyRatePct
  secretFeeCny: number // 保密补贴 = 综合工资 × secretRatePct
  housingCny: number // 内宿补贴 — 已按实际出勤天数折算过
  housingBaseCny: number // 折算前的内宿补贴 (满勤该有的数)
  fullAttendanceCny: number // 全勤 — 无事假/病假/旷工/迟到才有
  socialSubsidyCny: number // 社保补贴 = 综合 × socialRatePct
  /** 岗位补助 / 绩效工资 / 安全费的基数: 综合工资 − 加班费 − 餐补。 */
  ratedBaseCny: number
  /**
   * 福利 = 综合工资 − 以上所有项目。
   *
   * 它是兜底的那一格: 比例是死的, 人的工资是活的, 两边不可能正好凑齐, 差的
   * 和多的都落在这里 —— 所以拆出来的几项永远加得回综合工资, 一分不差。
   * 可以是负数 (综合工资低、上面几项拆超了), 工资条上照实写, 不藏。
   */
  welfareCny: number
  /** 综合工资没过门槛就不拆 (工资条上那几行留空)。 */
  splitApplies: boolean
  /** 当月无事假/病假/旷工/迟到。 */
  fullAttendance: boolean
  // === 出勤 ===
  workedDays: number // 实际出勤天数
  /** 缺勤扣合计 = 事假 + 病假 + 旷工 + 迟到 —— 在扣款栏里, 一行, 不拆明细。 */
  attendanceCutCny: number
  /**
   * 出勤工资 —— 工资条前半段那一小计: 基本工资 + 岗位补助 + 加班费。这三项
   * 是"人到岗才有"的那部分, 所以它们合起来叫出勤工资。
   *
   * 综合工资没过拆分门槛的人不拆构成, 这一格就退回老口径 (综合工资 + 加班
   * 费) —— 条子上只有这一行, 后面那一串是空的。
   */
  attendancePayCny: number
  // === 后半段里手填的几项 (综合工资之外, 真加上去的钱) ===
  nightShiftCny: number
  holidayCny: number
  bonusCny: number
  advanceCny: number
  otherDeductCny: number
  perfDeductCny: number
  safetyDeductCny: number
  socialInsuranceCny: number
  taxCny: number
  /** 应发工资 = 出勤工资 + 后面所有子项目 */
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

/** 当月日历上有几个周六 —— 周六是半天班, 工时另算。 */
export function saturdaysInMonth(month: string): number {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  let n = 0
  for (let d = 1; d <= daysInMonth(month); d++) {
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 6) n++
  }
  return n
}

/**
 * 当月该上多少小时 —— 加班费和每一笔缺勤扣都是从它算出来的。
 *
 *   应出勤天数 = 当月天数 − 月休
 *   其中周六按 rules.saturdayHours 算 (半天班), 其余按本部门每天工时
 *
 * 月休默认 4 天, 正好是四个周日; 遇到有五个周日的月份, 周六天数会被应出勤天
 * 数夹住, 不会算出比上班天数还多的周六。
 */
export function standardHoursOf(
  month: string,
  rules: PayrollRules,
  hoursPerDay: number,
): { standardDays: number; saturdays: number; standardHours: number } {
  const standardDays = standardDaysOf(month, rules)
  const saturdays = Math.min(saturdaysInMonth(month), standardDays)
  const standardHours =
    (standardDays - saturdays) * hoursPerDay + saturdays * rules.saturdayHours
  return { standardDays, saturdays, standardHours: Math.max(1, standardHours) }
}

/**
 * 话费补助 / 餐补 / 内宿补贴 / 交通补助 —— 按这个人的综合工资落在哪一档给。
 * 够不到第一档的没有。四项一张表, 数字是老板定的 (200 / 800 / 1000)。
 */
export function tierAllowanceCny(
  monthlyCny: number,
  rules: PayrollRules,
): number {
  if (monthlyCny >= rules.tier3MinCny) return Math.round(rules.tier3Cny)
  if (monthlyCny >= rules.tier2MinCny) return Math.round(rules.tier2Cny)
  if (monthlyCny >= rules.tier1MinCny) return Math.round(rules.tier1Cny)
  return 0
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
  const hoursPerDay = hoursForDept(rules, dept)
  const { standardDays, saturdays, standardHours } = standardHoursOf(
    month,
    rules,
    hoursPerDay,
  )
  const hourlyCny = monthlyCny / standardHours
  const adjustCny = Math.round(line.adjustCny ?? 0)

  // 缺勤扣还是按这个人自己的时薪 (综合工资 ÷ 应出勤工时) —— 少上一个小时,
  // 扣的就是那一个小时。
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

  // 加班费 —— 厂里定死的小时价, 跟月薪无关。周六周日一个价, 平时一个价; 是
  // 哪种由 人事 那条记录的日期决定 (见 summarizeAttendance)。
  const otWeekdayHours = attendance.otWeekdayHours
  const otWeekendHours = attendance.otWeekendHours
  const otHours = otWeekdayHours + otWeekendHours
  const otPay = Math.round(
    otWeekdayHours * rules.otWeekdayCny + otWeekendHours * rules.otWeekendCny,
  )

  const workedHours =
    standardHours -
    attendance.leaveHours -
    attendance.sickHours -
    attendance.injuryHours -
    attendance.absentHours +
    otHours

  const attendanceCutCny = leaveCut + sickCut + absentCut + lateCut

  // 实际出勤天数 —— 应出勤天数减掉缺勤折成的天 (半天假是常事, 留一位小数)。
  // 加班不算进出勤天数, 它自己有一行。住房补贴按它折算, 所以要先算出来。
  const workedDays =
    Math.round(
      Math.max(
        0,
        standardDays -
          (attendance.leaveHours +
            attendance.sickHours +
            attendance.injuryHours +
            attendance.absentHours) /
            (hoursPerDay || 1),
      ) * 10,
    ) / 10

  // === 工资条的两段 ===
  //
  // 前半段「出勤工资」= 基本工资 + 岗位补助 + 加班费 − 缺勤扣, 后半段是餐补
  // 起到福利、奖金为止的一串子项目; 两段加起来就是应发工资。
  //
  // 福利是倒挤出来的 (综合工资 − 前面所有项), 所以只要人到齐、没有额外的奖
  // 金, 应发工资正好等于综合工资 —— 条子上加得起来, 这是它能拿去对账的前提。
  const splitApplies = monthlyCny > rules.splitThresholdCny
  const on = (v: number) => (splitApplies ? Math.round(v) : 0)

  const money = (v: number | undefined) => Math.round(v ?? 0)

  // 基本工资是定额; 餐补、话费、交通、内宿按综合工资的档位自动给 —— 手填过
  // 的那个数优先 (有人不住厂里、有人跑客户跑得多), 清空就回到按档。
  const baseSalaryCny = on(rules.baseSalaryCny)
  const tier = tierAllowanceCny(monthlyCny, rules)
  const tiered = (v: number | undefined) => on(v ?? tier)
  const mealCny = tiered(line.mealCny)
  const phoneAllowanceCny = tiered(line.phoneAllowanceCny)
  const transportAllowanceCny = tiered(line.transportAllowanceCny)
  // 内宿补贴按天 —— 床位是住一天算一天的, 所以档位给的是满勤的数, 实发按
  // 「住房补贴 ÷ 应出勤天数 × 实际出勤天数」折。别的三项不折。
  const housingBaseCny = tiered(line.housingCny)
  const housingCny = splitApplies
    ? Math.round(housingBaseCny * (workedDays / (standardDays || 1)))
    : 0

  // 岗位补助 / 绩效工资 / 安全费的基数: 综合工资先减掉加班费和餐补 —— 那两
  // 笔是专款, 不该再被摊进比例里。
  const ratedBaseCny = splitApplies ? monthlyCny - otPay - mealCny : 0
  const postSubsidyCny = on(ratedBaseCny * (rules.postRatePct / 100))
  const perfPayCny = on(ratedBaseCny * (rules.perfRatePct / 100))
  // 安全补贴和保密补贴乘的是综合工资本身, 不是那个减过加班费的基数。
  const safetyFeeCny = on(monthlyCny * (rules.safetyRatePct / 100))
  const secretFeeCny = on(monthlyCny * (rules.secretRatePct / 100))

  // 全勤 —— 当月一次事假、病假、旷工、迟到都没有才有。工伤不算破全勤。
  const fullAttendance = isFullAttendance(attendance)
  const fullAttendanceCny =
    splitApplies && fullAttendance ? Math.round(rules.fullAttendanceCny) : 0

  const socialSubsidyCny = on(monthlyCny * (rules.socialRatePct / 100))

  // 前半段「出勤工资」= 基本工资 + 岗位补助 + 加班费 —— 人到岗才有的那几
  // 项。缺勤扣不在这里减: 它是扣款栏里的一行 (见下), 这样老板那句
  // 「福利 = 综合工资 − 出勤工资 − …」在条子上按下去正好对得上。
  const attendancePayCny = splitApplies
    ? baseSalaryCny + postSubsidyCny + otPay
    : monthlyCny + otPay

  // 福利 = 综合工资 − 出勤工资 − 后面这一串。兜底的那一格, 所以工资条上各
  // 项加起来永远等于综合工资, 一分不差。
  const welfareCny = splitApplies
    ? monthlyCny -
      attendancePayCny -
      phoneAllowanceCny -
      mealCny -
      housingCny -
      fullAttendanceCny -
      transportAllowanceCny -
      safetyFeeCny -
      secretFeeCny -
      perfPayCny -
      socialSubsidyCny
    : 0

  const nightShiftCny = money(line.nightShiftCny)
  const holidayCny = money(line.holidayCny)
  const bonusCny = money(line.bonusCny)
  const advanceCny = money(line.advanceCny)
  const otherDeductCny = money(line.otherDeductCny)
  const perfDeductCny = money(line.perfDeductCny)
  const safetyDeductCny = money(line.safetyDeductCny)
  const socialInsuranceCny = money(line.socialInsuranceCny)
  const taxCny = money(line.taxCny)

  // 应发工资 = 前半段 + 后半段所有子项目。
  const grossCny =
    attendancePayCny +
    mealCny +
    phoneAllowanceCny +
    transportAllowanceCny +
    perfPayCny +
    safetyFeeCny +
    secretFeeCny +
    housingCny +
    fullAttendanceCny +
    socialSubsidyCny +
    welfareCny +
    nightShiftCny +
    holidayCny +
    bonusCny +
    adjustCny
  // 缺勤扣进扣款栏 —— 一行合计, 不列事假/病假/旷工/迟到的明细 (条子上那四
  // 行只会换来当场对着条子争"那天不算旷工")。
  const deductCny =
    attendanceCutCny +
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
    saturdays,
    saturdayHours: rules.saturdayHours,
    standardHours,
    hourlyCny,
    attendance,
    otWeekdayHours,
    otWeekendHours,
    otHours,
    otWeekdayCny: rules.otWeekdayCny,
    otWeekendCny: rules.otWeekendCny,
    otPay,
    workedHours: Math.max(0, Math.round(workedHours * 10) / 10),
    workedDays,
    leaveCut,
    sickCut,
    absentCut,
    lateCut,
    adjustCny,
    baseSalaryCny,
    mealCny,
    postSubsidyCny,
    phoneAllowanceCny,
    transportAllowanceCny,
    perfPayCny,
    safetyFeeCny,
    secretFeeCny,
    housingCny,
    housingBaseCny,
    fullAttendanceCny,
    socialSubsidyCny,
    ratedBaseCny,
    welfareCny,
    splitApplies,
    fullAttendance,
    attendanceCutCny,
    attendancePayCny,
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
  '加班费',
  '餐补',
  '岗位补助',
  '话费补助',
  '交通补助',
  '绩效工资',
  '安全补贴',
  '保密补贴',
  '内宿补贴',
  '全勤',
  '社保补贴',
  '福利',
  '应出勤天',
  '实际出勤天',
  '每天工时',
  '周六天',
  '应出勤工时',
  '时薪',
  '事假h',
  '病假h',
  '工伤h',
  '旷工h',
  '迟到次',
  '平时加班h',
  '周末加班h',
  '实际工时',
  '事假扣',
  '病假扣',
  '旷工扣',
  '迟到扣',
  '出勤工资',
  '缺勤扣',
  '夜班补贴',
  '节假日补贴',
  '奖金',
  '奖罚',
  '应发工资',
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
    const split = (v: number) => (p.splitApplies ? v : '')
    aoa.push([
      p.name,
      p.dept,
      p.monthlyCny,
      split(p.baseSalaryCny),
      p.otPay,
      split(p.mealCny),
      split(p.postSubsidyCny),
      split(p.phoneAllowanceCny),
      split(p.transportAllowanceCny),
      split(p.perfPayCny),
      split(p.safetyFeeCny),
      split(p.secretFeeCny),
      split(p.housingCny),
      split(p.fullAttendanceCny),
      split(p.socialSubsidyCny),
      split(p.welfareCny),
      p.standardDays,
      p.workedDays,
      p.hoursPerDay,
      p.saturdays,
      p.standardHours,
      Math.round(p.hourlyCny * 100) / 100,
      p.attendance.leaveHours,
      p.attendance.sickHours,
      p.attendance.injuryHours,
      p.attendance.absentHours,
      p.attendance.lateTimes,
      p.otWeekdayHours,
      p.otWeekendHours,
      p.workedHours,
      p.leaveCut,
      p.sickCut,
      p.absentCut,
      p.lateCut,
      p.attendancePayCny,
      p.attendanceCutCny,
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
