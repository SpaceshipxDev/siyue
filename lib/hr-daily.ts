import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 实际上班时长 —— 考勤表上人事手填的那一格 (某人某天实际上了几个小时)。
 *
 * 考勤表的每一格本来是系统按记录算的 (该上的小时 − 请假旷工 + 加班); 人事
 * 照着打卡、照着现场填了实际的数, 那一格就以填的为准, 合计跟着变。清空就回
 * 到系统算的数。
 *
 * TABLE-FREE, 一个月一个文件, 跟人事记录一个路子:
 *   hr/daily-hours-<YYYY-MM>.json    { [姓名]: { [几号]: 小时 } }
 */

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

export type DailyHours = Record<string, Record<number, number>>

function key(month: string): string {
  return `hr/daily-hours-${month.replace(/[^0-9-]/g, '')}.json`
}

export async function getDailyHours(month: string): Promise<DailyHours> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(key(month))
  if (error || !data) return {}
  try {
    const raw = JSON.parse(await data.text()) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const out: DailyHours = {}
    for (const [name, days] of Object.entries(raw as Record<string, unknown>)) {
      if (!name.trim() || typeof days !== 'object' || days === null) continue
      const m: Record<number, number> = {}
      for (const [d, h] of Object.entries(days as Record<string, unknown>)) {
        const day = Number(d)
        if (day >= 1 && day <= 31 && typeof h === 'number' && Number.isFinite(h) && h >= 0 && h <= 24)
          m[day] = h
      }
      if (Object.keys(m).length > 0) out[name] = m
    }
    return out
  } catch {
    return {}
  }
}

/** 填一格; hours 为空 = 清掉, 回到系统算的数。 */
export async function setDailyHours(
  month: string,
  name: string,
  day: number,
  hours: number | null,
): Promise<void> {
  await withLock(async () => {
    const map = await getDailyHours(month)
    const row = { ...(map[name] ?? {}) }
    if (hours === null) delete row[day]
    else row[day] = Math.round(hours * 10) / 10
    if (Object.keys(row).length > 0) map[name] = row
    else delete map[name]
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(key(month), Buffer.from(JSON.stringify(map), 'utf8'), {
        contentType: 'application/json',
        upsert: true,
      })
    if (error) throw error
  })
}
