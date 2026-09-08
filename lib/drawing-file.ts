import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'
import { proxiedKeyUrl, storageKeyFromUrl } from './storage-url'
import type { DrawingFile } from './drawing'

/*
 * 零件图纸的存放处。跟合同附件一个路子 —— TABLE-FREE, 没有 migration 要人去
 * 应用:
 *   <jobId>/drawings/<uuid>.<ext>      文件本身
 *   <jobId>/drawings/manifest.json     [{id, componentId, filename, …}, …]
 * 清单里记着 storage 存不下的那几样 (原始文件名、挂在哪个零件、谁传的)。一张
 * 工单几十个零件、每个零件一两份图, 一份清单读写绰绰有余。
 */

function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function extFor(fileName: string): string {
  const m = fileName.toLowerCase().match(/\.([a-z0-9_]+)$/)
  return m ? m[1] : 'bin'
}

function manifestKey(jobId: string): string {
  return `${safeId(jobId)}/drawings/manifest.json`
}

async function readManifest(jobId: string): Promise<DrawingFile[]> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(manifestKey(jobId))
  if (error || !data) return []
  try {
    const arr = JSON.parse(await data.text())
    if (!Array.isArray(arr)) return []
    return (arr as DrawingFile[]).filter(
      (r) => r && typeof r.id === 'string' && typeof r.componentId === 'string',
    )
  } catch {
    return []
  }
}

async function writeManifest(jobId: string, rows: DrawingFile[]): Promise<void> {
  const upR = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(manifestKey(jobId), Buffer.from(JSON.stringify(rows), 'utf8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (upR.error) throw upR.error
}

/** 一张工单上的全部图纸。清单不在就是还没传过 —— 返回空, 不报错。 */
export async function getDrawingFiles(jobId: string): Promise<DrawingFile[]> {
  const rows = await readManifest(jobId)
  return rows
    .slice()
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
}

// 文件本体是浏览器传上来的 Blob, 直接转交给 storage —— 不 arrayBuffer() 再
// Buffer.from() 转一道手。一个三十兆的三维模型那样转两次就是六十多兆常驻内
// 存, 而全厂跑在一个 Node 进程上: 传图的那几十秒里, 车间每个人的页面都点不
// 动。那不是"上传慢", 是上传把整台机器顶住了。
export async function addDrawingFile(input: {
  jobId: string
  componentId: string
  body: Blob
  fileName: string
  contentType: string
  uploadedBy?: string
  nowIso: string
}): Promise<DrawingFile> {
  const { jobId } = input
  const id = crypto.randomUUID()
  const key = `${safeId(jobId)}/drawings/${id}.${extFor(input.fileName)}`
  const upR = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(key, input.body, {
      contentType: input.contentType || 'application/octet-stream',
      upsert: false,
    })
  if (upR.error) throw upR.error

  const row: DrawingFile = {
    id,
    componentId: input.componentId,
    url: proxiedKeyUrl(key),
    filename: input.fileName,
    filesize: input.body.size,
    contentType: input.contentType || undefined,
    uploadedBy: input.uploadedBy,
    createdAt: input.nowIso,
  }
  const rows = await readManifest(jobId)
  rows.push(row)
  await writeManifest(jobId, rows)
  return row
}

// 清单是准, 文件是次 —— 先从清单里摘掉, 再尽力删文件。删不掉的孤儿文件没人
// 看得见, 无害。
export async function deleteDrawingFile(
  jobId: string,
  drawingId: string,
): Promise<void> {
  const rows = await readManifest(jobId)
  const target = rows.find((r) => r.id === drawingId)
  if (!target) return
  await writeManifest(
    jobId,
    rows.filter((r) => r.id !== drawingId),
  )
  const key = storageKeyFromUrl(target.url)
  if (key) {
    try {
      await supabase.storage.from(STORAGE_BUCKET).remove([key])
    } catch {
      // Orphan blob — harmless.
    }
  }
}
