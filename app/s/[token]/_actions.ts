'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { getPartScanView, reportPartScan } from '@/lib/db'
import { logReportEvent } from '@/lib/packets'
import { WORKER_COOKIE, decodeWorker } from './_worker'

// Scan-page server actions. No session: identity IS the traveller token,
// re-verified inside reportPartScan on every call, and the CURRENT stage is
// re-derived server-side there — the phone never names a stage, so a forged
// form can't tick an arbitrary OP.
//
// Plain FormData actions because the page renders native <form> POSTs —
// they must work in decade-old WeChat webviews, JS or no JS.

function str(fd: FormData, key: string): string {
  const v = fd.get(key)
  return typeof v === 'string' ? v.trim() : ''
}

export async function scanSetWorker(formData: FormData): Promise<void> {
  const token = str(formData, 'token')
  const name = str(formData, 'name').slice(0, 20)
  if (name) {
    const jar = await cookies()
    jar.set(WORKER_COOKIE, encodeURIComponent(name), {
      path: '/s',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
    })
  }
  redirect(`/s/${token}`)
}

// 报工 — mode 'all' finishes the remaining quantity at the current OP (the
// default one-tap path); mode 'some' reports the typed count. Both funnel
// into reportPartScan, which clamps and owns the state machine.
export async function scanReport(formData: FormData): Promise<void> {
  const token = str(formData, 'token')
  const mode = str(formData, 'mode')
  const jar = await cookies()
  const actor = decodeWorker(jar.get(WORKER_COOKIE)?.value)
  if (!actor) redirect(`/s/${token}`)

  const view = await getPartScanView(token)
  if (!view || !view.currentStage) redirect(`/s/${token}`)
  const current = view!.stages.find((s) => s.stage === view!.currentStage)
  const remaining = Math.max(0, view!.qty - (current?.doneQty ?? 0))

  let doneNow = remaining
  if (mode === 'some') {
    const n = Number.parseInt(str(formData, 'qty'), 10)
    if (!Number.isFinite(n) || n <= 0) redirect(`/s/${token}`)
    doneNow = Math.min(n, remaining)
  }
  if (doneNow <= 0) redirect(`/s/${token}`)

  const prevDone = current?.doneQty ?? 0
  const result = await reportPartScan(token, doneNow, actor)
  // The master board and job detail read these rows — refresh them so the
  // PMC's screen reflects the scan without a manual reload.
  revalidatePath('/')
  revalidatePath(`/jobs/${view!.jobId}`)
  if (!result.ok) redirect(`/s/${token}`)
  // Append-only history — part_stages only keeps the latest state, but the
  // job page's worker timeline and the daily tallies need every report.
  const applied = Math.max(0, (result.totalDone ?? prevDone + doneNow) - prevDone)
  if (applied > 0 && result.stage) {
    await logReportEvent({
      partId: view!.componentId,
      jobId: view!.jobId,
      stage: result.stage,
      actor,
      qty: applied,
      cumulative: result.totalDone ?? prevDone + applied,
      source: str(formData, 'src') === 'photo' ? 'photo' : 'scan',
    })
  }
  redirect(`/s/${token}?reported=${applied}`)
}
