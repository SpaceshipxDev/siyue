import { currentUser } from '@/lib/auth'
import { componentBoardRows, type ComponentBoardRow } from '@/lib/packets'
import { supabase } from '@/lib/supabase'
import { shanghaiWindow, today } from '@/lib/today'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// /tv 大屏 data feed — one GET returns everything the boss's wall TV paints:
//
//   jobs     今日到期 + 逾期最久的工单，按工单聚合未出货零件
//   shipped  今日出货 — parts whose 出货 stage finished inside today's window
//
// Auth: any logged-in session (the TV logs in once with the boss PIN). Numbers
// only — no ¥ anywhere in the payload, so no money gate is needed.

const JOB_LIST_LIMIT = 8

type TvJob = {
  jobId: string
  jobNo: string
  customer: string
  dueDate: string
  openParts: number
  openQty: number
  partNames: string[]
  stageSummary: string
  daysOverdue: number
}

function dateDistanceDays(earlier: string, later: string): number {
  const a = Date.parse(`${earlier}T00:00:00Z`)
  const b = Date.parse(`${later}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

function groupLiveJobs(rows: ComponentBoardRow[], todayStr: string): TvJob[] {
  const grouped = new Map<string, {
    jobId: string
    jobNo: string
    customer: string
    dueDate: string
    openParts: number
    openQty: number
    partNames: Set<string>
    stages: Map<string, number>
  }>()

  for (const row of rows) {
    if (row.shipped) continue
    let job = grouped.get(row.jobId)
    if (!job) {
      job = {
        jobId: row.jobId,
        jobNo: row.jobNo,
        customer: row.customer,
        dueDate: row.dueDate ?? '',
        openParts: 0,
        openQty: 0,
        partNames: new Set(),
        stages: new Map(),
      }
      grouped.set(row.jobId, job)
    }
    job.openParts += 1
    job.openQty += row.qty
    if (row.name) job.partNames.add(row.name)
    const stage = row.current?.label || '待出货'
    job.stages.set(stage, (job.stages.get(stage) ?? 0) + 1)
  }

  return [...grouped.values()].map((job) => ({
    jobId: job.jobId,
    jobNo: job.jobNo,
    customer: job.customer,
    dueDate: job.dueDate,
    openParts: job.openParts,
    openQty: job.openQty,
    partNames: [...job.partNames].slice(0, 3),
    stageSummary: [...job.stages]
      .map(([stage, count]) => `${stage} ${count}`)
      .join(' · '),
    daysOverdue: job.dueDate ? dateDistanceDays(job.dueDate, todayStr) : 0,
  }))
}

export async function GET(): Promise<Response> {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  try {
    const todayStr = today()
    const window = shanghaiWindow(todayStr, 'day')

    const [rows, shipRes] = await Promise.all([
      componentBoardRows(),
      // 今日出货 — 出货 stage rows finished inside today's Shanghai window.
      supabase
        .from('part_stages')
        .select('part_id')
        .eq('stage', '出货')
        .eq('status', 'done')
        .gte('finished_at', window.from)
        .lt('finished_at', window.to),
    ])
    if (shipRes.error) throw shipRes.error

    // The source is part-grained; the TV speaks in JOBS. A partially shipped
    // job stays live with only its still-open parts included in the totals.
    const liveJobs = groupLiveJobs(rows, todayStr)
    const dueTodayJobs = liveJobs
      .filter((job) => job.dueDate === todayStr)
      .sort((a, b) => a.jobNo.localeCompare(b.jobNo, 'zh-CN'))
    const overdueJobs = liveJobs
      .filter((job) => job.dueDate && job.dueDate < todayStr)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.jobNo.localeCompare(b.jobNo, 'zh-CN'))

    // 今日出货 pieces — sum the shipped parts' qty (one small id-scoped read).
    const shippedIds = [...new Set((shipRes.data ?? []).map((r) => r.part_id as string))]
    let shippedPieces = 0
    if (shippedIds.length > 0) {
      const { data, error } = await supabase
        .from('parts')
        .select('id, qty')
        .in('id', shippedIds)
      if (error) throw error
      shippedPieces = (data ?? []).reduce((s, r) => s + Number(r.qty ?? 0), 0)
    }

    return Response.json(
      {
        ok: true,
        inProduction: liveJobs.length,
        dueToday: {
          total: dueTodayJobs.length,
          jobs: dueTodayJobs.slice(0, JOB_LIST_LIMIT),
        },
        overdue: {
          total: overdueJobs.length,
          jobs: overdueJobs.slice(0, JOB_LIST_LIMIT),
        },
        shippedToday: { parts: shippedIds.length, pieces: shippedPieces },
      },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
