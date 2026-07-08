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
