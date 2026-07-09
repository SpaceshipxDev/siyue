import { headers } from 'next/headers'
import { after } from 'next/server'
import { supabase } from './supabase'

// Board-view telemetry (migration 0076). One row per REAL page render of the
// master board — bare `/` and every `/?stage=…` station view — so "does
// anyone actually open the per-station tabs" is answered by a group-by, not
// inferred from 报工 tick attribution like the last time (which got the tabs
// removed, and then rolled back on worker complaint).
//
// Never throws and never blocks the response: the insert runs in `after()`
// once the page has flushed, and any failure is swallowed — telemetry must
// not be able to take the board down.
// Referer → path+query, origin stripped. The `ref` column (migration 0080)
// records which view a row was born FROM — nullable because direct hits and
// privacy-stripped referers exist.
function refPath(referer: string | null): string | null {
  if (!referer) return null
  try {
    const u = new URL(referer)
    return (u.pathname + u.search).slice(0, 200)
  } catch {
    return null
  }
}

// One row per REAL open of a job detail page. `ref` answers "clicked from
// which view" — `/?stage=操机` = their station tab, `/` = the dashboard.
// Same prefetch filter as the board: hovering a job link on the master
// board fires a prefetch render that no human saw.
export async function logJobView(entry: {
  userName: string
  role: string
  defaultStage?: string
  jobId: string
}): Promise<void> {
  const h = await headers()
  if (h.get('next-router-prefetch') || h.get('sec-purpose')?.includes('prefetch')) {
    return
  }
  const ref = refPath(h.get('referer'))
  after(async () => {
    try {
      await supabase.from('access_log').insert({
        user_name: entry.userName,
        role: entry.role,
        default_stage: entry.defaultStage ?? null,
        path: `/jobs/${entry.jobId}`,
        stage: null,
        ref,
      })
    } catch {
      // Swallow — a lost log row is noise; a thrown one is an outage.
    }
  })
}

// One row per successful 报工 tap (start/finish/undo/批量 qty), recording
// WHERE the tap physically happened: `path`/`ref` = the page the fetch was
// issued from (board cell vs station queue vs inside the job page), `action`
// = the mutate kind, `stage` = the stage being ticked. Called from the
// mutate route only after a 200 — failed taps are not usage.
export function logStageAction(entry: {
  userName: string
  role: string
  defaultStage?: string
  kind: string
  stage?: string
  referer: string | null
}): void {
  const ref = refPath(entry.referer)
  after(async () => {
    try {
      await supabase.from('access_log').insert({
        user_name: entry.userName,
        role: entry.role,
        default_stage: entry.defaultStage ?? null,
        path: ref ?? '(unknown)',
        stage: entry.stage ?? null,
        action: entry.kind,
        ref,
      })
    } catch {
      // Swallow — telemetry must never break a mutation response.
    }
  })
}

export async function logBoardView(entry: {
  userName: string
  role: string
  defaultStage?: string
  path: string
  stage?: string
}): Promise<void> {
  // Router prefetches render this page without a human looking at it —
  // counting them would credit every tab hover as a visit. Real navigations
  // carry neither header.
  const h = await headers()
  if (h.get('next-router-prefetch') || h.get('sec-purpose')?.includes('prefetch')) {
    return
  }
  after(async () => {
    try {
      await supabase.from('access_log').insert({
        user_name: entry.userName,
        role: entry.role,
        default_stage: entry.defaultStage ?? null,
        path: entry.path,
        stage: entry.stage ?? null,
      })
    } catch {
      // Swallow — a lost log row is noise; a thrown one is an outage.
    }
  })
}
