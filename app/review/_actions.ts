'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { setStageDoneQty } from '@/lib/db'
import { supabase } from '@/lib/supabase'
import { logReportEvent, resolvePendingReport } from '@/lib/packets'
import { TRACKING_STAGES, type Stage } from '@/lib/data'

// 待归档 actions — the PMC attaches a worker's unmatched photo-report to the
// right part (one narrow write through setStageDoneQty, same as every other
// 报工) or dismisses it. Auth: any logged-in user; the state machine and
// clamping stay inside setStageDoneQty exactly like the scan path.

function str(fd: FormData, key: string): string {
  const v = fd.get(key)
  return typeof v === 'string' ? v.trim() : ''
}

export async function applyPendingReport(formData: FormData): Promise<void> {
  const user = await requireUser()
  const prId = str(formData, 'pr')
  const partId = str(formData, 'part')
  const stageRaw = str(formData, 'stage')
  const stage = (TRACKING_STAGES as string[]).includes(stageRaw)
    ? (stageRaw as Stage)
    : undefined
  if (!prId || !partId || !stage) redirect('/review')

  const { data: partRows, error } = await supabase
    .from('parts')
    .select('id, job_id, qty')
    .eq('id', partId)
    .limit(1)
  if (error) throw error
  const part = partRows?.[0]
  if (!part) redirect('/review')

  const { data: stageRows, error: serr } = await supabase
    .from('part_stages')
    .select('stage, status, done_qty')
    .eq('part_id', partId)
    .eq('stage', stage)
    .limit(1)
  if (serr) throw serr
  const st = stageRows?.[0]
  if (!st || st.status === 'done') redirect(`/review?err=stage`)

  // Claim the pending row FIRST (status guard makes this idempotent — a
  // double-submit can't double-count the pieces).
  const pr = await resolvePendingReport({
    id: prId,
    status: 'attached',
    partId,
    appliedStage: stage,
    resolvedBy: user.name,
  })
  if (!pr) redirect('/review')

  const jobId = String(part.job_id)
  const componentId = partId.startsWith(`${jobId}:`)
    ? partId.slice(jobId.length + 1)
    : partId
  const qty = Math.max(1, pr.qty ?? 1)
  const prevDone = Math.max(0, Number(st.done_qty ?? 0))
  const cumulative = Math.min(Number(part.qty ?? qty), prevDone + qty)
  const actor = pr.actor || user.name

  await setStageDoneQty(jobId, componentId, stage, cumulative, actor)
  const applied = Math.max(0, cumulative - prevDone)
  if (applied > 0) {
    // report_events.part_id is FK'd to the FULL parts.id — setStageDoneQty
    // tolerates the short component shape, the event insert does not.
    await logReportEvent({
      partId,
      jobId,
      stage,
      actor,
      qty: applied,
      cumulative,
      source: 'photo',
    })
  }

  revalidatePath('/')
  revalidatePath(`/jobs/${jobId}`)
  revalidatePath('/review')
  redirect('/review?done=1')
}

export async function dismissPendingReport(formData: FormData): Promise<void> {
  const user = await requireUser()
  const prId = str(formData, 'pr')
  if (prId) {
    await resolvePendingReport({ id: prId, status: 'dismissed', resolvedBy: user.name })
  }
  revalidatePath('/review')
  redirect('/review')
}
