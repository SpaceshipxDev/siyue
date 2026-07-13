/*
 * Demo seed generator — a "busy mid-size precision shop" (智造精密).
 *
 * Produces a de-identified-but-believable order book for sales demos:
 *   - real customer names (Hikvision/DJI/etc.) are fine to show
 *   - real-sounding but generic part names (no model numbers that pin to a
 *     specific real job)
 *   - hard, realistic ¥ amounts rolled up from per-part unit prices
 *   - ~12 months of history, weighted toward "now" so the board looks alive
 *   - EXACTLY ~20 concurrent 在产 orders at seed time, spread across every
 *     stage, with per-part k/N progress mixes
 *   - a real roster of production workers (full Chinese names, each pinned to a
 *     home 工段) so /report 报工 shows a live day/week/month scoreboard with
 *     believable China-workday timestamps, dense over the last 7 days
 *   - a full historical lifecycle: shipped / invoiced / paid, plus outsourcing,
 *     a few paused jobs, products, a few 图纸变更 marks, and one showcase
 *     Hikvision order pinned to the top.
 *
 * It seeds THROUGH the app's own mutation functions (createJob, finishJobStage,
 * prepareShipping, updateShipmentFinance, createOutsourceBlockAt, ...) so every
 * invariant and the master_board_rows triggers stay correct — then backdates
 * the visible date columns AND re-attributes stage finishes to the right-stage
 * worker (see 报工 note below) for the historical spread.
 *
 * === 报工 attribution (the #1 requirement) ===
 * /report reads the worker_output() RPC, which attributes each part-stage
 * FINISH to `part_stages.by_actor` (coalesce(users.name, by_actor); by_user_id
 * is never written, so the free-text by_actor name IS the worker) at
 * part_stages.finished_at, and each START to started_by_actor at started_at.
 * Migration 0072 EXCLUDES 出货 cascade back-fills (a non-出货 finish whose
 * finished_at equals that part's 出货 finished_at). prepareShipping's cascade
 * stamps every earlier stage with the SHIPPER's name at the SAME instant — a
 * scoreboard lie. So for shipped jobs we OVERWRITE by_actor/started_by_actor
 * per stage with the correct home-stage worker at DISTINCT timestamps: real
 * attribution, and the 0072 predicate never fires on it.
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
 * Dry-run (no DB, prints the full distribution incl. 在产 count, per-stage
 * spread, and per-worker day/week/month finish counts):
 *   SEED_DRY=yes SEED_RESET=no SUPABASE_URL=x SUPABASE_SERVICE_ROLE_KEY=x \
 *     npx -y tsx scripts/seed-demo.ts
 *
 * Env it reads:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (target DB — REQUIRED)
 *   NEXT_PUBLIC_BRAND_CODE                     (doc-no prefix, default "MX")
 *   BOOTSTRAP_PIN                              (so the demo has a login)
 *   SEED_COUNT                                 (orders, default 240)
 *   SEED_INPROD                                (concurrent 在产, default 20)
 *   SEED_PAUSED                                (暂停 jobs, default 3)
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
import { today, shanghaiWindow } from '../lib/today'
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
  setBlockMembersReturnedQty,
  raisePartDrawingChange,
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

// ── 3. Date helpers — everything is anchored to Asia/Shanghai factory time ────
const NOW = new Date()
const DAY = 86_400_000
const SH_OFFSET = 8 * 60 * 60 * 1000 // Shanghai is a fixed +08:00, no DST
// No seed event may land in the future: today's 报工 finishes must read as
// having happened by now, not later tonight. Clamp every generated workday
// instant to at least this many ms before wall-clock now (a small buffer so a
// "just now" event still reads as past even under minor clock skew).
const CLAMP_BUFFER_MS = 5 * 60 * 1000 // 5 minutes
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY)
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const TODAY_SH = today() // 'YYYY-MM-DD' in Shanghai local time

// Shanghai calendar Y/M(0-based)/D for `daysAgo` before today.
function shParts(daysAgo: number): readonly [number, number, number] {
  const [y, m, d] = TODAY_SH.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d - daysAgo))
  return [t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()] as const
}
// A UTC ISO instant whose Shanghai wall-clock is a plausible workday hour
// (08:00–20:00) on the given Shanghai calendar day. Shanghai H == UTC H-8.
function workIso(y: number, mZero: number, d: number): string {
  const hour = 8 + Math.floor(rand() * 12) // 8..19 Shanghai
  let t = Date.UTC(y, mZero, d, hour - 8, randint(0, 59), randint(0, 59))
  // Clamp future instants (today's events, whose random hour may exceed the
  // wall clock) back into the past. Fold deterministically off the already-
  // drawn instant so the RNG stream — and thus the whole order-book structure —
  // stays identical; no extra rand() call.
  const cap = NOW.getTime() - CLAMP_BUFFER_MS
  if (t > cap) {
    const lo = Date.UTC(y, mZero, d, -8, 0, 0) // 08:00 Shanghai that day
    t = cap <= lo ? cap : lo + (t % (cap - lo))
  }
  return new Date(t).toISOString()
}
// Workday-hour ISO stamp for `daysAgo` before today (Shanghai).
function isoDaysAgo(daysAgo: number): string {
  const [y, m, d] = shParts(Math.max(0, daysAgo))
  return workIso(y, m, d)
}
// Workday-hour ISO stamp on the same Shanghai calendar day as instant `d`.
function isoAt(d: Date): string {
  const sh = new Date(d.getTime() + SH_OFFSET)
  return workIso(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate())
}
// MM-DD (Shanghai) of an ISO instant, for the legacy completed_at label.
function mmddOf(iso: string): string {
  const sh = new Date(Date.parse(iso) + SH_OFFSET)
  return `${String(sh.getUTCMonth() + 1).padStart(2, '0')}-${String(sh.getUTCDate()).padStart(2, '0')}`
}
// Weekday (0=Sun..6=Sat) of a Shanghai day `daysAgo` before today.
function weekdayAgo(daysAgo: number): number {
  const [y, m, d] = shParts(daysAgo)
  return new Date(Date.UTC(y, m, d)).getUTCDay()
}
// Pick a recent day offset in [0, span], weighted toward "today" and softly
// avoiding Sundays (Mon–Sat weighted) — but never re-rolls 0 (seed-day is
// always eligible so the last 7 days stay dense INCLUDING today).
function recentDayAgo(span: number): number {
  let n = 0
  for (let tries = 0; tries < 4; tries++) {
    const u = rand()
    n = Math.floor(u * u * (span + 1))
    if (n > span) n = span
    if (n === 0) break
    if (weekdayAgo(n) !== 0) break
    if (rand() < 0.2) break // 20% keep the Sunday
  }
  return n
}

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
  auto: ['电池模组支架', '散热板', '充电口盖', '传感器支架', '线束固定座', '中控装饰条', '穹顶支架', '水冷板', '高压盒支架'],
  robotics: ['关节外壳', '腿部连杆', '髋部结构件', '足端', '电机端盖', '躯干框架', '肩部连接件', '减速器外壳', '激光雷达支架'],
  scan: ['扫描仪外壳', '标定板支架', '镜组座', '手柄外壳', '模组框架', '十字标定块', '相机安装板'],
  industrial: ['治具底板', '定位块', '夹具体', '过渡板', '安装法兰', '导向座', '压块', '模组框架'],
}

const MATERIALS = ['6061铝合金', '7075铝合金', 'AL6063', '304不锈钢', '316不锈钢', '黄铜H62', 'POM(赛钢)', 'ABS', 'PC', 'PA6+GF30', 'PMMA(亚克力)', '镁合金AZ91', 'TC4钛合金'] as const
const SURFACES = ['阳极氧化(本色)', '阳极氧化(黑)', '阳极氧化(灰)', '喷砂阳极', '喷砂', '拉丝', '喷漆(哑黑)', '喷漆(白)', '电镀', '镀镍', '镀铬', '丝印', '镭雕', '本色', '钝化', '发黑'] as const
const PROCESSES = ['CNC机加', 'CNC机加', 'CNC机加', '钣金折弯', '3D打印(SLA)', '3D打印(SLS)', '压铸+CNC', '车铣复合'] as const

// 我方商务 (our commercial owners) — also seeded as commerce users.
const COMMERCE = ['张磊', '王芳', '李伟', '陈静', '刘洋', '周敏'] as const
// 客户工程师 (customer-side engineers) — free-text on jobs, not app users.
const ENGINEERS = ['林工', '赵工', '孙工', '吴工', '郑工', '钱工', '冯工', '蒋工'] as const

// generic outsourcing partners (no real vendor names). [name, 做什么, 工段, weight].
// Surface treatment (氧化/电镀/喷砂/丝印/喷涂) is the bread-and-butter of a 手板
// shop's 外协 spend, so it carries the heavier weights; whole-part subcontracting
// (CNC/打印/钣金) rounds it out.
const VENDORS: readonly (readonly [string, string, Stage[], number])[] = [
  ['精密阳极氧化厂', '外发氧化', ['喷漆'], 10],
  ['专业喷涂厂', '外发喷塑', ['喷漆'], 7],
  ['精密电镀厂', '外发电镀', ['喷漆'], 6],
  ['表面处理-喷砂', '外发喷砂', ['打磨'], 6],
  ['丝印移印厂', '外发丝印', ['丝印'], 5],
  ['协力CNC外协', '外发CNC', ['操机'], 6],
  ['三维打印中心', '外发打印', ['操机'], 4],
  ['钣金外协', '外发钣金', ['操机'], 3],
  ['激光焊接', '外发焊接', ['手工'], 2],
]

// ── 4b. People — the boss + production roster (real full names) ───────────────
// The demo boss. FIXED id: the demo deployment's auto-login impersonates this
// exact row, so it must be inserted verbatim (never a DB-generated id). Role
// commerce (sees everything); PIN seeded from BOOTSTRAP_PIN.
const BOSS_DEMO_ID = '00000000-0000-4000-8000-000000000001'
const BOSS_DEMO_NAME = '陈国栋' // 总经理
const OUTSOURCE_HANDLER = '卢晓峰' // 外协/采购专员 (commerce)

// The production roster: [full name, home 工段]. 2–3 per busy stage; every
// STAGE is covered so stageWorker() always resolves to a right-stage person.
// These names land in part_stages.by_actor / started_by_actor and ARE what
// /report 报工 shows (worker_output attributes to by_actor).
const WORKER_ROSTER: readonly (readonly [string, Stage])[] = [
  ['徐建国', '工程'],
  ['王海涛', '编程'],
  ['李国庆', '编程'],
  ['刘建军', '操机'],
  ['陈永强', '操机'],
  ['赵德海', '操机'],
  ['周淑芬', '检验'],
  ['吴红兵', '手工'],
  ['何春生', '手工'],
  ['罗小平', '打磨'],
  ['黄伟民', '喷漆'],
  ['冯建华', '喷漆'],
  ['谢秀兰', '丝印'],
  ['唐国良', '质量'],
  ['邓志远', '出货'],
  ['蒋文斌', '出货'],
]

const WORKERS_BY_STAGE: Record<Stage, string[]> = STAGES.reduce((acc, s) => {
  acc[s] = WORKER_ROSTER.filter(([, st]) => st === s).map(([n]) => n)
  return acc
}, {} as Record<Stage, string[]>)
// Every stage has ≥1 worker in the roster, but guard anyway.
const stageWorker = (s: Stage): string => {
  const pool = WORKERS_BY_STAGE[s]
  return pool && pool.length ? pick(pool) : WORKER_ROSTER[0][0]
}

// Seed the boss + the whole roster into the users table. resetDb() does NOT
// touch users, so we clear our own demo rows first for idempotent re-runs
// (the app's self-healing 老板 bootstrap row is left alone).
async function seedUsers(): Promise<void> {
  const bcrypt = await import('bcryptjs')
  const pin = process.env.BOOTSTRAP_PIN ?? '0000'
  const pinHash = await bcrypt.hash(pin, 10)

  await supabase.from('users').delete().like('id', 'u-demo-%')
  await supabase.from('users').delete().eq('id', BOSS_DEMO_ID)

  const rows: Record<string, unknown>[] = []
  rows.push({ id: BOSS_DEMO_ID, name: BOSS_DEMO_NAME, pin_hash: pinHash, role: 'commerce', employee_role: 'management', default_stage: null, active: true })
  COMMERCE.forEach((name, i) =>
    rows.push({ id: `u-demo-c-${i}`, name, pin_hash: pinHash, role: 'commerce', employee_role: 'management', default_stage: null, active: true }),
  )
  rows.push({ id: 'u-demo-c-wx', name: OUTSOURCE_HANDLER, pin_hash: pinHash, role: 'commerce', employee_role: 'management', default_stage: null, active: true })
  WORKER_ROSTER.forEach(([name, stage], i) =>
    rows.push({ id: `u-demo-w-${i}`, name, pin_hash: pinHash, role: 'production', employee_role: stage === '丝印' ? 'post_processing' : 'machine', default_stage: null, active: true }),
  )

  const { error } = await supabase.from('users').insert(rows)
  if (error) throw error
}

// The 8-ish recurring 外协厂商, created once and reused by every block (createVendor
// dedupes by name, but pre-seeding keeps one row per vendor and avoids a SELECT
// per order). name → vendor id.
const vendorIdByName = new Map<string, string>()
async function seedVendors(): Promise<void> {
  for (const [name] of VENDORS) {
    if (vendorIdByName.has(name)) continue
    const v = await createVendor({ name })
    if (v) vendorIdByName.set(name, v.id)
  }
}

// ── 5. Pricing — small-batch 手板/CNC, rolls up to hard totals ────────────────
const QTY = [1, 1, 2, 2, 3, 3, 5, 5, 8, 10, 10, 20, 20, 30, 50, 100] as const
function unitPriceFor(material: string, process: string): number {
  let base: number
  if (process.startsWith('3D')) base = randint(60, 600)
  else if (material.includes('钛') || material.includes('7075')) base = randint(180, 1800)
  else if (material.includes('不锈钢') || material.includes('镁')) base = randint(120, 1200)
  else if (material.includes('ABS') || material.includes('PC') || material.includes('POM') || material.includes('PMMA')) base = randint(40, 400)
  else base = randint(60, 900) // aluminum CNC, the bread & butter
  const r = base < 200 ? 5 : base < 600 ? 10 : 50
  return Math.max(r, Math.round(base / r) * r)
}

type CompSpec = {
  name: string
  qty: number
  material: string
  surfaceTreatment: string
  process: string
  partNo?: string
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
    const partNo = chance(0.5)
      ? `${String.fromCharCode(65 + randint(0, 25))}${randint(100, 999)}-${randint(1, 99)}`
      : undefined
    comps.push({ name, qty, material, surfaceTreatment, process, partNo, unitPriceCny: unit, lineTotalCny: line })
    amount += line
  }
  const amt = chance(0.06) ? undefined : Math.round(amount)
  return { comps, amount: amt }
}

// ── 6. Progress model ─────────────────────────────────────────────────────────
// A single FINISH event: N-or-fewer parts of a job crossing one stage, credited
// to one worker at one instant. Aggregating these across all orders IS what
// worker_output() reports — the dry-run prints exactly this.
type StageFinish = { stage: Stage; actor: string; ts: string; count: number }
type DoneStage = { stage: Stage; actor: string; ts: string }
type CurrentStage = { stage: Stage; actor: string; ts: string; startTs: string; doneCount: number }

type MoneyPhase = 'shipped' | 'invoiced' | 'overdue' | 'settled'

// A priced 外协 block plan attached to an order. The block-level spendCny is what
// the board hero's 外协支出 / 毛利 read (external_spend_cny = Σ outsource_blocks
// .amount_cny; 毛利 = 金额 − 外协支出). Everything else is display detail.
type OutsourcePlan = {
  vendorName: string
  activity: string
  stages: Stage[]
  memberIdx: number[] // component indices sent to the vendor
  unitPricesByIdx: Record<number, number>
  spendCny: number // 外发金额 (block amount_cny — drives 毛利)
  sentDate: string // 派单日期 (YYYY-MM-DD)
  expectedReturn: string // 预计回件 (YYYY-MM-DD)
  closed: boolean // true = 已回件 (returned); false = 外协中 (still out)
  returnDate?: string // 回件日期 when closed
}

// ── 7. Order spec (pure data) ─────────────────────────────────────────────────
type OrderSpec = {
  jobNo: string
  intake: Date
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
  note?: string
  jobType: 'short' | 'medium' | 'long' | 'rush' | null
  isProduct: boolean
  outsource: boolean
  outsourceSpendCny?: number // Σ priced 外协 block amount (0/undefined = none)
  outsourcePlan?: OutsourcePlan
  drawingChange: boolean
  // progress
  kind: 'production' | 'paused' | 'shipped'
  inProduction: boolean // counts toward the 在产 board column
  N: number
  doneStages: DoneStage[]
  current?: CurrentStage
  shipped: boolean
  ship?: Date
  moneyPhase?: MoneyPhase
  pauseReason?: string
  showcase?: boolean
}

// The flat FINISH events an order contributes to worker_output.
function orderFinishEvents(spec: OrderSpec): StageFinish[] {
  const out: StageFinish[] = spec.doneStages.map((d) => ({
    stage: d.stage,
    actor: d.actor,
    ts: d.ts,
    count: spec.N,
  }))
  if (spec.current && spec.current.doneCount > 0) {
    out.push({
      stage: spec.current.stage,
      actor: spec.current.actor,
      ts: spec.current.ts,
      count: spec.current.doneCount,
    })
  }
  return out
}

// Plan the stage-by-stage progress of an in-house (production/paused) job that
// is currently sitting at stage index `k`. Stages [0,k) are fully done; stage k
// is partially done (k/N mix). Finishes are dated so recent stages land in the
// last few days INCLUDING today.
function planInHouse(N: number, k: number, intakeDaysAgo: number, stalled: boolean): {
  doneStages: DoneStage[]
  current: CurrentStage
} {
  const doneStages: DoneStage[] = []
  for (let j = 0; j < k; j++) {
    const stage = STAGES[j]
    const frac = (j + 1) / (k + 1)
    const dayAgo = Math.max(0, Math.min(intakeDaysAgo, Math.round(intakeDaysAgo * (1 - frac))))
    doneStages.push({ stage, actor: stageWorker(stage), ts: isoDaysAgo(dayAgo) })
  }
  const stage = STAGES[k]
  // Stalled (paused) jobs' last touch is older; live jobs are today-heavy.
  const curDayAgo = stalled ? randint(3, 9) : chance(0.6) ? 0 : 1
  const startDayAgo = Math.min(intakeDaysAgo, curDayAgo + randint(1, 3))
  const doneCount = N <= 1 ? 0 : Math.floor(rand() * N) // 0..N-1 → real k/N mix
  return {
    doneStages,
    current: {
      stage,
      actor: stageWorker(stage),
      ts: isoDaysAgo(curDayAgo),
      startTs: isoDaysAgo(startDayAgo),
      doneCount,
    },
  }
}

// Plan a fully-shipped job: every stage done, each credited to its home-stage
// worker at a DISTINCT instant walking intake→ship (so the 0072 cascade
// predicate never fires and 报工 attribution is real).
function planShipped(N: number, intake: Date, ship: Date): DoneStage[] {
  const span = ship.getTime() - intake.getTime()
  return STAGES.map((stage, j) => {
    const t = new Date(intake.getTime() + ((j + 1) / STAGES.length) * span)
    return { stage, actor: stageWorker(stage), ts: isoAt(t < NOW ? t : new Date(NOW.getTime() - randint(1, 3) * DAY)) }
  })
}

// ── 7b. Outsourcing cost mass ─────────────────────────────────────────────────
// The board hero's 毛利 is literally 金额 − 外协支出 (external_spend_cny = Σ of the
// order's outsource_blocks.amount_cny — there is NO other cost column in the
// schema). With almost no 外协 seeded, every order shows ~100% margin. So we
// give a majority of priced orders a real 外协 block whose amount is a big slice
// of the order value, landing the book's aggregate gross margin near a real
// 手板 shop's ~40%. (Because 外协 is the ONLY cost the model captures, the block
// stands in for total COGS, so a block can be a large fraction of 金额.)
const P_OUT = Number(process.env.SEED_OUT_COVER) || 0.9 // share of priced orders outsourced
const OUT_FRAC_LO = Number(process.env.SEED_OUT_FRAC_LO) || 0.5 // 外协 as fraction of 金额
const OUT_FRAC_HI = Number(process.env.SEED_OUT_FRAC_HI) || 0.86

// Plan (or decline) an 外协 block for one order. Never touches an in-house order's
// CURRENT stage (would disturb its live k/N in-progress state): outsources only a
// stage the order has already finished (→ 已回件 history) or one it hasn't reached
// (→ 外协中, still out). Shipped orders always get a returned block.
function planOutsource(spec: OrderSpec): OutsourcePlan | undefined {
  const amount = spec.amount
  const comps = spec.comps
  if (amount == null || amount <= 0 || comps.length === 0) return undefined
  if (!chance(P_OUT)) return undefined

  const [vName, activity, stages] = weighted(
    VENDORS.map(
      (v) => [[v[0], v[1], v[2]] as [string, string, Stage[]], v[3]] as const,
    ),
  )
  const stIdx = Math.min(...stages.map((s) => STAGES.indexOf(s)))

  // Open vs closed + 派单/回件 dates, chosen so we never disturb the live stage.
  let closed: boolean
  let sentDate: string
  let expectedReturn: string
  let returnDate: string | undefined
  if (spec.kind === 'shipped' && spec.ship) {
    const sent = addDays(spec.intake, randint(2, 8))
    let ret = addDays(spec.ship, -randint(1, 5))
    if (ret.getTime() <= sent.getTime()) ret = addDays(sent, randint(2, 6))
    if (ret.getTime() > spec.ship.getTime()) ret = spec.ship
    sentDate = ymd(sent > NOW ? NOW : sent)
    returnDate = ymd(ret > NOW ? NOW : ret)
    expectedReturn = returnDate
    closed = true
  } else {
    const k = spec.current ? STAGES.indexOf(spec.current.stage) : 0
    if (stIdx === k) return undefined // don't outsource the live current stage
    closed = stIdx < k
    if (closed) {
      const sent = addDays(NOW, -randint(6, 16))
      let ret = addDays(sent, randint(3, 9))
      if (ret.getTime() > NOW.getTime()) ret = addDays(NOW, -randint(1, 4))
      sentDate = ymd(sent)
      returnDate = ymd(ret)
      expectedReturn = returnDate
    } else {
      const sent = addDays(NOW, -randint(2, 9))
      sentDate = ymd(sent)
      expectedReturn = ymd(addDays(sent, randint(3, 10)))
    }
  }

  const fraction = OUT_FRAC_LO + rand() * (OUT_FRAC_HI - OUT_FRAC_LO)
  const spendCny = Math.max(50, Math.round(amount * fraction))
  // Members: 40–90% of the parts, at least one.
  const idxs = shuffle([...comps.keys()])
  const m = Math.max(1, Math.round(idxs.length * (0.4 + rand() * 0.5)))
  const memberIdx = idxs.slice(0, m).sort((a, b) => a - b)
  // Per-member unit prices that roughly sum to the block amount (cosmetic — the
  // block-level spendCny is authoritative for 外协支出 / 毛利).
  const totalQty = memberIdx.reduce((s, i) => s + (comps[i].qty || 1), 0)
  const perUnit = Math.max(1, Math.round(spendCny / Math.max(1, totalQty)))
  const unitPricesByIdx: Record<number, number> = {}
  for (const i of memberIdx) unitPricesByIdx[i] = perUnit

  return {
    vendorName: vName,
    activity,
    stages,
    memberIdx,
    unitPricesByIdx,
    spendCny,
    sentDate,
    expectedReturn,
    closed,
    returnDate,
  }
}

// ── 8. Generate the order book ────────────────────────────────────────────────
function genOrders(count: number, inProd: number, paused: number): OrderSpec[] {
  const seqByDay = new Map<string, number>()
  const specs: OrderSpec[] = []

  const baseFields = (
    intake: Date,
    customer: string,
    cat: Cat,
    comps: CompSpec[],
    amount: number | undefined,
    opts: Partial<OrderSpec> = {},
  ): Omit<OrderSpec, 'kind' | 'inProduction' | 'N' | 'doneStages' | 'shipped'> => {
    const dayKey = ymd(intake)
    const seq = (seqByDay.get(dayKey) ?? 0) + 1
    seqByDay.set(dayKey, seq)
    const jobNo = `${CODE}-${String(intake.getFullYear()).slice(-2)}-${intake.getMonth() + 1}-${intake.getDate()}-${String(seq).padStart(3, '0')}`
    const leadDays = randint(8, 45)
    const dueDate = opts.dueDate ?? ymd(addDays(intake, leadDays))
    const product = opts.product ?? `${comps[0].name}等${comps.length}项 手板`
    return {
      jobNo,
      intake,
      customer,
      cat,
      product,
      comps,
      amount,
      dueDate,
      engineer: opts.engineer ?? pick(ENGINEERS),
      commerce: opts.commerce ?? pick(COMMERCE),
      contractNo:
        opts.contractNo !== undefined
          ? opts.contractNo
          : chance(0.45)
            ? `HT${String(intake.getFullYear()).slice(-2)}${String(randint(1, 9999)).padStart(4, '0')}`
            : null,
      batchNo: opts.batchNo !== undefined ? opts.batchNo : chance(0.3) ? `P${randint(1, 9)}` : null,
      note: opts.note,
      jobType: opts.jobType ?? null,
      isProduct: opts.isProduct ?? false,
      outsource: opts.outsource ?? false,
      drawingChange: opts.drawingChange ?? false,
      current: opts.current,
      ship: opts.ship,
      moneyPhase: opts.moneyPhase,
      pauseReason: opts.pauseReason,
      showcase: opts.showcase,
    }
  }

  // ── The ~20 concurrent 在产 jobs, one currentStage each, believable spread ──
  // Distribution across the 10 STAGES (工程,编程,操机,检验,手工,打磨,喷漆,丝印,质量,出货).
  // Heavier in the middle (操机/手工/打磨) than the ends. Length === inProd-1
  // (the showcase fills one more 操机 slot).
  const spread: number[] = []
  const plan: [Stage, number][] = [
    ['工程', 2], ['编程', 2], ['操机', 3], ['检验', 1], ['手工', 3],
    ['打磨', 2], ['喷漆', 2], ['丝印', 1], ['质量', 2], ['出货', 1],
  ]
  for (const [s, n] of plan) for (let i = 0; i < n; i++) spread.push(STAGES.indexOf(s))
  // Trim/pad the spread to exactly inProd-1 entries.
  while (spread.length > inProd - 1) spread.pop()
  while (spread.length < inProd - 1) spread.push(STAGES.indexOf('操机'))
  const spreadShuffled = shuffle(spread)

  // Showcase Hikvision order — clean, mid-production (操机), pinned, tidy numbers.
  {
    const intakeDaysAgo = 9
    const intake = addDays(NOW, -intakeDaysAgo)
    const comps: CompSpec[] = [
      { name: '球机外壳', qty: 10, material: '6061铝合金', surfaceTreatment: '喷砂阳极', process: 'CNC机加', partNo: 'HK-8501', unitPriceCny: 850, lineTotalCny: 8500 },
      { name: '球机上盖', qty: 10, material: '6061铝合金', surfaceTreatment: '阳极氧化(黑)', process: 'CNC机加', partNo: 'HK-6201', unitPriceCny: 620, lineTotalCny: 6200 },
      { name: '云台底座', qty: 10, material: '6061铝合金', surfaceTreatment: '阳极氧化(黑)', process: 'CNC机加', partNo: 'HK-5401', unitPriceCny: 540, lineTotalCny: 5400 },
      { name: '镜头护罩', qty: 20, material: 'PC', surfaceTreatment: '本色', process: '3D打印(SLA)', unitPriceCny: 180, lineTotalCny: 3600 },
      { name: '红外灯板支架', qty: 20, material: '6061铝合金', surfaceTreatment: '本色', process: 'CNC机加', unitPriceCny: 120, lineTotalCny: 2400 },
    ]
    const amount = comps.reduce((s, c) => s + c.lineTotalCny, 0) // 26,100
    const base = baseFields(intake, '海康威视', 'security', comps, amount, {
      product: '球机结构件手板一套',
      engineer: '林工',
      contractNo: 'HT26-0418',
      batchNo: 'P1',
      outsource: true,
      showcase: true,
    })
    const N = comps.length
    const k = STAGES.indexOf('操机')
    const { doneStages, current } = planInHouse(N, k, intakeDaysAgo, false)
    specs.push({ ...base, kind: 'production', inProduction: true, N, doneStages, current, shipped: false })
  }

  // The other in-production jobs.
  for (const k of spreadShuffled) {
    const intakeDaysAgo = Math.max(k + 1, randint(2, 13))
    const intake = addDays(NOW, -intakeDaysAgo)
    const [customer, cat] = weighted(
      CUSTOMERS.map((c) => [[c[0], c[1]] as [string, Cat], c[2]] as const),
    )
    const { comps, amount } = buildComponents(cat)
    const base = baseFields(intake, customer, cat, comps, amount, {
      jobType: chance(0.08) ? 'rush' : null,
      outsource: chance(0.22),
      drawingChange: chance(0.1),
      note: chance(0.14) ? pick(['客户催得紧', '注意配合公差', '首件已发客户确认', '表面要求高，慎重']) : undefined,
    })
    const N = comps.length
    const { doneStages, current } = planInHouse(N, k, intakeDaysAgo, false)
    specs.push({ ...base, kind: 'production', inProduction: true, N, doneStages, current, shipped: false })
  }

  // ── A few 暂停 jobs — mid-production, on hold, carved OUT of 在产 ──
  for (let i = 0; i < paused; i++) {
    const intakeDaysAgo = randint(6, 24)
    const intake = addDays(NOW, -intakeDaysAgo)
    const [customer, cat] = weighted(
      CUSTOMERS.map((c) => [[c[0], c[1]] as [string, Cat], c[2]] as const),
    )
    const { comps, amount } = buildComponents(cat)
    const base = baseFields(intake, customer, cat, comps, amount, {
      pauseReason: pick(['等客户确认图纸', '客户暂停', '料未到', '等付款']),
    })
    const N = comps.length
    const k = randint(1, 6)
    const { doneStages, current } = planInHouse(N, k, intakeDaysAgo, true)
    specs.push({ ...base, kind: 'paused', inProduction: false, N, doneStages, current, shipped: false })
  }

  // ── The historical backdrop — shipped / invoiced / overdue / settled ──
  const historical = count - specs.length
  for (let i = 0; i < historical; i++) {
    // bias intake toward the last ~4 months: square the uniform
    const u = rand()
    const ageDays = Math.floor(3 + u * u * 360)
    const intake = addDays(NOW, -ageDays)
    const [customer, cat] = weighted(
      CUSTOMERS.map((c) => [[c[0], c[1]] as [string, Cat], c[2]] as const),
    )
    const { comps, amount } = buildComponents(cat)
    const moneyPhase: MoneyPhase =
      ageDays < 30
        ? weighted<MoneyPhase>([['shipped', 4], ['invoiced', 3], ['settled', 2], ['overdue', 1]])
        : ageDays < 90
          ? weighted<MoneyPhase>([['shipped', 2], ['invoiced', 3], ['settled', 4], ['overdue', 1]])
          : weighted<MoneyPhase>([['invoiced', 1], ['settled', 8], ['overdue', 1]])
    // ship a few days after intake, always in the past
    let ship = addDays(intake, randint(6, Math.min(34, Math.max(7, ageDays - 1))))
    if (ship.getTime() > NOW.getTime() - DAY) ship = addDays(NOW, -randint(1, 5))
    const base = baseFields(intake, customer, cat, comps, amount, {
      isProduct: chance(0.04),
      note: chance(0.05) ? pick(['已全部结清', '客户返单意向', '批量转产品']) : undefined,
    })
    const N = comps.length
    specs.push({
      ...base,
      kind: 'shipped',
      inProduction: false,
      N,
      doneStages: planShipped(N, intake, ship),
      shipped: true,
      ship,
      moneyPhase,
    })
  }

  // ── Outsourcing cost mass — assign each order a priced 外协 block (or none) so
  // the board hero's 毛利 reads like a real shop's ~40%. Single pass in array
  // order keeps it deterministic; runs AFTER all generation so the rest of the
  // order-book structure (customers/amounts/stages/报工) is untouched.
  for (const s of specs) {
    s.outsourcePlan = planOutsource(s)
    s.outsourceSpendCny = s.outsourcePlan?.spendCny ?? 0
    s.outsource = Boolean(s.outsourcePlan)
  }

  return specs
}

// Attach the planned 外协 block to a job through the app's own mutation, then —
// for a returned (closed) block — stamp its members fully returned so it reads as
// 已回件 (outsourced_closed = done) and never flips a finished stage back to
// 外协中 on the board. Open blocks stay 外协中. Either way the block's amount_cny
// is what the hero's 外协支出 / 毛利 read.
async function applyOutsource(
  job: Awaited<ReturnType<typeof createJob>>,
  plan: OutsourcePlan,
): Promise<void> {
  const vendorId = vendorIdByName.get(plan.vendorName)
  if (!vendorId) return
  const N = job.components.length
  const memberIdx = plan.memberIdx.filter((i) => i < N)
  const members = memberIdx.map((i) => job.components[i].id)
  if (members.length === 0) return
  const unitPricesCny: Record<string, number | null> = {}
  for (const i of memberIdx) unitPricesCny[job.components[i].id] = plan.unitPricesByIdx[i]
  const res = await createOutsourceBlockAt(job.id, members, {
    vendorId,
    activity: plan.activity,
    stages: plan.stages,
    amountCny: plan.spendCny,
    sentDate: plan.sentDate,
    expectedReturn: plan.expectedReturn,
    unitPricesCny,
  })
  if (res.ok && plan.closed) {
    await setBlockMembersReturnedQty(
      res.id,
      members.map((cid) => ({ componentId: cid, qty: 999_999 })), // clamped to member qty
      plan.returnDate ?? plan.expectedReturn,
    )
  }
}

// ── 9. Execute one order against the DB ──────────────────────────────────────
async function seedOrder(spec: OrderSpec): Promise<void> {
  const job = await createJob({
    jobNo: spec.jobNo,
    customer: spec.customer,
    product: spec.product,
    amountCny: spec.amount,
    dueDate: spec.dueDate,
    engineer: spec.engineer,
    notes: spec.note,
    components: spec.comps.map((c) => ({
      name: c.name,
      qty: c.qty,
      material: c.material,
      surfaceTreatment: c.surfaceTreatment,
      process: c.process,
      partNo: c.partNo,
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

  const N = job.components.length
  const partStageId = (i: number, stage: Stage) => `${job.id}:p${i + 1}:${stage}`

  if (spec.shipped && spec.ship) {
    // Ship the whole job (creates the 出货单 + cascades every stage done).
    const res = await prepareShipping(
      job.id,
      job.components.map((c) => ({ componentId: c.id, qty: c.qty })),
      stageWorker('出货'),
    )

    // Money: invoice + payment depending on phase.
    const invAmt = spec.amount ?? spec.comps.reduce((s, c) => s + c.lineTotalCny, 0)
    if (spec.moneyPhase && spec.moneyPhase !== 'shipped') {
      const overdue = spec.moneyPhase === 'overdue'
      const invDate = overdue ? addDays(NOW, -randint(45, 110)) : addDays(spec.ship, randint(2, 15))
      const patch: Record<string, unknown> = {
        invoiceNo: `${String(spec.intake.getFullYear()).slice(-2)}${String(randint(1, 99999)).padStart(5, '0')}`,
        invoiceDate: ymd(invDate > NOW ? NOW : invDate),
        invoiceAmountCny: invAmt,
      }
      if (spec.moneyPhase === 'settled') {
        const payDate = addDays(invDate, randint(20, 70))
        patch.paymentDate = ymd(payDate > NOW ? NOW : payDate)
        patch.paymentAmountCny = invAmt
      }
      await updateShipmentFinance(res.shipmentId, patch, spec.commerce)
    }
    await supabase.from('shipments').update({ created_at: isoAt(spec.ship) }).eq('id', res.shipmentId)

    // Re-attribute EVERY stage to its home-stage worker at a DISTINCT instant,
    // overwriting the shipper's cascade back-fill (the 报工 lie 0072 targets).
    for (const d of spec.doneStages) {
      await supabase
        .from('part_stages')
        .update({
          status: 'done',
          started_at: d.ts,
          finished_at: d.ts,
          completed_at: mmddOf(d.ts),
          by_actor: d.actor,
          started_by_actor: d.actor,
        })
        .like('id', `${job.id}:%`)
        .eq('stage', d.stage)
    }

    // Historical 外协 spend (returned) — carries the bulk of the book's COGS so
    // the hero 毛利 reads realistically.
    if (spec.outsourcePlan) await applyOutsource(job, spec.outsourcePlan)
  } else {
    // In-house (production / paused): tap each fully-done stage, then hand-set
    // the current stage's partial k/N.
    for (const d of spec.doneStages) {
      await startJobStage(job.id, d.stage, d.actor)
      await finishJobStage(job.id, d.stage, d.actor)
      // Backdate the timestamps this stage just got stamped with `now`.
      await supabase
        .from('part_stages')
        .update({ started_at: d.ts, finished_at: d.ts, completed_at: mmddOf(d.ts) })
        .like('id', `${job.id}:%`)
        .eq('stage', d.stage)
        .eq('status', 'done')
    }

    if (spec.current) {
      const cur = spec.current
      // Start the whole current stage (records started_by_actor for all parts).
      await startJobStage(job.id, cur.stage, cur.actor)
      const idxs = shuffle([...Array(N).keys()])
      const doneIdxs = idxs.slice(0, cur.doneCount)
      const restIdxs = idxs.slice(cur.doneCount)
      if (doneIdxs.length) {
        await supabase
          .from('part_stages')
          .update({
            status: 'done',
            started_at: cur.startTs,
            finished_at: cur.ts,
            completed_at: mmddOf(cur.ts),
            by_actor: cur.actor,
            started_by_actor: cur.actor,
          })
          .in('id', doneIdxs.map((i) => partStageId(i, cur.stage)))
      }
      if (restIdxs.length) {
        await supabase
          .from('part_stages')
          .update({ started_at: cur.startTs, started_by_actor: cur.actor })
          .in('id', restIdxs.map((i) => partStageId(i, cur.stage)))
      }
    }

    // 外协 block (已回件 history or 外协中) — never on the live current stage.
    if (spec.outsourcePlan && N > 0) await applyOutsource(job, spec.outsourcePlan)

    // 图纸变更 mark on one part of a few jobs (lights the live alarm).
    if (spec.drawingChange && N > 0) {
      const comp = pick(job.components)
      await raisePartDrawingChange({
        componentId: comp.id,
        jobId: job.id,
        note: pick(['客户修改了安装孔位', '外形尺寸变更', '增加沉头孔', '表面处理由喷砂改阳极']),
        raisedBy: spec.engineer,
      })
    }

    if (spec.kind === 'paused') {
      await setJobPaused(job.id, true, spec.pauseReason ?? '客户暂停', spec.commerce)
    }
  }

  // Backdate the job's created_at so the master board reads chronologically.
  await supabase.from('jobs').update({ created_at: isoAt(spec.intake) }).eq('id', job.id)

  if (spec.showcase) await setJobPin(job.id, true, spec.commerce)
}

// ── 10. Distribution printout (dry-run) ───────────────────────────────────────
function printStats(specs: OrderSpec[]) {
  const kind: Record<string, number> = {}
  const money: Record<string, number> = {}
  const cust: Record<string, number> = {}
  const amounts: number[] = []
  let withAmt = 0
  for (const s of specs) {
    kind[s.kind] = (kind[s.kind] ?? 0) + 1
    if (s.moneyPhase) money[s.moneyPhase] = (money[s.moneyPhase] ?? 0) + 1
    cust[s.customer] = (cust[s.customer] ?? 0) + 1
    if (s.amount) { amounts.push(s.amount); withAmt += s.amount }
  }
  amounts.sort((a, b) => a - b)
  const q = (p: number) => amounts[Math.floor(p * (amounts.length - 1))] ?? 0
  console.log('══════════════════════════ ORDER BOOK ══════════════════════════')
  console.log(`orders: ${specs.length}`)
  console.log(`total 金额: ¥${withAmt.toLocaleString('zh-CN')}  (avg ¥${Math.round(withAmt / amounts.length).toLocaleString('zh-CN')})`)
  console.log(`金额 spread: min ¥${q(0).toLocaleString()} | p25 ¥${q(.25).toLocaleString()} | median ¥${q(.5).toLocaleString()} | p75 ¥${q(.75).toLocaleString()} | p95 ¥${q(.95).toLocaleString()} | max ¥${q(1).toLocaleString()}`)
  console.log('kind mix:', kind)
  console.log('money-phase mix (historical):', money)
  console.log('top customers:', Object.entries(cust).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join('  '))
  const sorted = [...specs].sort((a, b) => a.intake.getTime() - b.intake.getTime())
  console.log('date span:', ymd(sorted[0].intake), '→', ymd(sorted[sorted.length - 1].intake))

  // ── 资金 / 毛利 (mirrors the board hero: 毛利 = Σ金额 − Σ外协支出) ──
  let outsourceCny = 0
  let outsourcedOrders = 0
  let openBlocks = 0
  const outByVendor: Record<string, number> = {}
  for (const s of specs) {
    const spend = s.outsourceSpendCny ?? 0
    if (spend > 0) {
      outsourceCny += spend
      outsourcedOrders += 1
      if (s.outsourcePlan) {
        outByVendor[s.outsourcePlan.vendorName] = (outByVendor[s.outsourcePlan.vendorName] ?? 0) + spend
        if (!s.outsourcePlan.closed) openBlocks += 1
      }
    }
  }
  const marginCny = withAmt - outsourceCny
  const marginPct = withAmt > 0 ? (marginCny / withAmt) * 100 : 0
  console.log('\n════════════════════════ 资金 / 毛利 (board hero) ════════════════')
  console.log(`总额 (Σ金额)   : ¥${withAmt.toLocaleString('zh-CN')}`)
  console.log(`外协支出       : ¥${outsourceCny.toLocaleString('zh-CN')}  (${outsourcedOrders}/${specs.length} orders, ${openBlocks} 外协中, ${(outsourceCny / withAmt * 100).toFixed(1)}% of 总额)`)
  console.log(`毛利           : ¥${marginCny.toLocaleString('zh-CN')}  (${marginPct.toFixed(1)}% of 总额)`)
  console.log('外协 by vendor :', Object.entries(outByVendor).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ¥${Math.round(v).toLocaleString()}`).join('  '))

  // ── 在产 snapshot ──
  const inProd = specs.filter((s) => s.inProduction)
  console.log('\n════════════════════════ 在产 SNAPSHOT ═══════════════════════')
  console.log(`concurrent 在产 orders: ${inProd.length}  (target ~${process.env.SEED_INPROD || 20})`)
  const byStage: Record<string, number> = {}
  for (const s of inProd) if (s.current) byStage[s.current.stage] = (byStage[s.current.stage] ?? 0) + 1
  console.log('per-stage active spread (current 工段):')
  for (const st of STAGES) console.log(`   ${st.padEnd(4)} ${'█'.repeat(byStage[st] ?? 0)} ${byStage[st] ?? 0}`)
  const partial = inProd.filter((s) => s.current && s.current.doneCount > 0 && s.current.doneCount < s.N).length
  console.log(`k/N partial-progress current stages: ${partial}/${inProd.length}`)

  // ── 报工 scoreboard (day / week / month) ──
  const dayW = shanghaiWindow(TODAY_SH, 'day')
  const weekW = shanghaiWindow(TODAY_SH, 'week')
  const monthW = shanghaiWindow(TODAY_SH, 'month')
  const inWin = (ts: string, w: { from: string; to: string }) => ts >= w.from && ts < w.to
  type Agg = { day: number; week: number; month: number; total: number; stage: Stage }
  const agg = new Map<string, Agg>()
  const homeStage = new Map<string, Stage>()
  for (const [name, stage] of WORKER_ROSTER) homeStage.set(name, stage)
  let totalEvents = 0
  for (const spec of specs) {
    for (const ev of orderFinishEvents(spec)) {
      totalEvents += ev.count
      const a = agg.get(ev.actor) ?? { day: 0, week: 0, month: 0, total: 0, stage: homeStage.get(ev.actor) ?? ev.stage }
      a.total += ev.count
      if (inWin(ev.ts, dayW)) a.day += ev.count
      if (inWin(ev.ts, weekW)) a.week += ev.count
      if (inWin(ev.ts, monthW)) a.month += ev.count
      agg.set(ev.actor, a)
    }
  }
  console.log('\n═══════════════════════ 报工 SCOREBOARD ══════════════════════')
  console.log(`worker roster: ${WORKER_ROSTER.length} production workers + boss(${BOSS_DEMO_NAME}) + ${COMMERCE.length} commerce + 外协(${OUTSOURCE_HANDLER})`)
  console.log(`total finish events: ${totalEvents.toLocaleString()}  (完成零件 across all windows)`)
  console.log(`windows — 日 ${dayW.from.slice(0, 10)} · 周 ${weekW.from.slice(0, 10)}→ · 月 ${monthW.from.slice(0, 7)}`)
  console.log('  worker        工段    今日   本周   本月    合计')
  const rows = [...agg.entries()].sort((a, b) => b[1].total - a[1].total)
  for (const [name, a] of rows) {
    console.log(
      `  ${name.padEnd(12)}${(a.stage ?? '').padEnd(5)}${String(a.day).padStart(5)}${String(a.week).padStart(7)}${String(a.month).padStart(7)}${String(a.total).padStart(8)}`,
    )
  }
  const dayTot = rows.reduce((s, [, a]) => s + a.day, 0)
  const weekTot = rows.reduce((s, [, a]) => s + a.week, 0)
  const monthTot = rows.reduce((s, [, a]) => s + a.month, 0)
  console.log(`  ${'—— totals'.padEnd(17)}${String(dayTot).padStart(5)}${String(weekTot).padStart(7)}${String(monthTot).padStart(7)}${String(totalEvents).padStart(8)}`)
  const activeToday = rows.filter(([, a]) => a.day > 0).length
  console.log(`workers active 今日: ${activeToday}/${WORKER_ROSTER.length}   本周: ${rows.filter(([, a]) => a.week > 0).length}/${WORKER_ROSTER.length}`)

  console.log('\nsample orders:')
  for (const s of [specs[0], ...sorted.slice(-4)]) {
    const at = s.current ? `@${s.current.stage}(${s.current.doneCount}/${s.N})` : s.shipped ? '已出货' : ''
    console.log(`  ${s.jobNo}  ${s.customer.padEnd(6)}  ${(s.amount ? '¥' + s.amount.toLocaleString() : '待报价').padEnd(10)}  ${s.comps.length}件  ${s.kind}${s.moneyPhase ? '/' + s.moneyPhase : ''} ${at}${s.jobType ? ' ' + s.jobType : ''}${s.outsource ? ' 外协' : ''}`)
  }
}

// ── 11. Main ──────────────────────────────────────────────────────────────────
async function main() {
  const count = Number(process.env.SEED_COUNT) || 240
  const inProd = Number(process.env.SEED_INPROD) || 20
  const paused = Number(process.env.SEED_PAUSED) || 3

  if (DRY_MODE) {
    const specs = genOrders(count, inProd, paused)
    printStats(specs)
    process.exit(0)
  }

  console.log(`Seeding demo (智造精密): ${count} orders into ${process.env.SUPABASE_URL}`)

  if (RESET) {
    console.log('Resetting database (wiping jobs/vendors/customers)…')
    await resetDb()
  }
  await ensureBootstrapUser()
  console.log('Seeding users (boss + production roster)…')
  await seedUsers()
  console.log('Seeding 外协厂商…')
  await seedVendors()

  const specs = genOrders(count, inProd, paused)
  // insert oldest-first so position/sequence reads naturally
  specs.sort((a, b) => a.intake.getTime() - b.intake.getTime())

  let done = 0
  let totalCny = 0
  let outsourceCny = 0
  let outsourcedOrders = 0
  const kindCount: Record<string, number> = {}
  for (const spec of specs) {
    try {
      await seedOrder(spec)
      totalCny += spec.amount ?? 0
      outsourceCny += spec.outsourceSpendCny ?? 0
      if (spec.outsourceSpendCny) outsourcedOrders += 1
      kindCount[spec.kind] = (kindCount[spec.kind] ?? 0) + 1
    } catch (e) {
      console.error(`  ! ${spec.jobNo} (${spec.customer}) failed:`, (e as Error).message)
    }
    if (++done % 20 === 0) console.log(`  …${done}/${specs.length}`)
  }

  const marginCny = totalCny - outsourceCny
  const marginPct = totalCny > 0 ? (marginCny / totalCny) * 100 : 0
  console.log('\nDone.')
  console.log(`  orders seeded : ${done}`)
  console.log(`  在产 (production): ${kindCount['production'] ?? 0}`)
  console.log(`  total 金额    : ¥${totalCny.toLocaleString('zh-CN')}`)
  console.log(`  外协支出      : ¥${outsourceCny.toLocaleString('zh-CN')}  (${outsourcedOrders} orders)`)
  console.log(`  毛利          : ¥${marginCny.toLocaleString('zh-CN')}  (${marginPct.toFixed(1)}% of 金额)`)
  console.log(`  kind mix      :`, kindCount)
  process.exit(0)
}

main().catch((e) => {
  console.error('Seed failed:', e)
  process.exit(1)
})
