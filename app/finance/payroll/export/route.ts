import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import { requireFinance } from '@/lib/auth'
import {
  buildPayrollExportAoa,
  isPayrollMonth,
  monthLabel,
  PAYROLL_EXPORT_COL_WIDTHS,
} from '@/lib/payroll'
import { loadPayroll } from '@/lib/payroll-store'
import { today } from '@/lib/today'

// 工资表 → .xlsx. The sheet they print on payday: every person's month with
// the arithmetic spelled out, a 合计 row, and an empty 签字 column. Reads the
// month through the same loadPayroll the 工资 tab uses, so the file can never
// disagree with the screen it came from — including a 发放'd month, which
// exports the frozen 工资条 that were actually handed over. Same gate as
// 支出/工资 (boss + designated finance users).

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest): Promise<Response> {
  await requireFinance()

  const raw = request.nextUrl.searchParams.get('m') ?? ''
  const month = isPayrollMonth(raw) ? raw : today().slice(0, 7)
  const { slips } = await loadPayroll(month)

  const ws = XLSX.utils.aoa_to_sheet(buildPayrollExportAoa(slips))
  ws['!cols'] = PAYROLL_EXPORT_COL_WIDTHS.map((wch) => ({ wch }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '工资表')
  const body = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer

  const fileBase = `${monthLabel(month)}工资表`
  const fallback = `payroll_${month}.xlsx`
  const encoded = encodeURIComponent(`${fileBase}.xlsx`)

  return new Response(body, {
    headers: {
      'content-type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
      'cache-control': 'no-store',
    },
  })
}
