import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl, storageKeyFromUrl } from './storage-url'
import {
  isCommStage,
  isCommTopic,
  type CommEntry,
  type CommPhoto,
  type CommSheet,
  type CommTopic,
} from './comm-sheet'

// 沟通确认单的存放处 —— 一张工单一份 JSON, 跟 图纸清单 / 退货流转单 一个路
// 子: 没有 migration 要人去应用。按工单分文件 (不是全厂一份), 因为读它的时
// 机永远是"打开某一张工单", 一次只要一份。

function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function keyFor(jobId: string): string {
  return `${safeId(jobId)}/comm-sheet.json`
}

function str(v: unknown, max = 2000): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function photoList(v: unknown): CommPhoto[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: CommPhoto[] = []
  for (const x of v as unknown[]) {
    if (typeof x !== 'object' || x === null) continue
    const r = x as Record<string, unknown>
    if (typeof r.id !== 'string' || typeof r.url !== 'string') continue
    out.push({
      id: r.id,
      url: r.url,
      filename: str(r.filename, 200) || '图片',
      uploadedBy: str(r.uploadedBy, 40) || undefined,
      createdAt: str(r.createdAt, 40),
    })
  }
  return out.length > 0 ? out : undefined
}

function entry(v: unknown): CommEntry {
  if (typeof v !== 'object' || v === null) return {}
  const r = v as Record<string, unknown>
  return {
    ask: str(r.ask) || undefined,
    ours: str(r.ours) || undefined,
    agreed: str(r.agreed) || undefined,
    photos: photoList(r.photos),
  }
}

function normalize(raw: unknown, jobId: string): CommSheet {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >
  const items: Partial<Record<CommTopic, CommEntry>> = {}
  const rawItems =
    typeof r.items === 'object' && r.items !== null
      ? (r.items as Record<string, unknown>)
      : {}
  for (const [k, v] of Object.entries(rawItems)) {
    if (!isCommTopic(k)) continue
    items[k] = entry(v)
  }
  return {
    jobId,
    projectName: str(r.projectName, 200) || undefined,
    customerContact: str(r.customerContact, 80) || undefined,
    ourContact: str(r.ourContact, 80) || undefined,
    talkedAt: /^\d{4}-\d{2}-\d{2}$/.test(str(r.talkedAt, 10))
      ? str(r.talkedAt, 10)
      : undefined,
    stage: isCommStage(r.stage) ? r.stage : undefined,
    items,
    by: str(r.by, 40) || undefined,
    updatedAt: str(r.updatedAt, 40) || undefined,
  }
}

export async function getCommSheet(jobId: string): Promise<CommSheet | undefined> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(keyFor(jobId))
  if (error || !data) return undefined
  try {
    return normalize(JSON.parse(await data.text()), jobId)
  } catch {
    return undefined
  }
}

/** 能改的那几样 —— 抬头四格 + 阶段 + 某一项里的某一格。 */
export type CommSheetPatch = {
  projectName?: string
  customerContact?: string
  ourContact?: string
  talkedAt?: string
  stage?: string
  topic?: { key: CommTopic; field: 'ask' | 'ours' | 'agreed'; text: string }
}

export async function saveCommSheet(
  jobId: string,
  patch: CommSheetPatch,
  by: string,
  nowIso: string,
): Promise<CommSheet> {
  const cur = (await getCommSheet(jobId)) ?? { jobId, items: {} }
  if (patch.projectName !== undefined)
    cur.projectName = str(patch.projectName, 200) || undefined
  if (patch.customerContact !== undefined)
    cur.customerContact = str(patch.customerContact, 80) || undefined
  if (patch.ourContact !== undefined)
    cur.ourContact = str(patch.ourContact, 80) || undefined
  if (patch.talkedAt !== undefined)
    cur.talkedAt = /^\d{4}-\d{2}-\d{2}$/.test(patch.talkedAt)
      ? patch.talkedAt
      : undefined
  if (patch.stage !== undefined)
    cur.stage = isCommStage(patch.stage) ? patch.stage : undefined
  if (patch.topic) {
    const { key, field, text } = patch.topic
    const e = { ...(cur.items[key] ?? {}) }
    e[field] = str(text) || undefined
    cur.items[key] = e
  }
  cur.by = by
  cur.updatedAt = nowIso
  await write(jobId, cur)
  return cur
}

async function write(jobId: string, sheet: CommSheet): Promise<void> {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(keyFor(jobId), Buffer.from(JSON.stringify(sheet), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) throw error
}

// 图片本体进 storage, 一条元数据进这张单的 JSON。Blob 直接转交, 不在内存里
// 再拷一份 —— 全厂跑在一个 Node 进程上, 一张大图穿过它, 所有人都要跟着卡。
export async function addCommPhoto(input: {
  jobId: string
  topic: CommTopic
  body: Blob
  fileName: string
  contentType: string
  uploadedBy?: string
  nowIso: string
}): Promise<{ sheet: CommSheet; photo: CommPhoto }> {
  const { jobId, topic } = input
  const id = crypto.randomUUID()
  const m = input.fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
  const ext = m ? m[1] : 'png'
  const key = `${safeId(jobId)}/comm/${topic}-${id}.${ext}`
  const upR = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, input.body, {
      contentType: input.contentType || 'application/octet-stream',
      upsert: false,
    })
  if (upR.error) throw upR.error

  const photo: CommPhoto = {
    id,
    url: proxiedKeyUrl(key),
    filename: input.fileName,
    uploadedBy: input.uploadedBy,
    createdAt: input.nowIso,
  }
  const cur = (await getCommSheet(jobId)) ?? { jobId, items: {} }
  const e = { ...(cur.items[topic] ?? {}) }
  e.photos = [...(e.photos ?? []), photo]
  cur.items[topic] = e
  cur.by = input.uploadedBy
  cur.updatedAt = input.nowIso
  await write(jobId, cur)
  return { sheet: cur, photo }
}

export async function deleteCommPhoto(
  jobId: string,
  topic: CommTopic,
  photoId: string,
): Promise<CommSheet | undefined> {
  const cur = await getCommSheet(jobId)
  if (!cur) return undefined
  const e = cur.items[topic]
  const target = e?.photos?.find((p) => p.id === photoId)
  if (!e || !target) return cur
  const rest = (e.photos ?? []).filter((p) => p.id !== photoId)
  cur.items[topic] = { ...e, photos: rest.length > 0 ? rest : undefined }
  await write(jobId, cur)
  // 单是准, 文件是次 —— 删不掉的孤儿文件没人看得见, 无害。
  const key = storageKeyFromUrl(target.url)
  if (key) {
    try {
      await supabase.storage.from(STORAGE_BUCKET).remove([key])
    } catch {
      // 见上
    }
  }
  return cur
}
