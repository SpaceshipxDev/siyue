import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl, storageKeyFromUrl } from './storage-url'
import {
  LOAN_REPAY_METHODS,
  loanOutstanding,
  loanStage,
  type Loan,
  type LoanRepayMethod,
  type LoanRepayment,
  type LoanSlip,
} from './loan-shared'

/*
 * 员工借款的存取。口径和派生 (阶段 / 已还 / 未还) 在 lib/loan-shared.ts。
 *
 * TABLE-FREE, 跟 工资 / 人事 / 应收应付 一个路子: 没有 migration 要人去应
 * 用。一个厂一年几十笔借款, 一个 JSON 绰绰有余:
 *   finance/loans.json    [Loan, …]
 *
 * 每一步都在这里把前后关系守住 (没批不能放款, 没放款不能还), 不靠界面上藏
 * 按钮 —— 界面会过时, 这里不会。
 */

const KEY = 'finance/loans.json'

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

function money(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.round(v * 100) / 100
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function isMethod(v: unknown): v is LoanRepayMethod {
  return typeof v === 'string' && (LOAN_REPAY_METHODS as readonly string[]).includes(v)
}

function normalize(raw: unknown): Loan[] {
  if (!Array.isArray(raw)) return []
  const out: Loan[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.id !== 'string' || typeof r.no !== 'string') continue
    const repayments: LoanRepayment[] = Array.isArray(r.repayments)
      ? (r.repayments as Record<string, unknown>[])
          .filter((p) => p && typeof p.id === 'string')
          .map((p) => ({
            id: p.id as string,
            date: str(p.date),
            amountCny: money(p.amountCny),
            method: isMethod(p.method) ? p.method : '现金',
            note: str(p.note) || undefined,
            by: str(p.by) || undefined,
            createdAt: str(p.createdAt),
            payrollMonth: str(p.payrollMonth) || undefined,
          }))
      : []
    out.push({
      id: r.id,
      no: r.no,
      name: str(r.name),
      amountCny: money(r.amountCny),
      reason: str(r.reason),
      monthlyCny: typeof r.monthlyCny === 'number' && r.monthlyCny > 0 ? money(r.monthlyCny) : undefined,
      appliedBy: str(r.appliedBy),
      appliedAt: str(r.appliedAt),
      decision: r.decision === 'approved' || r.decision === 'rejected' ? r.decision : undefined,
      decidedBy: str(r.decidedBy) || undefined,
      decidedAt: str(r.decidedAt) || undefined,
      rejectNote: str(r.rejectNote) || undefined,
      paidOutAt: str(r.paidOutAt) || undefined,
      paidOutBy: str(r.paidOutBy) || undefined,
      repayments,
      slips: Array.isArray(r.slips)
        ? (r.slips as Record<string, unknown>[])
            .filter((x) => x && typeof x.id === 'string' && typeof x.url === 'string')
            .map((x) => ({
              id: x.id as string,
              url: x.url as string,
              filename: str(x.filename) || '借支单',
              contentType: str(x.contentType) || undefined,
              uploadedBy: str(x.uploadedBy) || undefined,
              createdAt: str(x.createdAt),
            }))
        : [],
    })
  }
  return out
}

async function read(): Promise<Loan[]> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return []
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return []
  }
}

async function write(rows: Loan[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

// 新申请的在前。
export async function getLoans(): Promise<Loan[]> {
  return (await read()).sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))
}

export async function getLoan(id: string): Promise<Loan | undefined> {
  return (await read()).find((l) => l.id === id)
}

async function mutateLoan(id: string, fn: (l: Loan) => void): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const l = rows.find((x) => x.id === id)
    if (!l) throw new Error('找不到这笔借款')
    fn(l)
    await write(rows)
  })
}

export async function createLoan(
  input: { name: string; amountCny: number; reason: string; monthlyCny?: number },
  by: string,
  nowIso: string,
): Promise<Loan> {
  return withLock(async () => {
    const rows = await read()
    // 单号: JK-申请年月-当月第几笔。撤回的也占号 —— 纸上写过的号不复用。
    const ym = nowIso.slice(0, 7)
    const head = `JK-${ym.slice(2, 4)}${ym.slice(5, 7)}-`
    const seq =
      rows
        .filter((r) => r.no.startsWith(head))
        .reduce((m, r) => Math.max(m, Number(r.no.slice(head.length)) || 0), 0) + 1
    const loan: Loan = {
      id: crypto.randomUUID(),
      no: `${head}${String(seq).padStart(3, '0')}`,
      name: input.name.trim(),
      amountCny: money(input.amountCny),
      reason: input.reason.trim(),
      monthlyCny: input.monthlyCny && input.monthlyCny > 0 ? money(input.monthlyCny) : undefined,
      appliedBy: by,
      appliedAt: nowIso,
      repayments: [],
      slips: [],
    }
    rows.push(loan)
    await write(rows)
    return loan
  })
}

export async function decideLoan(
  id: string,
  decision: 'approved' | 'rejected',
  by: string,
  nowIso: string,
  rejectNote?: string,
): Promise<void> {
  await mutateLoan(id, (l) => {
    if (loanStage(l) !== 'pending') throw new Error('这笔已经审过了')
    l.decision = decision
    l.decidedBy = by
    l.decidedAt = nowIso
    l.rejectNote = decision === 'rejected' ? rejectNote?.trim() || undefined : undefined
  })
}

export async function payOutLoan(id: string, date: string, by: string): Promise<void> {
  await mutateLoan(id, (l) => {
    if (loanStage(l) !== 'approved') throw new Error('还没批的借款不能放款')
    l.paidOutAt = date
    l.paidOutBy = by
  })
}

export async function addLoanRepayment(
  id: string,
  input: { date: string; amountCny: number; method: LoanRepayMethod; note?: string },
  by: string,
  nowIso: string,
): Promise<void> {
  await mutateLoan(id, (l) => {
    if (!l.paidOutAt) throw new Error('钱还没放出去, 谈不上还')
    if (loanOutstanding(l) <= 0) throw new Error('这笔已经还清了')
    l.repayments.push({
      id: crypto.randomUUID(),
      date: input.date,
      amountCny: money(input.amountCny),
      method: input.method,
      note: input.note?.trim() || undefined,
      by,
      createdAt: nowIso,
    })
    l.repayments.sort((a, b) => a.date.localeCompare(b.date))
  })
}

// 手动删一笔还款 —— 工资扣回的那几笔不行: 它们是工资条上的一格, 删了借款
// 和工资就对不上了。要退回, 撤销那个月的工资发放。
export async function deleteLoanRepayment(id: string, repaymentId: string): Promise<void> {
  await mutateLoan(id, (l) => {
    const r = l.repayments.find((x) => x.id === repaymentId)
    if (r?.payrollMonth) {
      throw new Error('这一笔是工资扣回的 —— 要退回, 撤销那个月的工资发放')
    }
    l.repayments = l.repayments.filter((x) => x.id !== repaymentId)
  })
}

/**
 * 工资发放了 —— 每个人工资条上的「借款扣回」记成还款。一个人几笔借款的, 按
 * 先借先还分下去; 扣完的那笔自己变成已还清。
 */
export async function applyPayrollLoanDeductions(
  month: string,
  deductions: { name: string; amountCny: number }[],
  dateYmd: string,
  by: string,
  label: string,
  nowIso: string,
): Promise<void> {
  if (deductions.every((d) => d.amountCny <= 0)) return
  await withLock(async () => {
    const rows = await read()
    for (const d of deductions) {
      let left = money(d.amountCny)
      if (left <= 0) continue
      const mine = rows
        .filter(
          (l) =>
            l.name === d.name &&
            loanStage(l) === 'repaying' &&
            !!l.paidOutAt &&
            l.paidOutAt.slice(0, 7) <= month &&
            !l.repayments.some((r) => r.payrollMonth === month),
        )
        .sort((a, b) => a.appliedAt.localeCompare(b.appliedAt))
      for (const l of mine) {
        if (left <= 0) break
        const take = Math.min(left, loanOutstanding(l))
        if (take <= 0) continue
        l.repayments.push({
          id: crypto.randomUUID(),
          date: dateYmd,
          amountCny: money(take),
          method: '工资扣回',
          note: `${label}工资扣回`,
          by,
          createdAt: nowIso,
          payrollMonth: month,
        })
        l.repayments.sort((a, b) => a.date.localeCompare(b.date))
        left = money(left - take)
      }
    }
    await write(rows)
  })
}

/** 撤销那个月的工资发放 —— 它记下的工资扣回一笔不留地退回。 */
export async function revertPayrollLoanDeductions(month: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    let touched = false
    for (const l of rows) {
      const before = l.repayments.length
      l.repayments = l.repayments.filter((r) => r.payrollMonth !== month)
      if (l.repayments.length !== before) touched = true
    }
    if (touched) await write(rows)
  })
}

// 撤回一笔申请 —— 只有还没放款的才能撤 (待审批 / 已驳回 / 批了还没给钱)。钱
// 一旦给出去, 这笔就只能一笔一笔还清, 不能凭空消失。
export async function withdrawLoan(id: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const l = rows.find((x) => x.id === id)
    if (!l) return
    if (l.paidOutAt) throw new Error('钱已经放出去了, 撤不了 —— 只能记还款')
    await write(rows.filter((x) => x.id !== id))
  })
  // 申请撤了, 挂在上面的支单跟着走。
  try {
    const dir = `finance/loans/slips/${safeId(id)}`
    const { data } = await supabase.storage.from(STORAGE_BUCKET).list(dir)
    const keys = (data ?? []).map((f) => `${dir}/${f.name}`)
    if (keys.length > 0) await supabase.storage.from(STORAGE_BUCKET).remove(keys)
  } catch {
    // 孤儿文件 —— 无害。
  }
}

// === 借支单 ===
//
// 员工签了字的那张借支单, 拍一张挂在借款上 (一笔可以挂好几张: 借支单 + 身份
// 证复印件 …)。文件在桶里, 地址挂在借款那一行上:
//   finance/loans/slips/<loanId>/<uuid>.<ext>

const SLIP_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'heic', 'pdf'] as const

function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export function isAllowedSlipName(fileName: string): boolean {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  return !!m && (SLIP_EXTS as readonly string[]).includes(m[1])
}

function slipExt(fileName: string, contentType: string): string {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  if (m && (SLIP_EXTS as readonly string[]).includes(m[1])) return m[1]
  if (contentType === 'application/pdf') return 'pdf'
  if (contentType === 'image/png') return 'png'
  if (contentType === 'image/webp') return 'webp'
  if (contentType === 'image/heic') return 'heic'
  return 'jpg'
}

export async function addLoanSlip(input: {
  loanId: string
  buf: ArrayBuffer
  fileName: string
  contentType: string
  uploadedBy: string
  nowIso: string
}): Promise<LoanSlip> {
  const id = crypto.randomUUID()
  const key = `finance/loans/slips/${safeId(input.loanId)}/${id}.${slipExt(
    input.fileName,
    input.contentType,
  )}`
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, Buffer.from(input.buf), {
      contentType: input.contentType || 'application/octet-stream',
      upsert: false,
    })
  if (error) throw error
  const slip: LoanSlip = {
    id,
    url: proxiedKeyUrl(key),
    filename: input.fileName,
    contentType: input.contentType || undefined,
    uploadedBy: input.uploadedBy,
    createdAt: input.nowIso,
  }
  await mutateLoan(input.loanId, (l) => {
    l.slips.push(slip)
  })
  return slip
}

// 删一张支单 —— 钱放出去以后不给删: 那张签了字的纸就是这笔钱出去的凭据。
export async function deleteLoanSlip(loanId: string, slipId: string): Promise<void> {
  let target: LoanSlip | undefined
  await mutateLoan(loanId, (l) => {
    if (l.paidOutAt) throw new Error('钱已经放出去了, 支单是凭据, 删不了')
    target = l.slips.find((s) => s.id === slipId)
    l.slips = l.slips.filter((s) => s.id !== slipId)
  })
  const key = target ? storageKeyFromUrl(target.url) : null
  if (key) {
    try {
      await supabase.storage.from(STORAGE_BUCKET).remove([key])
    } catch {
      // 孤儿文件 —— 无害。
    }
  }
}
