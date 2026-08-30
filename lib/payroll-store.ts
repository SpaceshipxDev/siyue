import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import {
  normalizeRules,
  isValidAdjust,
  isValidMonthlyCny,
  isValidOtHours,
  type PayrollLine,
  type PayrollRules,
  type Payslip,
} from './payroll'

/*
 * 工资 — the 月薪 roster, the 制度, and one sheet per month.
 *
 * Deliberately TABLE-FREE, the same choice as 人事 (lib/hr.ts), 合同, 凭证 and
 * 请购图片 — there is NO migration to apply by hand and nothing to break on a
 * stale DB. Payroll is one small object per month for one shop; a JSON file
 * per month IS the query.
 *
 *   payroll/rules.json     the 制度 — 月休天数 / 每天工时 / 扣薪比例 / 加班倍率
 *   payroll/base.json      { 姓名: 月薪 } — the standing roster
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
  key: keyof PayrollRules,
  value: number,
): Promise<void> {
  await withPayrollLock(async () => {
    const rules = normalizeRules(await readJson(RULES_KEY))
    rules[key] = value
    await writeJson(RULES_KEY, rules)
  })
}

// === 月薪名册 ===

function normalizeBase(raw: unknown): Record<string, number> {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >
  const out: Record<string, number> = {}
  for (const [name, v] of Object.entries(o)) {
    if (name.trim() && isValidMonthlyCny(v) && v > 0) out[name] = v
  }
  return out
}

export async function getPayrollBase(): Promise<Record<string, number>> {
  return normalizeBase(await readJson(BASE_KEY))
}

// 0 (or a cleared field) takes the person OFF payroll — one number is the whole
// employee lifecycle here, and a name with no 月薪 simply isn't paid.
export async function setPayrollBase(
  name: string,
  monthlyCny: number,
): Promise<void> {
  await withPayrollLock(async () => {
    const base = normalizeBase(await readJson(BASE_KEY))
    if (monthlyCny > 0) base[name] = monthlyCny
    else delete base[name]
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
  const paid =
    typeof o.paid === 'object' && o.paid !== null
      ? (o.paid as PayrollPaid)
      : undefined
  return paid ? { lines, paid } : { lines }
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
