import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import { requireReportViewer, requireUser } from '@/lib/auth'
import { getDefectRows } from '@/lib/db'
import { getComplaints } from '@/lib/complaints'
import { getProcessDefects } from '@/lib/process-defects'
import { today } from '@/lib/today'

// 质量异常 / 制程不良 / 客诉 → .xlsx. 导的就是屏幕上那一批 (同一个月份 + 同一个搜索
// 词), 所以"导出"永远等于"我现在看到的这些"。
//
//   ?v=defects  质量异常 — 厂里自己检出来的 (检验 + 成品检)
//   ?v=process  制程不良 — 质量落笔的那一份, 带责任人和纠正预防措施
//   ?v=complaint 客诉 — 客户反馈回来的, 带损失金额
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFECT_HEADERS = [
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
const DEFECT_WIDTHS = [12, 16, 20, 24, 10, 8, 30, 12, 12]

const PROCESS_HEADERS = [
  '日期',
  '工单号',
  '不良数量',
  '不良原因',
  '处理方式',
  '直接责任人',
  '间接责任人',
  '纠正预防措施',
  '记录人',
]
const PROCESS_WIDTHS = [12, 16, 10, 28, 24, 12, 12, 34, 12]

const COMPLAINT_HEADERS = [
  '日期',
  '客户',
  '工号',
  '不良数量',
  '不良原因',
  '处理方式',
  '责任人',
  '损失金额',
  '记录人',
]
const COMPLAINT_WIDTHS = [12, 22, 16, 10, 30, 24, 12, 12, 12]

export async function GET(request: NextRequest): Promise<Response> {
  const sp = request.nextUrl.searchParams
  // 制程不良是全厂的表 — 看得到就导得走; 另外两张跟报工同一档。
  if (sp.get('v') === 'process') {
    await requireUser()
  } else {
    await requireReportViewer()
  }
  const month = /^\d{4}-\d{2}$/.test(sp.get('m') ?? '')
    ? (sp.get('m') as string)
    : today().slice(0, 7)
  const q = (sp.get('q') ?? '').trim().toLowerCase()

  const view = sp.get('v')
  const complaints = view === 'complaint'
  const process = view === 'process'
  const aoa: (string | number)[][] = []
  let widths: number[]
  let sheetName: string
  let base: string
  let file: string

  if (process) {
    const rows = (await getProcessDefects())
      .filter((r) => r.date.slice(0, 7) === month)
      .filter((r) =>
        !q
          ? true
          : [r.jobNo, r.reason, r.handling, r.owner, r.coOwner, r.action, r.by]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(q),
      )
    aoa.push(PROCESS_HEADERS.slice())
    for (const r of rows) {
      aoa.push([
        r.date,
        r.jobNo,
        r.qty,
        r.reason,
        r.handling,
        r.owner,
        r.coOwner,
        r.action,
        r.by ?? '',
      ])
    }
    // 合计 — 这个月一共坏了多少件。
    const total: (string | number)[] = PROCESS_HEADERS.map(() => '')
    total[0] = '合计'
    total[PROCESS_HEADERS.indexOf('不良数量')] = rows.reduce(
      (s, r) => s + r.qty,
      0,
    )
    aoa.push(total)
    widths = PROCESS_WIDTHS
    sheetName = '制程不良'
    base = `制程不良_${month}`
    file = `process_defects_${month}.xlsx`
  } else if (complaints) {
    const rows = (await getComplaints())
      .filter((r) => r.date.slice(0, 7) === month)
      .filter((r) =>
        !q
          ? true
          : [r.customer, r.jobNo, r.reason, r.handling, r.owner, r.by]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(q),
      )
    aoa.push(COMPLAINT_HEADERS.slice())
    for (const r of rows) {
      aoa.push([
        r.date,
        r.customer,
        r.jobNo ?? '',
        r.qty,
        r.reason,
        r.handling,
        r.owner,
        r.lossCny,
        r.by ?? '',
      ])
    }
    // 合计 — 客诉表最后要看的是这个月赔了多少。
    const total: (string | number)[] = COMPLAINT_HEADERS.map(() => '')
    total[0] = '合计'
    total[COMPLAINT_HEADERS.indexOf('不良数量')] = rows.reduce(
      (s, r) => s + r.qty,
      0,
    )
    total[COMPLAINT_HEADERS.indexOf('损失金额')] =
      Math.round(rows.reduce((s, r) => s + r.lossCny, 0) * 100) / 100
    aoa.push(total)
    widths = COMPLAINT_WIDTHS
    sheetName = '客诉异常'
    base = `客诉异常_${month}`
    file = `complaints_${month}.xlsx`
  } else {
    const rows = (await getDefectRows())
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
    aoa.push(DEFECT_HEADERS.slice())
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
    widths = DEFECT_WIDTHS
    sheetName = '质量异常'
    base = `质量异常_${month}`
    file = `defects_${month}.xlsx`
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = widths.map((wch) => ({ wch }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  const body = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer

  return new Response(body, {
    headers: {
      'content-type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${file}"; filename*=UTF-8''${encodeURIComponent(`${base}.xlsx`)}`,
      'cache-control': 'no-store',
    },
  })
}
