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
import { findActivePayable } from '@/lib/payable'
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
  /** 这一方这个月那张还算数的应收单 (客户) / 应付单 (外协); 没认就是 null。 */
  record: Receivable | Payable | null
  /** 审批 / 确认 / 记收付款 —— 管钱那一档。 */
  canApprove: boolean
  /** 能进财务的应收/应付 (每个商务)。 */
  canOpenLedger: boolean
}

export async function loadDuizhang(params: {
  kind?: string
  name?: string
  m?: string
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
    const [rows, vendors, rec] = await Promise.all([
      getOutsourceBlockRows(),
      getVendors(),
      party ? findActivePayable(party, month) : Promise.resolve(undefined),
    ])
    parties = vendorOptions(rows, vendors, from, to)
    if (party) {
      sheet = buildVendorDuizhang(rows, vendors, party, from, to)
      record = rec ?? null
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
    canApprove: canSettleAccounts(user),
    canOpenLedger: user.role === 'commerce',
  }
}
