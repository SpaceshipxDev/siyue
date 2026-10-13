import { redirect } from 'next/navigation'
import { TopBar } from '@/app/_ui'
import {
  canEditPlan,
  canSeeOrderLedger,
  canSeeReport,
  landingPathFor,
  requireUser,
} from '@/lib/auth'
import { getActiveUsers, getJob, getMasterRows } from '@/lib/db'
import { getHrRoster } from '@/lib/hr'
import { getPlanRows, isPlanStage, PLAN_STAGES, type PlanStage } from '@/lib/plan'
import type { Stage } from '@/lib/data'
import type { MasterRow } from '@/lib/master'
import { today } from '@/lib/today'
import { PlanBoard, type PlanAuto } from './_plan'

export const dynamic = 'force-dynamic'

// 计划 — 原来的「重点」, 拆到工段上: 编程 / 操机 / 车铣 / 手工 / 打磨各一张表,
// 每一格手填。完成情况对着报工自动算 (下面 PlanPage 里), 手填的完成时间优先。
//
// 谁来排: 商务、工程, 加上编程的程江华 (lib/auth canEditPlan)。

// 计划的表 → 报工里的工序。车铣在路线上走的是操机那一道。
const STAGE_OF: Record<PlanStage, Stage> = {
  编程: '编程',
  操机: '操机',
  车铣: '操机',
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
  const done = c.inHouseDone + c.outsourcedClosed + c.outsourcedOpen
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

  const [all, masterRows, users, extraNames] = await Promise.all([
    getPlanRows(),
    getMasterRows(),
    getActiveUsers(),
    getHrRoster(),
  ])
  const rows = all.filter((r) => r.stage === stage)

  const byJobNo = new Map<string, MasterRow>()
  for (const m of masterRows) if (m.jobNo) byJobNo.set(norm(m.jobNo), m)

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
    const st = STAGE_OF[stage]
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
          rows={rows}
          auto={auto}
          names={names}
          jobNos={jobNos}
          todayStr={todayStr}
        />
      </main>
    </div>
  )
}
