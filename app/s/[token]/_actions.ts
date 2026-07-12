'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { getPartScanView, reportPartScan } from '@/lib/db'
import { logReportEvent, upsertWorker } from '@/lib/packets'
import { TRACKING_STAGES, type Stage } from '@/lib/data'
import { WORKER_COOKIE, decodeWorker } from './_worker'

// Scan-page server actions. No session: identity IS the traveller token,
// re-verified inside reportPartScan on every call. The form may name a stage
// (the chips on /s are links), but reportPartScan validates it against the
// part's own server-derived route — a forged form still can't tick an
// arbitrary OP, only choose among this part's open stages.
//
// Plain FormData actions because the page renders native <form> POSTs —
// they must work in decade-old WeChat webviews, JS or no JS.

function str(fd: FormData, key: string): string {
  const v = fd.get(key)
  return typeof v === 'string' ? v.trim() : ''
}

function stageOf(raw: string): Stage | undefined {
  return (TRACKING_STAGES as string[]).includes(raw) ? (raw as Stage) : undefined
}

export async function scanSetWorker(formData: FormData): Promise<void> {
  const token = str(formData, 'token')
  const name = str(formData, 'name').slice(0, 20)
  const stage = str(formData, 'stage')
  if (name) {
    const jar = await cookies()
    // Path '/' (not '/s'): the /p camera port and the no-match valve carry
    // the same identity, so one name-pick covers the whole floor loop.
    jar.set(WORKER_COOKIE, encodeURIComponent(name), {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
    })
    // Lazy roster: first report from a new hire adds them to the grid.
    await upsertWorker(name).catch(() => {})
  }
  redirect(`/s/${token}${stage ? `?stage=${encodeURIComponent(stage)}` : ''}`)
}

// 报工 — the count arrives prefilled with everything still open at the
// selected stage; reportPartScan clamps and owns the state machine.
export async function scanReport(formData: FormData): Promise<void> {
  const token = str(formData, 'token')
  const mode = str(formData, 'mode')
  const jar = await cookies()
  const actor = decodeWorker(jar.get(WORKER_COOKIE)?.value)
  if (!actor) redirect(`/s/${token}`)

  const stage = stageOf(str(formData, 'stage'))
  const view = await getPartScanView(token)
  if (!view) redirect(`/s/${token}`)
  const target =
    stage && view!.stages.some((s) => s.stage === stage && s.status !== 'done')
      ? stage
      : view!.currentStage
  if (!target) redirect(`/s/${token}`)
  const current = view!.stages.find((s) => s.stage === target)
  const remaining = Math.max(0, view!.qty - (current?.doneQty ?? 0))

  let doneNow = remaining
  if (mode === 'some') {
    const n = Number.parseInt(str(formData, 'qty'), 10)
    if (!Number.isFinite(n) || n <= 0) redirect(`/s/${token}`)
    doneNow = Math.min(n, remaining)
  }
  if (doneNow <= 0) redirect(`/s/${token}`)

  const prevDone = current?.doneQty ?? 0
  const result = await reportPartScan(token, doneNow, actor, target)
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
