// /x shared brain — types, the op reducer, clipboard parsing, value smarts.
//
// Both storage modes run the exact same pure reducer: demo mode persists the
// resulting state to localStorage, live mode also ships the ops to /api/x
// where the server re-applies them to Postgres. Keeping every mutation an Op
// is what makes optimistic UI + poll-reconcile + undo all trivial.

export type ColKind = 'img' | 'text'
export type Col = { id: string; label: string; kind: ColKind }

export type Group = {
  id: string
  title: string // 客户 / whatever the boss calls this 单
  orderNo: string
  due: string // free text; date-likes get rendered smart
  pos: number
}

export type StageDone = { at: string; by: string } // at = 'YYYY-MM-DD' factory day

export type Row = {
  id: string
  groupId: string
  cells: Record<string, string>
  stageDone: Record<string, StageDone>
  flag: boolean
  pos: number
}

export type SheetState = {
  name: string
  stages: string[]
  columns: Col[]
  groups: Group[]
  rows: Row[]
  version: number
}

export const DEFAULT_STAGES = ['编程', '操机', '手工', '表面', '质检', '出货']

// Deterministic ids for the seed columns so a fresh live sheet and a fresh
// demo sheet look identical and server/client agree without a round trip.
export function defaultColumns(): Col[] {
  return [
    { id: 'c-img', label: '图', kind: 'img' },
    { id: 'c-name', label: '名称', kind: 'text' },
    { id: 'c-qty', label: '数量', kind: 'text' },
    { id: 'c-mat', label: '材料', kind: 'text' },
    { id: 'c-note', label: '备注', kind: 'text' },
  ]
}

export function emptySheet(): SheetState {
  return {
    name: '生产表',
    stages: DEFAULT_STAGES.slice(),
    columns: defaultColumns(),
    groups: [],
    rows: [],
    version: 1,
  }
}

// ---------------------------------------------------------------------------
// Ops

export type Op =
  | { type: 'renameSheet'; name: string }
  | { type: 'setStages'; stages: string[] }
  | { type: 'addColumns'; cols: Col[] }
  | { type: 'renameColumn'; id: string; label: string }
  | { type: 'delColumn'; id: string }
  | { type: 'addGroup'; group: Group }
  | { type: 'editGroup'; id: string; patch: Partial<Pick<Group, 'title' | 'orderNo' | 'due'>> }
  | { type: 'delGroup'; id: string }
  | { type: 'addRows'; rows: Row[] }
  | { type: 'editCell'; rowId: string; colId: string; value: string }
  | { type: 'setStage'; rowId: string; stage: string; done: StageDone | null }
  | { type: 'setFlag'; rowId: string; flag: boolean }
  | { type: 'delRow'; id: string }

export function applyOp(s: SheetState, op: Op): SheetState {
  switch (op.type) {
    case 'renameSheet':
      return { ...s, name: op.name }
    case 'setStages':
      return { ...s, stages: op.stages }
    case 'addColumns': {
      const have = new Set(s.columns.map((c) => c.id))
      const add = op.cols.filter((c) => !have.has(c.id))
      return add.length ? { ...s, columns: [...s.columns, ...add] } : s
    }
    case 'renameColumn':
      return {
        ...s,
        columns: s.columns.map((c) => (c.id === op.id ? { ...c, label: op.label } : c)),
      }
    case 'delColumn':
      return { ...s, columns: s.columns.filter((c) => c.id !== op.id) }
    case 'addGroup':
      return s.groups.some((g) => g.id === op.group.id)
        ? s
        : { ...s, groups: [...s.groups, op.group] }
    case 'editGroup':
      return {
        ...s,
        groups: s.groups.map((g) => (g.id === op.id ? { ...g, ...op.patch } : g)),
      }
    case 'delGroup':
      return {
        ...s,
        groups: s.groups.filter((g) => g.id !== op.id),
        rows: s.rows.filter((r) => r.groupId !== op.id),
      }
    case 'addRows': {
      const have = new Set(s.rows.map((r) => r.id))
      const add = op.rows.filter((r) => !have.has(r.id))
      return add.length ? { ...s, rows: [...s.rows, ...add] } : s
    }
    case 'editCell':
      return {
        ...s,
        rows: s.rows.map((r) => {
          if (r.id !== op.rowId) return r
          const cells = { ...r.cells }
          if (op.value === '') delete cells[op.colId]
          else cells[op.colId] = op.value
          return { ...r, cells }
        }),
      }
    case 'setStage':
      return {
        ...s,
        rows: s.rows.map((r) => {
          if (r.id !== op.rowId) return r
          const stageDone = { ...r.stageDone }
          if (op.done) stageDone[op.stage] = op.done
          else delete stageDone[op.stage]
          return { ...r, stageDone }
        }),
      }
    case 'setFlag':
      return {
        ...s,
        rows: s.rows.map((r) => (r.id === op.rowId ? { ...r, flag: op.flag } : r)),
      }
    case 'delRow':
      return { ...s, rows: s.rows.filter((r) => r.id !== op.id) }
  }
}

export function applyOps(s: SheetState, ops: Op[]): SheetState {
  return ops.reduce(applyOp, s)
}

// ---------------------------------------------------------------------------
// Ids / time

export function rid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  // Old WeChat webview fallback — still a valid v4-shaped uuid.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// Factory day, always Asia/Shanghai — mirrors lib/today.ts (that module is
// fine on the client too, but keeping /x self-contained keeps the demo page
// dependency-free).
export function factoryToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
}

// ---------------------------------------------------------------------------
// Value smarts — semantics live on VALUES, not columns. That's the trick that
// kills the column-mapping wizard: a date-looking cell gets due-date
// treatment wherever it sits, digits right-align, everything else is text.

// '2026-07-10' | '7-10' | '7/10' | '7月10日' → 'YYYY-MM-DD' (yearless → this
// year, Shanghai). Bare decimals like 7.10 stay numbers on purpose.
export function parseDayLike(raw: string): string | null {
  const v = raw.trim()
  if (!v || v.length > 12) return null
  let m = v.match(/^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?$/)
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]))
  m = v.match(/^(\d{1,2})[-/月](\d{1,2})日?$/)
  if (m) {
    const y = Number(factoryToday().slice(0, 4))
    return ymd(y, Number(m[1]), Number(m[2]))
  }
  return null
}

function ymd(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function isNumeric(v: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(v.trim())
}

// Whole-day difference a − b for 'YYYY-MM-DD' strings.
export function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000)
}

export function mdShort(day: string): string {
  return day.length >= 10 ? day.slice(5) : day
}

// A row is "done" when its final stage (出货 by default) is ticked — the
// factory's definition of finished. Untapped middle stages don't block it;
// plenty of parts legitimately skip stations.
export function rowDone(r: Row, stages: string[]): boolean {
  const last = stages[stages.length - 1]
  return !!last && !!r.stageDone[last]
}

// ---------------------------------------------------------------------------
// Clipboard parsing. Excel/WPS put a real <table> on the clipboard as
// text/html (which survives in-cell newlines) plus a TSV text/plain fallback.
// We prefer the HTML, harvest any data-URI images embedded per cell, and trim
// the empty gutter rows/columns WPS loves to copy along.

export type ParsedGrid = {
  grid: string[][] // trimmed text matrix
  imgs: (string | null)[] // per data row (post-header), first data-URI found
  headerLabels: string[] | null // header row labels if row 1 looked like one
}

const HEADER_WORDS = [
  '名称', '零件', '零件名', '零件名称', '品名', '部件', '产品', '品番',
  '数量', '件数', '材料', '材质', '备注', '要求', '说明', '工艺',
  '表面', '表面处理', '处理', '客户', '客户名', '客户名称',
  '单号', '订单号', '工单号', '订单编号', '编号', '图号', '序号',
  '交期', '交货期', '交货日期', '纳期', '日期', '图', '图片', '图纸', '单价', '金额',
]

function looksLikeHeader(cells: string[]): boolean {
  let hits = 0
  for (const c of cells) {
    const v = c.trim()
    if (v && HEADER_WORDS.includes(v)) hits++
  }
  return hits >= 2
}

const CANON: Array<[RegExp, string]> = [
  [/^(名称|零件名称?|品名|零件|部件|产品名?|品番)$/, '名称'],
  [/^(数量|件数)$/, '数量'],
  [/^(材料|材质)$/, '材料'],
  [/^(备注|要求|说明)$/, '备注'],
]

// Normalize a pasted header label onto an existing column label when they
// obviously mean the same thing (零件名称 → 名称), otherwise keep THEIR word.
export function canonLabel(label: string): string {
  const v = label.trim()
  for (const [re, to] of CANON) if (re.test(v)) return to
  return v
}

export const CUSTOMER_ALIASES = /^(客户|客户名|客户名称)$/
export const ORDERNO_ALIASES = /^(单号|订单号|工单号|订单编号)$/
export const DUE_ALIASES = /^(交期|交货期|交货日期|纳期)$/

export function parseClipboard(html: string, text: string): ParsedGrid | null {
  let grid: string[][] = []
  let imgGrid: (string | null)[] = []

  if (html && /<table/i.test(html) && typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const table = doc.querySelector('table')
    if (table) {
      for (const tr of Array.from(table.querySelectorAll('tr'))) {
        const cells = Array.from(tr.querySelectorAll('td,th'))
        if (!cells.length) continue
        grid.push(
          cells.map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim()),
        )
        let img: string | null = null
        for (const td of cells) {
          const el = td.querySelector('img')
          const src = el?.getAttribute('src') ?? ''
          if (src.startsWith('data:image/')) {
            img = src
            break
          }
        }
        imgGrid.push(img)
      }
    }
  }

  if (!grid.length) {
    const lines = text.replace(/\r/g, '').split('\n')
    grid = lines.map((l) => l.split('\t').map((c) => c.trim()))
    imgGrid = lines.map(() => null)
  }

  // Drop fully-empty rows, then fully-empty trailing columns.
  const keep: (string | null)[] = []
  grid = grid.filter((r, i) => {
    const has = r.some((c) => c !== '')
    if (has) keep.push(imgGrid[i] ?? null)
    return has
  })
  imgGrid = keep as (string | null)[]
  if (!grid.length) return null
  const width = Math.max(...grid.map((r) => r.length))
  grid = grid.map((r) => {
    const out = r.slice()
    while (out.length < width) out.push('')
    return out
  })
  let lastUsed = -1
  for (let c = 0; c < width; c++) {
    if (grid.some((r) => r[c] !== '')) lastUsed = c
  }
  grid = grid.map((r) => r.slice(0, lastUsed + 1))
  if (!grid[0]?.length) return null

  const hasHeader = grid.length > 1 && looksLikeHeader(grid[0])
  return {
    grid: hasHeader ? grid.slice(1) : grid,
    imgs: hasHeader ? imgGrid.slice(1) : imgGrid,
    headerLabels: hasHeader ? grid[0] : null,
  }
}

// The full paste → ops planner. Returns the ops to dispatch plus the ids of
// the rows it created (for selection/animation) — pure, so it's testable and
// identical across demo/live.
export type PastePlan = {
  ops: Op[]
  rowIds: string[]
  groupId: string
  newGroup: boolean
  liftedNote: string | null
}

export function planPaste(
  s: SheetState,
  parsed: ParsedGrid,
  target: { groupId: string; afterPos: number } | null,
): PastePlan {
  const { grid, imgs, headerLabels } = parsed
  const ops: Op[] = []

  // --- lift 客户/单号/交期 columns that are constant across the paste ------
  let liftCustomer: string | null = null
  let liftOrderNo: string | null = null
  let liftDue: string | null = null
  const dropCols = new Set<number>()
  if (headerLabels) {
    headerLabels.forEach((label, i) => {
      const v = label.trim()
      const vals = grid.map((r) => r[i] ?? '').filter((x) => x !== '')
      const constant = vals.length > 0 && vals.every((x) => x === vals[0])
      if (!constant) return
      if (CUSTOMER_ALIASES.test(v)) {
        liftCustomer = vals[0]
        dropCols.add(i)
      } else if (ORDERNO_ALIASES.test(v)) {
        liftOrderNo = vals[0]
        dropCols.add(i)
      } else if (DUE_ALIASES.test(v)) {
        liftDue = vals[0]
        dropCols.add(i)
      }
    })
  }

  // --- map pasted columns onto sheet columns -------------------------------
  const textCols = s.columns.filter((c) => c.kind === 'text')
  const width = grid[0].length
  const mapping: (Col | null)[] = []
  const newCols: Col[] = []
  const usedIds = new Set<string>()
  let positional = 0
  for (let i = 0; i < width; i++) {
    if (dropCols.has(i)) {
      mapping.push(null)
      continue
    }
    const rawLabel = headerLabels ? headerLabels[i].trim() : ''
    if (rawLabel) {
      const canon = canonLabel(rawLabel)
      const existing =
        s.columns.find(
          (c) => c.kind === 'text' && !usedIds.has(c.id) && canonLabel(c.label) === canon,
        ) ?? null
      if (existing) {
        mapping.push(existing)
        usedIds.add(existing.id)
      } else {
        const col: Col = { id: `c-${rid().slice(0, 8)}`, label: rawLabel, kind: 'text' }
        newCols.push(col)
        mapping.push(col)
        usedIds.add(col.id)
      }
    } else {
      // Headerless paste: fill existing text columns left-to-right, then
      // overflow into fresh unlabeled columns.
      let col: Col | null = null
      while (positional < textCols.length) {
        const cand = textCols[positional++]
        if (!usedIds.has(cand.id)) {
          col = cand
          break
        }
      }
      if (!col) {
        col = { id: `c-${rid().slice(0, 8)}`, label: '', kind: 'text' }
        newCols.push(col)
      }
      usedIds.add(col.id)
      mapping.push(col)
    }
  }
  if (newCols.length) ops.push({ type: 'addColumns', cols: newCols })

  // --- target group ---------------------------------------------------------
  const imgCol = s.columns.find((c) => c.kind === 'img')
  let groupId: string
  let basePos: number
  let newGroup = false
  if (target) {
    groupId = target.groupId
    basePos = target.afterPos
    if (liftCustomer || liftOrderNo || liftDue) {
      const patch: Partial<Pick<Group, 'title' | 'orderNo' | 'due'>> = {}
      const g = s.groups.find((x) => x.id === groupId)
      if (liftCustomer && g && !g.title) patch.title = liftCustomer
      if (liftOrderNo && g && !g.orderNo) patch.orderNo = liftOrderNo
      if (liftDue && g && !g.due) patch.due = liftDue
      if (Object.keys(patch).length) ops.push({ type: 'editGroup', id: groupId, patch })
    }
  } else {
    newGroup = true
    groupId = rid()
    const maxPos = s.groups.reduce((m, g) => Math.max(m, g.pos), 0)
    ops.push({
      type: 'addGroup',
      group: {
        id: groupId,
        title: liftCustomer ?? '',
        orderNo: liftOrderNo ?? '',
        due: liftDue ?? '',
        pos: maxPos + 1,
      },
    })
    basePos = 0
  }

  // --- rows ------------------------------------------------------------------
  // Fractional positions: appends step by 1; inserts squeeze evenly between
  // the target row and its successor so repeated pastes never collide.
  let step = 1
  if (target) {
    const groupRows = s.rows
      .filter((r) => r.groupId === groupId)
      .sort((a, b) => a.pos - b.pos)
    const next = groupRows.find((r) => r.pos > basePos)
    step = next ? (next.pos - basePos) / (grid.length + 1) : 1
  } else {
    basePos = 0
  }
  const rows: Row[] = grid.map((line, ri) => {
    const cells: Record<string, string> = {}
    line.forEach((val, ci) => {
      const col = mapping[ci]
      if (col && val !== '') cells[col.id] = val
    })
    const img = imgs[ri]
    if (img && imgCol) cells[imgCol.id] = img
    return {
      id: rid(),
      groupId,
      cells,
      stageDone: {},
      flag: false,
      pos: basePos + (ri + 1) * step,
    }
  })
  ops.push({ type: 'addRows', rows })

  const lifted = [
    liftCustomer ? `客户 ${liftCustomer}` : null,
    liftOrderNo ? `单号 ${liftOrderNo}` : null,
    liftDue ? `交期 ${liftDue}` : null,
  ].filter(Boolean)

  return {
    ops,
    rowIds: rows.map((r) => r.id),
    groupId,
    newGroup,
    liftedNote: lifted.length ? lifted.join(' · ') : null,
  }
}

// ---------------------------------------------------------------------------
// Sample data for the 「粘贴示例数据」 button — a believable 手板 order so the
// demo (and TikTok clip) opens with something real-looking. SVG "drawings"
// keep it dependency-free.

function sketch(body: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">` +
    `<rect width="96" height="96" fill="#ffffff"/>` +
    `<g fill="none" stroke="#8a877e" stroke-width="1.6">${body}</g></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const SKETCH_COVER = sketch(
  '<rect x="16" y="22" width="64" height="52" rx="6"/><circle cx="26" cy="32" r="3"/><circle cx="70" cy="32" r="3"/><circle cx="26" cy="64" r="3"/><circle cx="70" cy="64" r="3"/><rect x="34" y="40" width="28" height="16" rx="2" stroke-dasharray="3 3"/>',
)
const SKETCH_SHELL = sketch(
  '<rect x="14" y="18" width="68" height="60" rx="4"/><rect x="24" y="28" width="48" height="40" rx="3"/><line x1="14" y1="48" x2="24" y2="48"/><line x1="72" y1="48" x2="82" y2="48"/>',
)
const SKETCH_BRACKET = sketch(
  '<path d="M24 16 v56 h52" stroke-width="2"/><path d="M24 16 h14 v42 h38 v14" /><circle cx="31" cy="28" r="3.4"/><circle cx="64" cy="65" r="3.4"/>',
)

export function samplePlan(s: SheetState): PastePlan {
  const parsed: ParsedGrid = {
    headerLabels: ['名称', '数量', '材料', '表面处理', '客户', '单号', '交期'],
    grid: [
      ['上盖', '2', '6061', '氧化黑', '华锐光电', 'HR-0703', ''],
      ['底壳', '2', '6061', '氧化黑', '华锐光电', 'HR-0703', ''],
      ['中框', '1', '304', '拉丝', '华锐光电', 'HR-0703', ''],
      ['按键', '4', 'POM', '', '华锐光电', 'HR-0703', ''],
      ['镜片支架', '2', 'PC透明', '抛光', '华锐光电', 'HR-0703', ''],
      ['散热片', '3', '紫铜', '', '华锐光电', 'HR-0703', ''],
    ],
    imgs: [SKETCH_COVER, SKETCH_SHELL, null, null, SKETCH_BRACKET, null],
  }
  // Give the sample a live-looking due date 4 days out.
  const t = factoryToday()
  const [y, m, d] = t.split('-').map(Number)
  const due = new Date(Date.UTC(y, m - 1, d + 4)).toISOString().slice(0, 10)
  parsed.grid = parsed.grid.map((r) => {
    const out = r.slice()
    out[6] = mdShort(due)
    return out
  })
  return planPaste(s, parsed, null)
}
