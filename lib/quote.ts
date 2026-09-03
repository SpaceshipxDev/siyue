// 报价 — 一个零件值多少钱。
//
// 拆开只有四块，正好是询价时要问的那四件事：
//
//   料钱   = 材料单价 × 单重
//   工钱   = 加工时长 ÷ 60 × 机时费
//   后道   = 表面处理 + 喷涂 + 丝印
//   报价   = (料 + 工 + 后道) × (1 + 毛利率)
//
// 「模板」指的是上面那几个费率：机时费、毛利率、一张材料单价表、一张表面处
// 理单价表、喷涂和丝印各一个数。设一次就长期用，往后报一个零件只要填三样：
// 什么料、多重、加工多久，再勾一下后道。
//
// 单价按分（0.01）取整——报价是要写进合同的数，不能带一串小数尾巴。
//
// Pure functions only — no DB, no React，跟 lib/expenses.ts 一样，页面和以后
// 的导出共用同一份算法。

export type RateItem = {
  name: string
  /** 材料是 元/kg；表面处理是 元/件。 */
  price: number
}

export type QuoteRates = {
  machineRatePerHour: number // 机时费 元/小时
  marginPct: number // 毛利率 %
  materials: RateItem[] // 材料单价 元/kg
  surfaces: RateItem[] // 表面处理单价 元/件
  paintPerPiece: number // 喷涂 元/件
  screenPerPiece: number // 丝印 元/件
}

// 起手的一套数 — 不是行情，是让第一次打开这页的人有东西可改。真实数字只有
// 厂里自己知道，所以每一项都摆在页面上等着被改掉。
export const DEFAULT_QUOTE_RATES: QuoteRates = {
  machineRatePerHour: 60,
  marginPct: 30,
  materials: [
    { name: '6061铝', price: 30 },
    { name: '7075铝', price: 55 },
    { name: 'SUS304', price: 25 },
    { name: 'SUS316', price: 40 },
    { name: '45#钢', price: 8 },
    { name: 'POM', price: 30 },
    { name: 'ABS', price: 20 },
    { name: '亚克力', price: 25 },
  ],
  surfaces: [
    { name: '阳极氧化', price: 3 },
    { name: '喷砂', price: 2 },
    { name: '电镀', price: 4 },
    { name: '发黑', price: 2 },
    { name: '拉丝', price: 3 },
  ],
  paintPerPiece: 5,
  screenPerPiece: 3,
}

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(hi, Math.max(lo, v))
}

function normalizeItems(raw: unknown, fallback: RateItem[]): RateItem[] {
  if (!Array.isArray(raw)) return fallback
  const out: RateItem[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.name !== 'string' || !r.name.trim()) continue
    out.push({ name: r.name.trim(), price: num(r.price, 0, 0, 1_000_000) })
  }
  return out
}

// 存过的费率缺一项就读默认那一项 — 永远不会因为一个字段没写进去而算出 NaN。
export function normalizeRates(raw: unknown): QuoteRates {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >
  return {
    machineRatePerHour: num(o.machineRatePerHour, 60, 0, 100_000),
    marginPct: num(o.marginPct, 30, -100, 1000),
    materials: normalizeItems(o.materials, DEFAULT_QUOTE_RATES.materials),
    surfaces: normalizeItems(o.surfaces, DEFAULT_QUOTE_RATES.surfaces),
    paintPerPiece: num(o.paintPerPiece, 5, 0, 1_000_000),
    screenPerPiece: num(o.screenPerPiece, 3, 0, 1_000_000),
  }
}

export function isValidRate(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= -100 && v <= 1_000_000
}

// === 一行报价 ===

export type QuoteLine = {
  id: string
  name: string // 零件名
  material: string // 材料名，对应 rates.materials
  weightKg: number // 单重 kg
  minutes: number // 加工时长 分钟/件
  surface: string // 表面处理名，'' = 无
  paint: boolean // 喷涂
  screen: boolean // 丝印
  qty: number
}

export function emptyLine(id: string): QuoteLine {
  return {
    id,
    name: '',
    material: '',
    weightKg: 0,
    minutes: 0,
    surface: '',
    paint: false,
    screen: false,
    qty: 1,
  }
}

export type QuoteBreakdown = {
  materialCny: number // 料
  machiningCny: number // 工
  surfaceCny: number // 表面处理
  paintCny: number // 喷涂
  screenCny: number // 丝印
  costCny: number // 成本合计
  unitCny: number // 单价 (含毛利)
  totalCny: number // 小计
}

function priceOf(items: RateItem[], name: string): number {
  if (!name) return 0
  return items.find((i) => i.name === name)?.price ?? 0
}

const cents = (n: number) => Math.round(n * 100) / 100

export function quoteLine(line: QuoteLine, rates: QuoteRates): QuoteBreakdown {
  const materialCny = cents(priceOf(rates.materials, line.material) * line.weightKg)
  const machiningCny = cents((line.minutes / 60) * rates.machineRatePerHour)
  const surfaceCny = cents(priceOf(rates.surfaces, line.surface))
  const paintCny = line.paint ? cents(rates.paintPerPiece) : 0
  const screenCny = line.screen ? cents(rates.screenPerPiece) : 0
  const costCny = cents(
    materialCny + machiningCny + surfaceCny + paintCny + screenCny,
  )
  const unitCny = cents(costCny * (1 + rates.marginPct / 100))
  return {
    materialCny,
    machiningCny,
    surfaceCny,
    paintCny,
    screenCny,
    costCny,
    unitCny,
    totalCny: cents(unitCny * Math.max(0, Math.floor(line.qty))),
  }
}

export type QuoteTotals = {
  costCny: number
  totalCny: number
  pieces: number
  profitCny: number
}

export function quoteTotals(
  lines: QuoteLine[],
  rates: QuoteRates,
): QuoteTotals {
  let costCny = 0
  let totalCny = 0
  let pieces = 0
  for (const l of lines) {
    const b = quoteLine(l, rates)
    const q = Math.max(0, Math.floor(l.qty))
    costCny += b.costCny * q
    totalCny += b.totalCny
    pieces += q
  }
  return {
    costCny: cents(costCny),
    totalCny: cents(totalCny),
    pieces,
    profitCny: cents(totalCny - costCny),
  }
}

// === 导出 ===

export const QUOTE_EXPORT_HEADERS = [
  '序号',
  '零件名称',
  '材料',
  '单重kg',
  '加工时长min',
  '表面处理',
  '喷涂',
  '丝印',
  '数量',
  '料费',
  '加工费',
  '后道费',
  '成本',
  '单价',
  '小计',
] as const

export const QUOTE_EXPORT_COL_WIDTHS = [
  6, 22, 12, 9, 12, 12, 7, 7, 8, 9, 10, 9, 9, 10, 12,
]

export function buildQuoteExportAoa(
  lines: QuoteLine[],
  rates: QuoteRates,
): (string | number)[][] {
  const aoa: (string | number)[][] = [QUOTE_EXPORT_HEADERS.slice() as string[]]
  lines.forEach((l, i) => {
    const b = quoteLine(l, rates)
    aoa.push([
      i + 1,
      l.name,
      l.material,
      l.weightKg,
      l.minutes,
      l.surface,
      l.paint ? '是' : '',
      l.screen ? '是' : '',
      l.qty,
      b.materialCny,
      b.machiningCny,
      cents(b.surfaceCny + b.paintCny + b.screenCny),
      b.costCny,
      b.unitCny,
      b.totalCny,
    ])
  })
  const t = quoteTotals(lines, rates)
  const total: (string | number)[] = QUOTE_EXPORT_HEADERS.map(() => '')
  total[0] = '合计'
  total[QUOTE_EXPORT_HEADERS.indexOf('数量')] = t.pieces
  total[QUOTE_EXPORT_HEADERS.indexOf('小计')] = t.totalCny
  aoa.push(total)
  return aoa
}
