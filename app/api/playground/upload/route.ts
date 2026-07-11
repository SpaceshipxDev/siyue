import { NextRequest } from 'next/server'
import { parseWorkbook } from '@/lib/xlsx'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(request: NextRequest) {
  const form = await request.formData()
  const file = form.get('file')
  if (!(file instanceof File)) {
    return Response.json({ error: 'no file' }, { status: 400 })
  }

  try {
    const buf = await file.arrayBuffer()
    const wb = parseWorkbook(buf, file.name)
    // Mirror what app/api/ingest/route.ts forwards to gemini today:
    // only { name, aoa } per sheet — records/ref/rows/cols are dropped.
    const sheets = wb.sheets.map((s) => ({ name: s.name, aoa: s.aoa }))
    return Response.json({
      fileName: wb.fileName,
      sizeBytes: file.size,
      sheetNames: wb.sheetNames,
      sheetMeta: wb.sheets.map((s) => ({
        name: s.name,
        ref: s.ref,
        rows: s.rows,
        cols: s.cols,
      })),
      sheets,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: `parse failed: ${message}` }, { status: 500 })
  }
}
