import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import {
  addDays,
  nextSettleNo,
  readSettleManual,
  settlePaid,
  SETTLE_TERM_DAYS,
  type Receivable,
  type ReceivablePayment,
  type SettleManual,
} from './settle-shared'

/*
 * 应收单的存取 —— 对账单审批通过后落下来的那一笔, 和它名下的每一笔回款。
 * 口径和派生 (已收 / 未收 / 逾期) 在 lib/settle-shared.ts —— 跟应付单
 * (lib/payable.ts) 共用一份。
 *
 * TABLE-FREE, 跟 客诉 / 人事 / 工资 一个路子: 没有 migration 要人去应用, 坏
 * 了也只坏这一处。一个厂一年几十个客户 × 十二个月, 顶天几百张单, 一个 JSON
 * 绰绰有余:
 *   finance/receivables.json    [Receivable, …]
 *
 * 读-改-写走一把进程内的锁 (生产是单个 pm2 进程), 两个人同一秒记回款不会互
 * 相盖掉 —— 跟 lib/hr.ts 同一个保证。
 */

const KEY = 'finance/receivables.json'

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

function money(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.round(v * 100) / 100
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function normalize(raw: unknown): Receivable[] {
  if (!Array.isArray(raw)) return []
  const out: Receivable[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.id !== 'string' || typeof r.no !== 'string') continue
    const payments: ReceivablePayment[] = Array.isArray(r.payments)
      ? (r.payments as Record<string, unknown>[])
          .filter((p) => p && typeof p.id === 'string')
          .map((p) => ({
            id: p.id as string,
            date: str(p.date),
            amountCny: money(p.amountCny),
            note: str(p.note) || undefined,
            by: str(p.by) || undefined,
            createdAt: str(p.createdAt),
          }))
      : []
    out.push({
      id: r.id,
      no: r.no,
      customer: str(r.customer),
      period: str(r.period),
      amountCny: money(r.amountCny),
      lineCount: typeof r.lineCount === 'number' ? r.lineCount : 0,
      totalQty: typeof r.totalQty === 'number' ? r.totalQty : 0,
      ...(r.manual ? { manual: readSettleManual(r.manual) } : null),
      ...(Array.isArray(r.jobNos)
        ? { jobNos: (r.jobNos as unknown[]).filter((x): x is string => typeof x === 'string') }
        : null),
      approvedBy: str(r.approvedBy),
      approvedAt: str(r.approvedAt),
      dueDate: str(r.dueDate),
      payments,
      voidedAt: str(r.voidedAt) || undefined,
      voidedBy: str(r.voidedBy) || undefined,
    })
  }
  return out
}

async function read(): Promise<Receivable[]> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return []
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return []
  }
}

async function write(rows: Receivable[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

// 新的期间在前, 同一期间按单号 —— 读起来是"最近这几个月谁欠着"。
export async function getReceivables(): Promise<Receivable[]> {
  return (await read()).sort(
    (a, b) => b.period.localeCompare(a.period) || a.no.localeCompare(b.no),
  )
}

/** 这个客户这个月那张还算数的应收单 (作废的不算)。整月审的那张优先。 */
export async function findActiveReceivable(
  customer: string,
  period: string,
): Promise<Receivable | undefined> {
  const rows = await read()
  const mine = rows.filter(
    (r) => r.customer === customer && r.period === period && !r.voidedAt && !r.manual,
  )
  return mine.find((r) => !r.jobNos) ?? mine[0]
}

/**
 * 审批一张对账单 —— 落下一张应收单。
 *
 * 金额和行数由调用方按服务端现算的那张对账单传进来 (不收前端的数)。同一个
 * 客户同一个月只能有一张还算数的应收单: 要按新数重来, 先把旧的作废。
 */
export async function createReceivable(input: {
  customer: string
  period: string
  amountCny: number
  lineCount: number
  totalQty: number
  /** 勾着审的那几个单号; 不传 = 整个月一起审。 */
  jobNos?: string[]
  approvedBy: string
  nowIso: string
  todayYmd: string
}): Promise<Receivable> {
  return withLock(async () => {
    const rows = await read()
    // 同一个月可以分几回审, 但同一个单号只能进一张; 整月审过的那张在, 就
    // 不能再审。
    const want = input.jobNos ? new Set(input.jobNos) : null
    const dup = rows.find(
      (r) =>
        r.customer === input.customer &&
        r.period === input.period &&
        !r.voidedAt &&
        !r.manual &&
        (!want || !r.jobNos || r.jobNos.some((n) => want.has(n))),
    )
    if (dup) throw new Error(`勾的单里有已经审批过的 —— 应收单 ${dup.no}，刷新再选`)

    const row: Receivable = {
      id: crypto.randomUUID(),
      no: nextSettleNo('YS', input.period, rows),
      customer: input.customer,
      period: input.period,
      amountCny: money(input.amountCny),
      lineCount: input.lineCount,
      totalQty: input.totalQty,
      ...(input.jobNos ? { jobNos: input.jobNos } : null),
      approvedBy: input.approvedBy,
      approvedAt: input.nowIso,
      dueDate: addDays(input.todayYmd, SETTLE_TERM_DAYS),
      payments: [],
    }
    rows.push(row)
    await write(rows)
    return row
  })
}

/**
 * 补录一张应收单 —— 系统上线以前的老账。不跟对账单挂钩, 金额、约定回款日都是
 * 财务手填的; 以后回款照样一笔一笔往上记。
 */
export async function createManualReceivable(input: {
  customer: string
  period: string
  amountCny: number
  dueDate: string
  manual: SettleManual
  by: string
  nowIso: string
}): Promise<Receivable> {
  return withLock(async () => {
    const rows = await read()
    const row: Receivable = {
      id: crypto.randomUUID(),
      no: nextSettleNo('YS', input.period, rows),
      customer: input.customer,
      period: input.period,
      amountCny: money(input.amountCny),
      lineCount: 0,
      totalQty: 0,
      manual: input.manual,
      approvedBy: input.by,
      approvedAt: input.nowIso,
      dueDate: input.dueDate,
      payments: [],
    }
    rows.push(row)
    await write(rows)
    return row
  })
}

export async function addReceivablePayment(
  id: string,
  input: { date: string; amountCny: number; note?: string },
  by: string,
  nowIso: string,
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const r = rows.find((x) => x.id === id)
    if (!r) throw new Error('找不到这张应收单')
    if (r.voidedAt) throw new Error('这张应收单已作废')
    r.payments.push({
      id: crypto.randomUUID(),
      date: input.date,
      amountCny: money(input.amountCny),
      note: input.note?.trim() || undefined,
      by,
      createdAt: nowIso,
    })
    r.payments.sort((a, b) => a.date.localeCompare(b.date))
    await write(rows)
  })
}

export async function deleteReceivablePayment(
  id: string,
  paymentId: string,
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const r = rows.find((x) => x.id === id)
    if (!r) return
    const before = r.payments.length
    r.payments = r.payments.filter((p) => p.id !== paymentId)
    if (r.payments.length !== before) await write(rows)
  })
}

// 作废 —— 已经有回款挂着的不给作废: 钱是真收了的, 单子一作废这笔钱就没地
// 方落了。先把回款删掉 (说明是记错了), 再作废。
export async function voidReceivable(
  id: string,
  by: string,
  nowIso: string,
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const r = rows.find((x) => x.id === id)
    if (!r || r.voidedAt) return
    if (settlePaid(r) > 0) {
      throw new Error('这张单上已经记了回款 —— 先把回款删掉再作废')
    }
    r.voidedAt = nowIso
    r.voidedBy = by
    await write(rows)
  })
}
