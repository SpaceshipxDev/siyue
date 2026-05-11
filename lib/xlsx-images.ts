import { unzipSync, strFromU8 } from 'fflate'

export const IMG_MARKER_PREFIX = '<<IMG:'
export const IMG_MARKER_SUFFIX = '>>'

export function imgMarker(ref: string): string {
  return `${IMG_MARKER_PREFIX}${ref}${IMG_MARKER_SUFFIX}`
}

/*
 * Extract images from .xlsx workbooks and resolve which sheet cell each one
 * is anchored to. Two anchor formats are supported:
 *
 *   1. WPS Office  — cells contain a `_xlfn.DISPIMG("ID_xxx", 1)` formula.
 *      `xl/cellimages.xml` maps each ID to a relationship; the sibling rels
 *      file maps the relationship to a `xl/media/imageN.*` zip entry.
 *
 *   2. Microsoft Excel — `xl/drawings/drawingN.xml` carries explicit
 *      `xdr:twoCellAnchor` / `xdr:oneCellAnchor` entries with row+col anchors,
 *      and the embed rel resolves to the media file the same way.
 *
 * The output keeps both: a flat list of anchors `{sheet, row, col, imageRef}`
 * and the image bytes keyed by `imageRef`. Refs are short, sequential strings
 * (`img1`, `img2`, …) so they're easy to round-trip through an LLM prompt.
 */

export type ExtractedImage = {
  ref: string
  mime: string
  ext: string
  bytes: Uint8Array
}

export type SheetImageAnchor = {
  sheet: string
  row: number
  col: number
  imageRef: string
}

export type WorkbookImages = {
  anchors: SheetImageAnchor[]
  images: Map<string, ExtractedImage>
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

function extOf(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path)
  return m ? m[1].toLowerCase() : 'bin'
}

function colLettersToIndex(letters: string): number {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function parseCellAddr(addr: string): { row: number; col: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(addr)
  if (!m) return null
  return { row: parseInt(m[2], 10) - 1, col: colLettersToIndex(m[1]) }
}

// Resolve a path inside the package using the dir that owns the relationship.
// Rels paths in OOXML are relative to the *document* the rels file describes,
// not to the rels file itself.
function resolveRel(docDir: string, target: string): string {
  const parts = (docDir.replace(/\/?$/, '/') + target).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '..') out.pop()
    else if (p && p !== '.') out.push(p)
  }
  return out.join('/')
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

function relsPathFor(docPath: string): string {
  const dir = dirOf(docPath)
  const base = docPath.slice(dir.length + (dir ? 1 : 0))
  return `${dir ? dir + '/' : ''}_rels/${base}.rels`
}

type Rel = { id: string; type: string; target: string }

function parseRels(xml: string): Rel[] {
  const rels: Rel[] = []
  const re = /<Relationship\b[^>]*\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0]
    const id = /\bId="([^"]+)"/.exec(tag)?.[1]
    const type = /\bType="([^"]+)"/.exec(tag)?.[1]
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1]
    if (id && type && target) rels.push({ id, type, target })
  }
  return rels
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

type Sheet = { name: string; path: string }

function parseSheetIndex(workbookXml: string, workbookRels: Rel[]): Sheet[] {
  const byId = new Map(workbookRels.map((r) => [r.id, r]))
  const sheets: Sheet[] = []
  const re = /<sheet\b[^>]*\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(workbookXml)) !== null) {
    const tag = m[0]
    const name = /\bname="([^"]+)"/.exec(tag)?.[1]
    const rid = /\br:id="([^"]+)"/.exec(tag)?.[1]
    if (!name || !rid) continue
    const rel = byId.get(rid)
    if (!rel) continue
    sheets.push({
      name: decodeXmlEntities(name),
      path: resolveRel('xl', rel.target),
    })
  }
  return sheets
}

// WPS DISPIMG cells: each has `<c r="ADDR" ...><f>...DISPIMG("ID_xxx", 1)...</f>...</c>`.
// We pull every `(addr, imageId)` pair the sheet declares.
function parseDispimgCells(sheetXml: string): { addr: string; imageId: string }[] {
  const out: { addr: string; imageId: string }[] = []
  const re = /<c\b[^>]*\br="([A-Z]+\d+)"[^>]*>\s*<f[^>]*>([^<]*)<\/f>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sheetXml)) !== null) {
    const addr = m[1]
    const formula = decodeXmlEntities(m[2])
    const idMatch = /DISPIMG\(\s*"([^"]+)"/.exec(formula)
    if (idMatch) out.push({ addr, imageId: idMatch[1] })
  }
  return out
}

// `xl/cellimages.xml`: pair each `name="ID_xxx"` with the immediately-following
// `r:embed="rIdN"` inside the same etc:cellImage block.
function parseCellImagesIndex(xml: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /<etc:cellImage\b[\s\S]*?<\/etc:cellImage>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const block = m[0]
    const name = /\bname="(ID_[^"]+)"/.exec(block)?.[1]
    const embed = /\br:embed="([^"]+)"/.exec(block)?.[1]
    if (name && embed) out.set(name, embed)
  }
  return out
}

// Standard drawings: each `xdr:twoCellAnchor` / `xdr:oneCellAnchor` containing
// an `<xdr:pic>` resolves to one image, anchored to the `xdr:from` cell.
function parseDrawingAnchors(
  xml: string,
): { row: number; col: number; embed: string }[] {
  const out: { row: number; col: number; embed: string }[] = []
  const re = /<xdr:(?:twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/xdr:(?:twoCellAnchor|oneCellAnchor)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const block = m[0]
    if (!/<xdr:pic\b/.test(block)) continue
    const from = /<xdr:from>([\s\S]*?)<\/xdr:from>/.exec(block)?.[1]
    if (!from) continue
    const colStr = /<xdr:col>(\d+)<\/xdr:col>/.exec(from)?.[1]
    const rowStr = /<xdr:row>(\d+)<\/xdr:row>/.exec(from)?.[1]
    const embed = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(block)?.[1]
    if (colStr == null || rowStr == null || !embed) continue
    out.push({ row: parseInt(rowStr, 10), col: parseInt(colStr, 10), embed })
  }
  return out
}

/**
 * Splice image markers into a sheet's aoa in place, returning the updated rows.
 * For every anchor on this sheet, the cell at (row, col) is set to
 * `<<IMG:imgRef>>` so an LLM reading the aoa sees an unambiguous placeholder
 * instead of a `=DISPIMG(...)` formula.
 */
export function annotateSheetWithImages<T extends (string | number | boolean | null)[]>(
  sheetName: string,
  aoa: T[],
  anchors: SheetImageAnchor[],
): T[] {
  for (const a of anchors) {
    if (a.sheet !== sheetName) continue
    while (aoa.length <= a.row) aoa.push([] as unknown as T)
    const row = aoa[a.row]
    while (row.length <= a.col) (row as unknown[]).push(null)
    ;(row as unknown[])[a.col] = imgMarker(a.imageRef)
  }
  return aoa
}

export function extractWorkbookImages(buf: ArrayBuffer): WorkbookImages {
  const zip = unzipSync(new Uint8Array(buf))
  const text = (key: string): string | null => {
    const u8 = zip[key]
    return u8 ? strFromU8(u8) : null
  }

  const workbookXml = text('xl/workbook.xml')
  const workbookRelsXml = text('xl/_rels/workbook.xml.rels')
  if (!workbookXml || !workbookRelsXml) return { anchors: [], images: new Map() }
  const sheets = parseSheetIndex(workbookXml, parseRels(workbookRelsXml))

  // Build a lazy ref allocator keyed by media path so the same image used in
  // multiple cells still yields one ref + one upload.
  const images = new Map<string, ExtractedImage>()
  const refByMediaPath = new Map<string, string>()
  let refSeq = 0
  const refFor = (mediaPath: string): string | null => {
    const cached = refByMediaPath.get(mediaPath)
    if (cached) return cached
    const u8 = zip[mediaPath]
    if (!u8) return null
    refSeq += 1
    const ref = `img${refSeq}`
    const ext = extOf(mediaPath)
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
    images.set(ref, { ref, mime, ext, bytes: u8 })
    refByMediaPath.set(mediaPath, ref)
    return ref
  }

  // WPS path: cellimages.xml + DISPIMG formulas. Both files are global to the
  // workbook, so we resolve once and reuse across every sheet.
  const cellImagesXml = text('xl/cellimages.xml')
  const cellImagesRelsXml = text('xl/_rels/cellimages.xml.rels')
  const dispimgRefById = new Map<string, string>() // imageId -> imageRef
  if (cellImagesXml && cellImagesRelsXml) {
    const idToRel = parseCellImagesIndex(cellImagesXml)
    const relTargets = new Map(parseRels(cellImagesRelsXml).map((r) => [r.id, r.target]))
    for (const [id, embed] of idToRel) {
      const target = relTargets.get(embed)
      if (!target) continue
      const mediaPath = resolveRel('xl', target)
      const ref = refFor(mediaPath)
      if (ref) dispimgRefById.set(id, ref)
    }
  }

  // WPS workbooks ship a stub `xl/drawings/drawing1.xml` full of decoy anchors
  // that reference a ~49-byte sentinel GIF — template chrome, not real photos.
  // We used to skip the entire standard-drawing path whenever cellimages.xml
  // had any resolvable IDs, but that dropped real floating images in mixed-mode
  // files (embedded DISPIMG + drag-pasted screenshots). Instead, run both paths
  // unconditionally and filter out individual anchors whose underlying media is
  // suspiciously small — any real industrial part photo is well above this
  // threshold, so the only thing it removes is the WPS sentinel.
  const SENTINEL_MAX_BYTES = 512

  const anchors: SheetImageAnchor[] = []

  for (const sheet of sheets) {
    const sheetXml = text(sheet.path)
    if (!sheetXml) continue

    // (a) DISPIMG cells
    if (dispimgRefById.size > 0) {
      for (const cell of parseDispimgCells(sheetXml)) {
        const ref = dispimgRefById.get(cell.imageId)
        const pos = parseCellAddr(cell.addr)
        if (!ref || !pos) continue
        anchors.push({ sheet: sheet.name, row: pos.row, col: pos.col, imageRef: ref })
      }
    }

    // (b) standard drawings — follow sheet rels → drawing → drawing rels
    const sheetRelsXml = text(relsPathFor(sheet.path))
    if (!sheetRelsXml) continue
    const sheetRels = parseRels(sheetRelsXml)
    const drawingRels = sheetRels.filter((r) => r.type.endsWith('/drawing'))
    for (const dr of drawingRels) {
      const drawingPath = resolveRel(dirOf(sheet.path), dr.target)
      const drawingXml = text(drawingPath)
      if (!drawingXml) continue
      const drawingRelsXml = text(relsPathFor(drawingPath))
      const drawingRelTargets = drawingRelsXml
        ? new Map(parseRels(drawingRelsXml).map((r) => [r.id, r.target]))
        : new Map<string, string>()
      for (const a of parseDrawingAnchors(drawingXml)) {
        const target = drawingRelTargets.get(a.embed)
        if (!target) continue
        const mediaPath = resolveRel(dirOf(drawingPath), target)
        const u8 = zip[mediaPath]
        if (!u8 || u8.length < SENTINEL_MAX_BYTES) continue
        const ref = refFor(mediaPath)
        if (!ref) continue
        anchors.push({ sheet: sheet.name, row: a.row, col: a.col, imageRef: ref })
      }
    }
  }

  return { anchors, images }
}
