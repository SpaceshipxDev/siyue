import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import { requireCommerce } from '@/lib/auth'
import { getFenqiData } from '@/lib/db'
import { today } from '@/lib/today'
import { buildRows, sortRows, passLens, buildFenqiWeiAoa, buildFenqiShouAoa } from '@/lib/fenqi'

// 分期账 (installment ledger) → .xlsx, her two accountant-handoff sheets:
// 未开票 (still owing an invoice) and 已开待收 (invoiced, not yet collected).
// Both are DERIVED from po_lines + money_events, so the Excel can never
// disagree with the /finance ledger. Commerce-only, mirroring /month.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest): Promise<Response> {
  await requireCommerce()

  const todayStr = today()
  const rows = sortRows(buildRows(await getFenqiData(), todayStr))

  const wb = XLSX.utils.book_new()

  const weiWs = XLSX.utils.aoa_to_sheet(
    buildFenqiWeiAoa(rows.filter((r) => passLens(r, 'wei')), todayStr),
  )
  weiWs['!cols'] = [12, 16, 10, 30, 8, 12, 18, 60].map((wch) => ({ wch }))
  XLSX.utils.book_append_sheet(wb, weiWs, '未开票')

  const shouWs = XLSX.utils.aoa_to_sheet(
    buildFenqiShouAoa(rows.filter((r) => passLens(r, 'shou'))),
  )
  shouWs['!cols'] = [16, 18, 12, 12, 24, 12, 50].map((wch) => ({ wch }))
  XLSX.utils.book_append_sheet(wb, shouWs, '已开待收')

  // SheetJS returns an ArrayBuffer for type:'array' — already a valid Response
  // BodyInit, so hand it over directly (no Buffer/Uint8Array conversion).
  const body = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer

  const base = `财务分期账-${todayStr}`
  const fallback = `fenqi_${todayStr}.xlsx`
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
