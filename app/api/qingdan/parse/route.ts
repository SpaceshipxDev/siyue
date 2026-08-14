import { NextRequest } from 'next/server'
import { parseWorkbook } from '@/lib/xlsx'
import {
  annotateSheetWithImages,
  extractWorkbookImages,
  type WorkbookImages,
} from '@/lib/xlsx-images'
import { canEditProductionFields, currentUser } from '@/lib/auth'
import { errMessage } from '@/lib/err'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/*
 * 清单导入 step 1 — turn an uploaded workbook into something the mapping
 * workspace can render: every sheet as a plain string grid with `<<IMG:ref>>`
 * markers where an embedded picture is anchored (WPS DISPIMG + standard Excel
 * drawings, same extractor the AI import uses), plus small data-URI previews
 * so the workspace can show the actual 图纸 in its cells.
 *
 * No LLM anywhere in this path — the user does the column mapping by hand and
 * commits via /api/qingdan/commit, re-sending the same file so the full-size
 * image bytes never have to round-trip through the browser.
 */

// A mapping surface, not a spreadsheet app — cap what we ship to the client.
const MAX_ROWS = 800
const MAX_COLS = 40
// Preview budget: small per-image cap and a workbook-wide total so a 100-photo
// 生产单 still loads fast. Cells past the budget render a generic 图 chip; the
// real bytes are re-extracted server-side at commit either way.
const PER_IMAGE_PREVIEW_BYTES = 400 * 1024
const TOTAL_PREVIEW_BYTES = 20 * 1024 * 1024

export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user || !canEditProductionFields(user)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let file: File | null = null
  try {
    const form = await request.formData()
    const f = form.get('file')
    if (f instanceof File) file = f
  } catch (err) {
    return Response.json(
      { ok: false, error: `formData: ${errMessage(err)}` },
      { status: 400 },
    )
  }
  if (!file) {
    return Response.json({ ok: false, error: 'no file' }, { status: 400 })
  }

  try {
    const buf = await file.arrayBuffer()
    const wb = parseWorkbook(buf, file.name)

    // .xls / .csv are not zip packages — no embedded images to extract.
    let extracted: WorkbookImages
    try {
      extracted = extractWorkbookImages(buf)
    } catch {
      extracted = { anchors: [], images: new Map() }
    }

    const sheets = wb.sheets.map((s) => {
      const aoa = annotateSheetWithImages(s.name, s.aoa, extracted.anchors)
      return {
        name: s.name,
        totalRows: aoa.length,
        aoa: aoa
          .slice(0, MAX_ROWS)
          .map((row) =>
            row
              .slice(0, MAX_COLS)
              .map((c) => (c == null ? '' : String(c))),
          ),
      }
    })

    let previewBudget = TOTAL_PREVIEW_BYTES
    const images: Record<string, string | null> = {}
    for (const [ref, img] of extracted.images) {
      if (img.bytes.length <= PER_IMAGE_PREVIEW_BYTES && img.bytes.length <= previewBudget) {
        previewBudget -= img.bytes.length
        images[ref] = `data:${img.mime};base64,${Buffer.from(img.bytes).toString('base64')}`
      } else {
        images[ref] = null
      }
    }

    return Response.json({ ok: true, fileName: file.name, sheets, images })
  } catch (err) {
    console.error('[qingdan/parse] failed', { fileName: file.name }, err)
    return Response.json(
      { ok: false, error: errMessage(err) },
      { status: 500 },
    )
  }
}
