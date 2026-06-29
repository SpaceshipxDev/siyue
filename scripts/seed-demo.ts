/*
 * Demo seed generator — a "busy mid-size precision shop".
 *
 * Produces a de-identified-but-believable order book for sales demos:
 *   - real customer names (Hikvision/DJI/etc.) are fine to show
 *   - real-sounding but generic part names (no model numbers that pin to a
 *     specific real job)
 *   - hard, realistic ¥ amounts rolled up from per-part unit prices
 *   - ~12 months of history, weighted toward "now" so the board looks alive
 *   - a full lifecycle mix: new / in-production / shipped / invoiced / paid,
 *     plus outsourcing, a few paused jobs, products, and one showcase Hikvision
 *     order pinned to the top.
 *
 * It seeds THROUGH the app's own mutation functions (createJob, finishJobStage,
 * prepareShipping, updateShipmentFinance, createOutsourceBlockAt, ...) so every
 * invariant and the master_board_rows triggers stay correct — then backdates
 * the visible date columns for the historical spread.
 *
 * SAFETY: this WIPES the target database (resetDb) before seeding. Point it at
 * a DEMO branch/project ONLY — never your production Supabase. The script
 * refuses to run unless SEED_I_UNDERSTAND_THIS_WIPES_THE_DB=yes.
 *
 * Run:
 *   npx -y tsx --env-file=.env.demo scripts/seed-demo.ts
 * or, if your node lacks --env-file, the script also reads SEED_ENV_FILE
 * (default ".env.demo") itself.
 *
 * Env it reads:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (target DB — REQUIRED)
 *   NEXT_PUBLIC_BRAND_CODE                     (doc-no prefix, default "MX")
 *   BOOTSTRAP_PIN                              (so the demo has a login)
 *   SEED_COUNT                                 (orders, default 240)
 *   SEED_SEED                                  (PRNG seed, default 20260621)
 *   SEED_RESET                                 ("no" to skip the wipe)
 */

import { readFileSync, existsSync } from 'node:fs'

// ── 1. Load the env file BEFORE importing anything that touches Supabase ──────
function loadEnvFile(path: string) {
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}
loadEnvFile(process.env.SEED_ENV_FILE || '.env.demo')

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Put them in .env.demo ' +
      '(the DEMO branch credentials) or export them. Refusing to run.',
  )
  process.exit(1)
}

// HARD GUARDRAIL: the demo reuses the production project's URL + service key,
// isolated only by schema. If the schema is unset/public, a single write would
// hit real factory data. Refuse unless explicitly pointed at a non-public schema.
const DB_SCHEMA = process.env.SUPABASE_DB_SCHEMA || ''
const DRY_MODE = (process.env.SEED_DRY || '').toLowerCase() === 'yes'
if (!DRY_MODE && (DB_SCHEMA === '' || DB_SCHEMA === 'public')) {
  console.error(
    `SUPABASE_DB_SCHEMA is "${DB_SCHEMA || '(unset)'}". This seed shares the ` +
      'production credentials and must NEVER write to the public schema. ' +
      'Set SUPABASE_DB_SCHEMA=demo (or another isolated schema). Aborting.',
  )
  process.exit(1)
}

const RESET = (process.env.SEED_RESET || 'yes').toLowerCase() !== 'no'
if (RESET && process.env.SEED_I_UNDERSTAND_THIS_WIPES_THE_DB !== 'yes') {
  console.error(
    'This script WIPES the target database before seeding.\n' +
      'Confirm you are pointing at the DEMO database (not production) by setting:\n' +
      '  SEED_I_UNDERSTAND_THIS_WIPES_THE_DB=yes\n' +
      'in .env.demo or the environment. Aborting.',
  )
  process.exit(1)
}

// Static imports are fine: the Supabase client is constructed lazily on first
// use, which only happens once we start calling these functions below.
import { STAGES, type Stage } from '../lib/data'
import { supabase } from '../lib/supabase'
import {
  createJob,
  confirmJob,
  updateJob,
  setJobType,
  setJobIsProduct,
  setJobPaused,
  setJobPin,
  startJobStage,
  finishJobStage,
  prepareShipping,
  updateShipmentFinance,
  createVendor,
  createOutsourceBlockAt,
  ensureBootstrapUser,
  resetDb,
} from '../lib/db'

// ── 2. Deterministic RNG so re-runs are stable ───────────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(Number(process.env.SEED_SEED) || 20260621)
const rand = () => rng()
const randint = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]
const chance = (p: number) => rand() < p
function weighted<T>(pairs: readonly (readonly [T, number])[]): T {
  const total = pairs.reduce((s, [, w]) => s + w, 0)
  let r = rand() * total
  for (const [v, w] of pairs) {
    r -= w
    if (r <= 0) return v
  }
  return pairs[pairs.length - 1][0]
}
const shuffle = <T>(arr: T[]): T[] => {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ── 3. Date helpers ──────────────────────────────────────────────────────────
const NOW = new Date()
const DAY = 86_400_000
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY)
function isoAt(d: Date): string {
  // give each timestamp a plausible working-hour so the board doesn't show a
  // wall of identical times
  const t = new Date(d)
  t.setHours(8 + randint(0, 9), randint(0, 59), randint(0, 59), 0)
  return t.toISOString()
}
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const mmdd = (d: Date) =>
  `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// ── 4. Business vocabulary (real customers OK; parts generic-but-real) ────────
const CODE = process.env.NEXT_PUBLIC_BRAND_CODE || 'MX'

type Cat =
  | 'security'
  | 'consumer'
  | 'medical'
  | 'auto'
  | 'robotics'
  | 'scan'
  | 'industrial'

// [customer, category, weight]  — heavier weight = appears more often
const CUSTOMERS: readonly (readonly [string, Cat, number])[] = [
  ['海康威视', 'security', 10],
  ['大华股份', 'security', 7],
  ['宇视科技', 'security', 3],
  ['大疆创新', 'consumer', 8],
  ['影石创新', 'consumer', 5],
  ['科沃斯', 'consumer', 4],
  ['石头科技', 'consumer', 3],
  ['追觅科技', 'consumer', 3],
  ['安克创新', 'consumer', 3],
  ['九号公司', 'consumer', 2],
  ['思看科技', 'scan', 6],
  ['先临三维', 'scan', 3],
  ['迈瑞医疗', 'medical', 5],
  ['联影医疗', 'medical', 3],
  ['比亚迪', 'auto', 5],
  ['宁德时代', 'auto', 4],
  ['蔚来', 'auto', 3],
  ['理想汽车', 'auto', 3],
  ['宇树科技', 'robotics', 4],
  ['云深处科技', 'robotics', 3],
  ['普渡机器人', 'robotics', 2],
  ['立讯精密', 'industrial', 3],
  ['歌尔股份', 'industrial', 3],
  ['大族激光', 'industrial', 2],
]

const PARTS: Record<Cat, readonly string[]> = {
  security: ['球机外壳', '枪机支架', '云台底座', '镜头护罩', '防护罩上盖', '防护罩下壳', '红外灯板支架', '立杆抱箍', '球机上盖', '电机座', '解码器面板'],
  consumer: ['中框', '上壳', '下壳', '电池仓盖', '云台臂', '云台支架', '镜头座', '散热支架', '充电底座', '按键', '旋钮', '装饰圈', '麦克风支架', '主板支架'],
  medical: ['监护仪面板', '探头外壳', '推车支架', '手柄外壳', '显示屏边框', '接口面板', '滚轮支架', '电池托盘'],
  auto: ['电池模组支架', '散热板', '充电口盖', '传感器支架', '线束固定座', '中控装饰条', 'domeBracket', '水冷板', '高压盒支架'],
  robotics: ['关节外壳', '腿部连杆', '髋部结构件', '足端', '电机端盖', '躯干框架', '肩部连接件', '减速器外壳', '激光雷达支架'],
  scan: ['扫描仪外壳', '标定板支架', '镜组座', '手柄外壳', '模组框架', '十字标定块', '相机安装板'],
  industrial: ['治具底板', '定位块', '夹具体', '过渡板', '安装法兰', '导向座', '压块', '模组框架'],
}

const MATERIALS = ['6061铝合金', '7075铝合金', 'AL6063', '304不锈钢', '316不锈钢', '黄铜H62', 'POM(赛钢)', 'ABS', 'PC', 'PA6+GF30', 'PMMA(亚克力)', '镁合金AZ91', 'TC4钛合金'] as const
const SURFACES = ['阳极氧化(本色)', '阳极氧化(黑)', '阳极氧化(灰)', '喷砂阳极', '喷砂', '拉丝', '喷漆(哑黑)', '喷漆(白)', '电镀', '镀镍', '镀铬', '丝印', '镭雕', '本色', '钝化', '发黑'] as const
const PROCESSES = ['CNC机加', 'CNC机加', 'CNC机加', '钣金折弯', '3D打印(SLA)', '3D打印(SLS)', '压铸+CNC', '车铣复合'] as const

const COMMERCE = ['张磊', '王芳', '李伟', '陈静', '刘洋', '周敏'] as const // 我方商务
const ENGINEERS = ['林工', '赵工', '孙工', '吴工', '郑工', '钱工', '冯工', '蒋工'] as const // 客户工程师

// generic outsourcing partners (no real vendor names)
const VENDORS: readonly (readonly [string, string, Stage[]])[] = [
  ['精密阳极氧化厂', '外发氧化', ['喷漆']],
  ['表面处理-喷砂', '外发喷砂', ['打磨']],
  ['协力CNC外协', '外发CNC', ['操机']],
  ['三维打印中心', '外发3D打印', ['操机']],
  ['钣金外协', '外发钣金', ['操机']],
  ['专业喷涂厂', '外发喷漆', ['喷漆']],
  ['激光焊接', '外发激光焊', ['手工']],
  ['精密电镀厂', '外发电镀', ['喷漆']],
]

// who clicks ✓ at each station — makes the audit column read like real people
const STAGE_WORKERS: Record<string, readonly string[]> = {
  工程: ['工程-周', '工程-黄'],
  编程: ['编程-阿强', '编程-小林'],
  操机: ['操机-老李', '操机-小陈', '操机-阿坤'],
  检验: ['质检-王', '质检-刘'],
  手工: ['钳工-阿明', '钳工-老张'],
  打磨: ['打磨-阿华', '打磨-小吴'],
  喷漆: ['喷涂-赵', '喷涂-阿杰'],
  丝印: ['丝印-小郑', '丝印-阿芳'],
  质量: ['质量-孙', '质量-钱'],
  出货: ['仓库-阿强', '仓库-小敏'],
}
const stageWorker = (s: Stage) => pick(STAGE_WORKERS[s] ?? ['操机-老李'])

// ── 5. Pricing — small-batch 手板/CNC, rolls up to hard totals ────────────────
const QTY = [1, 1, 2, 2, 3, 3, 5, 5, 8, 10, 10, 20, 20, 30, 50, 100] as const
function unitPriceFor(material: string, process: string): number {
  let base: number
  if (process.startsWith('3D')) base = randint(60, 600)
  else if (material.includes('钛') || material.includes('7075')) base = randint(180, 1800)
  else if (material.includes('不锈钢') || material.includes('镁')) base = randint(120, 1200)
  else if (material.includes('ABS') || material.includes('PC') || material.includes('POM') || material.includes('PMMA')) base = randint(40, 400)
  else base = randint(60, 900) // aluminum CNC, the bread & butter
  // round to a tidy quote number
  const r = base < 200 ? 5 : base < 600 ? 10 : 50
  return Math.max(r, Math.round(base / r) * r)
}

type CompSpec = {
  name: string
  qty: number
  material: string
  surfaceTreatment: string
  process: string
  unitPriceCny: number
  lineTotalCny: number
}

function buildComponents(cat: Cat): { comps: CompSpec[]; amount: number | undefined } {
  const n = weighted<number>([
    [1, 6], [2, 9], [3, 10], [4, 8], [5, 6], [6, 5], [8, 4], [10, 3], [12, 2],
  ])
  const names = shuffle([...PARTS[cat]])
  const comps: CompSpec[] = []
  let amount = 0
  for (let i = 0; i < n; i++) {
    const name = names[i % names.length] + (i >= names.length ? `-${i + 1}` : '')
    const material = pick(MATERIALS)
    const process = pick(PROCESSES)
    const surfaceTreatment = pick(SURFACES)
    const qty = pick(QTY)
    const unit = unitPriceFor(material, process)
    const line = unit * qty
    comps.push({ name, qty, material, surfaceTreatment, process, unitPriceCny: unit, lineTotalCny: line })
    amount += line
  }
  // a few orders are quoted "待报价" (null) — realistic on fresh imports
  const amt = chance(0.06) ? undefined : Math.round(amount)
  return { comps, amount: amt }
}

// ── 6. Lifecycle ─────────────────────────────────────────────────────────────
type Phase = 'new' | 'production' | 'shipped' | 'invoiced' | 'overdue' | 'settled'

function phaseFor(ageDays: number): Phase {
  // older orders skew toward shipped/paid; fresh ones toward new/in-production
  if (ageDays < 12) return weighted<Phase>([['new', 5], ['production', 5], ['shipped', 1]])
  if (ageDays < 35) return weighted<Phase>([['new', 1], ['production', 6], ['shipped', 3], ['invoiced', 1]])
  if (ageDays < 90) return weighted<Phase>([['production', 3], ['shipped', 3], ['invoiced', 3], ['overdue', 1], ['settled', 3]])
  return weighted<Phase>([['shipped', 1], ['invoiced', 2], ['overdue', 1], ['settled', 8]])
}

// ── 7. Generate the order book (pure data) ───────────────────────────────────
type OrderSpec = {
  jobNo: string
  intake: Date
  ageDays: number
  customer: string
  cat: Cat
  product: string
  comps: CompSpec[]
  amount: number | undefined
  dueDate: string
  engineer: string
  commerce: string
  contractNo: string | null
  batchNo: string | null
  phase: Phase
  jobType: 'short' | 'medium' | 'long' | 'rush' | null
  isProduct: boolean
  outsource: boolean
  paused: boolean
  showcase?: boolean
}

function genOrders(count: number): OrderSpec[] {
  const seqByDay = new Map<string, number>()
  const specs: OrderSpec[] = []

  const make = (intake: Date, opts: Partial<OrderSpec> & { customer: string; cat: Cat }): OrderSpec => {
    const dayKey = ymd(intake)
    const seq = (seqByDay.get(dayKey) ?? 0) + 1
    seqByDay.set(dayKey, seq)
    const jobNo = `${CODE}-${String(intake.getFullYear()).slice(-2)}-${intake.getMonth() + 1}-${intake.getDate()}-${String(seq).padStart(3, '0')}`
    const ageDays = Math.max(0, Math.round((NOW.getTime() - intake.getTime()) / DAY))
    const { comps, amount } = opts.comps
      ? { comps: opts.comps, amount: opts.amount }
      : buildComponents(opts.cat)
    const phase = opts.phase ?? phaseFor(ageDays)
    const leadDays = randint(8, 45)
    const dueDate = ymd(addDays(intake, leadDays))
    const product = opts.product ?? `${comps[0].name}等${comps.length}项 手板`
    return {
      jobNo,
      intake,
      ageDays,
      customer: opts.customer,
      cat: opts.cat,
      product,
      comps,
      amount,
      dueDate,
      engineer: opts.engineer ?? pick(ENGINEERS),
      commerce: opts.commerce ?? pick(COMMERCE),
      contractNo: opts.contractNo !== undefined ? opts.contractNo : chance(0.45) ? `HT${String(intake.getFullYear()).slice(-2)}${String(randint(1, 9999)).padStart(4, '0')}` : null,
      batchNo: opts.batchNo !== undefined ? opts.batchNo : chance(0.3) ? `P${randint(1, 9)}` : null,
      phase,
      jobType: opts.jobType ?? null,
      isProduct: opts.isProduct ?? chance(0.04),
      outsource: opts.outsource ?? chance(0.16),
      paused: opts.paused ?? false,
      showcase: opts.showcase,
    }
  }

  // ── Showcase Hikvision order: clean, mid-production, pinned, tidy numbers ──
  {
    const intake = addDays(NOW, -9)
    const comps: CompSpec[] = [
      { name: '球机外壳', qty: 10, material: '6061铝合金', surfaceTreatment: '喷砂阳极', process: 'CNC机加', unitPriceCny: 850, lineTotalCny: 8500 },
      { name: '球机上盖', qty: 10, material: '6061铝合金', surfaceTreatment: '阳极氧化(黑)', process: 'CNC机加', unitPriceCny: 620, lineTotalCny: 6200 },
      { name: '云台底座', qty: 10, material: '6061铝合金', surfaceTreatment: '阳极氧化(黑)', process: 'CNC机加', unitPriceCny: 540, lineTotalCny: 5400 },
      { name: '镜头护罩', qty: 20, material: 'PC', surfaceTreatment: '本色', process: '3D打印(SLA)', unitPriceCny: 180, lineTotalCny: 3600 },
      { name: '红外灯板支架', qty: 20, material: '6061铝合金', surfaceTreatment: '本色', process: 'CNC机加', unitPriceCny: 120, lineTotalCny: 2400 },
    ]
    const amount = comps.reduce((s, c) => s + c.lineTotalCny, 0) // 26,100
    specs.push(
      make(intake, {
        customer: '海康威视',
        cat: 'security',
        product: '球机结构件手板一套',
        comps,
        amount,
        phase: 'production',
        engineer: '林工',
        contractNo: 'HT26-0418',
        batchNo: 'P1',
        outsource: true,
        showcase: true,
      }),
    )
  }

  // ── The rest, spread across the year, weighted toward recent ──
  for (let i = 0; i < count - 1; i++) {
    // bias intake toward the last ~4 months: square the uniform so small
    // (recent) ages dominate
    const u = rand()
    const ageDays = Math.floor(2 + u * u * 363)
    const intake = addDays(NOW, -ageDays)
    const [customer, cat] = weighted(
      CUSTOMERS.map((c) => [[c[0], c[1]] as [string, Cat], c[2]] as const),
    )
    const spec = make(intake, { customer, cat })
    // a small slice are 加急 (rush)
    if (chance(0.05)) spec.jobType = 'rush'
    specs.push(spec)
  }
  return specs
}

// ── 8. Execute one order against the DB ──────────────────────────────────────
async function seedOrder(spec: OrderSpec): Promise<void> {
  const job = await createJob({
    jobNo: spec.jobNo,
    customer: spec.customer,
    product: spec.product,
    amountCny: spec.amount,
    dueDate: spec.dueDate,
    engineer: spec.engineer,
    components: spec.comps.map((c) => ({
      name: c.name,
      qty: c.qty,
      material: c.material,
      surfaceTreatment: c.surfaceTreatment,
      process: c.process,
      unitPriceCny: c.unitPriceCny,
      lineTotalCny: c.lineTotalCny,
    })),
  })
  await updateJob(job.id, {
    yuenongBusiness: spec.commerce,
    contractNo: spec.contractNo,
    batchNo: spec.batchNo,
  })
  await confirmJob(job.id) // draft -> ready (+ auto job_type from due date)
  if (spec.jobType) await setJobType(job.id, spec.jobType)
  if (spec.isProduct) await setJobIsProduct(job.id, true)

  const ids = job.components.map((c) => c.id)
  const lastIdx = STAGES.length - 1 // 出货
  const intakeISO = isoAt(spec.intake)

  // progress timeline anchors
  const shippedThrough = STAGES.length // all done
  let doneIdx = 0 // exclusive: stages [0, doneIdx) are done
  let currentStarted: Date | null = null
  let shipDate: Date | null = null

  if (spec.phase === 'new') {
    doneIdx = 0
    if (chance(0.5)) {
      await startJobStage(job.id, STAGES[0], stageWorker(STAGES[0]))
      currentStarted = addDays(NOW, -randint(0, 3))
    }
  } else if (spec.phase === 'production') {
    // done through stage k (1..7), current stage in progress
    const k = randint(1, 7)
    for (let i = 0; i < k; i++) {
      await startJobStage(job.id, STAGES[i], stageWorker(STAGES[i]))
      await finishJobStage(job.id, STAGES[i], stageWorker(STAGES[i]))
    }
    doneIdx = k
    if (k < lastIdx) {
      await startJobStage(job.id, STAGES[k], stageWorker(STAGES[k]))
      currentStarted = addDays(NOW, -randint(0, 6))
    }
  } else {
    // shipped / invoiced / overdue / settled — fully through the line
    const lead = randint(6, 34)
    shipDate = addDays(spec.intake, lead)
    if (shipDate.getTime() > NOW.getTime() - DAY) shipDate = addDays(NOW, -randint(1, 5))
    const res = await prepareShipping(
      job.id,
      job.components.map((c) => ({ componentId: c.id, qty: c.qty })),
      stageWorker('出货'),
    )
    doneIdx = shippedThrough

    // money: invoice + payment depending on phase
    const invAmt = spec.amount ?? spec.comps.reduce((s, c) => s + c.lineTotalCny, 0)
    if (spec.phase !== 'shipped') {
      const overdue = spec.phase === 'overdue'
      const invDate = overdue
        ? addDays(NOW, -randint(45, 110))
        : addDays(shipDate, randint(2, 15))
      const patch: Record<string, unknown> = {
        invoiceNo: `${String(spec.intake.getFullYear()).slice(-2)}${String(randint(1, 99999)).padStart(5, '0')}`,
        invoiceDate: ymd(invDate > NOW ? NOW : invDate),
        invoiceAmountCny: invAmt,
      }
      if (spec.phase === 'settled') {
        const payDate = addDays(invDate, randint(20, 70))
        patch.paymentDate = ymd(payDate > NOW ? NOW : payDate)
        patch.paymentAmountCny = invAmt
      }
      await updateShipmentFinance(res.shipmentId, patch, spec.commerce)
    }
    // backdate the shipment itself
    await supabase.from('shipments').update({ created_at: isoAt(shipDate) }).eq('id', res.shipmentId)
  }

  // ── outsourcing: a block for some in-production jobs ──
  if (spec.outsource && spec.phase === 'production' && ids.length > 0) {
    const [vName, activity, vStages] = pick(VENDORS)
    const vendor = await createVendor({ name: vName })
    if (vendor) {
      const members = shuffle(ids).slice(0, Math.max(1, Math.floor(ids.length / 2)))
      const sent = addDays(NOW, -randint(2, 9))
      const unitPrices: Record<string, number | null> = {}
      for (const cid of members) {
        const comp = spec.comps[job.components.findIndex((c) => c.id === cid)]
        unitPrices[cid] = comp ? Math.round((comp.unitPriceCny || 100) * (0.3 + rand() * 0.4)) : null
      }
      await createOutsourceBlockAt(job.id, members, {
        vendorId: vendor.id,
        activity,
        stages: vStages,
        amountCny: members.reduce((s, cid) => {
          const comp = spec.comps[job.components.findIndex((c) => c.id === cid)]
          return s + (unitPrices[cid] ?? 0) * (comp?.qty ?? 1)
        }, 0),
        sentDate: ymd(sent),
        expectedReturn: ymd(addDays(sent, randint(3, 10))),
        unitPricesCny: unitPrices,
      })
    }
  }

  // ── paused overlay ──
  if (spec.paused) {
    await setJobPaused(job.id, true, pick(['等客户确认图纸', '客户暂停', '料未到', '等付款']), spec.commerce)
  }

  // ── backdate visible dates (created_at + stage timestamps) ──
  await supabase.from('jobs').update({ created_at: intakeISO }).eq('id', job.id)

  // done stages: spread finished_at across the production window
  const finishAnchor =
    spec.phase === 'production'
      ? addDays(spec.intake, randint(1, 8))
      : shipDate ?? addDays(spec.intake, randint(2, 10))
  for (let i = 0; i < doneIdx; i++) {
    const fAt = addDays(spec.intake, Math.round(((i + 1) / Math.max(1, doneIdx)) * Math.max(1, (finishAnchor.getTime() - spec.intake.getTime()) / DAY)))
    const fIso = isoAt(fAt > NOW ? NOW : fAt)
    await supabase
      .from('part_stages')
      .update({ started_at: intakeISO, finished_at: fIso, completed_at: mmdd(fAt > NOW ? NOW : fAt) })
      .like('id', `${job.id}:%`)
      .eq('stage', STAGES[i])
      .eq('status', 'done')
  }
  // current in-progress stage: started a few days ago
  if (currentStarted) {
    await supabase
      .from('part_stages')
      .update({ started_at: isoAt(currentStarted) })
      .like('id', `${job.id}:%`)
      .eq('status', 'in_progress')
  }

  if (spec.showcase) await setJobPin(job.id, true, spec.commerce)
}

// ── 9. Main ──────────────────────────────────────────────────────────────────
function printStats(specs: OrderSpec[]) {
  const phase: Record<string, number> = {}
  const cust: Record<string, number> = {}
  const amounts: number[] = []
  let withAmt = 0
  for (const s of specs) {
    phase[s.phase] = (phase[s.phase] ?? 0) + 1
    cust[s.customer] = (cust[s.customer] ?? 0) + 1
    if (s.amount) { amounts.push(s.amount); withAmt += s.amount }
  }
  amounts.sort((a, b) => a - b)
  const q = (p: number) => amounts[Math.floor(p * (amounts.length - 1))] ?? 0
  console.log(`orders: ${specs.length}`)
  console.log(`total 金额: ¥${withAmt.toLocaleString('zh-CN')}  (avg ¥${Math.round(withAmt / amounts.length).toLocaleString('zh-CN')})`)
  console.log(`金额 spread: min ¥${q(0).toLocaleString()} | p25 ¥${q(.25).toLocaleString()} | median ¥${q(.5).toLocaleString()} | p75 ¥${q(.75).toLocaleString()} | p95 ¥${q(.95).toLocaleString()} | max ¥${q(1).toLocaleString()}`)
  console.log('phase mix:', phase)
  console.log('top customers:', Object.entries(cust).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join('  '))
  console.log('date span:', ymd(specs[0].intake), '→', ymd(specs[specs.length - 1].intake))
  console.log('sample orders:')
  for (const s of [specs[0], ...specs.slice(-4)]) {
    console.log(`  ${s.jobNo}  ${s.customer.padEnd(6)}  ${(s.amount ? '¥' + s.amount.toLocaleString() : '待报价').padEnd(10)}  ${s.comps.length}件  ${s.phase}${s.jobType ? '/' + s.jobType : ''}${s.outsource ? ' 外协' : ''}`)
  }
}

async function main() {
  const count = Number(process.env.SEED_COUNT) || 240

  if ((process.env.SEED_DRY || '').toLowerCase() === 'yes') {
    const specs = genOrders(count).sort((a, b) => a.intake.getTime() - b.intake.getTime())
    printStats(specs)
    process.exit(0)
  }

  console.log(`Seeding demo: ${count} orders into ${process.env.SUPABASE_URL}`)

  if (RESET) {
    console.log('Resetting database (wiping jobs/vendors/customers)…')
    await resetDb()
  }
  await ensureBootstrapUser()

  const specs = genOrders(count)
  // insert oldest-first so position/sequence reads naturally
  specs.sort((a, b) => a.intake.getTime() - b.intake.getTime())

  let done = 0
  let totalCny = 0
  const phaseCount: Record<string, number> = {}
  for (const spec of specs) {
    try {
      await seedOrder(spec)
      totalCny += spec.amount ?? 0
      phaseCount[spec.phase] = (phaseCount[spec.phase] ?? 0) + 1
    } catch (e) {
      console.error(`  ! ${spec.jobNo} (${spec.customer}) failed:`, (e as Error).message)
    }
    if (++done % 20 === 0) console.log(`  …${done}/${specs.length}`)
  }

  console.log('\nDone.')
  console.log(`  orders seeded : ${done}`)
  console.log(`  total 金额    : ¥${totalCny.toLocaleString('zh-CN')}`)
  console.log(`  phase mix     :`, phaseCount)
  process.exit(0)
}

main().catch((e) => {
  console.error('Seed failed:', e)
  process.exit(1)
})
