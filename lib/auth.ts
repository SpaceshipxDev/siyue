import 'server-only'
import { cache } from 'react'
import { redirect } from 'next/navigation'
import type { Stage } from './data'
import { getUserById, isAdminUser } from './db'
import { readSession } from './session'

export type Role = 'commerce' | 'production'

export type AuthUser = {
  id: string
  name: string
  role: Role
  defaultStage?: Stage
  // 财务可见性 flag from users.is_finance (migration 0051). Gates the
  // 支出/月度 tabs — payroll amounts are sensitive, so ordinary 商务 keep
  // seeing 应收 only. Check via canSeeExpenses, never this flag directly
  // (the boss is granted in code even on a pre-migration DB).
  isFinance: boolean
  // 改一下 access (users.can_gai, migration 0095). Check via canGai, never this flag directly.
  canGai: boolean
}

// Wrapped in React `cache` so multiple component reads in the same render
// share one DB hit. The cookie is read inside, but the `cookies()` call is
// itself per-request so memoization is correct.
export const currentUser = cache(async (): Promise<AuthUser | null> => {
  const session = await readSession()
  if (!session) return null
  const user = await getUserById(session.sub)
  if (!user) return null
  if (!user.active) return null
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    defaultStage: user.defaultStage,
    isFinance: user.isFinance,
    canGai: user.canGai,
  }
})

export async function requireUser(): Promise<AuthUser> {
  const u = await currentUser()
  if (!u) redirect('/login')
  return u
}

// Page guard for commerce-only routes. Production users would have already
// been redirected away by the proxy; this is defense in depth for the case
// where a request slips past (matcher gap, deep link from cache, etc).
export async function requireCommerce(): Promise<AuthUser> {
  const u = await requireUser()
  if (u.role !== 'commerce') {
    redirect(landingPathFor(u))
  }
  return u
}

// Minimal scope shape for dto.ts and the proxy. Anything that needs to make
// a "what can this user see" decision should take Scope, not Role — because
// 出货 (shipping) station heads run as production but need commerce-flavored
// visibility into customer data so they can print 出货单.
export type Scope = Pick<AuthUser, 'role' | 'defaultStage'>

export function canSeeMoney(s: Scope): boolean {
  return s.role === 'commerce'
}

// 支出台账 / 工资 / 月度现金流 — the boss, designated finance users, and a
// per-person allowlist. These pages carry every person's pay, so this is
// deliberately narrower than canSeeMoney (which every 商务 holds).
//
// The allowlist is the same shape as REPORT_VIEWER_USER_IDS and
// ORDER_LEDGER_VIEWER_USER_IDS below, and exists for the same reason: 于海伟
// runs the shop's people (he's the only account that may edit or delete a
// 人事 line, see HR_EDITOR_USER_IDS) and 工资 is his to settle, but he signs in on a
// 工程 production account whose role would otherwise stop at the 订单 book.
// A grant by name, not by role — 工资 is not something a whole 工段 gets.
const EXPENSE_VIEWER_USER_IDS = new Set<string>([
  'u-mose92lt-a0cutz', // 于海伟 — 生产号 (工程)
  'u-ms45yjq9-2kbdi1', // 于海伟 — 商务号
])

// The 老板 bootstrap account qualifies unconditionally so a half-applied
// migration can never lock the boss out of his own books.
export function canSeeExpenses(u: AuthUser): boolean {
  if (isAdminUser(u.id) || EXPENSE_VIEWER_USER_IDS.has(u.id)) return true
  return u.role === 'commerce' && u.isFinance
}

// 改一下 — the self-serve mirror + 上线. Granted by the boss per person in 管理员工;
// the boss himself always qualifies, even on a pre-migration DB.
export function canGai(u: AuthUser): boolean {
  return u.canGai || isAdminUser(u.id)
}

// ─── 人事 (请假 / 迟到 / 旷工 / 违纪 / 重大质量异常) ────────────────────────
//
// Three tiers, because the three questions are different:
//
//   填报 + 看本部门 — everyone who runs people. A 工段长 has to be able to
//     write down that his own man came in late, and to read his own 部门's
//     month; he must NOT be able to read another 工段's, because that is
//     somebody else's pay and somebody else's discipline.
//   看全部        — 商务 (the office runs payroll) and 采购站. The whole
//     factory in one table is a management view, not a working one.
//   改 / 删       — named people only, see HR_EDITOR_USER_IDS. A slip gets
//     corrected in place; a deleted 违纪 leaves no trace it ever happened.
//
// 部门 is the 工段 (商务 for office accounts) — this shop has no other notion
// of one, and the 工段 IS the team a person answers to.
export function hrDeptOf(s: Scope): string {
  return s.role === 'commerce' ? '商务' : (s.defaultStage ?? '未分部门')
}

// Anyone signed in may file — scoped to their own 部门 by hrDeptOf, so the
// blast radius of a floor account is its own team. Widen-then-scope rather
// than a per-person allowlist: the shop's managers are not enumerable in the
// user table (half the floor shares a station account), and a 工段长 who
// can't file is a 工段长 who keeps using paper.
export function canUseHr(_s: Scope): boolean {
  void _s
  return true
}

// 看全部 — every 部门 in one table. 商务 covers 老板 + 商务于海伟 + 人事;
// 采购站 is named because 采购 runs as production but sits in the office.
export function canSeeAllHr(s: Scope): boolean {
  return s.role === 'commerce' || s.defaultStage === '采购'
}

export async function requireHrUser(): Promise<AuthUser> {
  const u = await requireUser()
  if (!canUseHr(u)) redirect(landingPathFor(u))
  return u
}

// Who can 改 or 删 a 人事 record — the third tier described above, and one
// list for both because they answer the same question: who is trusted to
// reach back into a line that pay and discipline get argued from. Filing a
// line stays open to everybody; going back and altering one does not. Named
// people only, same as 零件行删除 and 订单删除.
//
// 改 exists because the common mistake is a slip, not a lie: 事假 tapped when
// it was 病假, 8 typed when it was 4. Before this the only fix was 删 + 重记,
// which meant the correction needed the heavier of the two permissions and
// silently moved the line's 记录人 to whoever fixed it.
const HR_EDITOR_USER_IDS = new Set<string>([
  'u-ms45yjq9-2kbdi1', // 商务于海伟
  'u-mose92lt-a0cutz', // 于海伟 — 工程号, 同一个人的另一个登录
])

export function canDeleteHrRecord(u: AuthUser): boolean {
  return HR_EDITOR_USER_IDS.has(u.id)
}

export function canEditHrRecord(u: AuthUser): boolean {
  return HR_EDITOR_USER_IDS.has(u.id)
}

// ─── 住宿登记 (谁住哪一间) ──────────────────────────────────────────────
//
// 宿舍是人事采购在管的 — 谁搬进来、谁换了房间, 她当天就知道, 所以填的是她
// (老板永远算一个)。看的人比填的人多一档: 老板、财务、于海伟 —— 住宿是记在
// 人头上的成本, 跟工资一起读才有意义, 所以直接沿用 canSeeExpenses 那一档,
// 不另开一个名单去维护。
const DORM_EDITOR_USER_IDS = new Set<string>([
  'u-mqoj62uq-olmh4c', // 采购人事
])

export function canEditDorm(u: AuthUser): boolean {
  return DORM_EDITOR_USER_IDS.has(u.id) || isAdminUser(u.id)
}

export function canSeeDorm(u: AuthUser): boolean {
  return canEditDorm(u) || canSeeExpenses(u)
}

// Page/export guard for the 支出/工资/月度 finance tabs. The grant is
// canSeeExpenses itself — role is not a second gate, or an allowlisted
// production account would be stopped here after being let through there.
// Anyone short of it lands back on the 订单 tab rather than an error page.
export async function requireFinance(): Promise<AuthUser> {
  const u = await requireUser()
  if (!canSeeExpenses(u)) redirect('/finance')
  return u
}

// Customer name, customerId, contractNo, batchNo — anything customer-facing
// that's needed to print 出货单 or look the order up by customer.
export function canSeeCustomerData(s: Scope): boolean {
  return s.role === 'commerce' || s.defaultStage === '出货'
}

// 改 / 删一张已开的出货单. The people who make them plus the 工程 head:
// a delivery note gets typed wrong at the loading dock, and whoever is holding
// the parts is the one who notices. Making them wait for somebody else to undo
// it is how a wrong 已交数量 survives to month-end reconciliation.
//
// A shipment that has been invoiced or paid against refuses to delete
// regardless of who asks (see deleteShipment) — that's an accounting fact, not
// a permission.
export function canEditShipment(s: Scope): boolean {
  return canSeeCustomerData(s) || canEditPartRoute(s)
}

// Outsource management — creating shipments, receiving parts back, printing
// 外协单. 商务 owns this end-to-end; 工程 head also runs it because in many
// shops the same person who plans the routing is the one who hands off
// parts to the vendor. Money on the page (block amounts, totals) follows
// canSeeMoney separately, so 工程 sees vendor + dates + members but not
// pricing unless the rest of the system grants it.
export function canManageOutsource(s: Scope): boolean {
  return s.role === 'commerce' || s.defaultStage === '工程'
}

// Vendor info, outsource block details — commerce + 工程 (the outsource
// managers). Production stations other than 工程 still get scrubbed vendor
// fields via dto.ts.
export function canSeeVendor(s: Scope): boolean {
  return canManageOutsource(s)
}

export function canEditJob(s: Scope): boolean {
  return s.role === 'commerce'
}

// 采购 审批 — clearing (or rejecting) the floor's 请购 requests. The office
// (商务) plus whoever mans the 采购 station itself. Every new buy is born
// 待审批, approvers' own included — approval is always a second pair of eyes.
export function canApproveProcurement(s: Scope): boolean {
  return s.role === 'commerce' || s.defaultStage === '采购'
}

// Stage chips on import draft (商务) and job detail (工程) pages. 商务 owns
// the initial route; 工程 keeps editing rights post-import because they
// catch routing mistakes once the part actually hits the floor. Other
// production stations only see the chips read-only.
export function canEditPartRoute(s: Scope): boolean {
  return s.role === 'commerce' || s.defaultStage === '工程'
}

// 工程 sees the same holistic master view as 商务 minus customer/money,
// and edits the same non-commercial job/component fields commerce edits
// (product, jobNo, dueDate, qty, material, etc). Same scope as
// canEditPartRoute today; named separately so the UI/action gates read
// at the right level of intent.
export function canEditProductionFields(s: Scope): boolean {
  return canEditPartRoute(s)
}

// 一键导出生产单 (.xlsx) — 商务 + 工程. The 生产单 is a shop-floor traveler,
// not a commercial document: it carries 单号/交期/备注/项目分组/跟单商务 and a
// 图号·材质·加工方式·工艺要求 part table with photos. No customer, no prices.
// 工程 already owns the fields it's built from (canEditProductionFields) and
// hands the printed sheet to the floor, so they get the export too.
export function canExportProductionOrder(s: Scope): boolean {
  return s.role === 'commerce' || s.defaultStage === '工程'
}

// Server-action guard for setPartRouteAction. Mirrors requireCommerce —
// throws via redirect when a non-editor tries to save.
export async function requirePartRouteEditor(): Promise<AuthUser> {
  const u = await requireUser()
  if (canEditPartRoute(u)) return u
  redirect(landingPathFor(u))
}

// Page guard for routes that the 出货 station head also needs (e.g. printing
// the customer-facing 出货单). Production users at other stations get bounced.
export async function requireCommerceOrShipping(): Promise<AuthUser> {
  const u = await requireUser()
  if (u.role === 'commerce') return u
  if (u.defaultStage === '出货') return u
  redirect(landingPathFor(u))
}

// Page + action guard for the 外协 surface — 商务 and 工程 both qualify.
// Mirrors requireCommerce but allows the 工程 head, who in this shop runs
// the vendor handoff alongside commerce.
export async function requireOutsourceManager(): Promise<AuthUser> {
  const u = await requireUser()
  if (canManageOutsource(u)) return u
  redirect(landingPathFor(u))
}

// /pulse (现场) view — 商务 + 工程 both qualify. The 工程 head runs the
// floor and needs the same factory-wide pulse view commerce uses (where is
// work piling up? what just moved?). Money columns on the page itself
// still follow canSeeMoney separately, so 工程 sees jobs/parts counts and
// the activity feed but no ¥ values.
export function canSeeFactoryPulse(s: Scope): boolean {
  return s.role === 'commerce' || s.defaultStage === '工程'
}

export async function requirePulseViewer(): Promise<AuthUser> {
  const u = await requireUser()
  if (canSeeFactoryPulse(u)) return u
  redirect(landingPathFor(u))
}

// Route guard for the 生产单 .xlsx download. Mirrors requireCommerce but
// lets the 工程 head through — see canExportProductionOrder.
export async function requireProductionOrderExporter(): Promise<AuthUser> {
  const u = await requireUser()
  if (canExportProductionOrder(u)) return u
  redirect(landingPathFor(u))
}

// 笔记 — born as the boss's scratchpad, and it stuck: the whole commerce
// office writes in it. 工程 gets it too (same commerce+工程 pair as 现场/
// 交接/外协 — the 工程 head runs the floor and keeps the same kind of
// running notes the boss does). Notes stay per-author regardless.
export function canUseNotes(s: Scope): boolean {
  return s.role === 'commerce' || s.defaultStage === '工程'
}

export async function requireNotesUser(): Promise<AuthUser> {
  const u = await requireUser()
  if (canUseNotes(u)) return u
  redirect(landingPathFor(u))
}

// ─── 零件行 权限 (adding / deleting rows on a job's 零件进度 sheet) ───────────
//
// These two capabilities are PER-PERSON allowlists, not role/stage rules, and
// that is deliberate. `defaultStage` is not trustworthy as an org chart on this
// DB: the seed parked most production accounts at 工程, so 车工徐兴旺, 质量倪伟群,
// 手工001潘健, 打磨喷漆, 批量组001夏, 塑料操机001吴亦能 … all read as "工程" today.
// A rule of the form `role === 'commerce' || defaultStage === '工程'` therefore
// hands the sheet's structure to half the shop floor.
//
// The alternative — repointing those accounts' default_stage at their real
// station — would silently change what stages they may 报工 on (requireOwnStage
// reads the same field) and where they land after login. That is a much larger,
// riskier change than the one being asked for, so the stage data is left exactly
// as it is and the row capability is expressed here instead.
//
// Granting or revoking someone = one line in the set below. Names are kept in
// the comments because ids are unreadable; the id is what's authoritative.

// Who can ADD a 零件 row (the + on a row's separator line, 添加零件, and the
// same gestures on the import draft): the whole 商务 office, plus the actual
// 工程 team by name.
const PART_ROW_CREATOR_USER_IDS = new Set<string>([
  'u-mose92lt-a0cutz', // 于海伟 — 工程
  'u-mose0apu-9ugtd8', // 周江华 — 工程
  'u-mpc3rcje-6987yo', // 程江华 — 工程
  'u-mroawaab-g84mo6', // 彭炳才 — 工程
  'u-mose7y1k-r91xn7', // 涂明杰 — 工程
  'u-mose8blz-dnkt24', // 工程003
  'u-mose8mdn-c8m695', // 工程004
  'u-mounqsw2-5g86hh', // harry 2 — 工程 (dev/test account)
])

export function canCreatePartRow(u: AuthUser): boolean {
  return u.role === 'commerce' || PART_ROW_CREATOR_USER_IDS.has(u.id)
}

// Who can DELETE a 零件 row. Strictly narrower than adding: an extra row is a
// visible mistake anyone can see and remove, a deleted row takes its 报工
// history with it and nobody notices until the part is missing at 出货. Named
// people only — 于海伟 (both his accounts), 黄优兰香, 老板, Harry.
const PART_ROW_DELETER_USER_IDS = new Set<string>([
  'u-mose92lt-a0cutz', // 于海伟 — 工程
  'u-ms45yjq9-2kbdi1', // 商务于海伟 — 他的商务号
  'u-mosdsv5z-pzalzv', // 黄优兰香
  'u-bootstrap-commerce', // 老板
  'u-mosbgpwr-pczcze', // Harry
  'u-mounqsw2-5g86hh', // harry 2 (dev/test account)
])

export function canDeletePartRow(u: AuthUser): boolean {
  return PART_ROW_DELETER_USER_IDS.has(u.id)
}

// Who can DELETE a 工单 (the × in the 导入收件箱 and the 丢弃 on a 工号-conflict
// import). The whole 商务 office has always had it; 工程 gets it by name only.
// Named rather than by defaultStage because ~15 floor accounts (车工/质量/手工/
// 打磨/操机) are parked at default_stage=工程 — the same trap canCreatePartRow
// was built to dodge — and they can all reach /import.
//
// Note this is only half the rule: deleteJobAction also refuses any job at
// status='ready'. A confirmed 单号 carries production history and is never
// deletable by anyone; delete exists to clean up drafts and failed parses.
const JOB_DELETER_USER_IDS = new Set<string>([
  'u-mose92lt-a0cutz', // 于海伟 — 工程 (his 商务号 qualifies via role)
  'u-mounqsw2-5g86hh', // harry 2 (dev/test account)
])

export function canDeleteJob(u: AuthUser): boolean {
  return u.role === 'commerce' || JOB_DELETER_USER_IDS.has(u.id)
}

// Server-action guard for deleteJobAction. Mirrors requireCommerce — the
// client shows a 权限 popover before it ever gets here, so reaching this
// redirect means the button was bypassed.
export async function requireJobDeleter(): Promise<AuthUser> {
  const u = await requireUser()
  if (canDeleteJob(u)) return u
  redirect(landingPathFor(u))
}

// Who can DELETE a CONFIRMED 工单 — the 删除 on the job page, which takes the
// whole order down regardless of status: parts, 报工 history, 出货记录 and the
// board row all cascade with it (0001_init FK graph). Deliberately narrower
// than canDeleteJob (draft cleanup, whole 商务 office): this is the only
// irreversible gesture in the product, so it's named people, not a role.
const ORDER_DELETER_USER_IDS = new Set<string>([
  'u-bootstrap-commerce', // 老板
  'u-mosbgpwr-pczcze', // Harry
  'u-mosdsv5z-pzalzv', // 黄优兰香
  'u-mose92lt-a0cutz', // 于海伟 — 工程号
  'u-ms45yjq9-2kbdi1', // 商务于海伟 — 他的商务号
  'u-mounqsw2-5g86hh', // harry 2 (dev/test account)
])

export function canDeleteOrder(u: AuthUser): boolean {
  return ORDER_DELETER_USER_IDS.has(u.id)
}

// 撤销一个已经报完的工序 — 名单制, 跟 零件行删除 / 订单删除 同一个道理。
//
// 开始点错了当场撤是一回事 (谁能点这道就能撤自己刚点下去的 ▶, 见
// undoStageStart); 把一道"已完成"退回去是另一回事 —— 完成时间和经手人是工资、
// 交期、产能全都在读的数, 一个人默默退掉三天前的完成, 没人会发现。
//
// 检验 / 质量 那两道不在此列: 那里的 ✓ 是判定 (OK), 撤销判定属于质量流程,
// 检验员判错了必须能当场改, 见 /api/mutate 的 undoStage。
const STAGE_UNDO_USER_IDS = new Set<string>([
  'u-ms45yjq9-2kbdi1', // 商务于海伟
  'u-mose92lt-a0cutz', // 于海伟 — 工程号
])

export function canUndoFinishedStage(u: AuthUser): boolean {
  return STAGE_UNDO_USER_IDS.has(u.id) || isAdminUser(u.id)
}

// ─── 报工 工段范围 (which stage cells a user may CLICK) ──────────────────────
//
// The boss reads money out of stage progress now, so a tap on someone else's
// station is no longer harmless noise — it corrupts the measurement. Every
// stage write (start/finish/undo/数量/检验/移交 — /api/mutate and the server
// actions alike) goes through canClickStage; the client shows a denial popup
// before the request even fires (app/_stage_scope.tsx).
//
// PER-PERSON map, same pattern (and same reason) as the part-row allowlists
// below: default_stage is NOT an org chart — the seed parked most of the
// floor at 工程, and repointing it would silently move logins and 报工
// attribution. The stage data stays exactly as-is; scope lives here.
//
// Derived 2026-08-15 from the boss's ERP permission matrix (✓ = operate,
// 查看 = read-only) cross-checked against 45 days of real taps in
// worker_stage_events, so nobody's actual recorded work went dark.
// Grant/revoke = edit one line.

export type StageScope = 'all' | readonly Stage[]

// 商务 office pattern: floor stages are 查看-only; they operate the
// commercial tail of the route. (外协 is its own surface, gated separately
// by canManageOutsource.)
const COMMERCE_STAGE_SCOPE: readonly Stage[] = ['采购', '表处', '出货']

// 后道三道 — 打磨 → 喷漆 → 丝印 是同一批人接着做的一条线，所以打磨账号报这
// 三个。手工 和 表处 不在里面：手工是另一个工位，表处是外协出去做的，都不该
// 从这个账号上报。(喷涂 = 喷漆，厂里两种叫法，系统里只有 喷漆 这一个工段。)
const FINISHING_STAGE_SCOPE: readonly Stage[] = ['打磨', '喷漆', '丝印']

const STAGE_SCOPE_BY_USER_ID: Record<string, StageScope> = {
  // — full access —
  'u-bootstrap-commerce': 'all', // 老板
  'u-mosbgpwr-pczcze': 'all', // Harry
  'u-mounqsw2-5g86hh': 'all', // harry 2 (dev/test)
  'u-ms45yjq9-2kbdi1': 'all', // 商务于海伟
  'u-mosdsv5z-pzalzv': 'all', // 黄优兰香 — boss's explicit grant
  // — 工程 (the real team) — routing owners act anywhere —
  'u-mose92lt-a0cutz': 'all', // 于海伟
  'u-mose0apu-9ugtd8': 'all', // 周江华
  'u-mpc3rcje-6987yo': 'all', // 程江华
  'u-mroawaab-g84mo6': 'all', // 彭炳才
  'u-mose7y1k-r91xn7': 'all', // 涂明杰
  'u-mose8blz-dnkt24': 'all', // 工程003
  'u-mose8mdn-c8m695': 'all', // 工程004
  // — 商务 —
  'u-mose9jng-o2g5ux': COMMERCE_STAGE_SCOPE, // 王雪梅
  'u-mp0s2vcp-1n0j4g': COMMERCE_STAGE_SCOPE, // 俞予悦
  'u-mosebiu8-81wy27': COMMERCE_STAGE_SCOPE, // 商务002
  'u-mose9xll-rtkinm': COMMERCE_STAGE_SCOPE, // 商务003
  'u-mosea6fl-p7zplz': COMMERCE_STAGE_SCOPE, // 商务004
  'u-moseby56-6vvs6y': COMMERCE_STAGE_SCOPE, // 商务005
  'u-mpvyxug7-9qo3hr': [], // 费会计 — reads the books, never taps a stage
  // — floor (most were seed-parked at default_stage=工程; this map is truth) —
  'u-mpkp07b5-fo939e': ['操机'], // 塑料操机001吴亦能
  'u-mpdgnrqb-66dbhr': ['操机'], // 塑料操机002罗杰
  'u-mpdgme24-aqp6cm': ['操机'], // 金属操机001高发祥
  'u-mpdgmq1d-q1celf': ['操机'], // 金属操机002小伍
  'u-mpdgklfi-3r0tfm': ['编程', '操机'], // 车工李元发 — 车工 run both per ERP matrix
  'u-mpdgkaii-we81gu': ['编程', '操机'], // 车工徐兴旺
  'u-mpdgg8zl-6vavvt': ['编程', '操机'], // 编程001高浩灿
  'u-mpdgirjs-facsb5': ['编程', '操机'], // 编程002李军军
  'u-mpdgj774-wnwgsf': ['编程', '操机'], // 编程003吴润静
  'u-mpdgjdiu-lq2hso': ['编程', '操机'], // 编程004毛伟超
  'u-mpdgjma9-lgyznp': ['编程', '操机'], // 编程005戴棵
  'u-mpdgjtj2-nzx055': ['编程', '操机'], // 编程006宋跃文
  'u-mpdg0tcr-beaxrv': ['手工', '打磨'], // 手工001潘健 — 299 real 打磨 taps/45d
  // 打磨喷漆 — 老板 2026-09 收紧：只报后道三道。原先还带着 手工 和 表处
  // (45 天里确有记录)，但那是别人的工位和外协的活，从这个账号上报会把工时和
  // 进度记到错的地方。
  'u-mpdgdq8f-fn7k40': FINISHING_STAGE_SCOPE, // 打磨喷漆
  'u-mpdg1xc0-w221oi': ['手工', '打磨', '喷漆'], // 批量组001夏
  'u-mpdgqdy0-twnhmy': ['质量', '检验', '出货'], // 质量周中华 — de facto shipper (2,105 出货 taps/45d)
  'u-mpdgra00-srf0qm': ['质量', '检验'], // 质量倪伟群
  'u-mpkkcscl-9aoza0': ['质量', '检验'], // 刘敏敏
  'u-mpkkghqt-p8qrvy': ['质量', '检验'], // 李佳怡
  'u-mqoj62uq-olmh4c': ['采购'], // 采购人事
}

// Accounts created after this map was written (new hires) fall back to the
// closest sane rule until someone adds them above: 商务 → the commercial
// tail, 工程 → everywhere, 打磨 → the three finishing stations it works as
// one, other production → their own station only.
function fallbackStageScope(u: AuthUser): StageScope {
  if (u.role === 'commerce') return COMMERCE_STAGE_SCOPE
  if (u.defaultStage === '工程') return 'all'
  if (u.defaultStage === '打磨') return FINISHING_STAGE_SCOPE
  return u.defaultStage ? [u.defaultStage] : []
}

export function stageScopeFor(u: AuthUser): StageScope {
  if (isAdminUser(u.id)) return 'all'
  return STAGE_SCOPE_BY_USER_ID[u.id] ?? fallbackStageScope(u)
}

export function canClickStage(u: AuthUser, stage: Stage): boolean {
  const scope = stageScopeFor(u)
  return scope === 'all' || scope.includes(stage)
}

// 报工 viewers: every 商务, PLUS a hand-picked allowlist of production users the
// boss has explicitly granted the per-person scoreboard. Kept as an id set (not
// a role/stage) precisely because the grant is per-person — e.g. 于海伟 sees 报工
// while the rest of 工程 does not. Add ids here to grant more.
const REPORT_VIEWER_USER_IDS = new Set<string>([
  'u-mose92lt-a0cutz', // 于海伟 (production / 工程)
])

// Can this user see the 报工 scoreboard + its export? Drives both the page/API
// guards and whether the 报工 nav tab is rendered for them.
export function canSeeReport(u: AuthUser): boolean {
  return u.role === 'commerce' || REPORT_VIEWER_USER_IDS.has(u.id)
}

// 财务·订单 viewers: every 商务, plus a per-person allowlist. Same shape as
// REPORT_VIEWER_USER_IDS and for the same reason — the grant is by name, not
// by stage (于海伟 sees the order money book; the rest of 工程 does not). A
// production grantee sees the 订单 tab on /finance — 记账/看钱 stay
// commerce-wide and 支出/工资/月度 go by canSeeExpenses (which a production
// account can hold by name); the page enforces both separately.
const ORDER_LEDGER_VIEWER_USER_IDS = new Set<string>([
  'u-mose92lt-a0cutz', // 于海伟 (production / 工程) — his 商务号 qualifies via role
])

export function canSeeOrderLedger(u: AuthUser): boolean {
  // canSeeExpenses implies this one: /finance's door is the 订单 grant, and
  // somebody trusted with every person's pay must not be stopped at it.
  return (
    u.role === 'commerce' ||
    ORDER_LEDGER_VIEWER_USER_IDS.has(u.id) ||
    canSeeExpenses(u)
  )
}

// Page guard for /finance now that it is no longer commerce-only: 商务 in
// full, allowlisted production users for the 订单 tab. Everyone else bounces
// to their landing page.
export async function requireOrderLedgerViewer(): Promise<AuthUser> {
  const u = await requireUser()
  if (canSeeOrderLedger(u)) return u
  redirect(landingPathFor(u))
}

// 报工 viewer gate. 商务 always; specific granted production users (see
// REPORT_VIEWER_USER_IDS) too. Everyone else bounces to their landing page on a
// direct URL hit.
export async function requireReportViewer(): Promise<AuthUser> {
  const u = await requireUser()
  if (canSeeReport(u)) return u
  redirect(landingPathFor(u))
}

export function landingPathFor(user: AuthUser): string {
  if (user.role === 'commerce') return '/'
  // 工程 head sees the same holistic master view as commerce by default —
  // no auto-applied station filter. They can still drill into ?stage=X
  // explicitly via the master grid headers.
  if (user.defaultStage === '工程') return '/'
  // A 采购 account's station IS the procurement ledger, not a board filter.
  if (user.defaultStage === '采购') return '/procurement'
  return user.defaultStage
    ? `/?stage=${encodeURIComponent(user.defaultStage)}`
    : '/'
}
