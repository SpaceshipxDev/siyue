'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import {
  getPartScanView,
  reportPartScan,
  setInspectionVerdict,
  setInspectionVerdictDetail,
} from '@/lib/db'
import { logReportEvent, upsertWorker } from '@/lib/packets'
import { TRACKING_STAGES, VERDICTS, type Stage, type Verdict } from '@/lib/data'
import { WORKER_COOKIE, decodeWorker, resolveActor } from './_worker'

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
// Every rejection redirects with ?err= so the page SAYS the report didn't
// land — a silent bounce back to the same form reads as success on the
// floor, and the pieces quietly never reach the board.
export async function scanReport(formData: FormData): Promise<void> {
  const token = str(formData, 'token')
  const mode = str(formData, 'mode')
  // Logged-in/cookie identity wins. On a fresh phone the quantity form also
  // carries the worker's name, so first-time users can report in one submit
  // instead of seeing a mysteriously empty selected OP.
  const knownActor = await resolveActor()
  const submittedActor = decodeWorker(str(formData, 'actor')).slice(0, 20)
  const actor = knownActor || submittedActor
  if (!actor) redirect(`/s/${token}?err=name`)
  if (!knownActor) {
    const jar = await cookies()
    jar.set(WORKER_COOKIE, encodeURIComponent(actor), {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
    })
    await upsertWorker(actor).catch(() => {})
  }

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
    if (!Number.isFinite(n) || n <= 0) redirect(`/s/${token}?err=qty`)
    doneNow = Math.min(n, remaining)
  }
  if (doneNow <= 0) redirect(`/s/${token}?err=qty`)

  const prevDone = current?.doneQty ?? 0
  const result = await reportPartScan(token, doneNow, actor, target)
  // The master board and job detail read these rows — refresh them so the
  // PMC's screen reflects the scan without a manual reload.
  revalidatePath('/')
  revalidatePath(`/jobs/${view!.jobId}`)
  if (!result.ok) redirect(`/s/${token}?err=fail`)
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

// 检验报工 — the inspector's phone gesture. Not a quantity report: the form
// posts a VERDICT (合格 = OK finishes the stage; 重做/返修/外修 hold the part
// at 检验 with a red tag) plus an optional 备注. Wired to the same
// setInspectionVerdict state machine the desktop inspection modal uses —
// last verdict wins, so a held part can be re-judged 合格 from the floor.
export async function scanInspect(formData: FormData): Promise<void> {
  const token = str(formData, 'token')
  const actor = await resolveActor()
  if (!actor) redirect(`/s/${token}?err=name`)

  const raw = str(formData, 'verdict')
  const verdict = (VERDICTS as string[]).includes(raw)
    ? (raw as Verdict)
    : undefined
  if (!verdict) redirect(`/s/${token}?err=fail`)
  const note = str(formData, 'note').slice(0, 200)

  const view = await getPartScanView(token)
  if (!view) redirect(`/s/${token}`)
  const insp = view!.stages.find((s) => s.stage === '检验')
  if (!insp || insp.status === 'done') redirect(`/s/${token}`)

  try {
    await setInspectionVerdict(view!.jobId, view!.componentId, verdict!, actor)
    // 备注 rides the column the verdict owns: free text on a hold is the
    // 不良原因 (why it bounced), on a 合格 release it's the passing 备注 —
    // exactly how the desktop modal splits the same field.
    if (note) {
      await setInspectionVerdictDetail(
        view!.jobId,
        view!.componentId,
        verdict === 'OK' ? { note } : { reason: note },
      )
    }
  } catch {
    redirect(`/s/${token}?err=fail`)
  }
  revalidatePath('/')
  revalidatePath(`/jobs/${view!.jobId}`)
  redirect(`/s/${token}?judged=${encodeURIComponent(verdict!)}`)
}
