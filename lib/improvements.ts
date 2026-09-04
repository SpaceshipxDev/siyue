import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 改善建议 — 厂里的人提的"这件事可以更好"。
 *
 * 质量模块的第四张表, 也是唯一一张不是记问题的表: 前三张回答"哪里坏了、谁
 * 的责任、赔了多少", 这一张回答"怎么才能不再这样"。所以它不带判定、不带金
 * 额、不带责任人 —— 一条建议只要说清楚: 谁提的、哪个部门、建议是什么、改善
 * 前是什么样、改善后是什么样、对效率/质量/成本有什么影响。
 *
 * 提报对全厂的账号开着, 一条都不该等着谁来代录: 看得见问题的是站在机床边上
 * 的那个人。改已经填下去的东西、删一条是另一档 (lib/auth canEditQuality)。
 *
 * Table-free, 跟 客诉 / 制程不良 / 人事 一个路子: 没有 migration 要人去应用。
 */

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const KEY = 'quality/improvements.json'

export type Improvement = {
  id: string
  date: string // 提报日期 YYYY-MM-DD
  reporter: string // 提报人
  dept: string // 提报部门
  suggestion: string // 改善建议
  before: string // 改善前
  after: string // 改善后
  impact: string // 对效率·质量·成本的影响
  note: string // 备注
  by?: string // 记录人 (登录的账号 — 车间共用账号时跟提报人不是一个)
  createdAt: string
}

export type ImprovementPatch = {
  date?: string
  reporter?: string
  dept?: string
  suggestion?: string
  before?: string
  after?: string
  impact?: string
  note?: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function normalize(raw: unknown): Improvement[] {
  if (!Array.isArray(raw)) return []
  const out: Improvement[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.id !== 'string') continue
    out.push({
      id: r.id,
      date: /^\d{4}-\d{2}-\d{2}$/.test(str(r.date)) ? str(r.date) : '',
      reporter: str(r.reporter),
      dept: str(r.dept),
      suggestion: str(r.suggestion),
      before: str(r.before),
      after: str(r.after),
      impact: str(r.impact),
      note: str(r.note),
      by: str(r.by) || undefined,
      createdAt: str(r.createdAt),
    })
  }
  return out
}

async function read(): Promise<Improvement[]> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(KEY)
  if (error || !data) return []
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return []
  }
}

async function write(rows: Improvement[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

// 新的在前 — 这张表读起来是"最近谁提了什么"。
export async function getImprovements(): Promise<Improvement[]> {
  return (await read()).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.createdAt < b.createdAt ? 1 : -1
  })
}

export type NewImprovement = {
  date: string
  reporter: string
  dept: string
  suggestion: string
  before: string
  after: string
  impact: string
  note: string
}

export async function addImprovement(
  input: NewImprovement,
  by: string,
  nowIso: string,
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    rows.push({
      id: crypto.randomUUID(),
      date: input.date,
      reporter: input.reporter.trim(),
      dept: input.dept.trim(),
      suggestion: input.suggestion.trim(),
      before: input.before.trim(),
      after: input.after.trim(),
      impact: input.impact.trim(),
      note: input.note.trim(),
      by,
      createdAt: nowIso,
    })
    await write(rows)
  })
}

// fillBlanksOnly — 见 lib/complaints 的同一段: 提报那一档只补空格, 改已经填
// 下去的东西是 工程 / 商务于海伟 那一档 (lib/auth canEditQuality)。
export async function updateImprovement(
  id: string,
  patch: ImprovementPatch,
  opts?: { fillBlanksOnly?: boolean },
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const row = rows.find((r) => r.id === id)
    if (!row) return
    if (opts?.fillBlanksOnly) {
      for (const k of Object.keys(patch) as (keyof ImprovementPatch)[]) {
        if (patch[k] === undefined) continue
        if (row[k]) throw new Error('这一格填过了 — 要改找工程或于海伟')
      }
    }
    if (patch.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(patch.date))
      row.date = patch.date
    if (patch.reporter !== undefined) row.reporter = patch.reporter.trim()
    if (patch.dept !== undefined) row.dept = patch.dept.trim()
    if (patch.suggestion !== undefined) row.suggestion = patch.suggestion.trim()
    if (patch.before !== undefined) row.before = patch.before.trim()
    if (patch.after !== undefined) row.after = patch.after.trim()
    if (patch.impact !== undefined) row.impact = patch.impact.trim()
    if (patch.note !== undefined) row.note = patch.note.trim()
    await write(rows)
  })
}

export async function deleteImprovement(id: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    if (!rows.some((r) => r.id === id)) return
    await write(rows.filter((r) => r.id !== id))
  })
}
