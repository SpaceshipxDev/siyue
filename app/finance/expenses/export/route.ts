import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import { requireFinance } from '@/lib/auth'
import { getExpenses } from '@/lib/db'
import { today } from '@/lib/today'
import {
  applyExpenseFilters,
  buildExpenseExportAoa,
  EXPENSE_EXPORT_COL_WIDTHS,
  isExpenseFilter,
} from '@/lib/expenses'

// 支出台账 → .xlsx. Honors the same search (q) + category (cat) the 支出 tab
// is showing, so "export" means "export what's on screen". Same gate as the
// tab — boss + designated finance users.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest): Promise<Response> {
  await requireFinance()

  const sp = request.nextUrl.searchParams
  const q = sp.get('q') ?? ''
  const catRaw = sp.get('cat') ?? 'all'
  const filter = isExpenseFilter(catRaw) ? catRaw : 'all'

  const todayStr = today()
  const all = await getExpenses()
  const rows = applyExpenseFilters(all, { q, filter })

  const ws = XLSX.utils.aoa_to_sheet(buildExpenseExportAoa(rows))
  ws['!cols'] = EXPENSE_EXPORT_COL_WIDTHS.map((wch) => ({ wch }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '支出台账')
  const body = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer

  const base = `支出台账_${todayStr}`
  const fallback = `expenses_${todayStr}.xlsx`
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
