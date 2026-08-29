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

export type NewHrRecordInput = {
  name: string
  type: HrType
  date: string // YYYY-MM-DD
  hours?: number // 时长, hours — only meaningful on 事假/病假/工伤/旷工
  note?: string
}

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
    createdAt: nowIso,
  }
  // The 月 a record belongs to is the month it HAPPENED in, not the month it
  // was filed — a 8-31 迟到 typed on 9-1 still counts against August.
  const month = row.date.slice(0, 7)
  await withHrLock(async () => {
    const rows = await readShard(month)
    rows.push(row)
    await writeShard(month, rows)
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
