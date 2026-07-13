import * as XLSX from 'xlsx'

export type SheetPayload = {
  name: string
  ref: string | null
  rows: number
  cols: number
  aoa: (string | number | boolean | null)[][]
  records: Record<string, string | number | boolean | null>[]
}

export type FilePayload = {
  fileName: string
  size: number
  sheetNames: string[]
  sheets: SheetPayload[]
}

export function parseWorkbook(buf: ArrayBuffer, fileName: string): FilePayload {
  const wb = XLSX.read(buf, { type: 'array', cellDates: true })
  const sheets: SheetPayload[] = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name]
    const ref = ws['!ref'] ?? null
    // `blankrows: true` keeps aoa row index aligned with the worksheet's
    // 1-indexed row number (aoa[r] === row r+1). The xlsx-images extractor
    // emits anchors using worksheet row numbers, so aligning here lets us
    // splice image markers into the right cell with no offset math.
    const aoa = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(ws, {
      header: 1,
      defval: null,
      raw: false,
      blankrows: true,
    })
    const records = XLSX.utils.sheet_to_json<Record<string, string | number | boolean | null>>(ws, {
      defval: null,
      raw: false,
      blankrows: false,
    })
    const cols = aoa.reduce((m, r) => Math.max(m, r.length), 0)
    return { name, ref, rows: aoa.length, cols, aoa, records }
  })
  return {
    fileName,
    size: buf.byteLength,
    sheetNames: wb.SheetNames,
    sheets,
  }
}
