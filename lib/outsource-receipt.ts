import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl, storageKeyFromUrl } from './storage-url'
import type { VoucherFile } from './data'

/*
 * 外协收货确认单 —— 外协件回厂之后, 客户那边签收的那张纸, 拍一张挂在订单
 * 上 (于海伟 2026-10-16)。一张订单分几次外协, 确认单是按订单、按客户签的,
 * 所以挂在工单上, 这张单的每一张外协单点开都看得到同一组图。
 *
 * TABLE-FREE, 跟 请购图 / 应收单 一个路子, 没有 migration:
 *   outsource/receipts/<jobId>/<uuid>.<ext>   图本身
 *   outsource/receipts.json                    { [jobId]: VoucherFile[] }
 * 一份清单而不是一单一份: 外协台一打开就要知道哪些单已经有确认单 (回厂那
 * 一格上标着), 一次读一个文件, 不用几百单各跑一趟。
 *
 * 读-改-写走一把进程内的锁 (生产是单个 pm2 进程), 两个人同时传不会互相盖掉。
 */

const KEY = 'outsource/receipts.json'

const ALLOWED_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'heic'] as const

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export function isAllowedReceiptName(fileName: string): boolean {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  return !!m && (ALLOWED_EXTS as readonly string[]).includes(m[1])
}

function extFor(fileName: string, contentType: string): string {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  if (m && (ALLOWED_EXTS as readonly string[]).includes(m[1])) return m[1]
  if (contentType === 'image/png') return 'png'
  if (contentType === 'image/webp') return 'webp'
  return 'jpg'
}

type Index = Record<string, VoucherFile[]>

async function read(): Promise<Index> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return {}
  try {
    const raw = JSON.parse(await data.text())
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const out: Index = {}
    for (const [jobId, list] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(list) && list.length > 0) out[jobId] = list as VoucherFile[]
    }
    return out
  } catch {
    return {}
  }
}

async function write(index: Index): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(KEY, Buffer.from(JSON.stringify(index), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

/** 每张订单的收货确认单, 先传的在前。读不到就是一张都没有。 */
export async function getOutsourceReceipts(): Promise<Index> {
  return read()
}

export async function addOutsourceReceipt(input: {
  jobId: string
  buf: ArrayBuffer
  fileName: string
  contentType: string
  uploadedBy?: string
}): Promise<VoucherFile> {
  const id = crypto.randomUUID()
  const key = `outsource/receipts/${safeId(input.jobId)}/${id}.${extFor(input.fileName, input.contentType)}`
  const up = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, Buffer.from(input.buf), {
      contentType: input.contentType || 'application/octet-stream',
      upsert: false,
    })
  if (up.error) throw up.error
  const row: VoucherFile = {
    id,
    url: proxiedKeyUrl(key),
    filename: input.fileName,
    filesize: input.buf.byteLength,
    contentType: input.contentType || undefined,
    uploadedBy: input.uploadedBy,
    createdAt: new Date().toISOString(),
  }
  await withLock(async () => {
    const index = await read()
    index[input.jobId] = [...(index[input.jobId] ?? []), row]
    await write(index)
  })
  return row
}

// 清单先改 (它说了算), 图本身尽力删 —— 删不掉的孤图不碍事。
export async function deleteOutsourceReceipt(jobId: string, id: string): Promise<void> {
  const target = await withLock(async () => {
    const index = await read()
    const list = index[jobId] ?? []
    const hit = list.find((r) => r.id === id)
    if (!hit) return undefined
    const rest = list.filter((r) => r.id !== id)
    if (rest.length > 0) index[jobId] = rest
    else delete index[jobId]
    await write(index)
    return hit
  })
  const key = target ? storageKeyFromUrl(target.url) : undefined
  if (key) {
    try {
      await supabase.storage.from(STORAGE_BUCKET).remove([key])
    } catch {
      // 孤图 —— 不碍事。
    }
  }
}
