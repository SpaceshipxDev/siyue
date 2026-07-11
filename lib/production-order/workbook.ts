import 'server-only'
import ExcelJS from 'exceljs'
import type { Job } from '@/lib/data'
import type { ImageSource } from '@/lib/pdf/images'

// 越侬生产单 → editable .xlsx, rebuilt from the order we already store so
// commerce can re-export the shop-floor traveler in one click instead of
// hand-maintaining it in WPS. Geometry mirrors the customer's original
// (YNMX-26-4-21-227.xlsx): a 4-row header block then a 10-column part table
// with an embedded photo per row.
//
// We use exceljs (not the SheetJS `xlsx` used for import parsing) for one
// reason: SheetJS can't write images, and the 零件图片 column is the whole
// point of the document on the floor. The original used WPS's proprietary
// DISPIMG; here we embed normal floating images anchored one-per-cell, which
// open identically in Excel/WPS and stay editable.

// 0-based column indices, left → right, matching the original layout.
const COL = {
  idx: 0, // 序号
  image: 1, // 零件图片
  partNo: 2, // 图号(产品编号)
  name: 3, // 材料(产品名称)
  qty: 4, // 数量
  unit: 5, // 单位
  material: 6, // 材质
  process: 7, // 加工方式
  spec: 8, // 工艺要求
  notes: 9, // 备注
} as const

const HEADERS = [
  '序号',
  '零件图片',
  '图号(产品编号)',
  '材料(产品名称)',
  '数量',
  '单位',
  '材质',
  '加工方式',
  '工艺要求',
  '备注',
]

// Column widths lifted from the customer's own file (YNMX-26-6-23-260.xlsx).
const COL_WIDTHS = [7, 14.125, 20.06, 18.51, 8.375, 8.375, 10.5, 15.375, 17.125, 13.5]

// Image box (px) inside the 零件图片 column; row height set to match.
const IMG_W = 80
const IMG_H = 64
const PART_ROW_HEIGHT = 55 // points, matching the customer's data rows

const THIN = { style: 'thin' as const, color: { argb: 'FF000000' } }
const ALL_BORDERS = { top: THIN, left: THIN, bottom: THIN, right: THIN }

// Chinese production docs render in 宋体 (SimSun) — WPS/Excel's CJK default.
// Pin it so the export looks native rather than falling back to Calibri.
const FONT = '宋体'

function extFor(src: ImageSource): 'png' | 'jpeg' {
  return src.format === 'jpg' ? 'jpeg' : 'png'
}

export async function buildProductionOrderWorkbook(
  job: Job,
  images: Map<string, ImageSource>,
): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook()
  wb.creator = '越侬'
  const ws = wb.addWorksheet('生产单', {
    views: [{ showGridLines: false }],
  })

  ws.columns = COL_WIDTHS.map((width) => ({ width }))

  // ── Title ────────────────────────────────────────────────────────────
  ws.mergeCells('A1:J1')
  const title = ws.getCell('A1')
  title.value = '越侬生产单'
  title.font = { name: FONT, size: 20, bold: true }
  title.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(1).height = 38

  // ── Header block (rows 2–4) ──────────────────────────────────────────
  // Sizes copied from the customer's file: 单号/交期 row all bold 18,
  // 备注 value bold 15 red, 分组/商务 labels bold 15, their values bold 17.
  const headerCell = (
    cell: ExcelJS.Cell,
    size: number,
    opts: { red?: boolean } = {},
  ) => {
    cell.font = {
      name: FONT,
      size,
      bold: true,
      ...(opts.red ? { color: { argb: 'FFFF0000' } } : {}),
    }
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
  }

  ws.mergeCells('A2:B2')
  ws.mergeCells('C2:D2')
  ws.mergeCells('E2:F2')
  ws.mergeCells('G2:H2')
  ws.mergeCells('A3:B4') // 备注 label
  ws.mergeCells('C3:D4') // 备注 value
  ws.mergeCells('E3:F3')
  ws.mergeCells('G3:H3')
  ws.mergeCells('E4:F4')
  ws.mergeCells('G4:H4')
  ws.mergeCells('I2:J4') // mirrors the original's top-right header slot (left empty)

  headerCell(ws.getCell('A2'), 18)
  ws.getCell('A2').value = '销售单号：'
  headerCell(ws.getCell('C2'), 18)
  ws.getCell('C2').value = job.jobNo || ''
  headerCell(ws.getCell('E2'), 18)
  ws.getCell('E2').value = '交期：'
  headerCell(ws.getCell('G2'), 18)
  ws.getCell('G2').value = job.dueDate || ''

  headerCell(ws.getCell('A3'), 18)
  ws.getCell('A3').value = '备 注'
  headerCell(ws.getCell('C3'), 15, { red: true })
  ws.getCell('C3').value = job.notes || ''
  headerCell(ws.getCell('E3'), 15)
  ws.getCell('E3').value = '项目分组：'
  headerCell(ws.getCell('G3'), 17)
  ws.getCell('G3').value = job.isProduct ? '产品' : '手板'
  headerCell(ws.getCell('E4'), 15)
  ws.getCell('E4').value = '跟单商务：'
  headerCell(ws.getCell('G4'), 17)
  ws.getCell('G4').value = job.yuenongBusiness || ''

  // Full grid over the title + header block, borders on every constituent
  // cell so merged regions keep their outlines.
  ws.getRow(2).height = 38
  ws.getRow(3).height = 38
  ws.getRow(4).height = 30
  for (let r = 1; r <= 4; r++) {
    for (let col = 1; col <= HEADERS.length; col++) {
      ws.getRow(r).getCell(col).border = ALL_BORDERS
    }
  }

  // ── Column headers (row 5) ───────────────────────────────────────────
  const headerRow = ws.getRow(5)
  HEADERS.forEach((label, i) => {
    const cell = headerRow.getCell(i + 1)
    cell.value = label
    cell.font = { name: FONT, size: 11 }
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    cell.border = ALL_BORDERS
  })
  headerRow.height = 24

  // ── Part rows (row 6+) ───────────────────────────────────────────────
  job.components.forEach((c, i) => {
    const rowNum = 6 + i
    const row = ws.getRow(rowNum)
    row.height = PART_ROW_HEIGHT

    row.getCell(COL.idx + 1).value = i + 1
    row.getCell(COL.partNo + 1).value = c.partNo || ''
    row.getCell(COL.name + 1).value = c.name || ''
    row.getCell(COL.qty + 1).value = c.qty ?? ''
    row.getCell(COL.unit + 1).value = '件'
    row.getCell(COL.material + 1).value = c.material || ''
    row.getCell(COL.process + 1).value = c.process || ''
    row.getCell(COL.spec + 1).value = c.surfaceTreatment || ''
    row.getCell(COL.notes + 1).value = c.notes || ''

    for (let col = 1; col <= HEADERS.length; col++) {
      const cell = row.getCell(col)
      cell.border = ALL_BORDERS
      cell.font = { name: FONT, size: 11 }
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    }

    // Embedded photo anchored one-per-cell in the 零件图片 column.
    const src = c.imageUrl ? images.get(c.imageUrl) : undefined
    if (src) {
      const id = wb.addImage({
        base64: src.data.toString('base64'),
        extension: extFor(src),
      })
      ws.addImage(id, {
        tl: { col: COL.image + 0.1, row: rowNum - 1 + 0.1 },
        ext: { width: IMG_W, height: IMG_H },
        editAs: 'oneCell',
      })
    }
  })

  return wb
}
