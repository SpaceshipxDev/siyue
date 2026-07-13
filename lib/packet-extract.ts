import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai'
import sharp from 'sharp'
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
//
// Three stages, each verified against real floor photos (IMG_7317/7300):
//   1. orientation — floor photos are routinely shot sideways; the models
//      misread 标题栏 names and handwritten digits on rotated pages, so we
//      detect glyph direction and physically rotate the pixels first.
//   2. main extract — one structured call over the upright pages.
//   3. stamp zoom — the handwritten 数量 (e.g. a cramped 2736) is illegible
//      at full-sheet scale for every Gemini tier; a padded crop of the blue
//      stamp re-read at 2x, forced to transcribe ALL handwriting first,
//      reads it reliably. Its qty/dueDate override the main pass.

// flash-lite is the proven vision model on both the API-key and Vertex
// endpoints; 'gemini-3.1-flash' 404s on the API-key endpoint and only wastes
// seconds before the fallback fires, so it is deliberately NOT in the chain.
const VISION_MODELS = [
  process.env.GEMINI_VISION_MODEL,
  'gemini-3.1-flash-lite',
].filter((m): m is string => Boolean(m))

// Orientation needs a stronger eye: flash-lite answers rotation questions
// confidently wrong (calibrated on 0/90/180/270 copies of a real drawing);
// 3.5-flash at LOW thinking got all four right, stable across reruns.
const ORIENT_MODEL = process.env.GEMINI_ORIENT_MODEL ?? 'gemini-3.5-flash'

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

// NOTE: the field instructions deliberately contain NO realistic example
// part names or quantities — earlier prompts' examples ("清洁棒调整块", a
// sample qty) leaked verbatim into extraction results on hard photos.
function buildSystem(): string {
  return `你是CNC加工厂的工单录入助手。用户上传的是同一个零件加工资料袋的照片：一张盖了蓝色印章的2D图纸，和一张或多张《CNC程序单》。照片可能有皱褶，桌面上可能露出其他纸张的边角——只提取占据画面主体的那份资料。

从所有照片综合提取一个零件的信息：

- partNo (货号): 客户货号，字母+数字编码。常见于图纸或程序单表头。找不到留 null。
- name (零件名称/描述): 一定优先取2D图纸标题栏（右下角表格）里的零件名称。名称必须逐字精确抄写：中文零件名往往由多个词组成，先逐个汉字辨认再拼出全名；多字名称容易被漏读成更短的名称，输出前对照标题栏逐字核对一遍，禁止漏字、换字或简写。CNC程序单表头的"零件编号"只是编程内部代号，只有完全没有图纸时才用它。
- drawingNo (图纸号): 图纸标题栏的图号 / 程序单的"模具编号"，一串以点分隔的编码，逐字符抄写。程序单上若带版本后缀（如 -VA.1）一并保留；图纸标题栏"版本号"是单独的格子，不要拼进图号。
- qty (数量): 生产数量。以图纸上蓝色印章/手写的"数量"为准。程序单表头的"数量"通常是编程批量（常常是1），不是生产数量，不要用它。都找不到时用 1。
- dueDate (交期): 以蓝色印章/手写的"交货期"为准，例如 "7-1" 表示7月1日。输出 YYYY-MM-DD，年份取距离今天最近的那一年——交期可能是几周前（已逾期的单子），不要因此推到明年。今日是 ${today()}。找不到留 null。
- material (材质): 以图纸标题栏"材质"栏为准；只要牌号本身，不带 GB 标准号。
- customer (客户): 如果任何页面出现客户公司名就提取，否则 null。
- opCount (CNC加工次数总数): 数一下有几个不同的"第N次加工"（每张CNC程序单表头"加工次数"字段）。没有程序单照片时为 1。
- pages: 逐张照片判断类型：工程2D图纸 kind="drawing"；《CNC程序单》表格 kind="program"（并给出 opNo = 第N次加工的N）；机床、车间、屏幕等其他照片 kind="other"。图纸页如有蓝色印章（质量要求/下料尺寸/数量/交货期 表格），stampBox 输出其边界框 [ymin, xmin, ymax, xmax]（0-1000 归一化），否则 null。index 从0开始，与照片顺序一致。
- notes: 手写的其他要点（如先加工件数、下料/材料尺寸等），照原样抄写，没有留 null。

规则：不要捏造。被划掉的字迹不算数，取未划掉的。手写字迹优先于打印字段（印章是这次生产的真实指令）。只输出结构化 JSON。`
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
          stampBox: {
            type: Type.ARRAY,
            items: { type: Type.INTEGER },
            nullable: true,
          },
        },
        required: ['index', 'kind'],
        propertyOrdering: ['index', 'kind', 'opNo', 'stampBox'],
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

type WireImage = { mimeType: string; data: string }

// === Stage 1: orientation ===
//
// Floor photos are shot with the phone in whatever grip is free; the baked
// pixels are routinely 90° off. Rotated pages are where 标题栏 names and
// handwritten digits get misread, so we straighten pixels before extraction.
//
// "How many degrees is this rotated" is answered unreliably even by strong
// models; "which edge do the character tops point at" calibrated perfectly
// (0/90/180/270 copies of a real drawing, stable across reruns). Empirical
// mapping verified against those copies: tops at left → sharp.rotate(-90),
// right → 90, bottom → 180.
const TEXT_UP_ROTATION: Record<string, number> = {
  top: 0,
  none: 0,
  left: -90,
  right: 90,
  bottom: 180,
}

const ORIENT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    textUp: {
      type: Type.ARRAY,
      items: { type: Type.STRING, enum: ['top', 'right', 'bottom', 'left', 'none'] },
    },
  },
  required: ['textUp'],
}

async function detectRotations(images: WireImage[]): Promise<number[]> {
  const ai = client()
  // Thumbnails are enough to judge glyph direction and keep the call fast.
  const thumbs = await Promise.all(
    images.map(async (img) => {
      const buf = await sharp(Buffer.from(img.data, 'base64'))
        .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer()
      return buf.toString('base64')
    }),
  )
  const response = await ai.models.generateContent({
    model: ORIENT_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `共 ${thumbs.length} 张照片，多数是文件/图纸的照片，可能拍歪了90/180/270度。对每张判断：照片中印刷文字的"头顶"方向指向照片的哪一条边？（正着可读=top，字头朝右边=right，倒立=bottom，字头朝左边=left，无文字=none）。textUp 数组按照片顺序输出。`,
          },
          ...thumbs.map((data) => ({ inlineData: { mimeType: 'image/jpeg', data } })),
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: ORIENT_SCHEMA,
      temperature: 0,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    },
  })
  const parsed = JSON.parse(response.text ?? '{}') as { textUp?: string[] }
  return images.map((_, i) => TEXT_UP_ROTATION[parsed.textUp?.[i] ?? 'top'] ?? 0)
}

async function normalizeOrientation(images: WireImage[]): Promise<WireImage[]> {
  try {
    const t0 = Date.now()
    const rotations = await detectRotations(images)
    const out = await Promise.all(
      images.map(async (img, i) => {
        const deg = rotations[i]
        if (!deg) return img
        const buf = await sharp(Buffer.from(img.data, 'base64'))
          .rotate(deg)
          .jpeg({ quality: 88 })
          .toBuffer()
        return { mimeType: 'image/jpeg', data: buf.toString('base64') }
      }),
    )
    console.log('[packet-extract] orient', {
      ms: Date.now() - t0,
      rotations,
    })
    return out
  } catch (err) {
    // Best-effort: a failed orientation pass degrades accuracy, not liveness.
    console.error('[packet-extract] orient failed', err)
    return images
  }
}

// === Stage 3: stamp zoom ===
//
// The handwritten 数量 in the blue stamp defeats every Gemini tier at full
// sheet scale (a cramped ｢7｣ under red scribbles reads as one digit less —
// wrong by 10x). Two things fix it, both required: a 2x zoom crop of the
// stamp, and forcing the model to transcribe ALL non-crossed-out handwriting
// before answering — the nearby 下料/光板 blank-count note then anchors the
// digit count. Verified 3/3 stable on the failing sheet.
const STAMP_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    handwritten: { type: Type.ARRAY, items: { type: Type.STRING } },
    blankCount: { type: Type.INTEGER, nullable: true },
    qtyDigits: { type: Type.STRING, nullable: true },
    qty: { type: Type.INTEGER, nullable: true },
    dueDate: { type: Type.STRING, nullable: true },
  },
  required: ['handwritten'],
  propertyOrdering: ['handwritten', 'blankCount', 'qtyDigits', 'qty', 'dueDate'],
}

// Feeding the main pass's notes in as an anchor was tried and REMOVED: when
// the full-sheet pass misreads the blank count ("2740件" → "274件"), the bad
// anchor actively flips a correct crop reading to a wrong one. Reading the
// blank count from the crop's own pixels (blankCount) votes 3/3 correct.
function stampSystem(): string {
  return `这是2D图纸上蓝色印章区域的放大特写（含周边手写字）。分两步：

第一步 handwritten：把照片里所有未被划掉的手写内容逐条照抄出来（黑笔和红笔都要，划掉的不要），包括印章格子里的和图纸空白处的。红笔写的"N件"里，"件"字前面的一串数字要逐位数清——最后一位数字可能与"件"字挨得很近，别漏。blankCount = 该件数整数，没有则 null。

第二步：从中得出印章"数量"和"交货期"。
- qtyDigits/qty: 印章"数量"栏的手写数字，逐位辨认，每位空格隔开。连笔的"7"常被漏读成少一位。件数备注=生产数量+几件备品，两者位数一定相同：若数量与 blankCount 差一个数量级，说明其中一个漏了一位，都重读一遍再定。
- dueDate: 交货期，例如手写 "7-1" 表示7月1日。输出 YYYY-MM-DD，年份取距离今天最近的那一年——交期可能是几周前，不要因此推到明年。今日是 ${today()}。
看不清输出 null，不要猜。`
}

// Crop geometries for the ensemble. A single read flips between right and
// wrong on borderline glyphs depending on exact crop bounds/scale, so we
// read three differently-framed crops in parallel and take the majority.
const STAMP_CROPS: { pad: number; scale: number }[] = [
  { pad: 140, scale: 3 },
  { pad: 280, scale: 2 },
  { pad: 140, scale: 4 },
]

async function readStampOnce(
  cropB64: string,
): Promise<{ qty?: number; dueDate?: string }> {
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
              { text: stampSystem() },
              { inlineData: { mimeType: 'image/jpeg', data: cropB64 } },
            ],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: STAMP_SCHEMA,
          temperature: 0,
          thinkingConfig: { thinkingBudget: 0 },
        },
      })
      const parsed = JSON.parse(response.text ?? '{}') as {
        qty?: number | null
        dueDate?: string | null
      }
      const qty =
        parsed.qty != null && Number.isFinite(parsed.qty) && parsed.qty >= 1
          ? Math.min(1_000_000, Math.floor(parsed.qty))
          : undefined
      const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(parsed.dueDate ?? '')
        ? (parsed.dueDate as string)
        : undefined
      return { qty, dueDate }
    } catch (err) {
      lastErr = err
    }
  }
  console.error('[packet-extract] stamp read failed', lastErr)
  return {}
}

function majority<T>(values: (T | undefined)[]): T | undefined {
  const counts = new Map<T, number>()
  for (const v of values) {
    if (v == null) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  let best: T | undefined
  let bestCount = 0
  for (const [v, n] of counts) {
    if (n > bestCount) {
      best = v
      bestCount = n
    }
  }
  // Require agreement: a lone reading among three disagreeing crops is a
  // coin flip, not a signal — fall back to the main pass instead.
  return bestCount >= 2 ? best : undefined
}

async function readStampCrop(
  image: WireImage,
  box: number[],
): Promise<{ qty?: number; dueDate?: string }> {
  const source = Buffer.from(image.data, 'base64')
  const meta = await sharp(source).metadata()
  const W = meta.width ?? 0
  const H = meta.height ?? 0
  if (!W || !H) return {}
  const [ymin, xmin, ymax, xmax] = box

  const crops = await Promise.all(
    STAMP_CROPS.map(async ({ pad, scale }) => {
      // Padding pulls in nearby handwritten notes (blank counts live outside
      // the stamp), which the digit-count cross-check depends on.
      const x1 = Math.max(0, Math.round(((xmin - pad) / 1000) * W))
      const x2 = Math.min(W, Math.round(((xmax + pad) / 1000) * W))
      const y1 = Math.max(0, Math.round(((ymin - pad) / 1000) * H))
      const y2 = Math.min(H, Math.round(((ymax + pad) / 1000) * H))
      if (x2 - x1 < 40 || y2 - y1 < 40) return null
      const buf = await sharp(source)
        .extract({ left: x1, top: y1, width: x2 - x1, height: y2 - y1 })
        .resize({ width: Math.round((x2 - x1) * scale) })
        .jpeg({ quality: 90 })
        .toBuffer()
      return buf.toString('base64')
    }),
  )

  const reads = await Promise.all(
    crops
      .filter((c): c is string => c != null)
      .map((crop) => readStampOnce(crop)),
  )
  if (reads.length === 0) return {}
  return {
    qty: majority(reads.map((r) => r.qty)),
    dueDate: majority(reads.map((r) => r.dueDate)),
  }
}

// === Stage 2 + assembly ===

export async function extractPacket(
  rawImages: WireImage[],
): Promise<PacketExtract> {
  const images = await normalizeOrientation(rawImages)
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
      const t0 = Date.now()
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
        pages: {
          index: number
          kind: string
          opNo?: number | null
          stampBox?: number[] | null
        }[]
      }
      console.log('[packet-extract] main', { model, ms: Date.now() - t0 })
      let qty = Math.max(1, Math.floor(Number(parsed.qty) || 1))
      let dueDate = clean(parsed.dueDate)
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

      // Stage 3: re-read the handwritten stamp fields at 2x zoom. The stamp
      // is the ground truth for qty/交货期 and the main pass misreads its
      // digits; the zoom result wins whenever it is confident (non-null).
      const stampPage = (parsed.pages ?? []).find(
        (p) =>
          p.kind === 'drawing' &&
          Array.isArray(p.stampBox) &&
          p.stampBox.length === 4 &&
          p.stampBox.every((n) => Number.isFinite(n)),
      )
      if (stampPage && images[stampPage.index]) {
        const t1 = Date.now()
        const stamp = await readStampCrop(
          images[stampPage.index],
          stampPage.stampBox as number[],
        )
        console.log('[packet-extract] stamp', {
          ms: Date.now() - t1,
          box: stampPage.stampBox,
          qty: stamp.qty ?? null,
          dueDate: stamp.dueDate ?? null,
        })
        if (stamp.qty != null) qty = stamp.qty
        if (stamp.dueDate) dueDate = stamp.dueDate
      }

      return {
        partNo: clean(parsed.partNo),
        name: clean(parsed.name) ?? '未识别零件',
        drawingNo: clean(parsed.drawingNo),
        qty,
        dueDate,
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
