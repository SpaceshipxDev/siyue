import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl } from './storage-url'
import {
  addDays,
  nextSettleNo,
  settlePaid,
  SETTLE_TERM_DAYS,
  type Payable,
  type PayablePayment,
  type PaymentProof,
} from './settle-shared'

/*
 * 应付单的存取 —— 外协对账单确认之后落下来的那一笔, 和它名下的每一笔付款。
 * 口径和派生跟应收单共用一份 (lib/settle-shared.ts), 这里只管存。
 *
 * 跟应收一个样子, 多一样: 每一笔付款可以挂一张付款凭证 (银行回单 / 转账截
 * 图)。付出去的钱, 凭证就是证据 —— 供应商说没收到, 翻出来就是那张回单。
 *
 * TABLE-FREE:
 *   finance/payables.json                     [Payable, …]
 *   finance/payables/proofs/<payableId>/<uuid>.<ext>   那张凭证本身
 */

const KEY = 'finance/payables.json'

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

function readProof(v: unknown): PaymentProof | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  if (typeof o.url !== 'string' || !o.url) return undefined
  return {
    url: o.url,
    filename: str(o.filename) || '付款凭证',
    contentType: str(o.contentType) || undefined,
  }
}

function normalize(raw: unknown): Payable[] {
  if (!Array.isArray(raw)) return []
  const out: Payable[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.id !== 'string' || typeof r.no !== 'string') continue
    const payments: PayablePayment[] = Array.isArray(r.payments)
      ? (r.payments as Record<string, unknown>[])
          .filter((p) => p && typeof p.id === 'string')
          .map((p) => ({
            id: p.id as string,
            date: str(p.date),
            amountCny: money(p.amountCny),
            note: str(p.note) || undefined,
            by: str(p.by) || undefined,
            createdAt: str(p.createdAt),
            proof: readProof(p.proof),
          }))
      : []
    out.push({
      id: r.id,
      no: r.no,
      vendor: str(r.vendor),
      period: str(r.period),
      amountCny: money(r.amountCny),
      lineCount: typeof r.lineCount === 'number' ? r.lineCount : 0,
      totalQty: typeof r.totalQty === 'number' ? r.totalQty : 0,
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

async function read(): Promise<Payable[]> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return []
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return []
  }
}

async function write(rows: Payable[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

export async function getPayables(): Promise<Payable[]> {
  return (await read()).sort(
    (a, b) => b.period.localeCompare(a.period) || a.no.localeCompare(b.no),
  )
}

export async function getPayable(id: string): Promise<Payable | undefined> {
  return (await read()).find((r) => r.id === id)
}

/** 这个供应商这个月那张还算数的应付单 (作废的不算)。 */
export async function findActivePayable(
  vendor: string,
  period: string,
): Promise<Payable | undefined> {
  const rows = await read()
  return rows.find((r) => r.vendor === vendor && r.period === period && !r.voidedAt)
}

/**
 * 确认一张外协对账单 —— 落下一张应付单。金额由调用方按服务端现算的那张纸
 * 传进来。同一家同一个月只能有一张还算数的。
 */
export async function createPayable(input: {
  vendor: string
  period: string
  amountCny: number
  lineCount: number
  totalQty: number
  approvedBy: string
  nowIso: string
  todayYmd: string
}): Promise<Payable> {
  return withLock(async () => {
    const rows = await read()
    const dup = rows.find(
      (r) => r.vendor === input.vendor && r.period === input.period && !r.voidedAt,
    )
    if (dup) throw new Error(`这个月已经确认过了 —— 应付单 ${dup.no}`)
    const row: Payable = {
      id: crypto.randomUUID(),
      no: nextSettleNo('YF', input.period, rows),
      vendor: input.vendor,
      period: input.period,
      amountCny: money(input.amountCny),
      lineCount: input.lineCount,
      totalQty: input.totalQty,
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

// 凭证是手机拍的回单、网银截图, 偶尔是银行导出的 PDF。
const PROOF_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'heic', 'pdf'] as const

export function isAllowedProofName(fileName: string): boolean {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  return !!m && (PROOF_EXTS as readonly string[]).includes(m[1])
}

function proofExt(fileName: string, contentType: string): string {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  if (m && (PROOF_EXTS as readonly string[]).includes(m[1])) return m[1]
  if (contentType === 'application/pdf') return 'pdf'
  if (contentType === 'image/png') return 'png'
  if (contentType === 'image/webp') return 'webp'
  if (contentType === 'image/heic') return 'heic'
  return 'jpg'
}

/**
 * 先把凭证存进桶里, 返回它的地址 —— 付款那一行还没记, 等人看过机器读出来的
 * 日期金额、点了「记付款」才挂上去。中途不记了, 桶里留一张没人指着的图, 无害。
 */
export async function storePaymentProof(input: {
  payableId: string
  buf: ArrayBuffer
  fileName: string
  contentType: string
}): Promise<PaymentProof> {
  const safe = input.payableId.replace(/[^a-zA-Z0-9._-]/g, '_')
  const key = `finance/payables/proofs/${safe}/${crypto.randomUUID()}.${proofExt(
    input.fileName,
    input.contentType,
  )}`
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, Buffer.from(input.buf), {
      contentType: input.contentType || 'application/octet-stream',
      upsert: false,
    })
  if (error) throw error
  return {
    url: proxiedKeyUrl(key),
    filename: input.fileName,
    contentType: input.contentType || undefined,
  }
}

export async function addPayablePayment(
  id: string,
  input: { date: string; amountCny: number; note?: string; proof?: PaymentProof },
  by: string,
  nowIso: string,
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const r = rows.find((x) => x.id === id)
    if (!r) throw new Error('找不到这张应付单')
    if (r.voidedAt) throw new Error('这张应付单已作废')
    r.payments.push({
      id: crypto.randomUUID(),
      date: input.date,
      amountCny: money(input.amountCny),
      note: input.note?.trim() || undefined,
      by,
      createdAt: nowIso,
      proof: input.proof,
    })
    r.payments.sort((a, b) => a.date.localeCompare(b.date))
    await write(rows)
  })
}

export async function deletePayablePayment(id: string, paymentId: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const r = rows.find((x) => x.id === id)
    if (!r) return
    const before = r.payments.length
    r.payments = r.payments.filter((p) => p.id !== paymentId)
    if (r.payments.length !== before) await write(rows)
  })
}

// 作废 —— 已经付过钱的不给作废, 先把付款删掉再说 (跟应收同一个道理)。
export async function voidPayable(id: string, by: string, nowIso: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const r = rows.find((x) => x.id === id)
    if (!r || r.voidedAt) return
    if (settlePaid(r) > 0) throw new Error('这张单上已经记了付款 —— 先把付款删掉再作废')
    r.voidedAt = nowIso
    r.voidedBy = by
    await write(rows)
  })
}
