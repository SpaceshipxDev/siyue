// 员工借款 — 一个人找厂里借一笔钱, 从申请到还清。
//
//   人事: 填申请 → 审批 (同意 / 驳回)
//   财务: 放款 → 每月发工资自动扣回 → 扣完自动关闭
//
// 以前这件事全在嘴上和几张纸条上: 谁借了、批没批、钱给没给、还了几次、还
// 差多少 —— 月底对工资的时候才一个个想起来。这里一条借款就是一行, 走到哪一
// 步一眼看得见, 未还自己算。
//
// 还钱的主路是工资: 放款以后, 每个月的工资条上自动多一格「借款扣回」(约定
// 的每月扣回, 没约定就一次扣清, 不会扣到实发为负)。工资一发放, 那一格就记成
// 这笔借款的一笔还款; 撤销发放, 那笔还款跟着退回。扣完了, 这笔借款自己变成
// 「已还清」, 不用谁去关。
//
// 审批是第二双眼睛: 录申请的人不能批自己录的那一笔 (老板除外 —— 他就是最后
// 拍板的人)。跟请购"审批永远是另一个人"同一个道理。
//
// 纯类型 + 纯函数 —— 服务端和客户端共用。存取在 lib/loan.ts。

export type LoanRepayMethod = '工资扣回' | '现金'
export const LOAN_REPAY_METHODS: readonly LoanRepayMethod[] = ['工资扣回', '现金']

export type LoanRepayment = {
  id: string
  date: string // YYYY-MM-DD
  amountCny: number
  method: LoanRepayMethod
  note?: string
  by?: string
  createdAt: string
  /** 工资扣回的那一笔: 哪个月的工资扣的。撤销那个月的发放时按它退回。 */
  payrollMonth?: string
}

export type Loan = {
  id: string
  no: string // 借款单号 JK-2609-001 —— 申请年月 + 当月第几笔
  name: string // 借款人 (人事名单上的名字)
  amountCny: number
  reason: string // 事由
  /** 约定每月从工资扣回多少 —— 空 = 没约定, 还款时再说。 */
  monthlyCny?: number
  appliedBy: string // 录申请的人
  appliedAt: string // ISO
  decision?: 'approved' | 'rejected'
  decidedBy?: string
  decidedAt?: string
  rejectNote?: string
  paidOutAt?: string // 放款日 YYYY-MM-DD
  paidOutBy?: string
  repayments: LoanRepayment[]
}

export type LoanStage =
  | 'pending' // 待审批
  | 'rejected' // 已驳回
  | 'approved' // 已同意, 待放款
  | 'repaying' // 已放款, 还款中
  | 'cleared' // 已还清

export const LOAN_STAGE_LABEL: Record<LoanStage, string> = {
  pending: '待审批',
  rejected: '已驳回',
  approved: '待放款',
  repaying: '还款中',
  cleared: '已还清',
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function loanRepaid(l: Loan): number {
  return round2(l.repayments.reduce((s, r) => s + r.amountCny, 0))
}

/** 还欠厂里多少 —— 钱没放出去之前是 0 (还没借到手, 谈不上欠)。 */
export function loanOutstanding(l: Loan): number {
  if (!l.paidOutAt) return 0
  return Math.max(0, round2(l.amountCny - loanRepaid(l)))
}

export function loanStage(l: Loan): LoanStage {
  if (l.decision === 'rejected') return 'rejected'
  if (l.decision !== 'approved') return 'pending'
  if (!l.paidOutAt) return 'approved'
  return loanOutstanding(l) > 0 ? 'repaying' : 'cleared'
}

/** 下一笔还款的建议金额: 约定的每月扣回, 但不超过还欠的; 没约定就是全部。 */
export function loanNextRepay(l: Loan): number {
  const left = loanOutstanding(l)
  if (l.monthlyCny && l.monthlyCny > 0) return Math.min(l.monthlyCny, left)
  return left
}

/**
 * 这个月的工资上每个人该扣回多少借款 —— 工资条上「借款扣回」那一格的来源。
 *
 * 只算已经放款、还没还清的, 而且放款月不晚于这个工资月; 一个人几笔借款就
 * 加起来。那个月已经有工资扣回记
 * 录的借款不再算 (发放过了就不重复扣)。实发不够扣的时候, 工资那边会把这一格
 * 压到实发为 0 为止, 发放时按先借先还分到每一笔上。
 */
export function loanDueByName(loans: Loan[], month: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const l of loans) {
    if (loanStage(l) !== 'repaying') continue
    // 按对应的月份: 九月放的款从九月的工资扣起, 八月的工资 (哪怕九月才核算、
    // 才发) 跟这笔钱没关系。
    if (!l.paidOutAt || l.paidOutAt.slice(0, 7) > month) continue
    if (l.repayments.some((r) => r.payrollMonth === month)) continue
    const due = loanNextRepay(l)
    if (due <= 0) continue
    out[l.name] = round2((out[l.name] ?? 0) + due)
  }
  return out
}
