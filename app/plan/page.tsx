import { redirect } from 'next/navigation'
import { TopBar } from '@/app/_ui'
import {
  canEditPlan,
  canSeeOrderLedger,
  canSeeReport,
  landingPathFor,
  requireUser,
} from '@/lib/auth'
import { getActiveUsers, getJob, getMasterRows, getStageCellsByJob } from '@/lib/db'
import { getHrRoster } from '@/lib/hr'
import { getPlanRows, isPlanStage, PLAN_STAGES, type PlanRow, type PlanStage } from '@/lib/plan'
import { OPT_IN_STAGES, type Stage } from '@/lib/data'
import type { MasterRow } from '@/lib/master'
import { today } from '@/lib/today'
import { PlanBoard, type PlanAuto } from './_plan'

export const dynamic = 'force-dynamic'

// 计划 — 原来的「重点」, 拆到工段上: 编程 / 操机 / 车铣 / 手工 / 打磨各一张表,
// 每一格手填。完成情况对着报工自动算 (下面 PlanPage 里), 手填的完成时间优先。
//
// 谁来排: 商务、工程, 加上编程的程江华 (lib/auth canEditPlan)。

// 计划的表 → 报工里的工序。车铣以前没有单独一道, 走的是操机 —— 老单子上没
// 有车铣那一格的, 还是看操机 (FALLBACK_OF)。
const STAGE_OF: Record<PlanStage, Stage> = {
  编程: '编程',
  操机: '操机',
  车铣: '车铣',
  手工: '手工',
  打磨: '打磨',
}

const FALLBACK_OF: Partial<Record<PlanStage, Stage>> = { 车铣: '操机' }

// 工程在工单上给哪一道排了计划交期, 计划里那一张表就自动带出这一行。
const ENG_STAGE: Partial<Record<PlanStage, Stage>> = {
  编程: '编程',
  操机: '操机',
  车铣: '车铣',
  手工: '手工',
  打磨: '打磨',
}

const norm = (s: string) => s.trim().toLowerCase()
const seqNorm = (s: string) => (/^\d+$/.test(s.trim()) ? String(Number(s.trim())) : s.trim())

// 报工的时间 —— ISO 的换成工厂本地的 MM-DD HH:mm; 老数据只有 MM-DD 的照原样。
function fmtAt(v?: string): string | undefined {
  if (!v) return undefined
  if (!/T/.test(v)) return v
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

function cellAuto(row: MasterRow, stage: Stage): PlanAuto | undefined {
  const c = row.cells[stage]
  if (!c || c.total === 0) return undefined
  // 同一个零件开过两回外协会被数两遍 —— 按零件数封顶 (lib/master rowRollupStage)。
  const done = Math.min(c.total, c.inHouseDone + c.outsourcedClosed + c.outsourcedOpen)
  const state = done >= c.total ? 'done' : done > 0 || c.inProgress > 0 ? 'partial' : 'none'
  return {
    state,
    done,
    total: c.total,
    at: state === 'done' ? fmtAt(c.latestFinishedAt ?? c.latestCompletedAt) : undefined,
    by: state === 'done' ? c.latestBy : undefined,
  }
}

export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requireUser()
  if (!canEditPlan(user)) redirect(landingPathFor(user))
  const sp = await searchParams
  const stage: PlanStage = isPlanStage(sp?.s) ? sp.s : '编程'
  const todayStr = today()

  const engSt = ENG_STAGE[stage]
  const [all, boardRows, users, extraNames, ownCells] = await Promise.all([
    getPlanRows(),
    getMasterRows(),
    getActiveUsers(),
    getHrRoster(),
    // 车铣这种点了才有的一道, 看板汇总里还没有它那一格 —— 从零件的工序里数。
    engSt && OPT_IN_STAGES.includes(engSt) ? getStageCellsByJob(engSt) : undefined,
  ])
  const masterRows = ownCells
    ? boardRows.map((m) => {
        const c = ownCells.get(m.id)
        return c && !m.cells[engSt!] ? { ...m, cells: { ...m.cells, [engSt!]: c } } : m
      })
    : boardRows
  const stored = all.filter((r) => r.stage === stage)
  const rows: PlanRow[] = stored.filter((r) => !r.dismissed)

  const byJobNo = new Map<string, MasterRow>()
  for (const m of masterRows) if (m.jobNo) byJobNo.set(norm(m.jobNo), m)
  // 已出货 (退货返工中的不算) —— 计划里这张单没做完的行自动取消。
  const shippedOut = (m: MasterRow | undefined) => !!m?.isShipped && !m.activeReturn

  // 工程排的 —— 在产的单, 这一道排了计划交期的, 每张单一行。已经存过 (有人改
  // 过一格) 的用存下来的那一行, 日期没被手改过就跟着工程排的日子走。
  const engPlan: Record<string, string> = {}
  // 工程排进来的行按看板上的先后排, 不看哪天存的 —— 不然填一格原因、第一次
  // 存下来, 它就跳到当天最后去了 (于海伟 2026-10-19)。
  const engOrder = new Map<string, number>()
  if (engSt) {
    const byKey = new Map(stored.filter((r) => r.engKey).map((r) => [r.engKey!, r]))
    for (const m of masterRows) {
      if (m.status === 'draft' || m.status === 'failed' || m.status === 'parsing') continue
      if (!m.cells[engSt]) continue
      // 出货走完了的单不再进计划 (于海伟 2026-10-23); 退货返工中的照样排。
      if (shippedOut(m)) continue
      let v = m.stagePlan?.[engSt]
      let d = v?.slice(0, 10)
      if (!v || !d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        // 车铣是工程点了才有的一道 —— 点上了就进车铣计划, 不用再排日子; 还没排
        // 日子、也还没做完的, 先挂在今天, 排了日子就跟着走 (于海伟 2026-10-16)。
        if (!OPT_IN_STAGES.includes(engSt) || cellAuto(m, engSt)?.state === 'done') continue
        v = undefined
        d = todayStr
      }
      const key = `${m.id}:${engSt}`
      engOrder.set(key, engOrder.size)
      // 工程排了钟点的, 那个钟点就是计划完成。
      const engDue = v && v.length > 10 ? v.slice(11, 16) : undefined
      const ex = byKey.get(key)
      if (ex) {
        if (ex.dismissed) continue
        if (ex.engDate) ex.date = d
        if (!ex.due && engDue) ex.due = engDue
        if (v) engPlan[ex.id] = v
        continue
      }
      const id = `eng:${key}`
      rows.push({ id, stage, date: d, jobNo: m.jobNo, workers: [], due: engDue, by: '工程', createdAt: '', engKey: key, engDate: true, virtual: true })
      if (v) engPlan[id] = v
    }
    const rank = (r: PlanRow) => (r.engKey ? engOrder.get(r.engKey) : undefined) ?? Infinity
    rows.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1
      const ra = rank(a)
      const rb = rank(b)
      if (ra !== rb) return ra - rb
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
    })
  }

  // 报工 → 完成情况。编程填了序列号的看那一个零件, 其余看整张单在那一道上。
  const auto: Record<string, PlanAuto> = {}
  const partLevel = rows.filter((r) => stage === '编程' && r.seq && byJobNo.has(norm(r.jobNo)))
  const jobIds = [...new Set(partLevel.map((r) => byJobNo.get(norm(r.jobNo))!.id))].slice(0, 80)
  const jobs = new Map(
    (await Promise.all(jobIds.map((id) => getJob(id)))).flatMap((j) => (j ? [[j.id, j] as const] : [])),
  )
  for (const r of rows) {
    const m = byJobNo.get(norm(r.jobNo))
    if (!m) continue
    const st = m.cells[STAGE_OF[stage]] ? STAGE_OF[stage] : (FALLBACK_OF[stage] ?? STAGE_OF[stage])
    const job = r.seq ? jobs.get(m.id) : undefined
    if (job) {
      const idx = job.components.findIndex(
        (c, i) => seqNorm(c.seqLabel || String(i + 1).padStart(2, '0')) === seqNorm(r.seq!),
      )
      const s = idx >= 0 ? job.components[idx].stages[st] : undefined
      if (s) {
        const qty = job.components[idx].qty
        auto[r.id] =
          s.status === 'done'
            ? { state: 'done', done: qty, total: qty, at: fmtAt(s.finishedAt ?? s.completedAt), by: s.by }
            : {
                state: s.status === 'in_progress' ? 'partial' : 'none',
                done: s.doneQty ?? 0,
                total: qty,
              }
        continue
      }
    }
    const a = cellAuto(m, st)
    if (a) auto[r.id] = a
  }

  // 已出货的单: 没做完的行不再挂在计划里 (做完的留在「已完成」当记录)。只是
  // 不显示, 存下的那一行不删 —— 退货回来又能排。
  const live = rows.filter(
    (r) => !shippedOut(byJobNo.get(norm(r.jobNo))) || !!r.doneAt || auto[r.id]?.state === 'done',
  )

  // 工单号 → 工单, 表里那一格点得进去。
  const jobIdOf: Record<string, string> = {}
  for (const r of live) {
    const m = byJobNo.get(norm(r.jobNo))
    if (m) jobIdOf[norm(r.jobNo)] = m.id
  }

  const names = [...new Set([...users.map((u) => u.name), ...extraNames])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'zh'))
  const jobNos = masterRows
    .filter((m) => !m.isShipped && m.status !== 'draft' && m.status !== 'failed')
    .map((m) => m.jobNo)
    .filter(Boolean)

  return (
    <div className="min-h-dvh bg-[var(--color-bg)]">
      <TopBar
        title="计划"
        subtitle="各工段每天的活 · 谁做 · 做完没有"
        currentTab="计划"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        canSeeReport={canSeeReport(user)}
        canSeeFinance={canSeeOrderLedger(user)}
      />
      <main className="mx-auto w-full max-w-[1240px] px-4 md:px-10 py-8">
        <PlanBoard
          key={stage}
          stage={stage}
          stages={[...PLAN_STAGES]}
          rows={live}
          auto={auto}
          engPlan={engPlan}
          jobIds={jobIdOf}
          names={names}
          jobNos={jobNos}
          todayStr={todayStr}
        />
      </main>
    </div>
  )
}
