import { NextRequest } from 'next/server'
import { currentUser } from '@/lib/auth'
import { applyOpsToDb, loadSheetState, sheetVersion } from '@/app/x/_server'
import type { Op } from '@/app/x/_model'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// /x live-mode wire. GET is the poll: pass ?v=<version you have> and you get
// {unchanged:true} back when nothing moved — the cheap path clients hit every
// few seconds. POST applies an op batch and returns the new version.
//
// Any logged-in user may read AND write: workers tapping stage cells IS the
// product (报工), so this is deliberately not commerce-gated.

const OP_TYPES = new Set([
  'renameSheet',
  'setStages',
  'addColumns',
  'renameColumn',
  'delColumn',
  'addGroup',
  'editGroup',
  'delGroup',
  'addRows',
  'editCell',
  'setStage',
  'setFlag',
  'delRow',
])

export async function GET(request: NextRequest) {
  const user = await currentUser()
  if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const have = request.nextUrl.searchParams.get('v')
  if (have) {
    const v = await sheetVersion()
    if (String(v) === have) return Response.json({ ok: true, unchanged: true, version: v })
  }
  const state = await loadSheetState()
  return Response.json({ ok: true, state })
}

export async function POST(request: NextRequest) {
  const user = await currentUser()
  if (!user) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  let body: { ops?: unknown }
  try {
    body = await request.json()
  } catch {
    return Response.json({ ok: false, error: 'bad json' }, { status: 400 })
  }
  const raw = Array.isArray(body.ops) ? body.ops : null
  if (!raw || raw.length === 0 || raw.length > 200) {
    return Response.json({ ok: false, error: 'bad ops' }, { status: 400 })
  }
  const ops: Op[] = []
  for (const o of raw) {
    if (!o || typeof o !== 'object' || !OP_TYPES.has((o as { type?: string }).type ?? '')) {
      return Response.json({ ok: false, error: 'bad op' }, { status: 400 })
    }
    ops.push(o as Op)
  }
  try {
    const version = await applyOpsToDb(ops)
    return Response.json({ ok: true, version })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'apply failed'
    return Response.json({ ok: false, error: msg }, { status: 500 })
  }
}
