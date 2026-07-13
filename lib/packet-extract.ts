import { GoogleGenAI, Type } from '@google/genai'
import { today } from './today'

// Photo-packet extraction — the programmer snaps every page of a printed
// order packet (2D drawing with the blue stamp + one CNC程序单 per 加工次数)
// and Gemini turns the pile into one structured component.
//
// Separate from lib/gemini.ts (xlsx extraction) because the inputs and the
// field rules are different: here the ground truth is the BLUE STAMP on the
// drawing (手写数量/交货期 for THIS production run), not the title block —
// the CNC sheet's printed 数量 is usually the programming batch (often 1),
// never the order quantity.

// flash-lite is the proven vision model on both the API-key and Vertex
// endpoints; 'gemini-3.1-flash' 404s on the API-key endpoint and only wastes
// seconds before the fallback fires, so it is deliberately NOT in the chain.
const VISION_MODELS = [
  process.env.GEMINI_VISION_MODEL,
  'gemini-3.1-flash-lite',
].filter((m): m is string => Boolean(m))

let cached: GoogleGenAI | null = null
function client(): GoogleGenAI {
  if (cached) return cached
  // API key first (local dev, simplest), Vertex ADC as the prod alternative.
  const apiKey = process.env.GEMINI_API_KEY
  if (apiKey) {
    cached = new GoogleGenAI({ apiKey })
    return cached
  }
  const project = process.env.GOOGLE_CLOUD_PROJECT
  if (!project) throw new Error('GEMINI_API_KEY or GOOGLE_CLOUD_PROJECT must be set')
  cached = new GoogleGenAI({
    vertexai: true,
    project,
    location: process.env.GOOGLE_CLOUD_LOCATION ?? 'global',
  })
  return cached
}

export type PacketPageInfo = {
  /** 0-based index into the uploaded photo array. */
  index: number
  kind: 'drawing' | 'program' | 'other'
  /** For program pages: the N of 第N次加工; null when absent/illegible. */
  opNo?: number
}

export type PacketExtract = {
  partNo?: string
  name: string
  drawingNo?: string
  qty: number
  dueDate?: string
  material?: string
  customer?: string
  opCount: number
  pages: PacketPageInfo[]
  notes?: string
}

function buildSystem(): string {
  return `你是CNC加工厂的工单录入助手。用户上传的是同一个零件加工资料袋的照片：一张盖了蓝色印章的2D图纸，和一张或多张《CNC程序单》。

从所有照片综合提取一个零件的信息：

- partNo (货号): 客户货号，形如 "ZRY0056484"。常见于图纸或程序单表头。找不到留 null。
- name (零件名称/描述): 一定优先取2D图纸右下角标题栏里的零件名称（如 "清洁棒调整块"）；CNC程序单表头的"零件编号"（如 "A板"）往往只是编程内部代号，只有在图纸上找不到名称时才用它。
- drawingNo (图纸号): 图纸标题栏的图号 / 程序单的"模具编号"，形如 "BSZ4255.04.01.01.09.021"，若带版本后缀（如 -VA.1）一并保留。
- qty (数量): 生产数量。以图纸上蓝色印章/手写的"数量"为准（例如手写 346）。程序单表头的"数量"通常是编程批量（常常是1），不是生产数量，不要用它。都找不到时用 1。
- dueDate (交期): 以蓝色印章/手写的"交货期"为准，例如 "7-1" 表示7月1日。输出 YYYY-MM-DD，年份取距离今天最近的那一年——交期可能是几周前（已逾期的单子），不要因此推到明年。今日是 ${today()}。找不到留 null。
- material (材质): 如 "45#"、"4Cr13"、"6061"。
- customer (客户): 如果任何页面出现客户公司名就提取，否则 null。
- opCount (CNC加工次数总数): 数一下有几个不同的"第N次加工"（每张CNC程序单表头"加工次数"字段，如 "第1次加工"、"第2次加工"）。没有程序单照片时为 1。
- pages: 逐张照片判断类型：图纸页 kind="drawing"；CNC程序单 kind="program"（并给出 opNo = 第N次加工的N）；其他 kind="other"。index 从0开始，与照片顺序一致。
- notes: 手写的其他要点（如 "先加工2件"、材料尺寸等），没有留 null。

规则：不要捏造。手写字迹优先于打印字段（印章是这次生产的真实指令）。只输出结构化 JSON。`
}

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    partNo: { type: Type.STRING, nullable: true },
    name: { type: Type.STRING },
    drawingNo: { type: Type.STRING, nullable: true },
    qty: { type: Type.INTEGER },
    dueDate: { type: Type.STRING, nullable: true },
    material: { type: Type.STRING, nullable: true },
    customer: { type: Type.STRING, nullable: true },
    opCount: { type: Type.INTEGER },
    notes: { type: Type.STRING, nullable: true },
    pages: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          index: { type: Type.INTEGER },
          kind: { type: Type.STRING, enum: ['drawing', 'program', 'other'] },
          opNo: { type: Type.INTEGER, nullable: true },
        },
        required: ['index', 'kind'],
        propertyOrdering: ['index', 'kind', 'opNo'],
      },
    },
  },
  required: ['name', 'qty', 'opCount', 'pages'],
  propertyOrdering: [
    'partNo',
    'name',
    'drawingNo',
    'qty',
    'dueDate',
    'material',
    'customer',
    'opCount',
    'notes',
    'pages',
  ],
}

function clean(s: string | null | undefined): string | undefined {
  if (s == null) return undefined
  const t = String(s).trim()
  return t.length > 0 ? t : undefined
}

export async function extractPacket(
  images: { mimeType: string; data: string }[],
): Promise<PacketExtract> {
  const ai = client()
  const contents = [
    {
      role: 'user',
      parts: [
        {
          text: `这是同一个资料袋的 ${images.length} 张照片，按顺序编号 0..${images.length - 1}。`,
        },
        ...images.map((img) => ({
          inlineData: { mimeType: img.mimeType, data: img.data },
        })),
      ],
    },
  ]

  let lastErr: unknown
  for (const model of VISION_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: buildSystem(),
          responseMimeType: 'application/json',
          responseSchema: SCHEMA,
          temperature: 0.1,
        },
      })
      const text = response.text
      if (!text) throw new Error('Gemini returned empty response')
      const parsed = JSON.parse(text) as {
        partNo?: string | null
        name: string
        drawingNo?: string | null
        qty: number
        dueDate?: string | null
        material?: string | null
        customer?: string | null
        opCount: number
        notes?: string | null
        pages: { index: number; kind: string; opNo?: number | null }[]
      }
      const qty = Math.max(1, Math.floor(Number(parsed.qty) || 1))
      const opCount = Math.max(1, Math.min(6, Math.floor(Number(parsed.opCount) || 1)))
      const pages: PacketPageInfo[] = images.map((_, i) => {
        const p = (parsed.pages ?? []).find((x) => x.index === i)
        const kind =
          p?.kind === 'drawing' || p?.kind === 'program' || p?.kind === 'other'
            ? p.kind
            : 'other'
        return {
          index: i,
          kind,
          opNo:
            p?.opNo != null && Number.isFinite(p.opNo) && p.opNo > 0
              ? Math.floor(p.opNo)
              : undefined,
        }
      })
      return {
        partNo: clean(parsed.partNo),
        name: clean(parsed.name) ?? '未识别零件',
        drawingNo: clean(parsed.drawingNo),
        qty,
        dueDate: clean(parsed.dueDate),
        material: clean(parsed.material),
        customer: clean(parsed.customer),
        opCount,
        pages,
        notes: clean(parsed.notes),
      }
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

// Worker-side fallback OCR — when the matcher service is down or unsure, one
// cheap vision call reads the identity fields off the photographed page and
// we look the part up by 图纸号/货号 instead. Slower than the matcher but
// keeps the floor loop alive.
export type PhotoIdRead = {
  kind: 'drawing' | 'program' | 'other'
  partNo?: string
  drawingNo?: string
  qty?: number
}

const ID_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    kind: { type: Type.STRING, enum: ['drawing', 'program', 'other'] },
    partNo: { type: Type.STRING, nullable: true },
    drawingNo: { type: Type.STRING, nullable: true },
    qty: { type: Type.INTEGER, nullable: true },
  },
  required: ['kind'],
  propertyOrdering: ['kind', 'partNo', 'drawingNo', 'qty'],
}

export async function readPhotoIdentity(image: {
  mimeType: string
  data: string
}): Promise<PhotoIdRead> {
  const ai = client()
  let lastErr: unknown
  for (const model of VISION_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: '这是车间里一张纸张的照片。先判断 kind：工程2D图纸为 drawing，《CNC程序单》为 program，其他为 other。然后只从2D图纸提取 partNo(货号，如 ZRY0056484)、drawingNo(图纸号，如 BSZ4255.04.01.01.09.021，带版本后缀则保留)、qty(蓝色印章手写数量)。如果 kind 不是 drawing，其他字段全部留 null。不要猜。',
              },
              { inlineData: { mimeType: image.mimeType, data: image.data } },
            ],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: ID_SCHEMA,
          temperature: 0,
        },
      })
      const text = response.text
      if (!text) throw new Error('empty')
      const parsed = JSON.parse(text) as {
        kind?: string
        partNo?: string | null
        drawingNo?: string | null
        qty?: number | null
      }
      return {
        kind:
          parsed.kind === 'drawing' || parsed.kind === 'program'
            ? parsed.kind
            : 'other',
        partNo: clean(parsed.partNo),
        drawingNo: clean(parsed.drawingNo),
        qty:
          parsed.qty != null && Number.isFinite(parsed.qty)
            ? Math.floor(parsed.qty)
            : undefined,
      }
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
