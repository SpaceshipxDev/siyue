// 应收单 / 应付单 — 对账单认下来之后, 落下来的那一笔"谁欠谁多少"。
//
// 两条对称的线:
//   客户: 对账单 → 审批 → 应收单 → 回款
//   外协: 对账单 → 确认 → 应付单 → 付款 (每一笔挂着付款凭证)
//
// 对账单本身永远是现算的 (lib/duizhang) —— 出货单、外协单改了, 纸就跟着变。
// 审批/确认是把某一刻的那张纸认下来: 这一方、这个月, 双方点过头的合计是多少。
// 从那一刻起这笔钱就是一个定数, 收/付一笔一笔往上记, 余额自己算出来, 不再跟
// 着单据漂。
//
// 纯类型 + 纯函数 —— 服务端和客户端共用一份口径, 不会一处说清了一处说还欠着。
// 存取在 lib/receivable.ts 和 lib/payable.ts。

export const SETTLE_TERM_DAYS = 30

// 两边都有的那几样 —— 余额、状态、逾期只看这些。
type SettleCore = {
  amountCny: number
  dueDate: string
  payments: { amountCny: number }[]
  voidedAt?: string
}

export type ReceivablePayment = {
  id: string
  date: string // YYYY-MM-DD 到账那天
  amountCny: number
  note?: string // 转账 / 承兑 / 哪个账户… 一句话
  by?: string // 记录人
  createdAt: string // ISO
}

export type Receivable = {
  id: string
  no: string // 应收单号 YS-2609-001 —— 期间年月 + 当月第几张
  customer: string
  period: string // 对账期间 YYYY-MM
  amountCny: number // 应收金额 = 审批那一刻对账单的合计
  lineCount: number
  totalQty: number
  /**
   * 按单号勾着审的 —— 这一张认的是哪几个交货单号。没有 = 整个月一起审的 (早
   * 先的做法)。一个月可以分几回审, 认过的单号不再上对账单。
   */
  jobNos?: string[]
  approvedBy: string
  approvedAt: string // ISO
  dueDate: string // 约定回款日 YYYY-MM-DD —— 审批日 + 30 天 (月结)
  payments: ReceivablePayment[]
  // 作废 —— 审批错了、或者单据审批后又改了要按新数重来。单子留着 (号不复
  // 用, 痕迹在), 只是不再算钱。
  voidedAt?: string
  voidedBy?: string
}

/** 付款凭证 —— 银行回单 / 转账截图, 挂在那一笔付款上。 */
export type PaymentProof = {
  url: string
  filename: string
  contentType?: string
}

export type PayablePayment = ReceivablePayment & {
  proof?: PaymentProof
}

export type Payable = {
  id: string
  no: string // 应付单号 YF-2609-001
  vendor: string
  period: string
  amountCny: number // 应付金额 = 确认那一刻外协对账单的合计
  lineCount: number
  totalQty: number
  approvedBy: string // 确认人
  approvedAt: string
  dueDate: string // 约定付款日 —— 确认日 + 30 天
  payments: PayablePayment[]
  /**
   * 这张应付单认的是哪几张外协单 —— 对账时勾了哪几张就是哪几张。认过的单下
   * 次对账不再出现。早先整月认的应付单没有这一格 (那一整个月都算认过了)。
   */
  blockIds?: string[]
  voidedAt?: string
  voidedBy?: string
}

export type SettleStatus = 'open' | 'partial' | 'overdue' | 'paid' | 'void'

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function settlePaid(r: SettleCore): number {
  return round2(r.payments.reduce((s, p) => s + p.amountCny, 0))
}

export function settleOutstanding(r: SettleCore): number {
  if (r.voidedAt) return 0
  return Math.max(0, round2(r.amountCny - settlePaid(r)))
}

export function settleStatus(r: SettleCore, todayYmd: string): SettleStatus {
  if (r.voidedAt) return 'void'
  if (settleOutstanding(r) <= 0) return 'paid'
  if (todayYmd > r.dueDate) return 'overdue'
  return settlePaid(r) > 0 ? 'partial' : 'open'
}

/** 过了约定日几天 (没过 / 已结清 / 作废 都是 0)。 */
export function settleOverdueDays(r: SettleCore, todayYmd: string): number {
  if (settleStatus(r, todayYmd) !== 'overdue') return 0
  const a = Date.parse(`${r.dueDate}T00:00:00Z`)
  const b = Date.parse(`${todayYmd}T00:00:00Z`)
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

export function addDays(ymd: string, days: number): string {
  const t = Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

/**
 * 单号: 前缀-期间年月-当月第几张。作废的也占号, 号不复用 —— 纸上写过的号,
 * 系统里就只能指向那一张。
 */
export function nextSettleNo(
  prefix: 'YS' | 'YF',
  period: string,
  existing: { no: string }[],
): string {
  const head = `${prefix}-${period.slice(2, 4)}${period.slice(5, 7)}-`
  const seq =
    existing
      .filter((r) => r.no.startsWith(head))
      .reduce((m, r) => Math.max(m, Number(r.no.slice(head.length)) || 0), 0) + 1
  return `${head}${String(seq).padStart(3, '0')}`
}

/**
 * 客户这个月审过哪些单号 —— 对账单上勾着审, 一个月可以分几回。
 * whole: 早先整个月一起审的那张 (有它就整个月都算审过了)。
 */
export function customerSettledFrom(
  rows: Receivable[],
  customer: string,
  period: string,
): { whole?: Receivable; records: Receivable[]; jobNos: Set<string> } {
  const records = rows.filter(
    (r) => !r.voidedAt && r.customer === customer && r.period === period,
  )
  const whole = records.find((r) => !r.jobNos)
  const jobNos = new Set(records.flatMap((r) => r.jobNos ?? []))
  return { whole, records, jobNos }
}
