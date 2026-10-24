import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl, storageKeyFromUrl } from './storage-url'
import { createRequestPayable } from './payable'
import type { VoucherFile } from './data'
import {
  nextPayNo,
  payStage,
  payTotal,
  PAY_DEPTS,
  type PayDept,
  type PayFileKind,
  type PayItem,
  type PayRecon,
  type PayRequest,
  type PayStatement,
  cleanStatement,
} from './pay-request-shared'

/*
 * 付款申请的存取。口径 (走到哪一步、金额、单号) 在 lib/pay-request-shared.ts。
 *
 * TABLE-FREE, 跟 借款 / 应付 一个路子, 没有 migration:
 *   finance/pay-requests.json                        [PayRequest, …]
 *   finance/pay-requests/<id>/<uuid>.<ext>            凭证 / 发票
 *
 * 读-改-写走一把进程内的锁 (生产是单个 pm2 进程)。
 */

const KEY = 'finance/pay-requests.json'

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

function opt(v: unknown): string | undefined {
  return str(v) || undefined
}

function files(v: unknown): VoucherFile[] {
  if (!Array.isArray(v)) return []
  return (v as Record<string, unknown>[])
    .filter((f) => f && typeof f.id === 'string' && typeof f.url === 'string')
    .map((f) => ({
      id: f.id as string,
      url: f.url as string,
      filename: str(f.filename) || '附件',
      filesize: typeof f.filesize === 'number' ? f.filesize : undefined,
      contentType: opt(f.contentType),
      uploadedBy: opt(f.uploadedBy),
      createdAt: str(f.createdAt),
    }))
}

function recon(v: unknown): PayRecon | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  const blockIds = Array.isArray(o.blockIds)
    ? (o.blockIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  if (!str(o.vendor) || blockIds.length === 0) return undefined
  return {
    vendor: str(o.vendor),
    period: str(o.period),
    blockIds,
    lineCount: typeof o.lineCount === 'number' ? o.lineCount : 0,
    totalQty: typeof o.totalQty === 'number' ? o.totalQty : 0,
  }
}

function normalize(raw: unknown): PayRequest[] {
  if (!Array.isArray(raw)) return []
  const out: PayRequest[] = []
  for (const v of raw as unknown[]) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    if (typeof r.id !== 'string' || typeof r.no !== 'string') continue
    const items: PayItem[] = Array.isArray(r.items)
      ? (r.items as Record<string, unknown>[])
          .filter((i) => i && typeof i.name === 'string')
          .map((i) => ({
            name: str(i.name),
            qty: typeof i.qty === 'number' ? i.qty : undefined,
            unitPriceCny: typeof i.unitPriceCny === 'number' ? i.unitPriceCny : undefined,
            amountCny: money(i.amountCny),
          }))
      : []
    out.push({
      id: r.id,
      no: r.no,
      dept: (PAY_DEPTS as readonly string[]).includes(r.dept as string)
        ? (r.dept as PayDept)
        : '商务',
      payee: str(r.payee),
      payeeAccount: opt(r.payeeAccount),
      category: str(r.category),
      subject: str(r.subject),
      note: opt(r.note),
      items,
      amountCny: money(r.amountCny),
      vouchers: files(r.vouchers),
      invoices: files(r.invoices),
      ...(r.statement && typeof r.statement === 'object'
        ? (() => {
            const st = r.statement as Record<string, unknown>
            const c = cleanStatement(st.rows, st.filename)
            return c ? { statement: c } : null
          })()
        : null),
      appliedBy: str(r.appliedBy),
      appliedAt: str(r.appliedAt),
      reviewedBy: opt(r.reviewedBy),
      reviewedAt: opt(r.reviewedAt),
      approvedBy: opt(r.approvedBy),
      approvedAt: opt(r.approvedAt),
      rejectedBy: opt(r.rejectedBy),
      rejectedAt: opt(r.rejectedAt),
      rejectNote: opt(r.rejectNote),
      payableId: opt(r.payableId),
      payableNo: opt(r.payableNo),
      ...(recon(r.recon) ? { recon: recon(r.recon) } : null),
      submittedAt: opt(r.submittedAt),
    })
  }
  return out
}

async function read(): Promise<PayRequest[]> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return []
  try {
    return normalize(JSON.parse(await data.text()))
  } catch {
    return []
  }
}

async function write(rows: PayRequest[]): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

/** 新的在前。 */
export async function getPayRequests(): Promise<PayRequest[]> {
  return (await read()).sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))
}

export async function getPayRequest(id: string): Promise<PayRequest | undefined> {
  return (await read()).find((r) => r.id === id)
}

export async function createPayRequest(
  input: {
    dept: PayDept
    payee: string
    payeeAccount?: string
    category: string
    subject: string
    note?: string
    items: PayItem[]
    statement?: PayStatement
  },
  by: string,
  nowIso: string,
  todayYmd: string,
): Promise<PayRequest> {
  return withLock(async () => {
    const rows = await read()
    const items = input.items.map((i) => ({ ...i, name: i.name.trim(), amountCny: money(i.amountCny) }))
    const row: PayRequest = {
      id: crypto.randomUUID(),
      no: nextPayNo(todayYmd, rows),
      dept: input.dept,
      payee: input.payee.trim(),
      payeeAccount: input.payeeAccount?.trim() || undefined,
      category: input.category.trim(),
      subject: input.subject.trim(),
      note: input.note?.trim() || undefined,
      items,
      amountCny: payTotal(items),
      vouchers: [],
      invoices: [],
      ...(input.statement ? { statement: input.statement } : null),
      appliedBy: by,
      appliedAt: nowIso,
    }
    rows.push(row)
    await write(rows)
    return row
  })
}

/**
 * 这一家正挂在付款申请上的外协单 —— 对账确认了、还没被驳回的。它们跟应付单
 * 上的一样算「对过账了」, 不再上对账单。
 */
export function reconBlockIds(requests: PayRequest[], vendor: string): string[] {
  const out: string[] = []
  for (const r of requests)
    if (r.recon && r.recon.vendor === vendor && payStage(r) !== 'rejected') out.push(...r.recon.blockIds)
  return out
}

/** 外协对账确认 —— 认下的那几张外协单生成一张待填付款的申请。 */
export async function createReconPayRequest(
  input: { recon: PayRecon; items: PayItem[]; statement?: PayStatement },
  by: string,
  nowIso: string,
  todayYmd: string,
): Promise<PayRequest> {
  return withLock(async () => {
    const rows = await read()
    const taken = new Set(reconBlockIds(rows, input.recon.vendor))
    const dup = input.recon.blockIds.find((id) => taken.has(id))
    if (dup) {
      const on = rows.find((r) => payStage(r) !== 'rejected' && r.recon?.blockIds.includes(dup))
      throw new Error(`有的单已经确认过了${on ? ` —— 在付款申请 ${on.no} 上` : ''}，刷新再选`)
    }
    const items = input.items.map((i) => ({ ...i, amountCny: money(i.amountCny) }))
    const row: PayRequest = {
      id: crypto.randomUUID(),
      no: nextPayNo(todayYmd, rows),
      dept: '商务',
      payee: input.recon.vendor,
      category: '外协加工费用',
      subject: `${input.recon.period.slice(0, 4)}年${Number(input.recon.period.slice(5, 7))}月外协对账`,
      items,
      amountCny: payTotal(items),
      vouchers: [],
      invoices: [],
      ...(input.statement ? { statement: input.statement } : null),
      appliedBy: by,
      appliedAt: nowIso,
      recon: input.recon,
    }
    rows.push(row)
    await write(rows)
    return row
  })
}

/** 待填付款那一步能改的: 收款账户、说明、清单上每一项的金额 (没定价的在这里补)。 */
export async function fillPayRequest(
  id: string,
  patch: { payeeAccount?: string; note?: string; amounts?: number[] },
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const r = rows.find((x) => x.id === id)
    if (!r) throw new Error('找不到这张付款申请')
    if (payStage(r) !== 'fill') throw new Error('已经提交审核了，改不了')
    if (patch.payeeAccount !== undefined) r.payeeAccount = patch.payeeAccount.trim() || undefined
    if (patch.note !== undefined) r.note = patch.note.trim() || undefined
    if (patch.amounts) {
      r.items = r.items.map((i, x) =>
        typeof patch.amounts![x] === 'number' && patch.amounts![x] >= 0
          ? { ...i, amountCny: money(patch.amounts![x]) }
          : i,
      )
      r.amountCny = payTotal(r.items)
    }
    await write(rows)
  })
}

/** 对账单明细 —— 导进来 / 换一张 / 去掉。批下来以后就定了。 */
export async function setPayStatement(id: string, statement: PayStatement | undefined): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const r = rows.find((x) => x.id === id)
    if (!r) throw new Error('找不到这张付款申请')
    if (payStage(r) === 'done') throw new Error('已经转到财务了，对账单明细不能再改')
    if (statement) r.statement = statement
    else delete r.statement
    await write(rows)
  })
}

/** 填好了, 交去审核。 */
export async function submitPayRequest(id: string, nowIso: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const r = rows.find((x) => x.id === id)
    if (!r) throw new Error('找不到这张付款申请')
    if (payStage(r) !== 'fill') throw new Error('这张已经提交过了')
    if (!(r.amountCny > 0)) throw new Error('付款金额是 0 —— 先把没定价的金额补上')
    r.submittedAt = nowIso
    await write(rows)
  })
}

/** 商务审核通过 —— 转到老板那一步。 */
export async function reviewPayRequest(id: string, by: string, nowIso: string): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const r = rows.find((x) => x.id === id)
    if (!r) throw new Error('找不到这张付款申请')
    if (payStage(r) !== 'review') throw new Error('这张申请已经不在审核这一步了，刷新看看')
    r.reviewedBy = by
    r.reviewedAt = nowIso
    await write(rows)
  })
}

/**
 * 老板批 —— 落一张应付单到财务, 申请上记着是哪一张。老板在审核那一步直接批
 * 也行 (他就是最后拍板的人), 审核那一格记成他。
 */
export async function approvePayRequest(
  id: string,
  by: string,
  nowIso: string,
  todayYmd: string,
): Promise<{ payableNo: string }> {
  return withLock(async () => {
    const rows = await read()
    const r = rows.find((x) => x.id === id)
    if (!r) throw new Error('找不到这张付款申请')
    const st = payStage(r)
    if (st === 'done') throw new Error('这张申请已经批过了')
    if (st === 'rejected') throw new Error('这张申请已经驳回了')
    if (st === 'fill') throw new Error('这张还没填好提交')
    if (!(r.amountCny > 0)) throw new Error('付款清单合计是 0，批不了')
    const payable = await createRequestPayable({
      payee: r.payee,
      amountCny: r.amountCny,
      recon: r.recon,
      request: { id: r.id, no: r.no, dept: r.dept, category: r.category, subject: r.subject },
      approvedBy: by,
      nowIso,
      todayYmd,
    })
    if (!r.reviewedAt) {
      r.reviewedBy = by
      r.reviewedAt = nowIso
    }
    r.approvedBy = by
    r.approvedAt = nowIso
    r.payableId = payable.id
    r.payableNo = payable.no
    await write(rows)
    return { payableNo: payable.no }
  })
}

export async function rejectPayRequest(
  id: string,
  by: string,
  note: string | undefined,
  nowIso: string,
): Promise<void> {
  await withLock(async () => {
    const rows = await read()
    const r = rows.find((x) => x.id === id)
    if (!r) throw new Error('找不到这张付款申请')
    const st = payStage(r)
    if (st === 'done' || st === 'rejected') throw new Error('这张申请已经有结果了')
    r.rejectedBy = by
    r.rejectedAt = nowIso
    r.rejectNote = note?.trim() || undefined
    await write(rows)
  })
}

/** 删一张 —— 只删还没批下来的 (批了的已经是财务的一笔账)。 */
export async function deletePayRequest(id: string): Promise<void> {
  const gone = await withLock(async () => {
    const rows = await read()
    const r = rows.find((x) => x.id === id)
    if (!r) return undefined
    if (payStage(r) === 'done') throw new Error('已经转到财务的申请删不了')
    await write(rows.filter((x) => x.id !== id))
    return r
  })
  for (const f of [...(gone?.vouchers ?? []), ...(gone?.invoices ?? [])]) {
    const key = storageKeyFromUrl(f.url)
    if (key) await supabase.storage.from(STORAGE_BUCKET).remove([key]).catch(() => undefined)
  }
}

const FILE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'heic', 'pdf'] as const

export function isAllowedPayFileName(fileName: string): boolean {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  return !!m && (FILE_EXTS as readonly string[]).includes(m[1])
}

function fileExt(fileName: string, contentType: string): string {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  if (m && (FILE_EXTS as readonly string[]).includes(m[1])) return m[1]
  if (contentType === 'application/pdf') return 'pdf'
  if (contentType === 'image/png') return 'png'
  if (contentType === 'image/webp') return 'webp'
  return 'jpg'
}

/** 挂一张凭证 / 发票。发票常常是付了钱才开, 所以批下来以后也能补。 */
export async function addPayRequestFile(input: {
  id: string
  kind: PayFileKind
  buf: ArrayBuffer
  fileName: string
  contentType: string
  by: string
}): Promise<VoucherFile> {
  const safe = input.id.replace(/[^a-zA-Z0-9._-]/g, '_')
  const fid = crypto.randomUUID()
  const key = `finance/pay-requests/${safe}/${fid}.${fileExt(input.fileName, input.contentType)}`
  const up = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, Buffer.from(input.buf), {
      contentType: input.contentType || 'application/octet-stream',
      upsert: false,
    })
  if (up.error) throw up.error
  const file: VoucherFile = {
    id: fid,
    url: proxiedKeyUrl(key),
    filename: input.fileName,
    filesize: input.buf.byteLength,
    contentType: input.contentType || undefined,
    uploadedBy: input.by,
    createdAt: new Date().toISOString(),
  }
  await withLock(async () => {
    const rows = await read()
    const r = rows.find((x) => x.id === input.id)
    if (!r) throw new Error('找不到这张付款申请')
    if (input.kind === 'voucher') r.vouchers.push(file)
    else r.invoices.push(file)
    await write(rows)
  })
  return file
}

/** 删一张附件 —— 批下来以前才能删, 批了的那几张就是这笔钱的依据。 */
export async function deletePayRequestFile(
  id: string,
  kind: PayFileKind,
  fileId: string,
): Promise<void> {
  const target = await withLock(async () => {
    const rows = await read()
    const r = rows.find((x) => x.id === id)
    if (!r) return undefined
    if (payStage(r) === 'done') throw new Error('已经转到财务了，附件不能删')
    const list = kind === 'voucher' ? r.vouchers : r.invoices
    const hit = list.find((f) => f.id === fileId)
    if (!hit) return undefined
    if (kind === 'voucher') r.vouchers = list.filter((f) => f.id !== fileId)
    else r.invoices = list.filter((f) => f.id !== fileId)
    await write(rows)
    return hit
  })
  const key = target ? storageKeyFromUrl(target.url) : undefined
  if (key) await supabase.storage.from(STORAGE_BUCKET).remove([key]).catch(() => undefined)
}
