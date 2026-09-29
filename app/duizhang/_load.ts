import 'server-only'
import { redirect } from 'next/navigation'
import {
  canSettleAccounts,
  canManageOutsource,
  canSeeOrderLedger,
  requireUser,
  type AuthUser,
} from '@/lib/auth'
import { findActiveReceivable } from '@/lib/receivable'
import { getPayables, vendorSettledFrom } from '@/lib/payable'
import type { Payable, Receivable } from '@/lib/settle-shared'
import {
  getCustomerStatementLines,
  getFinanceRows,
  getOutsourceBlockRows,
  getVendors,
} from '@/lib/db'
import { shanghaiDay, today } from '@/lib/today'
import {
  buildCustomerDuizhang,
  buildVendorDuizhang,
  customerOptions,
  isDuizhangKind,
  isMonth,
  monthBounds,
  vendorOptions,
  type Duizhang,
  type DuizhangKind,
  type DuizhangParty,
} from '@/lib/duizhang'

// 对账单的取数口 —— 页面和 PDF 走同一条路, 所以纸上和屏幕上不可能是两个数。
// 权限也在这里: 客户那半边跟着订单台账走, 供应商那半边跟着外协台走。

export type DuizhangLoad = {
  user: AuthUser
  kind: DuizhangKind
  party: string
  month: string
  todayStr: string
  sheet: Duizhang | null
  parties: DuizhangParty[]
  canCustomer: boolean
  canVendor: boolean
  /** 客户: 这个客户这个月那张还算数的应收单; 没审批就是 null。外协用下面那一格。 */
  record: Receivable | Payable | null
  /**
   * 外协: 这一家这个月已经确认过的应付单 (一个月可以分几回对, 所以是一串)。
   * 它们认过的外协单已经不在对账单上了。
   */
  vendorRecords: Payable[]
  /** 审批 / 确认 / 记收付款 —— 管钱那一档。 */
  canApprove: boolean
  /** 能进财务的应收/应付 (每个商务)。 */
  canOpenLedger: boolean
}

export async function loadDuizhang(params: {
  kind?: string
  name?: string
  m?: string
  /** 外协: 只要这几张外协单 (逗号分开) —— 打印勾选的那几张用。 */
  sel?: string
}): Promise<DuizhangLoad> {
  const user = await requireUser()
  const kind: DuizhangKind = isDuizhangKind(params.kind) ? params.kind : 'customer'

  const canCustomer = canSeeOrderLedger(user)
  const canVendor = canManageOutsource(user)
  if (kind === 'customer' && !canCustomer) redirect(canVendor ? '/duizhang?kind=vendor' : '/')
  if (kind === 'vendor' && !canVendor) redirect(canCustomer ? '/duizhang' : '/')

  const todayStr = today()
  const month = isMonth(params.m) ? params.m : todayStr.slice(0, 7)
  const { from, to } = monthBounds(month)
  const party = (params.name ?? '').trim()

  let sheet: Duizhang | null = null
  let parties: DuizhangParty[] = []
  let record: Receivable | Payable | null = null
  let vendorRecords: Payable[] = []
  if (kind === 'customer') {
    const rows = await getFinanceRows()
    parties = customerOptions(rows, from, to, shanghaiDay)
    if (party) {
      // 零件级明细 —— 只有真的选了客户才去取 (四步窄查询, 见 lib/db)。
      const [detail, rec] = await Promise.all([
        getCustomerStatementLines(party, from, to, shanghaiDay),
        findActiveReceivable(party, month),
      ])
      sheet = buildCustomerDuizhang(rows, party, from, to, shanghaiDay, detail)
      record = rec ?? null
    }
  } else {
    const [rows, vendors, payables] = await Promise.all([
      getOutsourceBlockRows(),
      getVendors(),
      getPayables(),
    ])
    // 对过账的单不再上对账单 —— 名单上的数和纸上的行都只算还没对的。
    const settledOf = (v: string) => vendorSettledFrom(payables, v)
    parties = vendorOptions(rows, vendors, from, to, settledOf)
    if (party) {
      const only = params.sel
        ? new Set(params.sel.split(',').map((x) => x.trim()).filter(Boolean))
        : undefined
      // 指名要这几张 (打印勾选的、从应付单重印当时那张) 就照给, 不管对没对过。
      sheet = buildVendorDuizhang(
        rows,
        vendors,
        party,
        from,
        to,
        only ? undefined : settledOf(party),
        only,
      )
      vendorRecords = payables.filter(
        (p) => !p.voidedAt && p.vendor === party && p.period === month,
      )
    }
  }

  return {
    user,
    kind,
    party,
    month,
    todayStr,
    sheet,
    parties,
    canCustomer,
    canVendor,
    record,
    vendorRecords,
    canApprove: canSettleAccounts(user),
    canOpenLedger: user.role === 'commerce',
  }
}
