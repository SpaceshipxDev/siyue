import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import { requireUser } from '@/lib/auth'
import { getStockMoves, rollupStock } from '@/lib/warehouse'
import { today } from '@/lib/today'

// 库存 / 出入库记录 → .xlsx. 导的就是屏幕上那一批。
//
//   (无参数)   库存 — 每一件物料的 累计入库 / 累计出库 / 库存数量 / 最近变动
//   ?v=log     出入库记录 — 一个月的流水 (同一个月份 + 同一个搜索词)
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STOCK_HEADERS = [
  '物料名称',
  '规格/型号',
  '累计入库',
  '累计出库',
  '库存数量',
  '最近变动',
]
const STOCK_WIDTHS = [28, 24, 12, 12, 12, 14]

const LOG_HEADERS = [
  '日期',
  '物料名称',
  '规格/型号',
  '进出',
  '数量',
  '备注',
  '记录人',
]
const LOG_WIDTHS = [12, 28, 24, 8, 10, 30, 12]

export async function GET(request: NextRequest): Promise<Response> {
  await requireUser()
  const sp = request.nextUrl.searchParams
  const month = /^\d{4}-\d{2}$/.test(sp.get('m') ?? '')
    ? (sp.get('m') as string)
    : today().slice(0, 7)
  const q = (sp.get('q') ?? '').trim().toLowerCase()

  const moves = await getStockMoves()
  const aoa: (string | number)[][] = []
  let widths: number[]
  let sheetName: string
  let base: string
  let file: string

  if (sp.get('v') === 'log') {
    const rows = moves
      .filter((r) => r.date.slice(0, 7) === month)
      .filter((r) =>
        !q
          ? true
          : [r.name, r.spec, r.note, r.by]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(q),
      )
    aoa.push(LOG_HEADERS.slice())
    for (const r of rows) {
      aoa.push([
        r.date,
        r.name,
        r.spec,
        r.kind === 'in' ? '入库' : '出库',
        r.qty,
        r.note,
        r.by ?? '',
      ])
    }
    // 合计 — 这个月进了多少、出了多少, 分两行, 混在一起加没有意义。
    const inSum = rows
      .filter((r) => r.kind === 'in')
      .reduce((s, r) => s + r.qty, 0)
    const outSum = rows
      .filter((r) => r.kind === 'out')
      .reduce((s, r) => s + r.qty, 0)
    const line = (label: string, v: number): (string | number)[] => {
      const row: (string | number)[] = LOG_HEADERS.map(() => '')
      row[0] = label
      row[LOG_HEADERS.indexOf('数量')] = Math.round(v * 100) / 100
      return row
    }
    aoa.push(line('入库合计', inSum))
    aoa.push(line('出库合计', outSum))
    widths = LOG_WIDTHS
    sheetName = '出入库记录'
    base = `出入库记录_${month}`
    file = `stock_moves_${month}.xlsx`
  } else {
    const items = rollupStock(moves).filter((it) =>
      !q ? true : `${it.name} ${it.spec}`.toLowerCase().includes(q),
    )
    aoa.push(STOCK_HEADERS.slice())
    for (const it of items) {
      aoa.push([it.name, it.spec, it.inQty, it.outQty, it.qty, it.lastDate])
    }
    widths = STOCK_WIDTHS
    sheetName = '库存'
    base = `库存_${today()}`
    file = `stock_${today()}.xlsx`
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
