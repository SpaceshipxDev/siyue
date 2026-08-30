import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import { requireFinance } from '@/lib/auth'
import { getHrMonth } from '@/lib/hr'
import {
  buildPayrollExportAoa,
  buildPayslips,
  isPayrollMonth,
  monthLabel,
  summarizeAttendance,
  PAYROLL_EXPORT_COL_WIDTHS,
} from '@/lib/payroll'
import {
  getPayrollBase,
  getPayrollRules,
  getPayrollSheet,
} from '@/lib/payroll-store'
import { today } from '@/lib/today'

// 工资表 → .xlsx. The sheet they print on payday: every person's month with
// the arithmetic spelled out, a 合计 row, and an empty 签字 column. A month
// that's been 发放'd exports its frozen 工资条 — the same numbers that were
// handed over. Same gate as 支出/工资 (boss + designated finance users).

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest): Promise<Response> {
  await requireFinance()

  const raw = request.nextUrl.searchParams.get('m') ?? ''
  const month = isPayrollMonth(raw) ? raw : today().slice(0, 7)

  const [rules, base, sheet, hr] = await Promise.all([
    getPayrollRules(),
    getPayrollBase(),
    getPayrollSheet(month),
    getHrMonth(month),
  ])
  const slips = sheet.paid
    ? sheet.paid.slips
    : buildPayslips(base, summarizeAttendance(hr), sheet.lines, rules, month)

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
