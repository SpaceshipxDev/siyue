import 'server-only'
import { supabase } from './supabase'
import { workSplitKey } from './work-split'

/*
 * 拆件 · 加刀 —— 一个零件下面挂的 1.1、1.2 那几行。
 *
 * 零件行下面点 + 插进来的行, 序号自动编成 1.1 / 1.2 (lib/db insertComponentAfter),
 * 原零件是 01。这些子行一般没有自己的单价, 经手金额原来是拿订单金额摊的
 * (0087), 摊多摊少跟它做了多少活没关系。商务定的规矩:
 *
 *   拆件 —— 一个零件拆成几件做: 原零件那一道的经手金额 (5%), 由原零件和它的
 *           拆件平分 (只在走这一道的那几行里分)。
 *   加刀 —— 名字里带「加刀」的子行: 拿原零件那一道经手金额的 15%。
 *           客供件的加刀除外 (原零件或加刀行材料写着客供) —— 照原来的算。
 *
 * 下面没挂子行的零件一分不动, 照原来的算。
 *
 * 只改报工统计读出来的金额, 不动任何数据。
 */

export type FamilyValue = {
  /** 这一行、这一道完成一次 (整行件数) 的经手金额。 */
  valueCny: number
  allocated: boolean
  unpriced: boolean
}

type AnyRow = Record<string, unknown>

const TTL_MS = 30_000
let jobsCache: { at: number; ids: Set<string> } | null = null
const valuesCache = new Map<string, { at: number; map: Map<string, FamilyValue> }>()

/** 挂了子行 (1.1 这种序号) 的工单。半分钟读一次。 */
export async function getFamilyJobIds(): Promise<Set<string>> {
  if (jobsCache && Date.now() - jobsCache.at < TTL_MS) return jobsCache.ids
  const ids = new Set<string>()
  for (let from = 0; from < 50_000; from += 1000) {
    const r = await supabase
      .from('parts')
      .select('job_id')
      .like('seq_label', '%.%')
      .range(from, from + 999)
    if (r.error) return ids
    const rows = (r.data ?? []) as AnyRow[]
    for (const row of rows) if (row.job_id) ids.add(row.job_id as string)
    if (rows.length < 1000) break
  }
  jobsCache = { at: Date.now(), ids }
  return ids
}

function partIdSeq(id: string): number {
  const m = /:p(\d+)$/.exec(id)
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}

// 01 和 1 是同一个号。
function norm(label: string): string {
  return /^\d+$/.test(label) ? String(Number(label)) : label
}

function isSub(label: string): boolean {
  return /^[^.]+(\.\d+)+$/.test(label)
}

async function inChunks(ids: string[], size: number, run: (chunk: string[]) => Promise<AnyRow[]>) {
  const out: AnyRow[] = []
  for (let i = 0; i < ids.length; i += size) out.push(...(await run(ids.slice(i, i + size))))
  return out
}

/**
 * 这几张工单里, 金额要改的那几行 —— 键是 workSplitKey(partId, stage)。不在里面的
 * 照原来的算。
 */
export async function getFamilyValues(jobIds: string[]): Promise<Map<string, FamilyValue>> {
  const out = new Map<string, FamilyValue>()
  const want = [...new Set(jobIds)].sort()
  if (want.length === 0) return out
  const cacheKey = want.join(',')
  const hit = valuesCache.get(cacheKey)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.map

  const parts = await inChunks(want, 20, async (chunk) => {
    const r = await supabase
      .from('parts')
      .select('id, job_id, position, seq_label, name, material, qty, unit_price_cny, line_total_cny')
      .in('job_id', chunk)
    if (r.error) throw r.error
    return (r.data ?? []) as AnyRow[]
  })

  type Fam = { parent: AnyRow; chai: AnyRow[]; jia: AnyRow[] }
  const fams: Fam[] = []
  const byJob = new Map<string, AnyRow[]>()
  for (const p of parts) {
    const j = p.job_id as string
    if (!byJob.has(j)) byJob.set(j, [])
    byJob.get(j)!.push(p)
  }
  for (const rows of byJob.values()) {
    const ordered = [...rows].sort(
      (a, b) =>
        Number(a.position ?? 0) - Number(b.position ?? 0) ||
        partIdSeq(a.id as string) - partIdSeq(b.id as string),
    )
    const shown = ordered.map(
      (p, i) => ((p.seq_label as string | null) ?? String(i + 1).padStart(2, '0')).trim(),
    )
    const parents = new Map<string, Fam>()
    ordered.forEach((p, i) => {
      if (!isSub(shown[i])) parents.set(norm(shown[i]), { parent: p, chai: [], jia: [] })
    })
    ordered.forEach((p, i) => {
      if (!isSub(shown[i])) return
      const fam = parents.get(norm(shown[i].split('.')[0]))
      if (!fam) return
      const name = String(p.name ?? '')
      if (name.includes('加刀')) {
        const kegong = [fam.parent.material, p.material].some((m) => String(m ?? '').includes('客供'))
        if (!kegong) fam.jia.push(p)
      } else fam.chai.push(p)
    })
    for (const f of parents.values()) if (f.chai.length > 0 || f.jia.length > 0) fams.push(f)
  }
  if (fams.length === 0) {
    valuesCache.set(cacheKey, { at: Date.now(), map: out })
    return out
  }

  // 每一行走哪几道。
  const memberIds = fams.flatMap((f) => [f.parent, ...f.chai, ...f.jia].map((p) => p.id as string))
  const stageRows = await inChunks(memberIds, 50, async (chunk) => {
    const r = await supabase.from('part_stages').select('part_id, stage').in('part_id', chunk)
    if (r.error) throw r.error
    return (r.data ?? []) as AnyRow[]
  })
  const route = new Map<string, Set<string>>()
  for (const s of stageRows) {
    const id = s.part_id as string
    if (!route.has(id)) route.set(id, new Set())
    route.get(id)!.add(s.stage as string)
  }

  // 原零件一道的经手金额 —— 先拿它报工记录上的 (跟统计里原来算的是同一个数,
  // 摊分也在里面); 一条都还没有, 就按它自己的单价 × 5%。
  const parentIds = fams.map((f) => f.parent.id as string)
  const evRows = await inChunks(parentIds, 30, async (chunk) => {
    const r = await supabase
      .from('worker_stage_events')
      .select('part_id, part_qty, value_cny, is_allocated, is_unpriced')
      .in('part_id', chunk)
      .limit(1000)
    if (r.error) throw r.error
    return (r.data ?? []) as AnyRow[]
  })
  const parentValue = new Map<string, FamilyValue>()
  for (const e of evRows) {
    const id = e.part_id as string
    if (parentValue.has(id)) continue
    parentValue.set(id, {
      valueCny: Number(e.value_cny ?? 0),
      allocated: Boolean(e.is_allocated),
      unpriced: Boolean(e.is_unpriced),
    })
  }
  for (const f of fams) {
    const id = f.parent.id as string
    if (parentValue.has(id)) continue
    const qty = Number(f.parent.qty ?? 0)
    const line =
      f.parent.line_total_cny != null
        ? Number(f.parent.line_total_cny)
        : f.parent.unit_price_cny != null
          ? Number(f.parent.unit_price_cny) * qty
          : null
    if (line != null && Number.isFinite(line) && line > 0) {
      parentValue.set(id, { valueCny: line * 0.05, allocated: false, unpriced: false })
    }
  }

  for (const f of fams) {
    const v = parentValue.get(f.parent.id as string)
    // 原零件自己都算不出钱 —— 没东西可分, 照原来的算。
    if (!v || v.valueCny <= 0) continue
    if (f.chai.length > 0) {
      const group = [f.parent, ...f.chai]
      const stages = new Set(group.flatMap((p) => [...(route.get(p.id as string) ?? [])]))
      for (const st of stages) {
        const members = group.filter((p) => route.get(p.id as string)?.has(st))
        for (const p of members) {
          out.set(workSplitKey(p.id as string, st), {
            ...v,
            valueCny: v.valueCny / members.length,
          })
        }
      }
    }
    for (const p of f.jia) {
      for (const st of route.get(p.id as string) ?? []) {
        out.set(workSplitKey(p.id as string, st), { ...v, valueCny: v.valueCny * 0.15 })
      }
    }
  }
  valuesCache.set(cacheKey, { at: Date.now(), map: out })
  if (valuesCache.size > 200) valuesCache.clear()
  return out
}

/**
 * 读出来的报工记录 (worker_stage_events 的行) 就地换上拆件 · 加刀的金额。行里要
 * 有 job_id / part_id / stage; 没挂子行的工单一行都不碰。返回换过的那几行原来
 * 的金额 (统计要拿差额去调整)。
 */
export async function applyFamilyValues(rows: AnyRow[]): Promise<Map<AnyRow, number>> {
  const changed = new Map<AnyRow, number>()
  if (rows.length === 0) return changed
  const famJobs = await getFamilyJobIds()
  if (famJobs.size === 0) return changed
  const jobIds = [...new Set(rows.map((r) => r.job_id as string).filter((j) => j && famJobs.has(j)))]
  if (jobIds.length === 0) return changed
  const values = await getFamilyValues(jobIds)
  if (values.size === 0) return changed
  for (const row of rows) {
    const v = values.get(workSplitKey(row.part_id as string, row.stage as string))
    if (!v) continue
    changed.set(row, Number(row.value_cny ?? 0))
    row.value_cny = Math.round(v.valueCny * 100) / 100
    row.is_allocated = v.allocated
    row.is_unpriced = v.unpriced
  }
  return changed
}
