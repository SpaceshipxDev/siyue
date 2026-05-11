import { NextRequest } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import type { Content } from '@google/genai'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MODEL = 'gemini-3.1-flash-lite-preview'

// Generic Q&A system prompt — the point of this playground is to probe
// what the model can recover from the AoA-as-JSON representation, not to
// run the production ingest extraction. So no domain-specific stage rules.
const SYSTEM = `你是一个帮助用户阅读 Excel 文件的助手。用户上传的 Excel 已被解析为 JSON 二维数组（每个工作表是一个 { name, aoa } 对象，aoa 按行/列）。请基于该 JSON 内容回答用户问题，必要时引用具体行列、单元格内容或数值。如果信息缺失，明确说出"找不到"。回答用中文。`

let cached: GoogleGenAI | null = null
function client() {
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

type Turn = { role: 'user' | 'assistant'; text: string }
type Sheet = { name: string; aoa: (string | number | boolean | null)[][] }
type Doc = { fileName: string; sheets: Sheet[] } | null

type Body = {
  doc: Doc
  history: Turn[]
  message: string
}

function buildDocContext(doc: NonNullable<Doc>): string {
  // Same shape as lib/gemini.ts:174 builds for the production ingest call —
  // so the chat is interrogating the exact representation Gemini sees today.
  return [
    `文件名: ${doc.fileName}`,
    '',
    'Excel 工作表内容（每个工作表为二维数组，按行/列）:',
    JSON.stringify(doc.sheets, null, 2),
  ].join('\n')
}

export async function POST(request: NextRequest) {
  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 })
  }
  if (!body.message?.trim()) {
    return Response.json({ error: 'empty message' }, { status: 400 })
  }

  const ai = client()
  const contents: Content[] = []

  // Document context lives in the very first user turn. Gemini keeps it in
  // its context window for the rest of the conversation; later turns are
  // pure follow-up questions.
  const firstUserIdx = body.history.findIndex((t) => t.role === 'user')
  let attachedDoc = !body.doc
  const docPrefix = body.doc ? buildDocContext(body.doc) + '\n\n---\n\n' : ''

  body.history.forEach((t, i) => {
    if (t.role === 'user') {
      const text = !attachedDoc && i === firstUserIdx ? docPrefix + t.text : t.text
      if (!attachedDoc && i === firstUserIdx) attachedDoc = true
      contents.push({ role: 'user', parts: [{ text }] })
    } else {
      contents.push({ role: 'model', parts: [{ text: t.text }] })
    }
  })

  const newText = !attachedDoc ? docPrefix + body.message : body.message
  contents.push({ role: 'user', parts: [{ text: newText }] })

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: SYSTEM,
        temperature: 0.4,
      },
    })
    return Response.json({
      text: response.text ?? '',
      usage: response.usageMetadata ?? null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: message }, { status: 500 })
  }
}
