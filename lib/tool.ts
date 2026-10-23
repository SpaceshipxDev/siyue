import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { toolState, type ToolIssue } from './tool-shared'

/*
 * 工具领用的存取。口径 (状态、价值、每月扣款) 在 lib/tool-shared.ts。
 *
 * TABLE-FREE, 跟 借款 / 住宿 一个路子, 没有 migration:
 *   hr/tools.json    [ToolIssue, …]
 *
 * 读-改-写走一把进程内的锁 (生产是单个 pm2 进程)。
 */

const KEY = 'hr/tools.json'

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

function money(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined
  return Math.round(v * 100) / 100
}

function str(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function normalize(raw: unknown): ToolIssue[] {
  if (!Array.isArray(raw)) return []
  const out: ToolIssue[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.id !== 'string' || !str(r.name) || !str(r.tool)) continue
    out.push({
      id: r.id,
      name: str(r.name, 40),
      date: str(r.date, 10),
      tool: str(r.tool),
      qty: typeof r.qty === 'number' && r.qty > 0 ? r.qty : 1,
      priceCny: money(r.priceCny),
      note: str(r.note, 500) || undefined,
      by: str(r.by, 40),
      createdAt: str(r.createdAt, 40),
      returnedAt: str(r.returnedAt, 10) || undefined,
      returnedBy: str(r.returnedBy, 40) || undefined,
      deductCny: money(r.deductCny),
      deductMonth: str(r.deductMonth, 7) || undefined,
      deductedBy: str(r.deductedBy, 40) || undefined,
    })
  }
  return out
}

async function read(): Promise<ToolIssue[]> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return []
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return []
  }
}

async function write(rows: ToolIssue[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

/** 新领的在前。 */
export async function getToolIssues(): Promise<ToolIssue[]> {
  return (await read()).sort(
    (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
  )
}

export async function addToolIssue(
  input: { name: string; date: string; tool: string; qty: number; priceCny?: number; note?: string },
  by: string,
  nowIso: string,
): Promise<ToolIssue> {
  return withLock(async () => {
    const rows = await read()
    const row: ToolIssue = {
      id: crypto.randomUUID(),
      name: input.name.trim(),
      date: /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : nowIso.slice(0, 10),
      tool: input.tool.trim(),
      qty: input.qty > 0 ? input.qty : 1,
      priceCny: money(input.priceCny),
      note: input.note?.trim() || undefined,
      by,
      createdAt: nowIso,
    }
    rows.push(row)
    await write(rows)
    return row
  })
}

/** 记错了删掉 —— 扣过款的不删 (那是工资里的一笔)。 */
export async function deleteToolIssue(id: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const t = rows.find((r) => r.id === id)
    if (!t) return
    if (toolState(t) === 'deducted') throw new Error('扣过款的删不了 —— 先撤销扣款')
    await write(rows.filter((r) => r.id !== id))
  })
}

/**
 * 归还 / 扣款 / 撤回到未归还 —— 平时还一件就点一件; 离职那天一次对完 (还了
 * 的勾归还, 没还的按价钱扣在这个月工资里)。
 */
export async function settleToolIssues(
  items: { id: string; action: 'return' | 'deduct' | 'reopen'; priceCny?: number }[],
  by: string,
  todayYmd: string,
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    for (const it of items) {
      const t = rows.find((r) => r.id === it.id)
      if (!t) continue
      if (it.action === 'reopen') {
        t.returnedAt = t.returnedBy = undefined
        t.deductCny = t.deductMonth = t.deductedBy = undefined
        continue
      }
      if (toolState(t) !== 'out') continue
      if (it.action === 'return') {
        t.returnedAt = todayYmd
        t.returnedBy = by
      } else {
        const price = money(it.priceCny) ?? t.priceCny
        if (price === undefined) throw new Error(`「${t.tool}」没有单价，填上才能扣款`)
        t.priceCny = price
        t.deductCny = Math.round(price * t.qty * 100) / 100
        t.deductMonth = todayYmd.slice(0, 7)
        t.deductedBy = by
      }
    }
    await write(rows)
  })
}
