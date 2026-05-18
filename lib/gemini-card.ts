import 'server-only'
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai'
import { STAGES, type Stage } from './data'

/*
 * Gemini 3.1 Pro — 工艺卡 generator (multi-component).
 * SDK @google/genai v1.50.x. 1M-token context, native PDF + image input.
 *
 * Output shape: one card per identified component. Gemini decides the
 * component split purely by reading the uploaded files (drawings, 3D screenshots,
 * quotes, notes) — the job's xlsx-derived parts list is intentionally NOT fed
 * in, so the card reflects what the drawings actually say to make.
 */

const MODEL = 'gemini-3.1-pro-preview'

const SYSTEM = `你是越侬模型（杭州手板厂）的资深工艺师。

读用户上传的图纸、3D 截图、报价单、客户备注。识别这一批文件里实际要做的零件，为每个零件单独写一份工艺卡，覆盖八个工段。

工段：工程 编程 操机 手工 打磨 喷漆丝印 质量 出货

"喷漆丝印" 是合并工段：同时覆盖喷涂和丝网印刷两道工序——底/面漆参数、丝印图案、套色顺序、温度都写在同一段里。

每段 3-6 条要点，只写工段头干活时真正用得到的信息：材料、装夹/取向、关键尺寸或公差、表面参数（粒度、温度、底/面漆层数）、易错点、客户特殊要求。不适用的工段把 applies 设为 false，keyPoints 留空。

risks 字段记录图纸冲突、温度/材料风险、不确定的尺寸或备注。

文风：老师傅写在料盒便条上的口吻——短、准、白话，能直接贴给工人看。用清晰中文。不解释概念，不写废话。

零件名按图纸/截图里写的来。summary 是这一批文件的一句话总览，每个 component 的 summary 是这件零件的一句话要点（可省）。`

const STAGE_ENUM = [...STAGES] as string[]

const STATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    stage: { type: Type.STRING, enum: STAGE_ENUM },
    applies: { type: Type.BOOLEAN },
    keyPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
    risks: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      nullable: true,
    },
  },
  required: ['stage', 'applies', 'keyPoints'],
  propertyOrdering: ['stage', 'applies', 'keyPoints', 'risks'],
}

const COMPONENT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    summary: { type: Type.STRING, nullable: true },
    stations: {
      type: Type.ARRAY,
      items: STATION_SCHEMA,
    },
  },
  required: ['name', 'stations'],
  propertyOrdering: ['name', 'summary', 'stations'],
}

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    components: {
      type: Type.ARRAY,
      items: COMPONENT_SCHEMA,
    },
  },
  required: ['summary', 'components'],
  propertyOrdering: ['summary', 'components'],
}

export type StationCard = {
  stage: Stage
  applies: boolean
  keyPoints: string[]
  risks?: string[]
}

export type ComponentCard = {
  name: string
  summary?: string
  stations: StationCard[]
}

export type ProcessCard = {
  summary: string
  components: ComponentCard[]
}

export type SourceFile = {
  mimeType: string
  data: string // base64
  name: string
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

export async function generateProcessCard(
  files: SourceFile[],
): Promise<ProcessCard> {
  const ai = client()

  const parts: Array<
    | { text: string }
    | { inlineData: { mimeType: string; data: string } }
  > = []

  for (const f of files) {
    parts.push({ inlineData: { mimeType: f.mimeType, data: f.data } })
  }

  parts.push({
    text: '基于以上文件，识别零件并按 schema 为每个零件输出工艺卡。',
  })

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction: SYSTEM,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
      temperature: 1.0,
      thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
    },
  })

  const text = response.text
  if (!text) throw new Error('Gemini returned empty response')

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(
      `Gemini returned non-JSON output: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return normalizeCard(parsed)
}

// Coerce arbitrary input into the canonical ProcessCard shape.
// Handles both the new {summary, components[]} schema and the legacy
// {summary, stations[]} single-card shape so old DB rows still render.
export function normalizeCard(input: unknown): ProcessCard {
  if (!input || typeof input !== 'object') {
    return { summary: '', components: [] }
  }
  const raw = input as {
    summary?: unknown
    components?: unknown
    stations?: unknown
  }
  const summary = typeof raw.summary === 'string' ? raw.summary : ''

  // Legacy single-card row — wrap into a one-component card.
  if (!Array.isArray(raw.components) && Array.isArray(raw.stations)) {
    const stations = normalizeStations(raw.stations)
    return {
      summary,
      components: [{ name: '工艺卡', stations }],
    }
  }

  const incoming = Array.isArray(raw.components) ? raw.components : []
  const components: ComponentCard[] = []
  for (const c of incoming) {
    if (!c || typeof c !== 'object') continue
    const obj = c as {
      name?: unknown
      summary?: unknown
      stations?: unknown
    }
    const name = typeof obj.name === 'string' ? obj.name.trim() : ''
    if (!name) continue
    const compSummary =
      typeof obj.summary === 'string' && obj.summary.trim().length > 0
        ? obj.summary.trim()
        : undefined
    const stations = normalizeStations(obj.stations)
    components.push({ name, summary: compSummary, stations })
  }

  return { summary, components }
}

function normalizeStations(input: unknown): StationCard[] {
  const byStage = new Map<Stage, StationCard>()
  if (Array.isArray(input)) {
    for (const s of input) {
      if (!s || typeof s !== 'object') continue
      const obj = s as {
        stage?: unknown
        applies?: unknown
        keyPoints?: unknown
        risks?: unknown
      }
      if (typeof obj.stage !== 'string') continue
      if (!STAGES.includes(obj.stage as Stage)) continue
      const stage = obj.stage as Stage
      const keyPoints = Array.isArray(obj.keyPoints)
        ? obj.keyPoints
            .filter((p): p is string => typeof p === 'string')
            .map((p) => p.trim())
            .filter((p) => p.length > 0)
        : []
      const risksRaw = Array.isArray(obj.risks)
        ? obj.risks
            .filter((p): p is string => typeof p === 'string')
            .map((p) => p.trim())
            .filter((p) => p.length > 0)
        : []
      byStage.set(stage, {
        stage,
        applies: Boolean(obj.applies),
        keyPoints,
        risks: risksRaw.length > 0 ? risksRaw : undefined,
      })
    }
  }
  return STAGES.map(
    (stage) =>
      byStage.get(stage) ?? {
        stage,
        applies: false,
        keyPoints: [],
      },
  )
}

export const PROCESS_CARD_MODEL = MODEL
