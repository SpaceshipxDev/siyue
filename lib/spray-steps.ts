import 'server-only'
import { supabase, STORAGE_BUCKET } from './supabase'

/*
 * 喷漆的两小步 —— 底漆、面漆。
 *
 * 工序还是「喷漆」一道 (生产表、统计、金额都只认它), 只是喷漆的人在这一道
 * 里先点「底漆」完成、再点「面漆」完成; 面漆点完, 喷漆这一道就完成了。报工
 * 统计和金额只在喷漆完成时算一次, 底漆、面漆不另算钱。
 *
 * 只记谁、什么时候点的。按 工单 + 零件 记 (格子上手里就是这两个号, 不用再查)。
 *
 * TABLE-FREE: production/spray-steps.json  { "<jobId>|<componentId>": { 底漆?: {by,at}, 面漆?: {by,at} } }
 */

export const SPRAY_STEPS = ['底漆', '面漆'] as const
export type SprayStep = (typeof SPRAY_STEPS)[number]
export type StepMark = { by: string; at: string }
export type PartSteps = Partial<Record<SprayStep, StepMark>>

const KEY = 'production/spray-steps.json'

let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

export function stepKey(jobId: string, componentId: string): string {
  return `${jobId}|${componentId}`
}

export function isSprayStep(x: unknown): x is SprayStep {
  return x === '底漆' || x === '面漆'
}

async function read(): Promise<Record<string, PartSteps>> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(KEY)
  if (error || !data) return {}
  try {
    const raw = JSON.parse(await data.text()) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const out: Record<string, PartSteps> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null) continue
      const steps: PartSteps = {}
      for (const s of SPRAY_STEPS) {
        const m = (v as Record<string, unknown>)[s] as Record<string, unknown> | undefined
        if (m && typeof m.by === 'string' && typeof m.at === 'string') steps[s] = { by: m.by, at: m.at }
      }
      if (Object.keys(steps).length > 0) out[k] = steps
    }
    return out
  } catch {
    return {}
  }
}

/** 这几张工单的零件各做到哪一步。 */
export async function getSpraySteps(jobIds: string[]): Promise<Record<string, PartSteps>> {
  const want = new Set(jobIds)
  const all = await read()
  return Object.fromEntries(Object.entries(all).filter(([k]) => want.has(k.split('|')[0])))
}

/**
 * 记 / 撤几个零件的几小步。mark 为空 = 撤掉 (退回没做)。
 */
export async function setSpraySteps(
  items: { jobId: string; componentId: string; step: SprayStep }[],
  mark: StepMark | null,
): Promise<void> {
  if (items.length === 0) return
  await withLock(async () => {
    const all = await read()
    for (const it of items) {
      const k = stepKey(it.jobId, it.componentId)
      const cur = { ...(all[k] ?? {}) }
      if (mark) {
        if (!cur[it.step]) cur[it.step] = mark
      } else delete cur[it.step]
      if (Object.keys(cur).length > 0) all[k] = cur
      else delete all[k]
    }
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(KEY, Buffer.from(JSON.stringify(all), 'utf8'), {
        contentType: 'application/json',
        upsert: true,
      })
    if (error) throw error
  })
}
