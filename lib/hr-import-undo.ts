import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import type { AttendanceSummary } from './hr'
import type { PunchDay } from './hr-daily'

/*
 * 撤销考勤导入 (于海伟 2026-11-09: 取消刚才的导入)。
 *
 * 一回导入写三样: 当月考勤汇总 (覆盖那几个人)、打卡时间 (覆盖那几个人)、
 * 人事记录 (新加一批)。覆盖掉的旧数系统本来不留, 所以每回导入在写之前把那几
 * 个人的旧数存一份; 新加的人事记录记下是哪一刻、谁记的。撤销 = 旧数原样还回
 * 去、新加的那批删掉。
 *
 * TABLE-FREE, 没有 migration, 一回导入一个文件:
 *   hr/import-undo/<batchId>.json
 */

export type ImportUndo = {
  by: string
  at: string
  /** 月份 → 姓名 → 导入前那一行 (null = 导入前没有)。 */
  summary: Record<string, Record<string, AttendanceSummary | null>>
  punch: Record<string, Record<string, Record<number, PunchDay> | null>>
  /** 新加的人事记录 —— 同一刻 (createdAt) 记的那一批。 */
  records: { createdAt: string; by: string; months: string[] }[]
}

const keyOf = (batchId: string) => `hr/import-undo/${batchId.replace(/[^A-Za-z0-9-]/g, '')}.json`

export function isBatchId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v)
}

export async function getImportUndo(batchId: string): Promise<ImportUndo | null> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(keyOf(batchId))
  if (error || !data) return null
  try {
    const raw = JSON.parse(await data.text()) as Partial<ImportUndo>
    return {
      by: raw.by ?? '',
      at: raw.at ?? '',
      summary: raw.summary ?? {},
      punch: raw.punch ?? {},
      records: raw.records ?? [],
    }
  } catch {
    return null
  }
}

/**
 * 往这一回导入的底子里添一样 —— 导入是一样一样按顺序存的, 同一回不会两处同
 * 时写。同一个人同一个月先出现的那份旧数为准 (第二次添的已经是导入后的了)。
 */
export async function addToImportUndo(
  batchId: string,
  by: string,
  part: Partial<Pick<ImportUndo, 'summary' | 'punch' | 'records'>>,
): Promise<void> {
  const cur = (await getImportUndo(batchId)) ?? {
    by,
    at: new Date().toISOString(),
    summary: {},
    punch: {},
    records: [],
  }
  for (const [m, rows] of Object.entries(part.summary ?? {}))
    cur.summary[m] = { ...rows, ...(cur.summary[m] ?? {}) }
  for (const [m, rows] of Object.entries(part.punch ?? {}))
    cur.punch[m] = { ...rows, ...(cur.punch[m] ?? {}) }
  cur.records.push(...(part.records ?? []))
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(keyOf(batchId), Buffer.from(JSON.stringify(cur), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

/** 这个人最近一回还能撤销的导入。 */
export async function latestImportUndo(by: string): Promise<{ batchId: string; undo: ImportUndo } | null> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .list('hr/import-undo', { limit: 30, sortBy: { column: 'created_at', order: 'desc' } })
  if (error || !data) return null
  for (const f of data) {
    if (!f.name.endsWith('.json')) continue
    const batchId = f.name.slice(0, -'.json'.length)
    const undo = await getImportUndo(batchId)
    if (undo && undo.by === by) return { batchId, undo }
  }
  return null
}

export async function dropImportUndo(batchId: string): Promise<void> {
  await supabase.storage.from(STORAGE_BUCKET).remove([keyOf(batchId)])
}
