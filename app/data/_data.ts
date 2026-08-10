// 越侬使用数据 — the weekly series behind /data.
//
// These are BAKED-IN numbers, not a live query, and that is deliberate. The
// page is a dated account of a period, not a dashboard: it should read the
// same next month as it does today, load instantly, never show a spinner or a
// stack trace, and never put a 15-week aggregate scan on the production DB
// just because someone opened a link. AS_OF is the contract — when it goes
// stale, re-run the queries and update this file rather than making it live.
//
// Provenance (read straight from prod on 2026-08-10):
//   finishes / starts / tappers  ← part_stages.finished_at / started_at / by_actor
//   jobs / parts                 ← jobs.created_at + parts joined via job_id
//   ship                         ← shipments.created_at
//   out                          ← outsource_blocks.sent_date
//   proc                         ← procurements.created_at
//   wau                          ← count(distinct access_log.user_name)
// Weeks are Monday-start, Asia/Shanghai.

export const AS_OF = '2026-08-10'
export const GO_LIVE = '2026-05-06'
export const DAYS_LIVE = 96

export type Week = {
  /** Monday of the week, MM-DD */
  w: string
  /** 新工单 */
  jobs: number
  /** 零件 */
  parts: number
  /** 报工开工 */
  st: number
  /** 报工完成 */
  fin: number
  /** 当周实际报工人数 (distinct by_actor) */
  tap: number
  /** 出货单 */
  ship: number
  /** 外协寄出 */
  out: number
  /** 采购下单 */
  proc: number
  /** 笔记写入 */
  notes: number
  /** 每日焦点写入 */
  foc: number
  /** 每周活跃账号 — 埋点 2026-07-08 才上线, 之前为 null (不是 0) */
  wau: number | null
  /** 历史补录周: 上线初期把在制品一次性录入系统, 不是当周产出 */
  backfill?: boolean
  /** 仅有部分天数的当前周 */
  partial?: boolean
}

export const WEEKS: Week[] = [
  { w: '05-04', jobs: 62, parts: 679, st: 317, fin: 496, tap: 7, ship: 0, out: 18, proc: 0, notes: 0, foc: 0, wau: null },
  { w: '05-11', jobs: 243, parts: 1441, st: 529, fin: 2234, tap: 8, ship: 18, out: 38, proc: 0, notes: 0, foc: 0, wau: null },
  { w: '05-18', jobs: 88, parts: 493, st: 3857, fin: 9895, tap: 22, ship: 70, out: 21, proc: 0, notes: 0, foc: 0, wau: null, backfill: true },
  { w: '05-25', jobs: 115, parts: 558, st: 2198, fin: 4799, tap: 17, ship: 43, out: 22, proc: 0, notes: 0, foc: 0, wau: null },
  { w: '06-01', jobs: 65, parts: 234, st: 1222, fin: 2213, tap: 19, ship: 26, out: 18, proc: 0, notes: 0, foc: 4, wau: null },
  { w: '06-08', jobs: 94, parts: 334, st: 1980, fin: 4256, tap: 24, ship: 59, out: 45, proc: 0, notes: 0, foc: 18, wau: null },
  { w: '06-15', jobs: 76, parts: 314, st: 2078, fin: 3376, tap: 24, ship: 64, out: 31, proc: 0, notes: 0, foc: 35, wau: null },
  { w: '06-22', jobs: 98, parts: 561, st: 2281, fin: 4630, tap: 25, ship: 84, out: 47, proc: 0, notes: 6, foc: 60, wau: null },
  { w: '06-29', jobs: 106, parts: 739, st: 2336, fin: 4361, tap: 26, ship: 78, out: 55, proc: 0, notes: 1, foc: 173, wau: null },
  { w: '07-06', jobs: 110, parts: 504, st: 2234, fin: 4018, tap: 27, ship: 80, out: 40, proc: 18, notes: 3, foc: 49, wau: 30 },
  { w: '07-13', jobs: 112, parts: 646, st: 2455, fin: 4713, tap: 27, ship: 107, out: 57, proc: 76, notes: 17, foc: 15, wau: 34 },
  { w: '07-20', jobs: 112, parts: 650, st: 2898, fin: 5639, tap: 29, ship: 100, out: 36, proc: 67, notes: 9, foc: 10, wau: 31 },
  { w: '07-27', jobs: 143, parts: 636, st: 2626, fin: 5143, tap: 28, ship: 181, out: 53, proc: 100, notes: 11, foc: 23, wau: 32 },
  { w: '08-03', jobs: 115, parts: 691, st: 2989, fin: 5297, tap: 26, ship: 134, out: 67, proc: 126, notes: 0, foc: 7, wau: 40 },
  { w: '08-10', jobs: 25, parts: 116, st: 284, fin: 899, tap: 21, ship: 19, out: 20, proc: 11, notes: 0, foc: 2, wau: 28, partial: true },
]

/** 累计 — 全库计数, 不是上表求和 (上表按周分桶, 少量早期行没有时间戳) */
export const TOTALS = {
  baogong: 74287,
  jobs: 1564,
  parts: 8595,
  shipments: 1063,
  procurements: 398,
  outsource: 589,
  accounts: 39,
  peakWau: 40,
}

/** 上线后陆续加的模块 — 时间与内容 */
export const TIMELINE: { when: string; what: string; note: string }[] = [
  { when: '5 月', what: '系统上线', note: '工单 · 零件 · 工序报工 · 外协寄出' },
  { when: '6 月', what: '质检报告 · 图纸变更 · 交接单', note: '质量与工程的日常单据进系统' },
  { when: '7 月上旬', what: '报工看板 · 财务分期账 · 外协厂商门户', note: '供应商在手机上回期,不再靠电话追' },
  { when: '7 月下旬', what: '商务负责人字段 · 零件级状态筛选', note: '越侬商务字段填充率约 57%' },
  { when: '8 月', what: '采购全流程 · 员工改名', note: '待下单 → 下单 → 到货 → 检验,关联工号' },
]
