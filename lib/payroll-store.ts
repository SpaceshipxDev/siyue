import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { hrDeptOf } from './auth'
import { getActiveUsers } from './db'
import { getHrMonth, getHrRoster } from './hr'
import {
  buildPayslips,
  normalizeRules,
  summarizeAttendance,
  isValidAdjust,
  isValidDeptHours,
  isValidMonthlyCny,
  DEFAULT_PAYROLL_RULES,
  FALLBACK_HOURS,
  NO_DEPARTMENT,
  isValidPayrollMoney,
  PAYROLL_MONEY_KEYS,
  type PayrollLine,
  type PayrollPerson,
  type PayrollRules,
  type Payslip,
  type SalaryChange,
  type ScalarRuleKey,
} from './payroll'

/*
 * 工资 — the 月薪 roster, the 制度, and one sheet per month.
 *
 * Deliberately TABLE-FREE, the same choice as 人事 (lib/hr.ts), 合同, 凭证 and
 * 请购图片 — there is NO migration to apply by hand and nothing to break on a
 * stale DB. Payroll is one small object per month for one shop; a JSON file
 * per month IS the query.
 *
 *   payroll/rules.json     the 制度 — 月休天数 / 各部门每天工时 / 扣薪比例 /
 *                          加班倍率
 *   payroll/base.json      { 姓名: {月薪, 部门} } — the standing roster
 *   payroll/changes.json   调薪记录 — every move of a 月薪, filed by the edit
 *                          that made it
 *   payroll/<YYYY-MM>.json { lines: { 姓名: {加班,奖罚,备注} }, paid? }
 *
 * 发放 freezes the run: the 工资条 as computed at that moment, plus the ids of
 * the 支出台账 rows it created. A later change to somebody's 月薪 or to the
 * 制度 must not rewrite a month that was already paid out — what was handed
 * over in cash is history, not a formula. 撤销发放 deletes exactly the rows it
 * created and nothing else.
 *
 * Writes go through a process-local chain (withPayrollLock), same guarantee
 * lib/hr.ts gives its shards; production is one pm2 process.
 */

let payrollChain: Promise<unknown> = Promise.resolve()
function withPayrollLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = payrollChain.then(fn, fn)
  payrollChain = next.catch(() => undefined)
  return next
}

const RULES_KEY = 'payroll/rules.json'
const BASE_KEY = 'payroll/base.json'
const CHANGES_KEY = 'payroll/changes.json'

function monthKey(month: string): string {
  return `payroll/${month.replace(/[^0-9-]/g, '')}.json`
}

async function readJson(key: string): Promise<unknown> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(key)
  if (error || !data) return null
  try {
    return JSON.parse(await data.text())
  } catch {
    return null
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, Buffer.from(JSON.stringify(value), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

// === 制度 ===

export async function getPayrollRules(): Promise<PayrollRules> {
  return normalizeRules(await readJson(RULES_KEY))
}

export async function setPayrollRule(
  key: ScalarRuleKey,
  value: number,
): Promise<void> {
  await withPayrollLock(async () => {
    const rules = normalizeRules(await readJson(RULES_KEY))
    rules[key] = value
    await writeJson(RULES_KEY, rules)
  })
}

// 一个部门一天算几个小时 — 商务 10, 车间 11, 操机 12, 人事/采购 8.
export async function setPayrollDeptHours(
  dept: string,
  hours: number,
): Promise<void> {
  await withPayrollLock(async () => {
    const rules = normalizeRules(await readJson(RULES_KEY))
    rules.hoursByDept = { ...rules.hoursByDept, [dept]: hours }
    await writeJson(RULES_KEY, rules)
  })
}

// === 月薪名册 ===

// Rows written before 部门 was part of pay carry a bare 月薪 number. They read
// as 未分部门 — visible on the sheet, priced at the shop's commonest day, and
// one click from being put right.
function normalizeBase(raw: unknown): Record<string, PayrollPerson> {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >
  const out: Record<string, PayrollPerson> = {}
  for (const [name, v] of Object.entries(o)) {
    if (!name.trim()) continue
    if (isValidMonthlyCny(v) && v > 0) {
      out[name] = { monthlyCny: v, dept: NO_DEPARTMENT }
      continue
    }
    if (typeof v !== 'object' || v === null) continue
    const p = v as Record<string, unknown>
    if (!isValidMonthlyCny(p.monthlyCny) || p.monthlyCny <= 0) continue
    out[name] = {
      monthlyCny: p.monthlyCny,
      dept:
        typeof p.dept === 'string' && p.dept.trim() ? p.dept : NO_DEPARTMENT,
    }
  }
  return out
}

export async function getPayrollBase(): Promise<Record<string, PayrollPerson>> {
  return normalizeBase(await readJson(BASE_KEY))
}

// 0 (or a cleared field) takes the person OFF payroll — one number is the whole
// employee lifecycle here, and a name with no 月薪 simply isn't paid. 部门 comes
// along because it's what prices the hours; an existing person keeps theirs.
//
// A real change to somebody's 月薪 files a 调薪记录 in the same write: the
// change and its record can't come apart, because they're one operation.
export async function setPayrollBase(
  name: string,
  monthlyCny: number,
  dept: string,
  by: string,
  date: string,
): Promise<void> {
  await withPayrollLock(async () => {
    const base = normalizeBase(await readJson(BASE_KEY))
    const before = base[name]
    if (monthlyCny > 0) {
      // An existing 部门 wins, except when it's the placeholder — then the
      // caller's guess is better than nothing and gets written down for good.
      const had = before?.dept
      base[name] = {
        monthlyCny,
        dept: had && had !== NO_DEPARTMENT ? had : dept,
      }
    } else delete base[name]
    await writeJson(BASE_KEY, base)

    // 建档 (from nothing to a first 月薪) is not an adjustment; a real move
    // between two amounts is, and so is being taken off payroll.
    const from = before?.monthlyCny ?? 0
    if (from === monthlyCny) return
    if (from === 0) return
    await appendChange({
      id: crypto.randomUUID(),
      name,
      dept: base[name]?.dept ?? before?.dept ?? dept,
      fromCny: from,
      toCny: monthlyCny,
      date,
      by,
      createdAt: new Date().toISOString(),
    })
  })
}

/**
 * 改名 —— 名字打错了、或者厂里换了叫法。
 *
 * 只动名册和**还没发放**的那些月份的行: 已经发过的工资条是发钱的凭据, 上面
 * 的名字不该在事后被人改掉。所以旧名字在历史条子上保持原样, 新名字从这个月
 * 往后生效。调薪记录同理跟着改 —— 它是名册的影子, 名字对不上就查不出人。
 */
export async function renamePayrollPerson(
  from: string,
  to: string,
): Promise<{ moved: number }> {
  const a = from.trim()
  const b = to.trim()
  if (!a || !b || a === b) return { moved: 0 }
  return withPayrollLock(async () => {
    const base = normalizeBase(await readJson(BASE_KEY))
    if (!base[a]) throw new Error(`名册里没有「${a}」`)
    if (base[b]) throw new Error(`「${b}」已经在名册里了`)
    base[b] = base[a]
    delete base[a]
    await writeJson(BASE_KEY, base)

    // 调薪记录跟着走。
    const changes = normalizeChanges(await readJson(CHANGES_KEY))
    let touched = false
    for (const c of changes) {
      if (c.name === a) {
        c.name = b
        touched = true
      }
    }
    if (touched) await writeJson(CHANGES_KEY, changes)

    // 未发放月份里那一行手填的数跟着搬 —— 已发放的一律不动。
    let moved = 0
    for (const m of await getPayrollMonths()) {
      const sheet = normalizeSheet(await readJson(monthKey(m)))
      if (sheet.paid) continue
      const line = sheet.lines[a]
      if (!line) continue
      delete sheet.lines[a]
      sheet.lines[b] = line
      await writeJson(monthKey(m), sheet)
      moved++
    }
    return { moved }
  })
}

// === 调薪记录 ===
//
// Append-only-ish: rows are born from 工资表 edits (see setPayrollBase), never
// typed. What CAN be edited afterwards is the 原因 — the reason is what a
// record is for, and asking for it mid-edit would turn one keystroke into a
// dialog. A row filed by a slipped keystroke can be deleted; only the three
// people who can see payroll at all ever reach this list.

function normalizeChanges(raw: unknown): SalaryChange[] {
  if (!Array.isArray(raw)) return []
  const out: SalaryChange[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const c = v as Record<string, unknown>
    if (typeof c.id !== 'string' || typeof c.name !== 'string') continue
    if (!isValidMonthlyCny(c.fromCny) || !isValidMonthlyCny(c.toCny)) continue
    out.push({
      id: c.id,
      name: c.name,
      dept: typeof c.dept === 'string' && c.dept ? c.dept : NO_DEPARTMENT,
      fromCny: c.fromCny,
      toCny: c.toCny,
      date: typeof c.date === 'string' ? c.date : '',
      by: typeof c.by === 'string' ? c.by : '',
      reason:
        typeof c.reason === 'string' && c.reason.trim() ? c.reason : undefined,
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : '',
    })
  }
  return out
}

// Newest first — a 调薪 list reads like a diary. Lock-free: it's a read.
export async function getSalaryChanges(): Promise<SalaryChange[]> {
  return normalizeChanges(await readJson(CHANGES_KEY)).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.createdAt < b.createdAt ? 1 : -1
  })
}

// Runs INSIDE the caller's lock — never takes one of its own, or the chain
// would wait on itself.
async function appendChange(c: SalaryChange): Promise<void> {
  const rows = normalizeChanges(await readJson(CHANGES_KEY))
  rows.push(c)
  await writeJson(CHANGES_KEY, rows)
}

// 在调薪栏直接填一笔 — 选人, 原月薪, 调后多少, 为什么.
//
// It is the SAME act as editing the 月薪 on the 工资表, just entered from the
// other end and with the reason in hand: the 名册 moves to 调后月薪 and the
// record is filed, in one locked write, so the two can never disagree. 原月薪
// is what the typist saw (prefilled from the 名册, editable so an old raise
// can be entered after the fact) — only 调后 decides what the person is paid.
export async function recordSalaryChange(
  input: {
    name: string
    fromCny: number
    toCny: number
    date: string
    reason?: string
  },
  by: string,
  fallbackDept: string,
): Promise<void> {
  await withPayrollLock(async () => {
    const base = normalizeBase(await readJson(BASE_KEY))
    const had = base[input.name]
    const dept =
      had?.dept && had.dept !== NO_DEPARTMENT ? had.dept : fallbackDept
    if (input.toCny > 0) base[input.name] = { monthlyCny: input.toCny, dept }
    else delete base[input.name]
    await writeJson(BASE_KEY, base)
    await appendChange({
      id: crypto.randomUUID(),
      name: input.name,
      dept,
      fromCny: input.fromCny,
      toCny: input.toCny,
      date: input.date,
      by,
      reason: input.reason?.trim() || undefined,
      createdAt: new Date().toISOString(),
    })
  })
}

// 谁可以被调薪, 和他现在的月薪 — the picker's options plus the 原月薪 it
// prefills. Everybody the shop knows about: the 工资名册 first, then system
// accounts and every name 人事 was told to remember (half the floor has no
// login), so a raise can be filed for somebody before payroll ever has been.
export async function getSalaryPeople(): Promise<
  { name: string; monthlyCny: number }[]
> {
  const [base, users, extraNames] = await Promise.all([
    getPayrollBase(),
    getActiveUsers(),
    getHrRoster(),
  ])
  return [
    ...new Set([
      ...Object.keys(base),
      ...users.map((u) => u.name),
      ...extraNames,
    ]),
  ]
    .sort((a, b) => a.localeCompare(b, 'zh'))
    .map((name) => ({ name, monthlyCny: base[name]?.monthlyCny ?? 0 }))
}

export async function setSalaryChangeReason(
  id: string,
  reason: string,
): Promise<void> {
  await withPayrollLock(async () => {
    const rows = normalizeChanges(await readJson(CHANGES_KEY))
    const row = rows.find((r) => r.id === id)
    if (!row) return
    row.reason = reason.trim() || undefined
    await writeJson(CHANGES_KEY, rows)
  })
}

export async function deleteSalaryChange(id: string): Promise<void> {
  await withPayrollLock(async () => {
    const rows = normalizeChanges(await readJson(CHANGES_KEY))
    if (!rows.some((r) => r.id === id)) return
    await writeJson(
      CHANGES_KEY,
      rows.filter((r) => r.id !== id),
    )
  })
}

// 换部门 — the person's day gets longer or shorter, so every number on their
// row re-derives. Only meaningful for somebody already on payroll.
export async function setPayrollDept(
  name: string,
  dept: string,
): Promise<void> {
  await withPayrollLock(async () => {
    const base = normalizeBase(await readJson(BASE_KEY))
    const row = base[name]
    if (!row) return
    base[name] = { ...row, dept }
    await writeJson(BASE_KEY, base)
  })
}

// === 月度工资表 ===

export type PayrollPaid = {
  at: string // ISO
  by: string
  total: number
  expenseIds: string[]
  slips: Payslip[]
}

export type PayrollSheet = {
  lines: Record<string, PayrollLine>
  paid?: PayrollPaid
}

function normalizeSheet(raw: unknown): PayrollSheet {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >
  const rawLines = (
    typeof o.lines === 'object' && o.lines !== null ? o.lines : {}
  ) as Record<string, unknown>
  const lines: Record<string, PayrollLine> = {}
  for (const [name, v] of Object.entries(rawLines)) {
    if (typeof v !== 'object' || v === null) continue
    const l = v as Record<string, unknown>
    const line: PayrollLine = {}
    if (isValidAdjust(l.adjustCny)) line.adjustCny = l.adjustCny
    // 工资条上手填的那十二格 —— 一份清单管住存和取, 加一项只改 lib/payroll。
    for (const k of PAYROLL_MONEY_KEYS) {
      if (isValidPayrollMoney(l[k])) line[k] = l[k] as number
    }
    if (typeof l.note === 'string' && l.note.trim()) line.note = l.note
    lines[name] = line
  }
  if (typeof o.paid !== 'object' || o.paid === null) return { lines }
  // 工资条 frozen before 部门 was part of pay carry neither — they read as
  // 未分部门 at the shop's commonest day, which is what they were paid at.
  // 同样地, 发放于"周六半天"和"加班读自人事"之前的条子上没有这几格: 它们读
  // 成 0 / 1 倍, 因为那个月本来就是那么发的 —— 已发放的工资条是凭据, 不能被
  // 后来改的算法追认。
  const p = o.paid as PayrollPaid
  const paid: PayrollPaid = {
    ...p,
    slips: (Array.isArray(p.slips) ? p.slips : []).map((s) => ({
      ...s,
      dept: s.dept || NO_DEPARTMENT,
      hoursPerDay: isValidDeptHours(s.hoursPerDay)
        ? s.hoursPerDay
        : FALLBACK_HOURS,
      saturdays: typeof s.saturdays === 'number' ? s.saturdays : 0,
      saturdayHours:
        typeof s.saturdayHours === 'number'
          ? s.saturdayHours
          : DEFAULT_PAYROLL_RULES.saturdayHours,
      otWeekdayHours:
        typeof s.otWeekdayHours === 'number' ? s.otWeekdayHours : 0,
      otWeekendHours:
        typeof s.otWeekendHours === 'number' ? s.otWeekendHours : 0,
      otWeekdayCny:
        typeof s.otWeekdayCny === 'number'
          ? s.otWeekdayCny
          : DEFAULT_PAYROLL_RULES.otWeekdayCny,
      otWeekendCny:
        typeof s.otWeekendCny === 'number'
          ? s.otWeekendCny
          : DEFAULT_PAYROLL_RULES.otWeekendCny,
      // 发放在这套工资构成之前的条子上没有这几格 —— 读成 0, 那个月本来就是
      // 那么发的。已发放的工资条是凭据, 不能被后来改的拆法追认。
      fullAttendanceCny:
        typeof s.fullAttendanceCny === 'number' ? s.fullAttendanceCny : 0,
      fullAttendance: s.fullAttendance === true,
      ratedBaseCny: typeof s.ratedBaseCny === 'number' ? s.ratedBaseCny : 0,
      welfareCny: typeof s.welfareCny === 'number' ? s.welfareCny : 0,
      mealCny: typeof s.mealCny === 'number' ? s.mealCny : 0,
      housingCny: typeof s.housingCny === 'number' ? s.housingCny : 0,
      housingBaseCny:
        typeof s.housingBaseCny === 'number' ? s.housingBaseCny : 0,
      phoneAllowanceCny:
        typeof s.phoneAllowanceCny === 'number' ? s.phoneAllowanceCny : 0,
      transportAllowanceCny:
        typeof s.transportAllowanceCny === 'number'
          ? s.transportAllowanceCny
          : 0,
      socialSubsidyCny:
        typeof s.socialSubsidyCny === 'number' ? s.socialSubsidyCny : 0,
      postSubsidyCny:
        typeof s.postSubsidyCny === 'number' ? s.postSubsidyCny : 0,
      perfPayCny: typeof s.perfPayCny === 'number' ? s.perfPayCny : 0,
      safetyFeeCny: typeof s.safetyFeeCny === 'number' ? s.safetyFeeCny : 0,
      secretFeeCny: typeof s.secretFeeCny === 'number' ? s.secretFeeCny : 0,
      attendanceCutCny:
        typeof s.attendanceCutCny === 'number' ? s.attendanceCutCny : 0,
      baseSalaryCny:
        typeof s.baseSalaryCny === 'number' ? s.baseSalaryCny : 0,
    })),
  }
  return { lines, paid }
}

export async function getPayrollSheet(month: string): Promise<PayrollSheet> {
  return normalizeSheet(await readJson(monthKey(month)))
}

// 加班 / 奖罚 / 备注 for one person in one month. Refuses to touch a month that
// has already been paid — the sheet under a 发放 is a receipt.
export async function setPayrollLine(
  month: string,
  name: string,
  patch: PayrollLine,
): Promise<void> {
  await withPayrollLock(async () => {
    const sheet = normalizeSheet(await readJson(monthKey(month)))
    if (sheet.paid) throw new Error('这个月已发放，先撤销再改')
    const line = { ...(sheet.lines[name] ?? {}) }
    if (patch.adjustCny !== undefined) {
      if (patch.adjustCny !== 0) line.adjustCny = patch.adjustCny
      else delete line.adjustCny
    }
    // 手填的钱格子: 0 就是清空 (格子留白), 其余照存。
    for (const k of PAYROLL_MONEY_KEYS) {
      const v = patch[k]
      if (v === undefined) continue
      if (v > 0) line[k] = v
      else delete line[k]
    }
    if (patch.note !== undefined) {
      if (patch.note.trim()) line.note = patch.note.trim()
      else delete line.note
    }
    if (Object.keys(line).length === 0) delete sheet.lines[name]
    else sheet.lines[name] = line
    await writeJson(monthKey(month), sheet)
  })
}

// Freeze the run. Returns false if somebody already paid this month out (a
// double-tap, a second tab) — the caller must then NOT have created rows.
export async function markPayrollPaid(
  month: string,
  paid: PayrollPaid,
): Promise<boolean> {
  return withPayrollLock(async () => {
    const sheet = normalizeSheet(await readJson(monthKey(month)))
    if (sheet.paid) return false
    sheet.paid = paid
    await writeJson(monthKey(month), sheet)
    return true
  })
}

// Undo the freeze, handing back the 支出 rows it created so the caller can
// delete exactly those.
export async function clearPayrollPaid(month: string): Promise<string[]> {
  return withPayrollLock(async () => {
    const sheet = normalizeSheet(await readJson(monthKey(month)))
    const ids = sheet.paid?.expenseIds ?? []
    if (!sheet.paid) return ids
    delete sheet.paid
    await writeJson(monthKey(month), sheet)
    return ids
  })
}

// === 一个月的完整读法 ===
//
// One place computes a month's payroll — the 工资 page and the 工资表导出 both
// call this, so an exported sheet can never say something different from the
// screen it was exported from.
//
// 部门 is guessed for anybody the 名册 hasn't been told about: an account's own
// 工段 (商务 for the office), else the 部门 stamped on their 人事 lines. The
// guess is only ever a starting value — the moment somebody picks a 部门 on the
// row it's written into the 名册 and stops being guessed.
export type PayrollView = {
  rules: PayrollRules
  slips: Payslip[]
  /** 名册里还没定月薪的人, 带上猜出来的部门。 */
  offRoster: { name: string; dept: string }[]
  paid: PayrollPaid | null
}

export async function loadPayroll(month: string): Promise<PayrollView> {
  const [rules, base, sheet, hrRecords, users, extraNames] = await Promise.all([
    getPayrollRules(),
    getPayrollBase(),
    getPayrollSheet(month),
    getHrMonth(month),
    getActiveUsers(),
    getHrRoster(),
  ])

  const guessDept = (name: string): string => {
    const account = users.find((u) => u.name === name)
    if (account) return hrDeptOf(account)
    return (
      hrRecords.find((r) => r.name === name && r.dept)?.dept ?? NO_DEPARTMENT
    )
  }

  const resolved: Record<string, PayrollPerson> = {}
  for (const [name, p] of Object.entries(base)) {
    resolved[name] = p.dept === NO_DEPARTMENT ? { ...p, dept: guessDept(name) } : p
  }

  // A paid-out month renders what was handed over, not a fresh computation.
  const slips = sheet.paid
    ? sheet.paid.slips
    : buildPayslips(resolved, summarizeAttendance(hrRecords), sheet.lines, rules, month)

  const onPayroll = new Set(slips.map((s) => s.name))
  const offRoster = [...new Set([...users.map((u) => u.name), ...extraNames])]
    .filter((n) => !onPayroll.has(n))
    .sort((a, b) => a.localeCompare(b, 'zh'))
    .map((name) => ({ name, dept: guessDept(name) }))

  return { rules, slips, offRoster, paid: sheet.paid ?? null }
}

// Which months have a sheet — drives the period picker, same idea as
// getHrMonths(). Derived from the bucket listing, not a scan.
export async function getPayrollMonths(): Promise<string[]> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .list('payroll', { limit: 1000 })
  if (error || !data) return []
  return data
    .map((o) => o.name.replace(/\.json$/i, ''))
    .filter((m) => /^\d{4}-\d{2}$/.test(m))
    .sort()
    .reverse()
}
