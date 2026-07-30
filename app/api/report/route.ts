import { currentUser, canSeeReport, canSeeMoney } from '@/lib/auth'
import { STAGES, type Stage } from '@/lib/data'
import { shanghaiRangeWindow } from '@/lib/today'
import {
  getWorkerOutput,
  getStationStuck,
  getWorkerTimeline,
  getStationDetailByOrder,
  getReportActorNames,
} from '@/lib/pulse'
import { getAllUsers } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 报工 data API — powers the /report client view so switching station / period
// and expanding a person never triggers a full-page navigation.
//
//   GET /api/report?from=&to=[&stage=]            → { people, stuck }       (summary)
//   GET /api/report?from=&to=&w=<name>[&stage=]   → { jobs }                (one worker's drill)
//   GET /api/report?from=&to=&mode=export[&stage=][&w=] → { orders, truncated } (报表)
//   GET /api/report?mode=roster                   → { roster }               (找人 people list)
//
// Viewers: every 商务 + explicitly-granted production users (canSeeReport, e.g.
// 于海伟). ¥ (value_cny) is scrubbed for anyone without money visibility.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const STUCK_DAYS = 5

export async function GET(request: Request): Promise<Response> {
  const user = await currentUser()
  if (!user || !canSeeReport(user)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const showMoney = canSeeMoney(user)

  const sp = new URL(request.url).searchParams

  // 找人 roster — every selectable 经手人, range-independent (so picking someone
  // with no output *this* window still works). Accounts ∪ anyone who reported in
  // the last year, so deactivated and free-text actors stay searchable.
  if (sp.get('mode') === 'roster') {
    try {
      const [users, actors] = await Promise.all([getAllUsers(), getReportActorNames()])
      const lastByName = new Map(actors.map((a) => [a.name, a.lastActiveTs]))
      const seen = new Set<string>()
      const roster: {
        name: string
        subtitle: string
        active: boolean
        lastActiveTs?: string
      }[] = []
      const push = (name: string, subtitle: string, active: boolean) => {
        if (!name || seen.has(name)) return
        seen.add(name)
        roster.push({ name, subtitle, active, lastActiveTs: lastByName.get(name) })
      }
      // 工段 is deliberately NOT the subtitle: users.default_stage is a landing
      // preference, not what a person does (most floor accounts sit on 工程), so
      // printing it would lie. Only 商务 (a real, reliable role split) is marked;
      // the row's honest identity signal is 最后活动, rendered by the client.
      const label = (u: (typeof users)[number]) => (u.role === 'commerce' ? '商务' : '')
      const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'zh-CN')
      // 生产 first (the people 报工 is about), then 商务, then everyone inactive.
      const live = [...users.filter((u) => u.active)].sort(
        (a, b) => Number(a.role === 'commerce') - Number(b.role === 'commerce') || byName(a, b),
      )
      for (const u of live) push(u.name, label(u), true)
      const rest = [...users.filter((u) => !u.active)].sort(byName)
      for (const u of rest) push(u.name, label(u), false)
      // Pure free-text actors with no account at all.
      for (const a of [...actors].sort(byName)) push(a.name, '', false)
      return Response.json({ ok: true, roster }, { headers: { 'cache-control': 'no-store' } })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return Response.json({ ok: false, error: message }, { status: 500 })
    }
  }

  const from = sp.get('from')
  const to = sp.get('to')
  if (!from || !to || !ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    return Response.json({ ok: false, error: 'bad range' }, { status: 400 })
  }
  const lo = from <= to ? from : to
  const hi = from <= to ? to : from
  const window = shanghaiRangeWindow(lo, hi)

  const stageParam = sp.get('stage')
  const stage: Stage | undefined =
    stageParam && (STAGES as readonly string[]).includes(stageParam)
      ? (stageParam as Stage)
      : undefined

  const worker = sp.get('w')

  try {
    // 报表 export: 工单-first, components underneath.
    if (sp.get('mode') === 'export') {
      // `w` narrows the 报表 to one 经手人 — the 找人 filter's export.
      const { orders, truncated } = await getStationDetailByOrder(stage, window, worker ?? undefined)
      if (!showMoney) {
        for (const o of orders) {
          o.amountCny = 0
          o.valueCny = 0
          for (const c of o.components) c.valueCny = 0
        }
      }
      return Response.json(
        { ok: true, orders, truncated, showMoney },
        { headers: { 'cache-control': 'no-store' } },
      )
    }

    // Per-worker drill-down (expanded inline on the client), grouped by 工单.
    if (worker) {
      const events = await getWorkerTimeline({
        actorName: worker,
        ...window,
        kind: 'finished',
        stage,
        limit: 500,
      })
      const jobMap = new Map<
        string,
        {
          jobId: string
          jobNo: string
          customer: string
          finishes: number
          pieces: number
          valueCny: number
          components: {
            ts: string
            stage: Stage
            partName: string
            qty: number
            valueCny: number
            unpriced: boolean
            imageUrl?: string
          }[]
        }
      >()
      for (const e of events) {
        let j = jobMap.get(e.jobId)
        if (!j) {
          j = { jobId: e.jobId, jobNo: e.jobNo, customer: e.customer, finishes: 0, pieces: 0, valueCny: 0, components: [] }
          jobMap.set(e.jobId, j)
        }
        j.finishes += 1
        j.pieces += e.partQty
        j.valueCny += showMoney ? e.valueCny : 0
        j.components.push({
          ts: e.ts,
          stage: e.stage,
          partName: e.partName,
          qty: e.partQty,
          valueCny: showMoney ? e.valueCny : 0,
          unpriced: e.unpriced,
          imageUrl: e.imageUrl,
        })
      }
      const jobs = [...jobMap.values()].sort((a, b) => b.finishes - a.finishes)
      return Response.json({ ok: true, jobs }, { headers: { 'cache-control': 'no-store' } })
    }

    // Summary: the people list (hero) + stuck (bottom, station-scoped only).
    const [people, stuck] = await Promise.all([
      getWorkerOutput(window, stage),
      stage ? getStationStuck(stage, STUCK_DAYS) : Promise.resolve([]),
    ])
    if (!showMoney) for (const p of people) p.valueCny = 0
    return Response.json(
      { ok: true, people, stuck, stuckDays: STUCK_DAYS, showMoney },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
