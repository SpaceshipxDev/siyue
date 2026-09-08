import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import type { ReturnFlow, ReturnFlowEntry } from './return-flow'

// 退货流转单的存放处 —— 一个 JSON, 跟 客诉 / 人事 / 工资 一个路子: 没有
// migration 要人去应用。一个厂一年几十条退货, 一个 JSON 绰绰有余。
//
// 类型和"走到哪一步"的判断在 lib/return-flow.ts —— 那一份退货台的客户端也要
// import, 不能带 server-only。

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const KEY = 'returns/flow.json'

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function count(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return Math.max(0, Math.min(1_000_000, Math.floor(v)))
}

function normalize(raw: unknown): ReturnFlow[] {
  if (!Array.isArray(raw)) return []
  const out: ReturnFlow[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.returnId !== 'string' || !r.returnId) continue
    out.push({
      returnId: r.returnId,
      plan: str(r.plan) || undefined,
      planBy: str(r.planBy) || undefined,
      planAt: str(r.planAt) || undefined,
      cause: str(r.cause) || undefined,
      causeBy: str(r.causeBy) || undefined,
      causeAt: str(r.causeAt) || undefined,
      releasedAt: str(r.releasedAt) || undefined,
      releasedBy: str(r.releasedBy) || undefined,
      stockedAt: str(r.stockedAt) || undefined,
      stockedBy: str(r.stockedBy) || undefined,
      stockedQty: count(r.stockedQty),
      shippedAt: str(r.shippedAt) || undefined,
      shippedBy: str(r.shippedBy) || undefined,
      shipmentId: str(r.shipmentId) || undefined,
    })
  }
  return out
}

async function read(): Promise<ReturnFlow[]> {
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

async function write(rows: ReturnFlow[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

export async function getReturnFlows(): Promise<Map<string, ReturnFlow>> {
  const rows = await read()
  return new Map(rows.map((r) => [r.returnId, r]))
}

export async function getReturnFlow(
  returnId: string,
): Promise<ReturnFlow | undefined> {
  return (await read()).find((r) => r.returnId === returnId)
}

export async function writeReturnFlow(
  returnId: string,
  entry: ReturnFlowEntry,
  by: string,
  nowIso: string,
): Promise<ReturnFlow> {
  return withLock(async () => {
    const rows = await read()
    let row = rows.find((r) => r.returnId === returnId)
    if (!row) {
      row = { returnId }
      rows.push(row)
    }
    switch (entry.kind) {
      case 'plan': {
        const text = entry.text.trim()
        row.plan = text || undefined
        // 清空等于撤回这一笔 —— 签名跟着走, 免得留下"某某写过但现在是空的"。
        row.planBy = text ? by : undefined
        row.planAt = text ? nowIso : undefined
        break
      }
      case 'cause': {
        const text = entry.text.trim()
        row.cause = text || undefined
        row.causeBy = text ? by : undefined
        row.causeAt = text ? nowIso : undefined
        break
      }
      case 'release':
        row.releasedAt = nowIso
        row.releasedBy = by
        break
      case 'stock':
        row.stockedAt = nowIso
        row.stockedBy = by
        row.stockedQty = entry.qty
        break
      case 'ship':
        row.shippedAt = nowIso
        row.shippedBy = by
        row.shipmentId = entry.shipmentId
        break
    }
    await write(rows)
    return row
  })
}
