import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import { requireReportViewer } from '@/lib/auth'
import { getDefectRows } from '@/lib/db'
import { today } from '@/lib/today'

// 不良记录 → .xlsx. 导的就是屏幕上那一批 (同一个月份 + 同一个搜索词), 所以
// "导出"永远等于"我现在看到的这些"。检验 (过程检) 和 质量 (成品检) 一起。
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEADERS = [
  '日期',
  '工号',
  '客户',
  '零件',
  '环节',
  '判定',
  '不良原因',
  '责任人',
  '判定人',
]
const WIDTHS = [12, 16, 20, 24, 10, 8, 30, 12, 12]

export async function GET(request: NextRequest): Promise<Response> {
  await requireReportViewer()
  const sp = request.nextUrl.searchParams
  const month = /^\d{4}-\d{2}$/.test(sp.get('m') ?? '')
    ? (sp.get('m') as string)
    : today().slice(0, 7)
  const q = (sp.get('q') ?? '').trim().toLowerCase()

  const all = await getDefectRows()
  const rows = all
    .filter((r) => (r.at ?? '').slice(0, 7) === month)
    .filter((r) =>
      !q
        ? true
        : [r.jobNo, r.customer, r.partName, r.reason, r.owner, r.by]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(q),
    )

  const aoa: (string | number)[][] = [HEADERS.slice()]
  for (const r of rows) {
    aoa.push([
      (r.at ?? '').slice(0, 10),
      r.jobNo,
      r.customer,
      r.partName,
      r.stage === '质量' ? '成品检' : '检验',
      r.verdict,
      r.reason ?? '',
      r.owner ?? '',
      r.by ?? '',
    ])
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = WIDTHS.map((wch) => ({ wch }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '不良记录')
  const body = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer

  const base = `不良记录_${month}`
  return new Response(body, {
    headers: {
      'content-type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="defects_${month}.xlsx"; filename*=UTF-8''${encodeURIComponent(`${base}.xlsx`)}`,
      'cache-control': 'no-store',
    },
  })
}
