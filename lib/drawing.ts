import { partRef } from './data'

/*
 * 零件图纸 — 编程员打开系统, 要看的第一样东西。
 *
 * 在这之前, 系统里关于一个零件只有一张缩略图和一排工序格子。图看得见形状,
 * 看不见尺寸、公差、基准; 工序告诉你这件走哪几站, 不告诉你怎么做。编程员于
 * 是回头去翻微信、翻邮件、翻共享盘里那个叫"最终版(3)"的文件夹 —— 那正是这
 * 个产品要消灭的那种沟通。
 *
 * 所以图纸是零件的一等公民: 挂在零件上 (不是挂在工单上), 谁都能下载 (编程
 * 员是生产账号, 一旦按"钱"那一档去挡, 他就又看不见了), 谁传的、哪天传的写
 * 在旁边。
 *
 * 纯类型 ⇒ 两端都能 import。读写在 lib/drawing-file.ts。
 */

export type DrawingFile = {
  id: string
  /** 哪张工单 —— componentId 只在工单内唯一 (p1/p2/p3), 单独拿它认不出零件。 */
  jobId: string
  /** 挂在哪个零件上 (配合 jobId 才是一个零件, 见 lib/data 的 partRef) */
  componentId: string
  url: string
  filename: string
  filesize?: number
  contentType?: string
  uploadedBy?: string
  createdAt: string
}

// 编程要用的图, 不只是 PDF: 三维模型 (step/igs/x_t/sldprt) 才是刀路的输入,
// 二维 (dwg/dxf/pdf) 是尺寸和公差的来源, 两样都得能传。压缩包留着, 客户常常
// 一次发一整包。
export const DRAWING_EXTS = [
  'pdf',
  'dwg',
  'dxf',
  'step',
  'stp',
  'igs',
  'iges',
  'x_t',
  'x_b',
  'sldprt',
  'sldasm',
  'prt',
  'stl',
  'zip',
  'rar',
  '7z',
  'png',
  'jpg',
  'jpeg',
  'webp',
] as const

export type DrawingExt = (typeof DRAWING_EXTS)[number]

export function isAllowedDrawingName(fileName: string): boolean {
  const m = fileName.toLowerCase().match(/\.([a-z0-9_]+)$/)
  return !!m && (DRAWING_EXTS as readonly string[]).includes(m[1])
}

/** 三维模型 —— 编程真正要的那一份, 在列表里点出来。 */
const MODEL_EXTS = new Set([
  'step',
  'stp',
  'igs',
  'iges',
  'x_t',
  'x_b',
  'sldprt',
  'sldasm',
  'prt',
  'stl',
])

export function drawingKind(filename: string): '三维' | '二维' | '' {
  const m = filename.toLowerCase().match(/\.([a-z0-9_]+)$/)
  const ext = m ? m[1] : ''
  if (MODEL_EXTS.has(ext)) return '三维'
  if (ext === 'pdf' || ext === 'dwg' || ext === 'dxf') return '二维'
  return ''
}

export function formatFileSize(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 按零件归集。键是 partRef (工单 + 零件), 不是 componentId —— 编程台上摆的是
 * 几十张工单的图纸, 只按 componentId 归会把每张工单的 p1 全堆到一块。
 */
export function drawingsByPart(rows: DrawingFile[]): Map<string, DrawingFile[]> {
  const by = new Map<string, DrawingFile[]>()
  for (const d of rows) {
    const k = partRef(d.jobId, d.componentId)
    const arr = by.get(k) ?? []
    arr.push(d)
    by.set(k, arr)
  }
  // 新传的在前 —— 图纸变更之后, 最后一版才是要照着做的那一版。
  for (const [k, arr] of by) {
    by.set(
      k,
      arr.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
    )
  }
  return by
}
