import 'server-only'
import { supabase } from '@/lib/supabase'
import {
  DEFAULT_STAGES,
  defaultColumns,
  type Col,
  type Group,
  type Op,
  type Row,
  type SheetState,
} from './_model'

// Server twin of the /x client reducer: resolves the singleton sheet and
// applies op batches to Postgres. The factory has exactly one sheet (this is
// a single-tenant deployment); ensureSheet lazily creates it on first hit.

type SheetRow = {
  id: string
  name: string
  stages: string[]
  columns: Col[]
  version: number
}

export async function ensureSheet(): Promise<SheetRow> {
  const { data, error } = await supabase
    .from('x_sheets')
    .select('id,name,stages,columns,version')
    .order('created_at', { ascending: true })
    .limit(1)
  if (error) throw new Error(`x_sheets read failed: ${error.message}`)
  if (data && data.length) return data[0] as SheetRow
  const { data: created, error: insErr } = await supabase
    .from('x_sheets')
    .insert({ name: '生产表', stages: DEFAULT_STAGES, columns: defaultColumns() })
    .select('id,name,stages,columns,version')
    .single()
  if (insErr || !created) throw new Error(`x_sheets create failed: ${insErr?.message}`)
  return created as SheetRow
}

export async function loadSheetState(): Promise<SheetState> {
  const sheet = await ensureSheet()
  const [{ data: groups, error: gErr }, { data: rows, error: rErr }] = await Promise.all([
    supabase
      .from('x_groups')
      .select('id,title,order_no,due,pos')
      .eq('sheet_id', sheet.id)
      .order('pos', { ascending: true }),
    supabase
      .from('x_rows')
      .select('id,group_id,cells,stage_done,flag,pos')
      .eq('sheet_id', sheet.id)
      .order('pos', { ascending: true }),
  ])
  if (gErr) throw new Error(`x_groups read failed: ${gErr.message}`)
  if (rErr) throw new Error(`x_rows read failed: ${rErr.message}`)
  return {
    name: sheet.name,
    stages: sheet.stages ?? DEFAULT_STAGES,
    columns: sheet.columns ?? defaultColumns(),
    version: Number(sheet.version),
    groups: (groups ?? []).map(
      (g): Group => ({
        id: g.id,
        title: g.title ?? '',
        orderNo: g.order_no ?? '',
        due: g.due ?? '',
        pos: Number(g.pos),
      }),
    ),
    rows: (rows ?? []).map(
      (r): Row => ({
        id: r.id,
        groupId: r.group_id,
        cells: r.cells ?? {},
        stageDone: r.stage_done ?? {},
        flag: !!r.flag,
        pos: Number(r.pos),
      }),
    ),
  }
}

export async function sheetVersion(): Promise<number> {
  const sheet = await ensureSheet()
  return Number(sheet.version)
}

const MAX_TEXT = 4000

function clip(v: unknown, max = MAX_TEXT): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function cleanCells(cells: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (cells && typeof cells === 'object') {
    for (const [k, v] of Object.entries(cells as Record<string, unknown>)) {
      if (typeof v === 'string' && v !== '') out[clip(k, 64)] = v.slice(0, 200000)
    }
  }
  return out
}

function cleanStageDone(sd: unknown): Record<string, { at: string; by: string }> {
  const out: Record<string, { at: string; by: string }> = {}
  if (sd && typeof sd === 'object') {
    for (const [k, v] of Object.entries(sd as Record<string, unknown>)) {
      const d = v as { at?: unknown; by?: unknown } | null
      if (d && typeof d.at === 'string') {
        out[clip(k, 12)] = { at: d.at.slice(0, 10), by: clip(d.by, 24) }
      }
    }
  }
  return out
}

// Applies one batch, then bumps the sheet version once — atomically, via the
// x_bump_version SQL function, so two phones tapping in the same second can't
// lose an increment. Concurrent editors last-write-win at cell granularity,
// which is exactly how the shared WPS file they came from behaved — except
// here nothing ever silently overwrites a whole row.
export async function applyOpsToDb(ops: Op[]): Promise<number> {
  const sheet = await ensureSheet()
  for (const op of ops) {
    await applyOne(sheet, op)
  }
  const { data, error } = await supabase.rpc('x_bump_version', { p_sheet: sheet.id })
  if (error) throw new Error(`version bump failed: ${error.message}`)
  return Number(data)
}

async function applyOne(sheet: SheetRow, op: Op): Promise<void> {
  switch (op.type) {
    case 'renameSheet': {
      await supabase
        .from('x_sheets')
        .update({ name: clip(op.name, 60) || '生产表' })
        .eq('id', sheet.id)
      return
    }
    case 'setStages': {
      const stages = (Array.isArray(op.stages) ? op.stages : [])
        .map((s) => clip(s, 12))
        .filter(Boolean)
        .slice(0, 20)
      if (!stages.length) return
      await supabase.from('x_sheets').update({ stages }).eq('id', sheet.id)
      sheet.stages = stages
      return
    }
    case 'addColumns': {
      const fresh = await currentColumns(sheet.id)
      const have = new Set(fresh.map((c) => c.id))
      const add = (Array.isArray(op.cols) ? op.cols : [])
        .filter((c) => c && typeof c.id === 'string' && !have.has(c.id))
        .map(
          (c): Col => ({
            id: clip(c.id, 64),
            label: clip(c.label, 40),
            kind: c.kind === 'img' ? 'img' : 'text',
          }),
        )
        .slice(0, 30)
      if (!add.length) return
      await supabase
        .from('x_sheets')
        .update({ columns: [...fresh, ...add] })
        .eq('id', sheet.id)
      return
    }
    case 'renameColumn': {
      const fresh = await currentColumns(sheet.id)
      await supabase
        .from('x_sheets')
        .update({
          columns: fresh.map((c) =>
            c.id === op.id ? { ...c, label: clip(op.label, 40) } : c,
          ),
        })
        .eq('id', sheet.id)
      return
    }
    case 'delColumn': {
      const fresh = await currentColumns(sheet.id)
      await supabase
        .from('x_sheets')
        .update({ columns: fresh.filter((c) => c.id !== op.id) })
        .eq('id', sheet.id)
      return
    }
    case 'addGroup': {
      const g = op.group
      if (!g || typeof g.id !== 'string') return
      await supabase.from('x_groups').upsert(
        {
          id: g.id,
          sheet_id: sheet.id,
          title: clip(g.title, 120),
          order_no: clip(g.orderNo, 80),
          due: clip(g.due, 40),
          pos: Number(g.pos) || 0,
        },
        { onConflict: 'id', ignoreDuplicates: true },
      )
      return
    }
    case 'editGroup': {
      const patch: Record<string, string> = {}
      if (typeof op.patch.title === 'string') patch.title = clip(op.patch.title, 120)
      if (typeof op.patch.orderNo === 'string') patch.order_no = clip(op.patch.orderNo, 80)
      if (typeof op.patch.due === 'string') patch.due = clip(op.patch.due, 40)
      if (!Object.keys(patch).length) return
      await supabase.from('x_groups').update(patch).eq('id', op.id).eq('sheet_id', sheet.id)
      return
    }
    case 'delGroup': {
      await supabase.from('x_groups').delete().eq('id', op.id).eq('sheet_id', sheet.id)
      return
    }
    case 'addRows': {
      const rows = (Array.isArray(op.rows) ? op.rows : []).slice(0, 500)
      if (!rows.length) return
      // stage_done rides along so undo-restoring a deleted row keeps its ✓s.
      await supabase.from('x_rows').upsert(
        rows
          .filter((r) => r && typeof r.id === 'string' && typeof r.groupId === 'string')
          .map((r) => ({
            id: r.id,
            sheet_id: sheet.id,
            group_id: r.groupId,
            cells: cleanCells(r.cells),
            stage_done: cleanStageDone(r.stageDone),
            flag: !!r.flag,
            pos: Number(r.pos) || 0,
          })),
        { onConflict: 'id', ignoreDuplicates: true },
      )
      return
    }
    case 'editCell': {
      const { data } = await supabase
        .from('x_rows')
        .select('cells')
        .eq('id', op.rowId)
        .eq('sheet_id', sheet.id)
        .single()
      if (!data) return
      const cells = { ...(data.cells ?? {}) } as Record<string, string>
      const key = clip(op.colId, 64)
      if (op.value === '') delete cells[key]
      else cells[key] = clip(op.value, 200000)
      await supabase.from('x_rows').update({ cells }).eq('id', op.rowId)
      return
    }
    case 'setStage': {
      const { data } = await supabase
        .from('x_rows')
        .select('stage_done')
        .eq('id', op.rowId)
        .eq('sheet_id', sheet.id)
        .single()
      if (!data) return
      const done = { ...(data.stage_done ?? {}) } as Record<string, { at: string; by: string }>
      const key = clip(op.stage, 12)
      if (op.done) done[key] = { at: clip(op.done.at, 10), by: clip(op.done.by, 24) }
      else delete done[key]
      await supabase.from('x_rows').update({ stage_done: done }).eq('id', op.rowId)
      return
    }
    case 'setFlag': {
      await supabase
        .from('x_rows')
        .update({ flag: !!op.flag })
        .eq('id', op.rowId)
        .eq('sheet_id', sheet.id)
      return
    }
    case 'delRow': {
      await supabase.from('x_rows').delete().eq('id', op.id).eq('sheet_id', sheet.id)
      return
    }
  }
}

async function currentColumns(sheetId: string): Promise<Col[]> {
  const { data } = await supabase.from('x_sheets').select('columns').eq('id', sheetId).single()
  return (data?.columns ?? []) as Col[]
}
