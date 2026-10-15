import 'server-only'
import ExcelJS from 'exceljs'
import { fetchImages, type ImageSource } from '@/lib/pdf/images'
import {
  cleanJobNo,
  commOrderTitle,
  type CommImage,
  type CommOrder,
  type CommOrderRow,
} from '@/lib/comm-order'
import { roundLabel } from '@/lib/comm-order-label'

// 工单分析沟通确认单 ⇄ Excel。表头照厂里原来那张: 标题一行, 交期一行, 表头两
// 行 (缺失说明下面还有一行小字), 每次沟通一行, 图片嵌在格子里。用 exceljs (能
// 读写图片)。

const FONT = '宋体'
const THIN = { style: 'thin' as const, color: { argb: 'FF000000' } }
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN }

const COLS = [
  { head: '序号', width: 10 },
  { head: '文件名/图号', width: 20 },
  { head: '图片', width: 22 },
  { head: '文件/图纸要求（截图）', width: 24 },
  { head: '不满足与问题说明', width: 24 },
  { head: '改善建议', width: 24 },
  { head: '缺失说明', width: 24 },
  { head: '客户确认结果', width: 22 },
  { head: '客户对接人', width: 14 },
  { head: '记录人', width: 14 },
] as const
const MISSING_SUB = '图档（2D.3D.丝印图.组装图）.配件，色板，适配件'

const IMG_W = 140 // px
const IMG_H = 100

function dims(src: ImageSource): { w: number; h: number } | undefined {
  const b = src.data
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  }
  // JPEG: 找 SOF 段。
  let i = 2
  while (i + 9 < b.length && b[0] === 0xff && b[1] === 0xd8) {
    if (b[i] !== 0xff) return undefined
    const marker = b[i + 1]
    const len = b.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) }
    }
    i += 2 + len
  }
  return undefined
}

function isEmbeddable(src: ImageSource): boolean {
  const b = src.data
  const png = b.length > 8 && b[0] === 0x89 && b[1] === 0x50
  const jpg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8
  return png || jpg
}

function fit(src: ImageSource): { width: number; height: number } {
  const d = dims(src)
  if (!d || !d.w || !d.h) return { width: IMG_W, height: IMG_H }
  const k = Math.min(IMG_W / d.w, IMG_H / d.h, 1)
  return { width: Math.round(d.w * k), height: Math.round(d.h * k) }
}

function shortDay(iso: string): string {
  return iso ? iso.slice(5, 10) : ''
}

// 表头从第几行起 (标题 · 交期 在上面)。
const HEAD = 3

export async function buildCommOrderWorkbook(sheet: CommOrder, due: string): Promise<ExcelJS.Workbook> {
  const all = sheet.rows.flatMap((r) => [...r.images, ...r.reqImages].map((x) => x.url))
  const pics = await fetchImages(all)

  const wb = new ExcelJS.Workbook()
  wb.creator = '越侬'
  const ws = wb.addWorksheet('沟通确认单', { views: [{ showGridLines: false }] })
  ws.columns = COLS.map((c) => ({ width: c.width }))
  const last = COLS.length

  ws.mergeCells(1, 1, 1, last)
  const title = ws.getCell(1, 1)
  title.value = commOrderTitle(sheet.jobNo)
  title.font = { name: FONT, size: 20 }
  title.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(1).height = 40

  ws.mergeCells(2, 1, 2, last)
  const dueCell = ws.getCell(2, 1)
  dueCell.value = `交期：${due}`
  dueCell.font = { name: FONT, size: 12 }
  dueCell.alignment = { horizontal: 'left', vertical: 'middle' }
  ws.getRow(2).height = 24

  const missingCol = COLS.findIndex((c) => c.head === '缺失说明') + 1
  COLS.forEach((c, i) => {
    const col = i + 1
    if (col !== missingCol) ws.mergeCells(HEAD, col, HEAD + 1, col)
    const cell = ws.getCell(HEAD, col)
    cell.value = c.head
  })
  ws.getCell(HEAD + 1, missingCol).value = MISSING_SUB
  for (const r of [HEAD, HEAD + 1]) {
    for (let col = 1; col <= last; col++) {
      const cell = ws.getCell(r, col)
      cell.font = { name: FONT, size: r === HEAD + 1 && col === missingCol ? 10 : 11 }
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
      cell.border = BORDER
    }
  }
  ws.getRow(HEAD).height = 24
  ws.getRow(HEAD + 1).height = 32

  sheet.rows.forEach((r, i) => {
    const rowNum = HEAD + 2 + i
    const row = ws.getRow(rowNum)
    const values: string[] = [
      roundLabel(i),
      r.fileName ?? '',
      '',
      r.req ?? '',
      r.problem ?? '',
      r.suggestion ?? '',
      r.missing ?? '',
      r.result ?? '',
      r.contact ?? '',
      [r.by, shortDay(r.at)].filter(Boolean).join(' '),
    ]
    values.forEach((v, j) => {
      const cell = row.getCell(j + 1)
      cell.value = v
      cell.font = { name: FONT, size: 11 }
      cell.border = BORDER
      cell.alignment = {
        horizontal: j === 0 ? 'center' : 'left',
        // 图片列的字压到底下, 图在上面。
        vertical: j === 3 && r.reqImages.length > 0 ? 'bottom' : 'middle',
        wrapText: true,
      }
    })

    // 先定行高再放图 —— exceljs 按放图那一刻的行高算图在格子里的位置。
    const usable = (list: CommImage[]) =>
      list.map((x) => pics.get(x.url)).filter((x): x is ImageSource => !!x && isEmbeddable(x))
    const a = usable(r.images)
    const b = usable(r.reqImages)
    const n = Math.max(a.length, b.length + (r.req && b.length ? 0.4 : 0))
    row.height = n > 0 ? Math.ceil(n * (IMG_H + 8) * 0.75) : 60
    const place = (ok: ImageSource[], col0: number) => {
      ok.forEach((src, k) => {
        const id = wb.addImage({
          base64: src.data.toString('base64'),
          extension: src.data[0] === 0x89 ? 'png' : 'jpeg',
        })
        ws.addImage(id, {
          tl: { col: col0 + 0.05, row: rowNum - 1 + (k * (IMG_H + 8) * 0.75 + 3) / (row.height ?? 60) },
          ext: fit(src),
          editAs: 'oneCell',
        })
      })
    }
    place(a, 2)
    place(b, 3)
  })

  return wb
}

// ── 导入 ─────────────────────────────────────────────────────────────────

export type ParsedRow = Omit<CommOrderRow, 'id' | 'by' | 'at' | 'images' | 'reqImages'> & {
  images: { data: Buffer; ext: string }[]
  reqImages: { data: Buffer; ext: string }[]
}

const FIELD_OF: [RegExp, keyof ParsedRow][] = [
  [/^图片$/, 'images'],
  [/文件名|图号/, 'fileName'],
  [/要求|截图/, 'reqImages'],
  [/不满足|问题/, 'problem'],
  [/改善|建议/, 'suggestion'],
  [/缺失/, 'missing'],
  [/确认结果|客户确认/, 'result'],
  [/对接人/, 'contact'],
]

/** 读厂里那种沟通确认单 —— 标题里的工号、每次沟通一行、格子里的图。 */
export async function parseCommOrderWorkbook(
  buf: ArrayBuffer,
): Promise<{ jobNo: string; dueDate?: string; rows: ParsedRow[] }> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  const ws = wb.worksheets[0]
  if (!ws) throw new Error('表格是空的')

  const text = (r: number, c: number) => ws.getCell(r, c).text?.trim() ?? ''

  // 标题: 「YN-123工单分析沟通确认单」/「YN-123 沟通确认单」。
  let jobNo = ''
  let dueDate: string | undefined
  let headRow = 0
  for (let r = 1; r <= Math.min(ws.rowCount, 15); r++) {
    for (let c = 1; c <= Math.max(ws.columnCount, 1); c++) {
      const t = text(r, c)
      if (!jobNo && /沟通确认单/.test(t)) {
        const m = t.match(/^(.*?)(工单分析)?沟通确认单/)
        const raw = cleanJobNo(m?.[1] ?? '')
        if (raw && !/^x+$/i.test(raw)) jobNo = raw
      }
      if (!headRow && t === '序号') headRow = r
      // 「交期：2026-10-20」/「交期 10/20」—— 一格里写全, 或者标签和日期分两格。
      if (!dueDate && !headRow && /交期/.test(t)) {
        const d = ymd(t.replace(/.*交期[:：\s]*/, '')) ?? ymd(text(r, c + 1)) ?? ymdCell(ws.getCell(r, c + 1).value)
        if (d) dueDate = d
      }
    }
  }
  if (!headRow) throw new Error('没找到表头（序号那一行）')

  // 表头 → 字段。缺失说明下面那行小字也算表头。
  const colField = new Map<number, keyof ParsedRow>()
  let seqCol = 0
  for (let c = 1; c <= ws.columnCount; c++) {
    const t = text(headRow, c).replace(/\s+/g, '')
    if (t === '序号') seqCol = c
    if (t === '记录人') continue
    const hit = FIELD_OF.find(([re]) => re.test(t))
    if (hit && !colField.has(c)) colField.set(c, hit[1])
  }

  // 图: 按左上角落在哪一格归到那一行那一列。
  const picsAt = new Map<string, { data: Buffer; ext: string }[]>()
  for (const im of ws.getImages()) {
    const img = wb.getImage(Number(im.imageId))
    const data = img?.buffer as Buffer | undefined
    if (!data) continue
    const r = Math.floor(im.range.tl.nativeRow) + 1
    const c = Math.floor(im.range.tl.nativeCol) + 1
    const k = `${r}:${c}`
    picsAt.set(k, [...(picsAt.get(k) ?? []), { data: Buffer.from(data), ext: img.extension || 'png' }])
  }

  const rows: ParsedRow[] = []
  for (let r = headRow + 1; r <= ws.rowCount; r++) {
    // 跟表头合并的那一行 / 缺失说明的小字那一行跳过。
    if (seqCol && text(r, seqCol) === '序号') continue
    if ([...colField.keys()].some((c) => /图档/.test(text(r, c)))) continue
    const out: ParsedRow = { images: [], reqImages: [] }
    let any = false
    for (const [c, f] of colField) {
      const pics = picsAt.get(`${r}:${c}`) ?? []
      if (f === 'images' || f === 'reqImages') {
        out[f].push(...pics)
        if (pics.length) any = true
        if (f === 'reqImages' && text(r, c)) {
          out.req = text(r, c)
          any = true
        }
        continue
      }
      const t = text(r, c)
      if (t) {
        out[f] = t
        any = true
      }
    }
    if (any) rows.push(out)
  }
  return { jobNo, dueDate, rows }
}

function ymd(t: string): string | undefined {
  const m = t.trim().match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  if (!m) return undefined
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

function ymdCell(v: ExcelJS.CellValue): string | undefined {
  if (!(v instanceof Date)) return undefined
  const p = (n: number) => String(n).padStart(2, '0')
  return `${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())}`
}
