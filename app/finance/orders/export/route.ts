import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import { requireCommerce } from '@/lib/auth'
import { getOrderMoneyRows } from '@/lib/db'
import { today } from '@/lib/today'
import {
  applyOrderMoneyFilters,
  buildOrderExportAoa,
  ORDER_EXPORT_COL_WIDTHS,
  isOrderMoneyFilter,
} from '@/lib/order-money'

// 订单资金 board → .xlsx, one row per order, money pipeline left-to-right.
// Honors the same search (q) + filter the /finance?tab=orders page is showing,
// so "导出" means "export what's on screen". Numbers stay numeric so the boss
// can SUM any column — it IS Excel, already filled in. Commerce-only.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest): Promise<Response> {
  await requireCommerce()

  const sp = request.nextUrl.searchParams
  const q = sp.get('q') ?? ''
  const filterRaw = sp.get('filter') ?? 'all'
  const filter = isOrderMoneyFilter(filterRaw) ? filterRaw : 'all'

  const todayStr = today()
  const all = await getOrderMoneyRows()
  const rows = applyOrderMoneyFilters(all, { q, filter })

  const ws = XLSX.utils.aoa_to_sheet(buildOrderExportAoa(rows, todayStr))
  ws['!cols'] = ORDER_EXPORT_COL_WIDTHS.map((wch) => ({ wch }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '订单资金')
  const body = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer

  const base = `订单资金_${todayStr}`
  const fallback = `orders_money_${todayStr}.xlsx`
  const encoded = encodeURIComponent(`${base}.xlsx`)

  return new Response(body, {
    headers: {
      'content-type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
      'cache-control': 'no-store',
    },
  })
}
