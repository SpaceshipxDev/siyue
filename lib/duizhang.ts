// 对账单 — 月底和外面那一方把账对齐的那张纸。
//
// 一张纸，两个对象：
//   客户  — 这个月发给他的每一车货 (出货单)，合计多少钱，开了多少票，收了多少钱
//   供应商 — 这个月他做完回厂的每一张外协单，合计该付他多少钱
//
// 两边是同一件事：一段时间里，双方之间发生了什么，末了谁欠谁多少。所以它们
// 是同一个 Duizhang 结构、同一张纸、同一个 PDF —— 只是取数的那一头不同。
//
// 这里不存任何状态。对账单永远是从已经存在的出货单 / 外协单现算出来的，所以
// 它和记账表、外协台、月度统计不可能各说各话。
//
// 纯函数 ⇒ 服务端 (页面 / PDF) 和客户端 (导出 Excel) 都能用。

import {
  blockClosedAt,
  blockAmountCny,
  effectiveMemberLineTotal,
  effectiveUnitPriceCny,
  type OpenBlockRow,
  type Vendor,
} from './data'
import { effectiveAmount, outstanding, type FinanceRow } from './finance'

/** 零件级明细的入参 —— 和 lib/db 的 StatementLine 同形, 这里只留用得上的几样。 */
export type StatementLineInput = {
  shipmentId: string
  shipDate: string
  componentId: string
  jobNo: string
  contractNo?: string
  partNo?: string
  partName: string
  imageUrl?: string
  qty: number
  unitPriceCny?: number
  amountCny?: number
}

export type DuizhangKind = 'customer' | 'vendor'

export function isDuizhangKind(x: string | undefined): x is DuizhangKind {
  return x === 'customer' || x === 'vendor'
}

/**
 * 单据上的一行。
 *
 * 客户那半边是**一个零件一行** (不是一车一行): 客户核对账要的是"哪个物料、
 * 几个、单价多少", 给他一车的总数他对不下去。所以这一行带着图、物料号、物
 * 料名、单价, 以及那张单的合同号。
 * 供应商那半边仍是一张外协单一行 —— 他核的是"哪张单多少钱"。
 */
export type DuizhangLine = {
  key: string
  /** 客户: 出货日期 · 供应商: 回厂日期 (结算日) */
  date: string
  /** 客户: 交货单号 (= 销售单号, 和交货单上印的一致) · 供应商: 外协单号 */
  docNo: string
  /** 主名: 物料名称 / 零件 */
  title: string
  /** 副名: 料号 / 工序 */
  detail: string
  qty: number
  /** 未定价的行是空, 不是 0 —— 0 会被合计吃掉, 空才会被人问起。 */
  amountCny?: number
  // —— 以下几样只有客户对账单用到 ——
  /** 合同号 */
  contractNo?: string
  /** 物料号 */
  partNo?: string
  /** 零件图 */
  imageUrl?: string
  /** 单价 */
  unitPriceCny?: number
  // —— 以下两样只有外协对账单用到 ——
  /** 这一行属于哪张外协单 —— 勾选、确认按单走。 */
  groupId?: string
  /** 那张外协单的总价 (单头一口价或逐件合计), 合计按它加, 不按行加。 */
  groupAmountCny?: number
}

export type Duizhang = {
  kind: DuizhangKind
  /** 对方名字。空 = 还没选。 */
  party: string
  /** 期间 */
  from: string
  to: string
  lines: DuizhangLine[]
  count: number
  totalQty: number
  totalAmountCny: number
  /** 本期里没填金额的单数 —— 合计下面那句话, 免得双方对着一个偏小的数点头。 */
  unpricedCount: number
  /** 客户: 本期开票 · 供应商: 无 */
  invoicedCny: number
  /** 客户: 本期回款 · 供应商: 无 */
  paidCny: number
  /** 客户: 截至今日该客户全部未收 · 供应商: 尚在外未结的金额 */
  carryAmountCny: number
  /** 供应商: 尚在外未回厂的单数 */
  carryCount: number
}

// === 期间 ===

export function monthBounds(ym: string): { from: string; to: string } {
  const [y, m] = ym.split('-').map(Number)
  const from = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10)
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  return { from, to }
}

export function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7)
}

export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-')
  return `${y}年${Number(m)}月`
}

export function isMonth(x: string | undefined): x is string {
  return typeof x === 'string' && /^\d{4}-\d{2}$/.test(x)
}

export function dateLabel(ymd: string): string {
  if (!ymd) return '—'
  const [, m, d] = ymd.split('-')
  return `${Number(m)}月${Number(d)}日`
}

// === 客户 ===

/**
 * 一个客户、一段期间的对账单。行 = 出货单 (这个月拉走的每一车)。
 * 金额取记账表那一栏 (财务改过的优先, 没改过就是零件单价 × 出货数)。
 */
export function buildCustomerDuizhang(
  all: FinanceRow[],
  party: string,
  from: string,
  to: string,
  dayOf: (iso: string) => string,
  /** 零件级明细 (lib/db getCustomerStatementLines)。 */
  detail: StatementLineInput[] = [],
): Duizhang {
  const mine = all.filter((r) => (r.customer ?? '').trim() === party)

  const lines: DuizhangLine[] = detail
    .map((d) => ({
      key: `${d.shipmentId}:${d.componentId}`,
      date: dayOf(d.shipDate),
      docNo: d.jobNo || '—',
      title: d.partName || '—',
      detail: d.partNo || '',
      qty: d.qty,
      amountCny: d.amountCny,
      contractNo: d.contractNo,
      partNo: d.partNo,
      imageUrl: d.imageUrl,
      unitPriceCny: d.unitPriceCny,
    }))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.docNo.localeCompare(b.docNo) ||
        a.title.localeCompare(b.title, 'zh'),
    )

  let totalQty = 0
  let totalAmountCny = 0
  let unpricedCount = 0
  for (const l of lines) {
    totalQty += l.qty
    if (typeof l.amountCny === 'number') totalAmountCny += l.amountCny
    else unpricedCount += 1
  }

  // 本期开票 / 本期回款按各自的日期落期, 不按出货日 —— 这个月开的是上个月的
  // 票, 是常事。
  let invoicedCny = 0
  let paidCny = 0
  for (const r of mine) {
    if (r.invoiceDate && r.invoiceDate >= from && r.invoiceDate <= to) {
      invoicedCny += r.invoiceAmountCny ?? effectiveAmount(r) ?? 0
    }
    if (r.paymentDate && r.paymentDate >= from && r.paymentDate <= to) {
      paidCny += r.paymentAmountCny ?? 0
    }
  }

  // 截至今日, 这个客户所有已开票还没收齐的钱 —— 对账单真正的落脚点。
  const carryAmountCny = mine.reduce((s, r) => s + outstanding(r), 0)

  return {
    kind: 'customer',
    party,
    from,
    to,
    lines,
    count: lines.length,
    totalQty,
    totalAmountCny,
    unpricedCount,
    invoicedCny,
    paidCny,
    carryAmountCny,
    carryCount: 0,
  }
}

/**
 * 客户名单 —— 数是「本期」的数, 不是全历史的。页头写着几月, 名单上却是开厂
 * 至今的总额, 那张名单就没法当账用: 要对的是这个月的账。
 * 本期有往来的排前面 (金额大的在上), 其余留着只为能被搜到。
 */
export function customerOptions(
  all: FinanceRow[],
  from: string,
  to: string,
  dayOf: (iso: string) => string,
): DuizhangParty[] {
  return rollupParties(
    all,
    (r) => (r.customer ?? '').trim(),
    (r) => {
      const d = dayOf(r.shipDate)
      return d >= from && d <= to
    },
    (r) => effectiveAmount(r) ?? 0,
  )
}

// === 对账对象名单 ===

/** 名单上的一家。count / amountCny 只算本期; inPeriod=false 表示本期没往来。 */
export type DuizhangParty = {
  name: string
  count: number
  amountCny: number
  inPeriod: boolean
}

/** 客户和供应商共用的一次归并 —— 谁、算不算本期、这一笔多少钱。 */
function rollupParties<T>(
  rows: T[],
  nameOf: (r: T) => string,
  inPeriod: (r: T) => boolean,
  amountOf: (r: T) => number,
): DuizhangParty[] {
  const by = new Map<string, DuizhangParty>()
  for (const r of rows) {
    const name = (nameOf(r) ?? '').trim()
    if (!name) continue
    const g = by.get(name) ?? { name, count: 0, amountCny: 0, inPeriod: false }
    if (inPeriod(r)) {
      g.count += 1
      g.amountCny += amountOf(r)
      g.inPeriod = true
    }
    by.set(name, g)
  }
  // 本期有往来的在前, 金额大的在上 —— 月底先对的就是这几家。
  return [...by.values()].sort(
    (a, b) =>
      Number(b.inPeriod) - Number(a.inPeriod) ||
      b.amountCny - a.amountCny ||
      a.name.localeCompare(b.name, 'zh'),
  )
}

// === 供应商 (外协) ===

/** 一张外协单该付多少 —— 全厂同一个口径, 见 lib/data 的 blockAmountCny。 */
export function blockSettleAmount(
  block: OpenBlockRow['block'],
): number | undefined {
  return blockAmountCny(block)
}

/**
 * 哪些外协单已经对过账了 —— 确认过的应付单上记着它们 (blockIds)。
 *
 * 早先的应付单是按「这一家 × 这个月」整月认的, 没记单号: 那几个月回厂的单
 * 都算对过了 (legacyMonths, YYYY-MM)。
 */
export type VendorSettled = {
  blockIds: Set<string>
  legacyMonths: Set<string>
}

export const NO_VENDOR_SETTLED: VendorSettled = {
  blockIds: new Set(),
  legacyMonths: new Set(),
}

function isSettledBlock(
  block: OpenBlockRow['block'],
  closedAt: string,
  settled: VendorSettled,
): boolean {
  return settled.blockIds.has(block.id) || settled.legacyMonths.has(closedAt.slice(0, 7))
}

/**
 * 一个供应商的外协对账单 —— 截至所选月底、回了厂、**还没对过账**的外协单,
 * 一个零件一行。
 *
 * 跟客户对账单一个样子: 图、料号、零件名、数量、单价、金额, 供应商核的是
 * "哪个零件几个、多少钱", 不是一张单一个总数。每一行带着它那张外协单的 id
 * (groupId) —— 勾选、确认都按单走, 一张单是一起付的。
 *
 * 对过账的单不再出现: 这一次勾了哪几张、确认成应付单, 下一次打开就只剩没勾
 * 的那些。以前月份没对掉的单也在里面 —— 没对就是没对, 不会因为换了月份就从
 * 账上消失。
 *
 * only —— 只要这几张单 (打印选中的那几张、确认时服务端重算用)。
 */
export function buildVendorDuizhang(
  rows: OpenBlockRow[],
  vendors: Vendor[],
  party: string,
  from: string,
  to: string,
  settled: VendorSettled = NO_VENDOR_SETTLED,
  only?: Set<string>,
): Duizhang {
  const nameOf = new Map(vendors.map((v) => [v.id, v.name]))
  const mine = rows.filter(
    (r) => (nameOf.get(r.block.vendorId) ?? r.block.vendorId) === party,
  )

  const lines: DuizhangLine[] = []
  let carryAmountCny = 0
  let carryCount = 0
  let totalAmountCny = 0
  let unpricedCount = 0
  let blockCount = 0
  for (const r of mine) {
    const closedAt = blockClosedAt(r.block)
    const amount = blockSettleAmount(r.block)
    if (!closedAt) {
      carryCount += 1
      carryAmountCny += amount ?? 0
      continue
    }
    if (closedAt > to) continue
    if (isSettledBlock(r.block, closedAt, settled)) continue
    if (only && !only.has(r.block.id)) continue
    blockCount += 1
    if (typeof amount === 'number') totalAmountCny += amount
    else unpricedCount += 1
    const docNo = r.block.docNo || r.jobNo || '—'
    for (const m of r.block.members) {
      lines.push({
        key: `${r.block.id}:${m.componentId}`,
        date: closedAt,
        docNo,
        title: m.name || '—',
        detail: r.block.activity || '',
        qty: m.qty,
        amountCny: effectiveMemberLineTotal(m, r.block),
        partNo: m.partNo,
        imageUrl: m.imageUrl,
        unitPriceCny: effectiveUnitPriceCny(m, r.block),
        groupId: r.block.id,
        groupAmountCny: amount,
      })
    }
  }
  lines.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.docNo.localeCompare(b.docNo) ||
      (a.groupId ?? '').localeCompare(b.groupId ?? ''),
  )

  const totalQty = lines.reduce((s, l) => s + l.qty, 0)
  // 期间从最早那张没对掉的单算起 —— 纸上写的期间要盖得住纸上的每一行。
  const earliest = lines.length > 0 ? lines[0].date : from

  return {
    kind: 'vendor',
    party,
    from: earliest < from ? earliest : from,
    to,
    lines,
    count: blockCount,
    totalQty,
    totalAmountCny: Math.round(totalAmountCny * 100) / 100,
    unpricedCount,
    invoicedCny: 0,
    paidCny: 0,
    carryAmountCny,
    carryCount,
  }
}

/**
 * 供应商名单 —— 一家一行, 数是截至这个月底**还没对过账**的回厂单, 也就是现
 * 在该跟他对、该付他的。对过的不算, 以前月份没对掉的算上。
 */
export function vendorOptions(
  rows: OpenBlockRow[],
  vendors: Vendor[],
  from: string,
  to: string,
  settledOf: (vendor: string) => VendorSettled = () => NO_VENDOR_SETTLED,
): DuizhangParty[] {
  void from
  const nameOf = new Map(vendors.map((v) => [v.id, v.name]))
  const vendorOf = (r: OpenBlockRow) => nameOf.get(r.block.vendorId) ?? r.block.vendorId
  return rollupParties(
    rows,
    vendorOf,
    (r) => {
      const closedAt = blockClosedAt(r.block)
      return (
        !!closedAt &&
        closedAt <= to &&
        !isSettledBlock(r.block, closedAt, settledOf(vendorOf(r)))
      )
    },
    (r) => blockSettleAmount(r.block) ?? 0,
  )
}

// === 单据上的字 ===

export const DUIZHANG_TITLE: Record<DuizhangKind, string> = {
  customer: '客户对账单',
  vendor: '外协对账单',
}

export const DUIZHANG_PARTY_LABEL: Record<DuizhangKind, string> = {
  customer: '客户名称',
  vendor: '供应商',
}

export const DUIZHANG_DOCNO_LABEL: Record<DuizhangKind, string> = {
  customer: '交货单号',
  vendor: '外协单号',
}

export const DUIZHANG_DATE_LABEL: Record<DuizhangKind, string> = {
  customer: '出货日期',
  vendor: '回厂日期',
}

export const DUIZHANG_TITLE_LABEL: Record<DuizhangKind, string> = {
  customer: '物料名称',
  vendor: '零件名称',
}

export const DUIZHANG_DETAIL_LABEL: Record<DuizhangKind, string> = {
  customer: '物料号',
  vendor: '工序',
}

/** 双方签章那一栏的抬头。 */
export const DUIZHANG_SIGN: Record<DuizhangKind, [string, string]> = {
  customer: ['供方 (盖章)', '需方 (盖章)'],
  vendor: ['需方 (盖章)', '供方 (盖章)'],
}
