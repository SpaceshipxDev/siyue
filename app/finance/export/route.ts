import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import { requireCommerce } from '@/lib/auth'
import { getFinanceRows } from '@/lib/db'
import { today } from '@/lib/today'
import {
  applyFinanceFilters,
  buildExportAoa,
  EXPORT_COL_WIDTHS,
  isFinanceFilter,
} from '@/lib/finance'

// 应收账款 ledger → .xlsx, in 王雪梅's exact column order. Honors the same
// search (q) + status (filter) the /finance page is showing, so "export" means
// "export what's on screen". Commerce-only, mirroring /month.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest): Promise<Response> {
  await requireCommerce()

  const sp = request.nextUrl.searchParams
  const q = sp.get('q') ?? ''
  const filterRaw = sp.get('filter') ?? 'all'
  const filter = isFinanceFilter(filterRaw) ? filterRaw : 'all'

  const todayStr = today()
  const all = await getFinanceRows()
  const rows = applyFinanceFilters(all, { q, filter, todayYmd: todayStr })

  const ws = XLSX.utils.aoa_to_sheet(buildExportAoa(rows))
  ws['!cols'] = EXPORT_COL_WIDTHS.map((wch) => ({ wch }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '应收账款')
  // SheetJS returns an ArrayBuffer for type:'array' — already a valid Response
  // BodyInit, so hand it over directly (no Buffer/Uint8Array conversion).
  const body = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer

  const base = `应收账款_${todayStr}`
  const fallback = `receivables_${todayStr}.xlsx`
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
