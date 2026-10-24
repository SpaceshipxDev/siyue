// 付款申请 —— 人事、商务要往外付一笔钱, 从申请到落进财务应付。
//
//   人事 / 商务 填申请 → 商务审核 (黄优兰香 或 于海伟) → 老板批 → 自动落一张
//   应付单到 财务 · 应付 → 财务照常付款、挂回单
//
// 外协的钱也走这一条 (于海伟 2026-10-23): 外协对账单上勾着点「确认」, 就生成
// 一张待填付款的申请 (清单是认下的那几张外协单) → 填好收款账户、补上没定价
// 的金额, 点「提交审核」→ 审核 → 老板批 → 落进财务应付, 那张应付单认下那几
// 张外协单。
//
// 一张申请上要有的: 收款方 (名称 + 账户), 付款类别 (跟采购同一套类别), 付款
// 事项和说明, 付款清单 (一项一行, 合计就是这张申请的金额), 付款凭证和发票
// (照片 / PDF)。审批的人点开一张就看得到全部, 不用再去问。
//
// 纯类型 + 纯函数 —— 服务端和客户端共用。存取在 lib/pay-request.ts。

import { PROCUREMENT_CATEGORIES, type VoucherFile } from './data'

// 付款类别 —— 采购那一套, 再加两样只有付款才有的 (于海伟 2026-10-16)。
export const PAY_CATEGORIES: readonly string[] = [
  ...PROCUREMENT_CATEGORIES,
  '供应商货款',
  '外协加工费用',
]

export type PayDept = '人事' | '商务'
export const PAY_DEPTS: readonly PayDept[] = ['人事', '商务']

export type PayItem = {
  name: string
  qty?: number
  unitPriceCny?: number
  amountCny: number
}

export type PayFileKind = 'voucher' | 'invoice'
export const PAY_FILE_LABEL: Record<PayFileKind, string> = {
  voucher: '付款凭证',
  invoice: '发票',
}

export type PayRequest = {
  id: string
  no: string // 付款单号 FK-2610-001 —— 申请年月 + 当月第几张
  dept: PayDept
  payee: string // 收款方
  payeeAccount?: string // 开户行 / 账号 / 联系人
  category: string // 付款类别 (采购类别那一套)
  subject: string // 付款事项
  note?: string // 说明
  items: PayItem[] // 需要付款清单
  amountCny: number // 清单合计
  vouchers: VoucherFile[] // 付款凭证
  /** 对账单明细 —— 供应商那张对账单, 导进来原样摆着 (于海伟 2026-10-24)。 */
  statement?: PayStatement
  invoices: VoucherFile[] // 发票
  appliedBy: string
  appliedAt: string // ISO
  // 一审 —— 商务 (黄优兰香 / 于海伟)
  reviewedBy?: string
  reviewedAt?: string
  // 终审 —— 老板。批了就落应付单。
  approvedBy?: string
  approvedAt?: string
  rejectedBy?: string
  rejectedAt?: string
  rejectNote?: string
  payableId?: string
  payableNo?: string
  /** 外协对账确认生成的 —— 认的是这家哪几张外协单。 */
  recon?: PayRecon
  /** 对账来的申请: 填好付款点「提交审核」那一刻。没提交之前是「待填付款」。 */
  submittedAt?: string
}

/** 一张表: 第一行是表头, 后面一行一条。格子都是字。 */
export type PayStatement = {
  filename: string
  rows: string[][]
}

/** 导进来的表收拾一下: 空行去掉, 右边全空的列去掉, 太大的截掉。 */
export function cleanStatement(raw: unknown, filename: unknown): PayStatement | undefined {
  if (!Array.isArray(raw)) return undefined
  const text = (v: unknown) => (v == null ? '' : String(v).trim().slice(0, 200))
  let rows = (raw as unknown[])
    .filter(Array.isArray)
    .map((r) => (r as unknown[]).slice(0, 30).map(text))
    .filter((r) => r.some(Boolean))
    .slice(0, 1000)
  if (rows.length === 0) return undefined
  const width = Math.max(...rows.map((r) => r.reduce((w, c, i) => (c ? i + 1 : w), 0)))
  rows = rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''))
  return { filename: text(filename) || '对账单', rows }
}

export type PayRecon = {
  vendor: string
  period: string // 对账月份 YYYY-MM
  blockIds: string[]
  lineCount: number
  totalQty: number
}

export type PayStage =
  | 'fill' // 对账来的, 待填付款
  | 'review' // 待商务审核
  | 'boss' // 待老板批
  | 'done' // 已批, 转财务应付
  | 'rejected' // 已驳回

export const PAY_STAGE_LABEL: Record<PayStage, string> = {
  fill: '待填付款',
  review: '待审核',
  boss: '待老板批',
  done: '已转财务',
  rejected: '已驳回',
}

export function payStage(r: PayRequest): PayStage {
  if (r.rejectedAt) return 'rejected'
  if (r.approvedAt) return 'done'
  if (r.recon && !r.submittedAt) return 'fill'
  if (r.reviewedAt) return 'boss'
  return 'review'
}

/** 一行清单的金额: 数量 × 单价都填了就按它算, 不然用手填的金额。 */
export function payItemAmount(i: {
  qty?: number
  unitPriceCny?: number
  amountCny?: number
}): number {
  if (typeof i.qty === 'number' && typeof i.unitPriceCny === 'number')
    return Math.round(i.qty * i.unitPriceCny * 100) / 100
  return typeof i.amountCny === 'number' ? i.amountCny : 0
}

export function payTotal(items: PayItem[]): number {
  return Math.round(items.reduce((s, i) => s + i.amountCny, 0) * 100) / 100
}

export function nextPayNo(nowYmd: string, existing: { no: string }[]): string {
  const head = `FK-${nowYmd.slice(2, 4)}${nowYmd.slice(5, 7)}-`
  const seq =
    existing
      .filter((r) => r.no.startsWith(head))
      .reduce((m, r) => Math.max(m, Number(r.no.slice(head.length)) || 0), 0) + 1
  return `${head}${String(seq).padStart(3, '0')}`
}
