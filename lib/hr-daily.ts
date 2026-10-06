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

/*
 * 打卡时长 —— 导入打卡机明细读出来的, 某人某天打卡上了几个小时。
 *
 * 跟手填的分开放: 手填的是人改过的, 永远压在打卡上面; 打卡的这个月导过的人,
 * 没打卡的日子就是 0。同一个人再导一遍, 他这个月整行换成新的。
 *
 *   hr/punch-hours-<YYYY-MM>.json    { [姓名]: { [几号]: 小时 } }
 */
function punchKey(month: string): string {
  return `hr/punch-hours-${month.replace(/[^0-9-]/g, '')}.json`
}

/**
 * 一天的打卡 —— 上下班时间 (时长到考勤表上按部门扣午休再算), 或者表上只给了
 * 的工时 (小时数)。
 */
export type PunchDay = number | { in: string; out: string }
export type PunchHours = Record<string, Record<number, PunchDay>>

const HHMM = /^\d{2}:\d{2}$/

// 同一个文件里放一份「打卡表上写的部门」—— 扣不扣午休看部门, 考勤表不去工资
// 名单里找部门。
const DEPT_KEY = '__dept__'

async function readPunchRaw(month: string): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(punchKey(month))
  if (error || !data) return {}
  try {
    const raw = JSON.parse(await data.text()) as unknown
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** 打卡表上写的部门 { 姓名: 部门 }。 */
export async function getPunchDepts(month: string): Promise<Record<string, string>> {
  const d = (await readPunchRaw(month))[DEPT_KEY]
  if (typeof d !== 'object' || d === null) return {}
  return Object.fromEntries(
    Object.entries(d as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '',
    ),
  )
}

export async function getPunchHours(month: string): Promise<PunchHours> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(punchKey(month))
  if (error || !data) return {}
  try {
    const raw = JSON.parse(await data.text()) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const out: PunchHours = {}
    for (const [name, days] of Object.entries(raw as Record<string, unknown>)) {
      if (name === DEPT_KEY) continue
      if (!name.trim() || typeof days !== 'object' || days === null) continue
      const m: Record<number, PunchDay> = {}
      for (const [d, h] of Object.entries(days as Record<string, unknown>)) {
        const day = Number(d)
        if (!(day >= 1 && day <= 31)) continue
        if (typeof h === 'number' && Number.isFinite(h) && h >= 0 && h <= 24) m[day] = h
        else if (typeof h === 'object' && h !== null) {
          const o = h as Record<string, unknown>
          if (typeof o.in === 'string' && typeof o.out === 'string' && HHMM.test(o.in) && HHMM.test(o.out))
            m[day] = { in: o.in, out: o.out }
        }
      }
      out[name] = m
    }
    return out
  } catch {
    return {}
  }
}

/** 存一批打卡 —— 出现的人整月换成这一份, 没出现的人原样留着。返回人数。 */
export async function savePunchHours(
  month: string,
  rows: { name: string; day: number; hours?: number; in?: string; out?: string; dept?: string }[],
): Promise<number> {
  return withLock(async () => {
    const map: Record<string, unknown> = await getPunchHours(month)
    const depts = await getPunchDepts(month)
    const fresh: PunchHours = {}
    for (const r of rows) {
      const name = r.name.trim()
      if (!name || !(r.day >= 1 && r.day <= 31)) continue
      if (r.dept?.trim()) depts[name] = r.dept.trim()
      const v: PunchDay =
        r.in && r.out && HHMM.test(r.in) && HHMM.test(r.out)
          ? { in: r.in, out: r.out }
          : Math.round((r.hours ?? 0) * 10) / 10
      fresh[name] = { ...(fresh[name] ?? {}), [r.day]: v }
    }
    Object.assign(map, fresh)
    map[DEPT_KEY] = depts
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(punchKey(month), Buffer.from(JSON.stringify(map), 'utf8'), {
        contentType: 'application/json',
        upsert: true,
      })
    if (error) throw error
    return Object.keys(fresh).length
  })
}
