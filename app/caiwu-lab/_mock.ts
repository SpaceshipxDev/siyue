// caiwu-lab — shared in-memory dataset. Six HERO orders are hand-seeded from
// the real Excel screenshots (海康's 4-PO installment monster, 思看's payment
// installments, 大华/五八 pure 待开票, 艾罗 逾期, 微影 已结清). On top of those we
// procedurally generate a realistic LONG TAIL — hundreds of orders across dozens
// of customers — so the UI's behavior at scale (grouping, collapse, lens filter,
// windowing) is visible, not asserted. Generation is deterministic (seeded PRNG)
// so reloads and screenshots are stable.
//
// NOTHING here is stored as a remainder. 待开票余额 / 未收余额 are ALWAYS derived
// (see _derive.ts) — she never types or trusts a 剩余 again.

export type EventKind = 'invoice' | 'payment' // 开票 / 收款

export interface MoneyEvent {
  id: string
  poLineId: string
  kind: EventKind
  amountCny: number
  /** ISO YYYY-MM-DD. */
  date: string
  reversal?: boolean
}

export interface PoLine {
  id: string
  jobId: string // 生产编号
  poNo: string // 订单号
  materialNo?: string // 物料号
  poAmountCny: number // 订单额
}

export interface Job {
  id: string // 生产编号 / 内部流水号 (YNMX-…)
  customer: string // 客户名称
  product: string // 产品
  engineer?: string // 工程
  salesperson: string // 商务
  amountCny: number // 订单金额 (= Σ poAmount)
  shipDate: string // 出货 / 下单 ISO
  dueDate?: string
}

/** Factory-local "today" — matches currentDate so 艾罗 ages into 逾期. */
export const TODAY = '2026-06-24'

// ── HERO ORDERS (hand-seeded from the real screenshots) ────────────────────
const HERO_JOBS: Job[] = [
  { id: 'YNMX-26-1-30-331', customer: '海康仓库', product: '视觉支架组件', engineer: '李工', salesperson: '王伟', amountCny: 638034, shipDate: '2026-05-12', dueDate: '2026-05-10' },
  { id: 'YNMX-26-1-22-208', customer: '思看科技', product: '3D扫描仪外壳', engineer: '赵工', salesperson: '陈静', amountCny: 543210, shipDate: '2026-05-08', dueDate: '2026-05-06' },
  { id: 'YNMX-26-1-28-301', customer: '大华', product: '云台底座', engineer: '李工', salesperson: '王伟', amountCny: 88000, shipDate: '2026-06-18', dueDate: '2026-06-16' },
  { id: 'YNMX-26-1-29-318', customer: '五八智能', product: '机器人关节件', engineer: '孙工', salesperson: '陈静', amountCny: 126400, shipDate: '2026-06-20', dueDate: '2026-06-18' },
  { id: 'YNMX-26-1-10-142', customer: '艾罗网络能源', product: '逆变器散热片', engineer: '李工', salesperson: '王伟', amountCny: 152300, shipDate: '2026-04-28', dueDate: '2026-04-26' },
  { id: 'YNMX-26-1-15-177', customer: '微影', product: '微型投影模组', engineer: '赵工', salesperson: '陈静', amountCny: 24600, shipDate: '2026-04-20', dueDate: '2026-04-18' },
]

const HERO_POLINES: PoLine[] = [
  { id: 'po-331-a', jobId: 'YNMX-26-1-30-331', poNo: '4508106878', materialNo: '02.01.0337', poAmountCny: 235736 },
  { id: 'po-331-b', jobId: 'YNMX-26-1-30-331', poNo: '4508106923', materialNo: '02.01.0341', poAmountCny: 7980 },
  { id: 'po-331-c', jobId: 'YNMX-26-1-30-331', poNo: '4508106877', materialNo: '02.01.0336', poAmountCny: 386868 },
  { id: 'po-331-d', jobId: 'YNMX-26-1-30-331', poNo: '4508121434', materialNo: '02.01.0398', poAmountCny: 7450 },
  { id: 'po-208-a', jobId: 'YNMX-26-1-22-208', poNo: '4500291847', materialNo: 'SK-3DX-07', poAmountCny: 543210 },
  { id: 'po-301-a', jobId: 'YNMX-26-1-28-301', poNo: '4400557812', poAmountCny: 88000 },
  { id: 'po-318-a', jobId: 'YNMX-26-1-29-318', poNo: '4600118203', poAmountCny: 126400 },
  { id: 'po-142-a', jobId: 'YNMX-26-1-10-142', poNo: '4700882019', poAmountCny: 152300 },
  { id: 'po-177-a', jobId: 'YNMX-26-1-15-177', poNo: '4810023311', poAmountCny: 24600 },
]

const HERO_EVENTS: MoneyEvent[] = [
  { id: 'ev-1', poLineId: 'po-331-a', kind: 'invoice', amountCny: 2800, date: '2024-06-15' },
  { id: 'ev-2', poLineId: 'po-331-a', kind: 'invoice', amountCny: 39610, date: '2024-08-15' },
  { id: 'ev-3', poLineId: 'po-331-c', kind: 'invoice', amountCny: 386868, date: '2026-06-10' },
  { id: 'ev-4', poLineId: 'po-331-c', kind: 'payment', amountCny: 200000, date: '2026-06-20' },
  { id: 'ev-5', poLineId: 'po-208-a', kind: 'invoice', amountCny: 543210, date: '2026-05-20' },
  { id: 'ev-6', poLineId: 'po-208-a', kind: 'payment', amountCny: 41885, date: '2026-05-30' },
  { id: 'ev-7', poLineId: 'po-208-a', kind: 'payment', amountCny: 13380, date: '2026-06-15' },
  { id: 'ev-8', poLineId: 'po-142-a', kind: 'invoice', amountCny: 152300, date: '2026-04-30' },
  { id: 'ev-9', poLineId: 'po-177-a', kind: 'invoice', amountCny: 24600, date: '2026-05-05' },
  { id: 'ev-10', poLineId: 'po-177-a', kind: 'payment', amountCny: 24600, date: '2026-05-25' },
]

// ── LONG-TAIL GENERATOR (deterministic) ────────────────────────────────────
// mulberry32 — tiny seeded PRNG so the dataset is identical every reload.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CUSTOMERS = [
  '海康仓库', '思看科技', '大华', '五八智能', '艾罗网络能源', '微影', // heroes reappear → multi-order groups
  '汇川技术', '迈瑞医疗', '大族激光', '埃斯顿自动化', '绿的谐波', '禾赛科技', '速腾聚创',
  '商汤科技', '旷视科技', '联影医疗', '先导智能', '宁德时代', '比亚迪精密', '立讯精密',
  '歌尔股份', '舜宇光学', '韦尔半导体', '兆易创新', '卓胜微', '汇顶科技', '中微公司',
  '北方华创', '盛美上海', '华大智造', '奥普特', '凌云光', '天准科技', '矩子科技',
  '柏楚电子', '杰普特', '锐科激光', '英诺激光', '海目星', '联赢激光', '帝尔激光',
  '科瑞技术', '博众精工', '智云股份', '快克智能', '赛腾股份', '正业科技', '劲拓股份',
  '田中精机', '智立方', '荣旗科技', '思林杰', '德龙激光', '飞荣达', '光库科技',
  '炬光科技', '长光华芯', '仕佳光子', '腾景科技', '光迅科技', '天孚通信', '太辰光',
  '中际旭创', '新易盛', '剑桥科技', '华工科技', '锐捷网络', '紫光股份', '星网锐捷',
]

const PRODUCTS = [
  '精密结构件', '铝合金外壳', '光学镜筒', '传感器支架', '散热基板', '电机端盖', '导轨滑块',
  '夹具组件', '真空腔体', '法兰盘', '齿轮箱体', '连接器壳体', '探针卡座', '镜头模组',
  '机器人关节件', '云台底座', '激光头外壳', '工装治具', '晶圆载台', '电池托盘',
]
const SALES = ['王伟', '陈静', '李娜', '张磊', '刘洋', '周敏']
const ENGINEERS = ['李工', '赵工', '孙工', '周工', '吴工']

// status profiles → how events get laid down (drives 待开票 / 收款中 / 逾期 / 已结清 mix)
type Profile = 'await_none' | 'await_partial' | 'collecting' | 'partial_paid' | 'settled' | 'overdue'
// Weighted so the board reads realistically: mostly 待开票 / 收款中, a healthy
// tail of 已结清, and only a genuine minority 逾期 — so the red 逾期 tag stays
// meaningful instead of becoming wallpaper.
const PROFILE_DECK: Profile[] = [
  'await_none', 'await_none', 'await_none', 'await_none',
  'await_partial', 'await_partial', 'await_partial',
  'collecting', 'collecting', 'collecting',
  'partial_paid', 'partial_paid',
  'settled', 'settled', 'settled',
  'overdue',
]

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
function isoFrom(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10)
}
function roundTo(n: number, step: number): number {
  return Math.max(step, Math.round(n / step) * step)
}

function generate(count: number) {
  const rng = mulberry32(20260624)
  const jobs: Job[] = []
  const lines: PoLine[] = []
  const events: MoneyEvent[] = []
  let poSeq = 4500300000
  let evSeq = 1000

  for (let i = 0; i < count; i++) {
    // Frequent customers (first ~22) get weighted more so groups have depth.
    const pick = rng()
    const ci =
      pick < 0.55
        ? Math.floor(rng() * 22)
        : Math.floor(rng() * CUSTOMERS.length)
    const customer = CUSTOMERS[ci]
    const product = PRODUCTS[Math.floor(rng() * PRODUCTS.length)]
    const salesperson = SALES[Math.floor(rng() * SALES.length)]
    const engineer = ENGINEERS[Math.floor(rng() * ENGINEERS.length)]

    // ship date spread across the last ~10 months
    const monthsBack = Math.floor(rng() * 10) // 0..9
    const baseMonth = 6 - monthsBack
    const y = baseMonth >= 1 ? 2026 : 2025
    const m = ((baseMonth + 11) % 12) + 1
    const d = 1 + Math.floor(rng() * 27)
    const shipDate = isoFrom(y, m, d)
    const jobId = `YNMX-${String(y).slice(2)}-${m}-${d}-${400 + i}`

    // 1–3 PO lines
    const nLines = rng() < 0.6 ? 1 : rng() < 0.85 ? 2 : 3
    const lineAmounts: number[] = []
    let total = 0
    for (let l = 0; l < nLines; l++) {
      const amt = roundTo(8000 + rng() * 280000, 10)
      lineAmounts.push(amt)
      total += amt
    }

    const profile = PROFILE_DECK[Math.floor(rng() * PROFILE_DECK.length)]
    jobs.push({ id: jobId, customer, product, engineer, salesperson, amountCny: total, shipDate, dueDate: shipDate })

    lineAmounts.forEach((amt, l) => {
      const lineId = `${jobId}:${l}`
      const poNo = String(poSeq++)
      lines.push({ id: lineId, jobId, poNo, materialNo: `0${1 + (i % 9)}.0${l + 1}.${pad(i % 90)}`, poAmountCny: amt })

      // lay down events per profile
      const invMonth = m + 1 > 12 ? 1 : m + 1
      const invYear = m + 1 > 12 ? y + 1 : y
      const addInv = (frac: number, ym: [number, number], day: number) =>
        events.push({ id: `evg-${evSeq++}`, poLineId: lineId, kind: 'invoice', amountCny: roundTo(amt * frac, 10), date: isoFrom(ym[0], ym[1], day) })
      const addPay = (amount: number, ym: [number, number], day: number) =>
        events.push({ id: `evg-${evSeq++}`, poLineId: lineId, kind: 'payment', amountCny: amount, date: isoFrom(ym[0], ym[1], day) })

      if (profile === 'await_none') {
        // no events — pure 待开票
      } else if (profile === 'await_partial') {
        // partially invoiced RECENTLY (within term) → still 待开票, not aged
        addInv(0.4, [2026, 6], 8)
      } else if (profile === 'collecting') {
        // fully invoiced recently, not yet paid (within term)
        addInv(1, [2026, 6], 5)
      } else if (profile === 'partial_paid') {
        addInv(1, [2026, 5], 28)
        addPay(roundTo(amt * 0.5, 10), [2026, 6], 12)
      } else if (profile === 'settled') {
        addInv(1, [invYear, invMonth], 10)
        addPay(amt, [invYear, invMonth + 1 > 12 ? 1 : invMonth + 1], 18)
      } else if (profile === 'overdue') {
        // invoiced long ago, never paid — SPREAD the age so the header's
        // 逾期 N天 token self-ranks by real severity (45–219 days) instead of
        // every overdue customer reading an identical number.
        const agingDays = 45 + ((i * 53) % 175)
        const iso = new Date(Date.UTC(2026, 5, 24) - agingDays * 86400000)
          .toISOString()
          .slice(0, 10)
        events.push({ id: `evg-${evSeq++}`, poLineId: lineId, kind: 'invoice', amountCny: amt, date: iso })
      }
    })
  }
  return { jobs, lines, events }
}

const TAIL = generate(232)

export const SEED_JOBS: Job[] = [...HERO_JOBS, ...TAIL.jobs]
export const SEED_POLINES: PoLine[] = [...HERO_POLINES, ...TAIL.lines]
export const SEED_EVENTS: MoneyEvent[] = [...HERO_EVENTS, ...TAIL.events]

// Headline scale (used by the UI to make "hundreds of orders" legible).
export const DATASET_STATS = {
  orders: SEED_JOBS.length,
  customers: new Set(SEED_JOBS.map((j) => j.customer)).size,
  poLines: SEED_POLINES.length,
}
