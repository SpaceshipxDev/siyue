import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import type { HrRecord, HrType } from './data'
import { HR_TYPES, hrHasHours } from './data'

/*
 * 人事 — 事假 / 病假 / 工伤 / 迟到 / 旷工 / 违纪 / 重大质量异常, one line per
 * event, written the day it happens and read back per person by month or by
 * year. The four absence kinds carry 时长 in hours; the rest are counted.
 *
 * Deliberately TABLE-FREE — the same choice as 合同 (lib/contract-file.ts),
 * 凭证 (lib/voucher-file.ts) and 请购图片 (lib/procurement-photo.ts), so there
 * is NO migration to apply by hand and nothing to break on a stale DB.
 *
 * Sharded ONE FILE PER MONTH:
 *   hr/<YYYY-MM>.json    [{id,name,type,date,hours,note,by,createdAt}, …]
 *
 * The shard is the query. 月度 reads exactly one file; 年度 reads twelve in
 * parallel; a person's history is a filter over those. A shop this size books
 * a few hundred events a month, so a month is a small JSON and the
 * read-modify-write on it stays cheap.
 *
 * Writes go through a process-local chain (see withHrLock) so two people
 * filing at the same second can't overwrite each other's line — the same
 * guarantee lib/db.ts gives its multi-row writes, and production is one pm2
 * process.
 */

// Serialize read-modify-write on the shards. Same shape as lib/db.ts's
// withWriteLock: a promise chain, never rejecting, so one failed write can't
// wedge the next.
let hrChain: Promise<unknown> = Promise.resolve()
function withHrLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = hrChain.then(fn, fn)
  hrChain = next.catch(() => undefined)
  return next
}

function shardKey(month: string): string {
  return `hr/${month.replace(/[^0-9-]/g, '')}.json`
}

function isHrType(x: unknown): x is HrType {
  return typeof x === 'string' && (HR_TYPES as readonly string[]).includes(x)
}

// Records filed before 请假 was split into 事假 / 病假 / 工伤 carry the old
// single kind. They read as 事假 — the commonest of the three and the one
// that costs the person pay, so the reading errs toward the record still
// meaning something rather than quietly vanishing from the month.
function migrateType(raw: unknown): HrType | null {
  if (raw === '请假') return '事假'
  return isHrType(raw) ? raw : null
}

// One month of records. Missing shard (nothing filed that month) reads as an
// empty list — never an error, so the page always renders.
async function readShard(month: string): Promise<HrRecord[]> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(shardKey(month))
  if (error || !data) return []
  try {
    const arr = JSON.parse(await data.text())
    if (!Array.isArray(arr)) return []
    const out: HrRecord[] = []
    for (const r of arr as HrRecord[]) {
      if (!r || typeof r.name !== 'string') continue
      const type = migrateType(r.type)
      if (!type) continue
      out.push({ ...r, type })
    }
    return out
  } catch {
    return []
  }
}

async function writeShard(month: string, rows: HrRecord[]): Promise<void> {
  const body = Buffer.from(JSON.stringify(rows), 'utf8')
  const upR = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(shardKey(month), body, {
      contentType: 'application/json',
      upsert: true,
    })
  if (upR.error) throw upR.error
}

// Newest first — the page reads as a diary, most recent at the top.
function byDateDesc(a: HrRecord, b: HrRecord): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1
  return (a.createdAt ?? '') < (b.createdAt ?? '') ? 1 : -1
}

// 月度 — one shard.
export async function getHrMonth(month: string): Promise<HrRecord[]> {
  const rows = await readShard(month)
  return rows.sort(byDateDesc)
}

// 年度 — twelve shards in parallel. Absent months cost one 404 each and
// contribute nothing.
export async function getHrYear(year: string): Promise<HrRecord[]> {
  const months = Array.from(
    { length: 12 },
    (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`,
  )
  const all = await Promise.all(months.map((m) => readShard(m)))
  return all.flat().sort(byDateDesc)
}

// Which periods have anything in them, so the picker only offers real months.
// Derived from the bucket listing rather than a scan of the files themselves.
export async function getHrMonths(): Promise<string[]> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .list('hr', { limit: 1000 })
  if (error || !data) return []
  return data
    .map((o) => o.name.replace(/\.json$/i, ''))
    .filter((m) => /^\d{4}-\d{2}$/.test(m))
    .sort()
    .reverse()
}

// === 员工名册 ===
//
// The 人事 picker can't be the system's user list alone: plenty of people on
// the floor share a station account or have none at all, and they still take
// 事假 and still turn up late. So the roster is the account names PLUS every
// name this module has ever been asked to remember, kept in one small file.
//
// Adding somebody is just filing their first record — type the name, and it's
// in the picker from then on. There is no separate 员工管理 screen because
// there is nothing to manage: a name that was never used costs nothing, and a
// typo disappears the moment the record carrying it is deleted and the name
// stops being offered... except it doesn't, so 名册 is append-only on purpose
// and a mistyped name simply sits unused at the bottom of the picker.
const ROSTER_KEY = 'hr/roster.json'

async function readRoster(): Promise<string[]> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(ROSTER_KEY)
  if (error || !data) return []
  try {
    const arr = JSON.parse(await data.text())
    if (!Array.isArray(arr)) return []
    return (arr as unknown[]).filter(
      (n): n is string => typeof n === 'string' && n.trim().length > 0,
    )
  } catch {
    return []
  }
}

export async function getHrRoster(): Promise<string[]> {
  return (await readRoster()).sort((a, b) => a.localeCompare(b, 'zh'))
}

// Remember a name the picker didn't have. Runs inside the caller's lock.
async function rememberName(name: string): Promise<void> {
  const rows = await readRoster()
  if (rows.includes(name)) return
  rows.push(name)
  const upR = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(ROSTER_KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (upR.error) throw upR.error
}

export type NewHrRecordInput = {
  name: string
  type: HrType
  date: string // YYYY-MM-DD
  hours?: number // 时长, hours — only meaningful on 事假/病假/工伤/旷工
  note?: string
}

// 部门 is decided server-side, never sent by the client — it's what scopes who
// may read the line, so it can't be something the browser gets to claim.

export function isValidHrInput(x: unknown): x is NewHrRecordInput {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (typeof o.name !== 'string' || o.name.trim().length === 0) return false
  if (!isHrType(o.type)) return false
  if (typeof o.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.date))
    return false
  if (o.note !== undefined && typeof o.note !== 'string') return false
  if (o.hours !== undefined) {
    if (typeof o.hours !== 'number' || !Number.isFinite(o.hours)) return false
    // A shift is 8h; a month of sick leave is ~200h. Anything past that is a
    // typo (a 8000 that was meant to be 8), and 0 or negative is not a length.
    if (o.hours <= 0 || o.hours > 999) return false
  }
  return true
}

export async function addHrRecord(
  input: NewHrRecordInput,
  by: string,
  dept: string,
  nowIso: string,
): Promise<HrRecord> {
  const row: HrRecord = {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    type: input.type,
    date: input.date,
    // Only the kinds measured in hours keep one — a 迟到 with a length would
    // be a number nothing ever adds up.
    hours: hrHasHours(input.type) ? input.hours : undefined,
    note: input.note?.trim() || undefined,
    by,
    dept,
    createdAt: nowIso,
  }
  // The 月 a record belongs to is the month it HAPPENED in, not the month it
  // was filed — a 8-31 迟到 typed on 9-1 still counts against August.
  const month = row.date.slice(0, 7)
  await withHrLock(async () => {
    const rows = await readShard(month)
    rows.push(row)
    await writeShard(month, rows)
    // Filing somebody's first record IS how they join the picker.
    await rememberName(row.name)
  })
  return row
}

export async function deleteHrRecord(
  month: string,
  recordId: string,
): Promise<void> {
  await withHrLock(async () => {
    const rows = await readShard(month)
    if (!rows.some((r) => r.id === recordId)) return
    await writeShard(
      month,
      rows.filter((r) => r.id !== recordId),
    )
  })
}

export type HrRecordPatch = {
  type?: HrType
  hours?: number | null // null = 清掉时长
  note?: string | null
}

export function isValidHrPatch(x: unknown): x is HrRecordPatch {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (o.type !== undefined && !isHrType(o.type)) return false
  if (o.note !== undefined && o.note !== null && typeof o.note !== 'string')
    return false
  if (o.hours !== undefined && o.hours !== null) {
    if (typeof o.hours !== 'number' || !Number.isFinite(o.hours)) return false
    if (o.hours <= 0 || o.hours > 999) return false
  }
  return true
}

// 改一条已经记下的线。The common mistake is a slip — 事假 tapped when it was
// 病假, 8 typed when it was 4 — and before this the only fix was 删了重记,
// which loses who originally filed it and needs the heavier permission.
//
// 日期 is deliberately NOT editable: the day a record happened is what decides
// which month's shard it lives in, so changing it would mean moving the line
// between files. A line filed against the wrong day is rare and stays a
// 删 + 重记.
//
// Switching to a kind that carries no 时长 drops the hours rather than leaving
// an orphan number nothing adds up; switching INTO one without giving hours is
// refused, because 事假 with no length is a line payroll can't use.
export async function updateHrRecord(
  month: string,
  recordId: string,
  patch: HrRecordPatch,
): Promise<void> {
  await withHrLock(async () => {
    const rows = await readShard(month)
    const row = rows.find((r) => r.id === recordId)
    if (!row) return
    const nextType = patch.type ?? row.type
    let nextHours = patch.hours === undefined ? row.hours : (patch.hours ?? undefined)
    if (!hrHasHours(nextType)) nextHours = undefined
    else if (nextHours === undefined) {
      throw new Error(`${nextType}要填时长`)
    }
    row.type = nextType
    row.hours = nextHours
    if (patch.note !== undefined) row.note = patch.note?.trim() || undefined
    await writeShard(month, rows)
  })
}
