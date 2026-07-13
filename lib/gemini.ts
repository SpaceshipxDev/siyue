import { GoogleGenAI, Type } from '@google/genai'
import { today } from './today'
import { BRAND } from './brand'
import type { NewJobInput } from './db'

/** What `extractJobFromXlsx` returns: a NewJobInput plus a per-component
 *  imageRef the caller resolves against the extracted image catalog. The
 *  caller uploads bytes to storage and replaces imageRef with imageUrl
 *  before persisting. NewJobInput itself stays imageRef-free since other
 *  callers (createJob) don't deal with workbook images. */
export type ExtractedJob = Omit<NewJobInput, 'components'> & {
  components: (NewJobInput['components'][number] & { imageRef?: string })[]
}

/*
 * Gemini 3.1 Flash Lite (GA — the -preview model ID was shut down 2026-05-25).
 * Verified for SDK @google/genai v1.50.1.
 *
 * Schema constraints worth knowing:
 *   - Subset of OpenAPI 3.0 / JSON Schema. No oneOf/anyOf/$ref/allOf/recursive.
 *   - `propertyOrdering` materially affects output quality on structured tasks.
 *   - For optional+nullable fields: set `nullable: true` AND omit from `required`.
 *   - thinkingConfig is omitted: Flash Lite does not think by default,
 *     so this is the lowest-latency setting for plain JSON extraction.
 */

const MODEL = 'gemini-3.1-flash-lite'

// Built per request so the "今日是 …" line in the prompt always reflects the
// real local date — not the date the server process started.
function buildSystem(): string {
  return `你是一名工厂订单录入助手，专门处理"${BRAND.legalName}"的报价单和生产单 Excel。

任务：从用户上传的、结构未必规范的 Excel 内容中，抽取一张工单 (Job) 及其零件列表 (parts)。

字段规则：
- jobNo (工号): 优先使用文件名或表内出现的 ${BRAND.code}-XX-X-XX-XXX 格式编号。如果只在文件夹名中出现，也按文件名给出的提示来定。如果都找不到，使用文件名（去掉扩展名）作为工号。
- customer (客户): 通常在"甲方"字段后面，比如"浙江艾罗网络能源技术股份有限公司"。提取公司主名，去掉前缀。
- product (产品): 这批零件的整体名称或主要型号；如无明显单一产品名，用类似"手板报价单"或"手板"或第一个零件名称的简称作为兜底。
- amountCny (金额): 含税总价或合计金额，单位人民币元。如果只能找到分项金额，可求和；找不到留 null。
- dueDate (交期): 格式 YYYY-MM-DD。如果只写"确认后 15 天内完成"等模糊描述，按今日 + 15 天估算。如果完全找不到，留 null。今日是 ${today()}。
- notes (备注): 工单级备注，比如付款方式、特殊要求；零件级别的备注放到对应 part 内。
- engineer (工程师): 客户方对接人的姓名——厂里叫"工程师"，单据上也常写作"联系人"，是同一个人。常见于"工程师"、"项目工程师"、"对接工程师"、"项目负责人"、"联系人"、"对接人"、"跟单"等字段。只输出姓名，去掉职务前缀。找不到留 null。

零件列表 (parts)：每行实际零件占一项，跳过表头/合计/付款方式/验收标准等说明行。
- name (零件名称): 物料名称或零件名称那一列；尽量保留完整描述。
- qty (数量): 整数。如果列里写"31"等纯数字，直接转 int。
- material (材料): 材料/材质列，比如 "ADC12"、"PA66+GF30 135℃ V-0"、"阻燃ABS"。
- surfaceTreatment (表面处理): 表面处理列，比如"喷涂灰色户外粉艾罗色号：C-020-1000，有遮喷要求"、"P-002 云海白"、"黑色"。
- notes (零件备注): 该行的any备注列内容，没有就 null。
- process (加工工艺): 该行的"加工方式"或"工艺要求"列，比如 "机加"、"3D打印"、"打印"、"CNC"。两列都有时合并为 "打印·机加" 这种形式。找不到留 null。
- unitPriceCny (单价): 该行的单价/单价(元)/unit price 列，单位人民币元。找不到留 null。
- lineTotalCny (小计): 该行的小计/金额/合计 列（数量 × 单价的那一列），单位人民币元。如果只列了单价但有数量，可不填，让前端自行计算。两个都没有就 null。

工段路线不由你判断：每个零件默认经过全部九工段，由商务/工程在录入界面手动关闭不需要的工段。不要输出 stages 字段。

通用：
- 不要捏造数据。找不到就用 null 或合理空字符串。
- "<<IMG:imgN>>" 是图片占位符（来自 Excel 中嵌入的图片），不是零件名也不是公式；零件名应取相邻的"物料名称"列。
- 输出只给结构化 JSON，不要解释。

图片字段 (imageRef)：
- 每个零件可能在某一格有 "<<IMG:imgN>>" 占位符（imgN 即图片引用，如 img1、img2）。
- 如果该零件所在的行包含 "<<IMG:imgN>>"，把 imageRef 设为对应的 imgN（例如 "img3"）。
- 如果该零件所在的行没有 "<<IMG:...>>"，imageRef 设为 null。绝对不要瞎猜——找不到就 null。
- imageRef 必须取自下面 "可用图片" 清单中存在的引用；不要发明新的 imgX。`
}

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    jobNo: { type: Type.STRING },
    customer: { type: Type.STRING },
    product: { type: Type.STRING },
    amountCny: { type: Type.NUMBER, nullable: true },
    dueDate: { type: Type.STRING, nullable: true },
    notes: { type: Type.STRING, nullable: true },
    engineer: { type: Type.STRING, nullable: true },
    parts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          qty: { type: Type.INTEGER },
          material: { type: Type.STRING, nullable: true },
          surfaceTreatment: { type: Type.STRING, nullable: true },
          process: { type: Type.STRING, nullable: true },
          notes: { type: Type.STRING, nullable: true },
          unitPriceCny: { type: Type.NUMBER, nullable: true },
          lineTotalCny: { type: Type.NUMBER, nullable: true },
          imageRef: { type: Type.STRING, nullable: true },
        },
        required: ['name', 'qty'],
        propertyOrdering: [
          'name',
          'qty',
          'material',
          'surfaceTreatment',
          'process',
          'notes',
          'unitPriceCny',
          'lineTotalCny',
          'imageRef',
        ],
      },
    },
  },
  required: ['jobNo', 'customer', 'product', 'parts'],
  propertyOrdering: [
    'jobNo',
    'customer',
    'product',
    'amountCny',
    'dueDate',
    'notes',
    'engineer',
    'parts',
  ],
}

type GeminiJobJson = {
  jobNo: string
  customer: string
  product: string
  amountCny?: number | null
  dueDate?: string | null
  notes?: string | null
  engineer?: string | null
  parts: {
    name: string
    qty: number
    material?: string | null
    surfaceTreatment?: string | null
    process?: string | null
    notes?: string | null
    unitPriceCny?: number | null
    lineTotalCny?: number | null
    imageRef?: string | null
  }[]
}

let cached: GoogleGenAI | null = null
function client(): GoogleGenAI {
  const project = process.env.GOOGLE_CLOUD_PROJECT
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT is not set')
  if (!cached)
    cached = new GoogleGenAI({
      vertexai: true,
      project,
      location: process.env.GOOGLE_CLOUD_LOCATION ?? 'global',
    })
  return cached
}

export type ExtractInput = {
  fileName: string
  /** Unstructured xlsx dump produced by /api/parse-xlsx logic. Cells whose
   * source contains a `_xlfn.DISPIMG(...)` formula or sit on a drawing anchor
   * have already been rewritten to `<<IMG:imgN>>` markers by
   * `annotateSheetWithImages`. */
  sheets: {
    name: string
    aoa: (string | number | boolean | null)[][]
  }[]
  /** All image refs available in this workbook. Empty list = no embedded
   * images; the model must return imageRef=null for every part. */
  imageRefs: string[]
}

const FALLBACK_DUE_OFFSET_DAYS = 15

// jobs.due_date is NOT NULL (0001_init.sql) — every ingest path must supply
// a date. Exported so the photo-packet path can apply the same estimate when
// the blue stamp has no legible 交货期.
export function fallbackDueDate(): string {
  const [y, m, d] = today().split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + FALLBACK_DUE_OFFSET_DAYS))
  return t.toISOString().slice(0, 10)
}

function clean(s: string | null | undefined): string | undefined {
  if (s == null) return undefined
  const t = String(s).trim()
  return t.length > 0 ? t : undefined
}

export async function extractJobFromXlsx(input: ExtractInput): Promise<ExtractedJob> {
  const ai = client()

  const imageList =
    input.imageRefs.length > 0
      ? input.imageRefs.map((r) => `- ${r}`).join('\n')
      : '(无)'

  const userPrompt = [
    `文件名: ${input.fileName}`,
    '',
    '可用图片引用 (imageRef 必须从中选取，否则 null):',
    imageList,
    '',
    'Excel 工作表内容（每个工作表为二维数组，按行/列）。',
    '"<<IMG:imgN>>" 表示该单元格在原 Excel 中嵌入了一张图片：',
    JSON.stringify(input.sheets, null, 2),
  ].join('\n')

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: userPrompt,
    config: {
      systemInstruction: buildSystem(),
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
      temperature: 0.1,
    },
  })

  const text = response.text
  if (!text) throw new Error('Gemini returned empty response')

  let parsed: GeminiJobJson
  try {
    parsed = JSON.parse(text) as GeminiJobJson
  } catch (err) {
    throw new Error(
      `Gemini returned non-JSON output: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return {
    jobNo: clean(parsed.jobNo) ?? input.fileName.replace(/\.[^.]+$/, ''),
    customer: clean(parsed.customer) ?? '未识别',
    product: clean(parsed.product) ?? '未识别',
    amountCny:
      typeof parsed.amountCny === 'number' && Number.isFinite(parsed.amountCny)
        ? parsed.amountCny
        : undefined,
    dueDate: clean(parsed.dueDate) ?? fallbackDueDate(),
    notes: clean(parsed.notes),
    engineer: clean(parsed.engineer),
    sourceFile: input.fileName,
    components: (parsed.parts ?? []).map((p) => ({
      name: clean(p.name) ?? '未命名零件',
      qty: Number.isFinite(p.qty) ? Math.max(0, Math.round(p.qty)) : 0,
      material: clean(p.material),
      surfaceTreatment: clean(p.surfaceTreatment),
      process: clean(p.process),
      notes: clean(p.notes),
      unitPriceCny:
        typeof p.unitPriceCny === 'number' && Number.isFinite(p.unitPriceCny)
          ? p.unitPriceCny
          : undefined,
      lineTotalCny:
        typeof p.lineTotalCny === 'number' && Number.isFinite(p.lineTotalCny)
          ? p.lineTotalCny
          : undefined,
      // Image bytes still live in the workbook; the caller looks this ref up
      // against the extracted image catalog and uploads to storage. We pass
      // it through here as a side-channel rather than mutating NewJobInput,
      // since NewJobInput is also reused by createJob.
      imageRef: clean(p.imageRef),
      // Stages are no longer LLM-inferred — let resolvePartStages() seed
      // every part with the full 9-stage route. 商务/工程 prune via chips.
    })),
  }
}
