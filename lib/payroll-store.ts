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
  isValidOtHours,
  FALLBACK_HOURS,
  NO_DEPARTMENT,
  type PayrollLine,
  type PayrollPerson,
  type PayrollRules,
  type Payslip,
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
export async function setPayrollBase(
  name: string,
  monthlyCny: number,
  dept: string,
): Promise<void> {
  await withPayrollLock(async () => {
    const base = normalizeBase(await readJson(BASE_KEY))
    if (monthlyCny > 0) {
      // An existing 部门 wins, except when it's the placeholder — then the
      // caller's guess is better than nothing and gets written down for good.
      const had = base[name]?.dept
      base[name] = {
        monthlyCny,
        dept: had && had !== NO_DEPARTMENT ? had : dept,
      }
    } else delete base[name]
    await writeJson(BASE_KEY, base)
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
    if (isValidOtHours(l.otHours)) line.otHours = l.otHours
    if (isValidAdjust(l.adjustCny)) line.adjustCny = l.adjustCny
    if (typeof l.note === 'string' && l.note.trim()) line.note = l.note
    lines[name] = line
  }
  if (typeof o.paid !== 'object' || o.paid === null) return { lines }
  // 工资条 frozen before 部门 was part of pay carry neither — they read as
  // 未分部门 at the shop's commonest day, which is what they were paid at.
  const p = o.paid as PayrollPaid
  const paid: PayrollPaid = {
    ...p,
    slips: (Array.isArray(p.slips) ? p.slips : []).map((s) => ({
      ...s,
      dept: s.dept || NO_DEPARTMENT,
      hoursPerDay: isValidDeptHours(s.hoursPerDay)
        ? s.hoursPerDay
        : FALLBACK_HOURS,
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
    if (patch.otHours !== undefined) {
      if (patch.otHours > 0) line.otHours = patch.otHours
      else delete line.otHours
    }
    if (patch.adjustCny !== undefined) {
      if (patch.adjustCny !== 0) line.adjustCny = patch.adjustCny
      else delete line.adjustCny
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
