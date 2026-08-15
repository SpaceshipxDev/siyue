// 清单导入 column matching — pure logic, no React. Extracted from
// _workspace.tsx so the mapping rules can be exercised headlessly against
// real workbooks (node --experimental-strip-types) before they ship.

export type FieldKey =
  | 'name'
  | 'qty'
  | 'material'
  | 'surfaceTreatment'
  | 'process'
  | 'partNo'
  | 'notes'
  | 'unitPriceCny'
  | 'lineTotalCny'
  | 'image'

// Exact matches against a normalized header cell (spaces/punctuation/units in
// parens stripped). Deliberately exact, not contains — "数量备注" must not
// grab 数量. LIST ORDER IS PRIORITY: when two columns both claim a field
// (加工方式 vs 工艺要求 → process), the header that appears EARLIER in the
// field's list wins, regardless of column position.
export const SYNONYMS: Record<FieldKey, string[]> = {
  name: ['零件名称', '零件名', '名称', '品名', '产品名称', '产品名', '零件', '部件名称', '品番', '项目名称', 'name'],
  qty: ['数量', '件数', '加工数量', '订单数量', '需求数量', '数量件', 'qty', 'quantity'],
  material: ['材料', '材质', '原材料', '材料材质'],
  surfaceTreatment: ['表面处理', '表处', '表面', '后处理', '表面要求', '处理方式'],
  process: ['加工工艺', '工艺', '加工方式', '工艺要求', '加工类型', '加工'],
  // 料号-family ONLY. 图号/规格型号 headers are NOT auto-claimed generically: a
  // drawing number is not a 料号, and auto-labeling one as the other poisons
  // the 出货单/生产单 downstream. The user can still map such a column to
  // 料号 by hand when that's what their sheet actually means. (The 生产单
  // template pass below IS allowed to claim 图号(产品编号) — there the header
  // provably means 料号 because we print it ourselves.)
  partNo: ['料号', '物料编码', '物料编号', '物料号'],
  notes: ['备注', '说明', '要求', '技术要求', '其他要求', 'remark'],
  unitPriceCny: ['单价', '含税单价', '不含税单价', '单价元', 'price'],
  lineTotalCny: ['小计', '金额', '总价', '合计', '总金额', '总额', 'amount'],
  image: ['图片', '图纸', '产品图', '图', '照片', '示意图', '零件图', '图例'],
}

export const SYNONYM_TO_FIELD = new Map<string, FieldKey>()
for (const key of Object.keys(SYNONYMS) as FieldKey[]) {
  for (const s of SYNONYMS[key]) SYNONYM_TO_FIELD.set(s, key)
}

export const IMG_RE = /^<<IMG:([^>]+)>>$/

// Strips the parenthetical AND punctuation: "图号(产品编号)" → "图号".
export function norm(raw: string): string {
  return raw
    .replace(/[（(][^（()）]*[)）]/g, '')
    .replace(/[\s　:：*＊·．.、/\\_-]/g, '')
    .toLowerCase()
}

// Keeps the parenthetical text (parens themselves dropped):
// "图号(产品编号)" → "图号产品编号". Used for exact template recognition,
// where the full composite header IS the signature.
function normFull(raw: string): string {
  return raw
    .replace(/[（()）]/g, '')
    .replace(/[\s　:：*＊·．.、/\\_-]/g, '')
    .toLowerCase()
}

export function detectHeaderRow(aoa: string[][]): number {
  let best = 0
  let bestScore = 0
  for (let r = 0; r < Math.min(aoa.length, 20); r++) {
    let score = 0
    for (const cell of aoa[r] ?? []) {
      const v = norm(cell)
      if (v && SYNONYM_TO_FIELD.has(v)) score++
    }
    if (score > bestScore) {
      bestScore = score
      best = r
    }
  }
  return bestScore >= 2 ? best : 0
}

// ---------------------------------------------------------- 生产单 round-trip
//
// The factory's own 生产单 export (lib/production-order/workbook.ts) prints
// parts under these headers — and 返修 orders come back through 清单导入 as
// that exact file. Its two composite headers are actively misleading to the
// generic pass: 材料(产品名称) holds the PART NAME and 图号(产品编号) holds
// the 料号. Recognize the template by those two signatures and map every
// known header to the field we printed into it.
const PRODUCTION_ORDER_SIG_PARTNO = normFull('图号(产品编号)')
const PRODUCTION_ORDER_SIG_NAME = normFull('材料(产品名称)')
const PRODUCTION_ORDER_HEADERS: Record<string, FieldKey | 'skip'> = {
  [normFull('序号')]: 'skip',
  [normFull('零件图片')]: 'image',
  [normFull('数量')]: 'qty',
  [normFull('单位')]: 'skip',
  [normFull('材质')]: 'material',
  [normFull('加工方式')]: 'process',
  [normFull('工艺要求')]: 'surfaceTreatment', // the 生产单 prints 表面处理 here
  [normFull('备注')]: 'notes',
}

function hasCJK(s: string): boolean {
  return /[一-鿿]/.test(s)
}

export function autoMapColumns(
  aoa: string[][],
  headerRow: number,
): (FieldKey | null)[] {
  const header = aoa[headerRow] ?? []
  const cols = Math.max(header.length, ...aoa.map((r) => r.length), 0)
  const mapping: (FieldKey | null)[] = Array.from({ length: cols }, () => null)
  const used = new Set<FieldKey>()
  const skipped = new Set<number>()

  // The column that actually CONTAINS embedded pictures is the 图纸 column,
  // whatever its header says — resolve it FIRST so its header text (often
  // 图号, with the pictures pasted over) doesn't eat a field another column
  // deserves (e.g. 规格型号 → 图号/料号).
  let imgCol = -1
  let imgBest = 0
  for (let c = 0; c < cols; c++) {
    let count = 0
    for (let r = headerRow + 1; r < aoa.length; r++) {
      if (IMG_RE.test(aoa[r]?.[c] ?? '')) count++
    }
    if (count > imgBest) {
      imgBest = count
      imgCol = c
    }
  }
  if (imgCol >= 0) {
    mapping[imgCol] = 'image'
    used.add('image')
  }

  // 生产单 template pass.
  const full = (c: number) => normFull(header[c] ?? '')
  let sigPartNoCol = -1
  let sigNameCol = -1
  for (let c = 0; c < cols; c++) {
    if (c === imgCol) continue
    if (full(c) === PRODUCTION_ORDER_SIG_PARTNO) sigPartNoCol = c
    if (full(c) === PRODUCTION_ORDER_SIG_NAME) sigNameCol = c
  }
  if (sigPartNoCol >= 0 && sigNameCol >= 0) {
    // Customers reuse this template with the two columns swapped (name text
    // under 图号(产品编号), codes under 材料(产品名称)) — decide orientation
    // from the data: the column whose values carry Chinese is the 零件名称.
    let cjkAtName = 0
    let cjkAtPartNo = 0
    for (let r = headerRow + 1; r < aoa.length; r++) {
      const a = (aoa[r]?.[sigNameCol] ?? '').trim()
      const b = (aoa[r]?.[sigPartNoCol] ?? '').trim()
      if (a && !IMG_RE.test(a) && hasCJK(a)) cjkAtName++
      if (b && !IMG_RE.test(b) && hasCJK(b)) cjkAtPartNo++
    }
    // Tie (or empty columns) keeps our own template's orientation.
    const swap = cjkAtPartNo > cjkAtName
    mapping[swap ? sigPartNoCol : sigNameCol] = 'name'
    mapping[swap ? sigNameCol : sigPartNoCol] = 'partNo'
    used.add('name')
    used.add('partNo')
    for (let c = 0; c < cols; c++) {
      if (c === imgCol || mapping[c]) continue
      const t = PRODUCTION_ORDER_HEADERS[full(c)]
      if (t === 'skip') {
        skipped.add(c)
      } else if (t && !used.has(t)) {
        mapping[c] = t
        used.add(t)
      }
    }
  }

  // Generic pass — rank-ranked, not first-column-wins: collect every
  // (column, field, rank-in-synonym-list) candidate, then award each field to
  // its best-ranked header. A sheet with 加工工艺 in column J and 工艺 in
  // column B must map J, not B.
  const candidates: { c: number; field: FieldKey; rank: number }[] = []
  for (let c = 0; c < cols; c++) {
    if (c === imgCol || mapping[c] || skipped.has(c)) continue
    const h = norm(header[c] ?? '')
    if (!h) continue
    const field = SYNONYM_TO_FIELD.get(h)
    if (!field) continue
    candidates.push({ c, field, rank: SYNONYMS[field].indexOf(h) })
  }
  candidates.sort((a, b) => a.rank - b.rank || a.c - b.c)
  for (const cand of candidates) {
    if (used.has(cand.field) || mapping[cand.c]) continue
    mapping[cand.c] = cand.field
    used.add(cand.field)
  }
  return mapping
}
