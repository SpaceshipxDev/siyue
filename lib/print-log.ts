import { after } from 'next/server'
import { supabase } from './supabase'

// PDF-generation telemetry (migration 0079). One row per REAL PDF render —
// the 外协单 raw route calls this after a successful renderToBuffer, so each
// press of 打印外协单 (and every reprint) is one row. This is the only record
// of print volume: nothing logged it before 0079.
//
// Never throws and never blocks the response: the insert runs in `after()`
// once the PDF has flushed, and any failure is swallowed — a lost log row is
// noise, a thrown one would be a failed print.
export async function logPrint(entry: {
  kind: 'outsource' | 'shipping' | 'inspection' | 'traveller'
  refId?: string
  docNo?: string
  jobNo?: string
  userName: string
  role: string
}): Promise<void> {
  after(async () => {
    try {
      await supabase.from('print_log').insert({
        kind: entry.kind,
        ref_id: entry.refId ?? null,
        doc_no: entry.docNo ?? null,
        job_no: entry.jobNo ?? null,
        user_name: entry.userName,
        role: entry.role,
      })
    } catch {
      // Swallow — telemetry must not be able to fail a print.
    }
  })
}
