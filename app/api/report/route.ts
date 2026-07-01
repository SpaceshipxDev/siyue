import { currentUser, canSeeReport, canSeeMoney } from '@/lib/auth'
import { STAGES, type Stage } from '@/lib/data'
import { shanghaiRangeWindow } from '@/lib/today'
import {
  getWorkerOutput,
  getStationStuck,
  getWorkerTimeline,
  getStationDetailByOrder,
} from '@/lib/pulse'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 报工 data API — powers the /report client view so switching station / period
// and expanding a person never triggers a full-page navigation.
//
//   GET /api/report?from=&to=[&stage=]            → { people, stuck }       (summary)
//   GET /api/report?from=&to=&w=<name>[&stage=]   → { jobs }                (one worker's drill)
//   GET /api/report?from=&to=&mode=export[&stage=]→ { orders, truncated }   (工单→components 报表)
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
      const { orders, truncated } = await getStationDetailByOrder(stage, window)
      if (!showMoney) {
        for (const o of orders) {
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
