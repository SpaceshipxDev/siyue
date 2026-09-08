import 'server-only'
import { redirect } from 'next/navigation'
import {
  canManageOutsource,
  canSeeOrderLedger,
  requireUser,
  type AuthUser,
} from '@/lib/auth'
import { getFinanceRows, getOutsourceBlockRows, getVendors } from '@/lib/db'
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
  if (kind === 'customer') {
    const rows = await getFinanceRows()
    parties = customerOptions(rows, from, to, shanghaiDay)
    if (party) sheet = buildCustomerDuizhang(rows, party, from, to, shanghaiDay)
  } else {
    const [rows, vendors] = await Promise.all([getOutsourceBlockRows(), getVendors()])
    parties = vendorOptions(rows, vendors, from, to)
    if (party) sheet = buildVendorDuizhang(rows, vendors, party, from, to)
  }

  return { user, kind, party, month, todayStr, sheet, parties, canCustomer, canVendor }
}
