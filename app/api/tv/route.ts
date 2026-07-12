import { currentUser } from '@/lib/auth'
import { stageLabel, type Stage } from '@/lib/data'
import { componentBoardRows, partFacts, todaySummary } from '@/lib/packets'
import { supabase } from '@/lib/supabase'
import { shanghaiWindow, today } from '@/lib/today'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// /tv 大屏 data feed — one GET returns everything the boss's wall TV paints:
//
//   today    今日报工 totals + per-worker leaderboard (todaySummary — the same
//            Asia/Shanghai day boundary the board's 今日报工 strip uses)
//   parts    在产 / 逾期 part counts (componentBoardRows — the board's own read,
//            so the TV and the board can never disagree)
//   shipped  今日出货 — parts whose 出货 stage finished inside today's window
//   feed     the latest 报工 events, joined to part names for the ticker
//
// Auth: any logged-in session (the TV logs in once with the boss PIN). Numbers
// only — no ¥ anywhere in the payload, so no money gate is needed.

const FEED_LIMIT = 12

export async function GET(): Promise<Response> {
  const user = await currentUser()
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  try {
    const todayStr = today()
    const window = shanghaiWindow(todayStr, 'day')

    const [summary, rows, shipRes, feedRes] = await Promise.all([
      todaySummary(),
      componentBoardRows(),
      // 今日出货 — 出货 stage rows finished inside today's Shanghai window.
      supabase
        .from('part_stages')
        .select('part_id')
        .eq('stage', '出货')
        .eq('status', 'done')
        .gte('finished_at', window.from)
        .lt('finished_at', window.to),
      supabase
        .from('report_events')
        .select('part_id, actor, stage, qty, created_at')
        .order('created_at', { ascending: false })
        .limit(FEED_LIMIT),
    ])
    if (shipRes.error) throw shipRes.error
    if (feedRes.error) throw feedRes.error

    // 在产 = not fully shipped; 逾期 = past due AND not shipped. Both counted
    // over the live component board (open jobs only).
    const live = rows.filter((r) => !r.shipped)
    const inProduction = live.length
    const overdue = live.filter((r) => r.dueDate && r.dueDate < todayStr).length

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

    // Feed rows carry only part_id — join names via the existing partFacts read.
    const feedRows = feedRes.data ?? []
    const facts = await partFacts([...new Set(feedRows.map((r) => r.part_id as string))])
    const factById = new Map(facts.map((f) => [f.partId, f]))
    const feed = feedRows.map((r) => {
      const f = factById.get(r.part_id as string)
      return {
        at: r.created_at as string,
        actor: r.actor as string,
        part: f?.name || f?.partNo || '—',
        stage: stageLabel(r.stage as Stage),
        qty: Number(r.qty ?? 0),
      }
    })

    return Response.json(
      {
        ok: true,
        today: { pieces: summary.pieces, reports: summary.reports },
        inProduction,
        overdue,
        shippedToday: { parts: shippedIds.length, pieces: shippedPieces },
        workers: summary.workers.slice(0, 10),
        feed,
      },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
