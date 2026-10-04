// 计划达成率 —— 工程在工单上给每道工序排了一个"哪天做完"(排产 · 计划交期),
// 到了那一天, 这一道做完了没有。
//
// 一张单的一道工序算一次:
//   按时     —— 这道的零件全部做完, 最后一件做完的时间不晚于计划那天 (排了钟点
//               就按钟点, 没排钟点就是那天晚上 12 点前)
//   延期完成 —— 全部做完了, 但晚于计划
//   逾期未完 —— 计划那天已经过了, 还有没做完的
//   还没到期 —— 计划那天还没到、也还没做完: 不进达成率, 现在说它达没达成还早
//
//   达成率 = 按时 ÷ (按时 + 延期完成 + 逾期未完)
//
// 哪个月的账看计划日期落在哪个月。取数就是看板那一份 (每一格带着还剩几件没
// 做完、最后一件什么时候做完), 所以这里算出来的跟看板上红不红是同一个口径。
//
// 打磨 · 喷漆 · 丝印 共用一个节点 (SHARED_PLAN_STAGES), 三道各自对着同一个
// 日子算 —— 哪一道拖了后腿一眼看得出来。操机、手工各自一个节点。
//
// 纯函数, 服务端页面直接用。

import { PLANNABLE_STAGES, type Stage } from './data'
import type { MasterRow } from './master'

export type PlanOutcome = 'onTime' | 'late' | 'overdue' | 'notDue'

export type PlanMiss = {
  jobId: string
  jobNo: string
  product: string
  customer: string
  plan: string // 计划 (YYYY-MM-DD 或 YYYY-MM-DDTHH:mm)
  outcome: 'late' | 'overdue'
  days: number // 晚了几天
}

export type StagePlanRate = {
  stage: Stage
  onTime: number
  late: number
  overdue: number
  notDue: number
  /** 按时 ÷ (按时+延期+逾期); 一个到期的都没有是 null。 */
  rate: number | null
  misses: PlanMiss[]
}

const DAY = 86_400_000

// 计划那一刻 (上海时间): 排了钟点就是那个钟点, 没排就是当天最后一秒。
function deadlineMs(plan: string): number {
  const [d, t] = plan.split('T')
  return Date.parse(t ? `${d}T${t}:00+08:00` : `${d}T23:59:59+08:00`)
}

// 看板上最后完成时间多半是完整的时间戳; 很老的记录只剩 "MM-DD", 按计划那一年
// 的那天晚上算。
function finishedMs(latest: string | undefined, planYear: string): number | null {
  if (!latest) return null
  if (latest.includes('T')) {
    const t = Date.parse(latest)
    return Number.isFinite(t) ? t : null
  }
  if (/^\d{2}-\d{2}$/.test(latest)) return Date.parse(`${planYear}-${latest}T23:59:59+08:00`)
  const t = Date.parse(latest)
  return Number.isFinite(t) ? t : null
}

function daysLate(fromMs: number, toMs: number): number {
  return Math.max(1, Math.ceil((toMs - fromMs) / DAY))
}

export function computePlanRates(
  rows: MasterRow[],
  month: string, // YYYY-MM —— 计划日期落在这个月的
  nowMs: number = Date.now(),
): StagePlanRate[] {
  const out: StagePlanRate[] = PLANNABLE_STAGES.map((stage) => ({
    stage,
    onTime: 0,
    late: 0,
    overdue: 0,
    notDue: 0,
    rate: null,
    misses: [],
  }))
  const byStage = new Map(out.map((r) => [r.stage, r]))

  for (const row of rows) {
    for (const stage of PLANNABLE_STAGES) {
      const plan = row.stagePlan?.[stage]
      if (!plan || plan.slice(0, 7) !== month) continue
      const cell = row.cells[stage]
      if (!cell || cell.total <= 0) continue // 这道不在这张单的路线上
      const acc = byStage.get(stage)!
      const due = deadlineMs(plan)
      const done = cell.pending === 0 && cell.inProgress === 0 && cell.outsourcedOpen === 0
      const miss = (outcome: 'late' | 'overdue', days: number) =>
        acc.misses.push({
          jobId: row.id,
          jobNo: row.jobNo,
          product: row.product,
          customer: row.customer,
          plan,
          outcome,
          days,
        })
      if (done) {
        const fin = finishedMs(cell.latestFinishedAt, plan.slice(0, 4))
        if (fin === null || fin <= due) acc.onTime += 1
        else {
          acc.late += 1
          miss('late', daysLate(due, fin))
        }
      } else if (nowMs > due) {
        acc.overdue += 1
        miss('overdue', daysLate(due, nowMs))
      } else {
        acc.notDue += 1
      }
    }
  }

  for (const r of out) {
    const counted = r.onTime + r.late + r.overdue
    r.rate = counted > 0 ? r.onTime / counted : null
    // 还没做完的在前 (要追的), 拖得越久越靠前。
    r.misses.sort(
      (a, b) =>
        (a.outcome === 'overdue' ? 0 : 1) - (b.outcome === 'overdue' ? 0 : 1) ||
        b.days - a.days,
    )
  }
  return out
}
