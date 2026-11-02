// 质量异常那张表的表头筛选 (于海伟 2026-11-02) —— 每一列点开列出这个月出现过的
// 值, 选一个只看那些; 几列叠着筛, 跟 Excel 的筛选一样。页面和导出走同一套,
// 导出的就是屏幕上那一批。
//
// 纯函数 —— 客户端和服务端共用。

import type { DefectRow } from './db'

export type DefectCol =
  | 'date'
  | 'jobNo'
  | 'part'
  | 'stage'
  | 'verdict'
  | 'reason'
  | 'owner'
  | 'action'
  | 'by'

export const DEFECT_COLS: readonly DefectCol[] = [
  'date',
  'jobNo',
  'part',
  'stage',
  'verdict',
  'reason',
  'owner',
  'action',
  'by',
]

export const DEFECT_COL_LABEL: Record<DefectCol, string> = {
  date: '日期',
  jobNo: '工号',
  part: '零件',
  stage: '环节',
  verdict: '判定',
  reason: '不良原因',
  owner: '责任人',
  action: '纠正预防措施',
  by: '判定人',
}

export type DefectFilters = Partial<Record<DefectCol, string>>

/** 这一行在这一列上算哪个值 —— 空的记成「(空)」, 措施只分「已定 / 待定」。 */
export function defectCell(r: DefectRow, col: DefectCol, actions: Record<string, string>): string {
  const v = (s: string | undefined | null) => (s ?? '').trim() || '(空)'
  switch (col) {
    case 'date':
      return (r.at ?? '').slice(5, 10) || '(空)'
    case 'jobNo':
      return v(r.jobNo)
    case 'part':
      return v(r.partName)
    case 'stage':
      return r.stage === '质量' ? '成品检' : '检验'
    case 'verdict':
      return v(r.verdict)
    case 'reason':
      return v(r.reason)
    case 'owner':
      return v(r.owner)
    case 'action':
      return actions[`${r.partId}::${r.stage}`]?.trim() ? '已定' : '待定'
    case 'by':
      return v(r.by)
  }
}

export function matchDefectFilters(
  r: DefectRow,
  filters: DefectFilters,
  actions: Record<string, string>,
  skip?: DefectCol,
): boolean {
  for (const col of DEFECT_COLS) {
    if (col === skip) continue
    const want = filters[col]
    if (want && defectCell(r, col, actions) !== want) return false
  }
  return true
}

/** 导出链接上带的参数: f.part=…&f.owner=… */
export function defectFilterParams(filters: DefectFilters): string {
  return DEFECT_COLS.filter((c) => filters[c])
    .map((c) => `&f.${c}=${encodeURIComponent(filters[c]!)}`)
    .join('')
}

export function defectFiltersFrom(sp: URLSearchParams): DefectFilters {
  const out: DefectFilters = {}
  for (const c of DEFECT_COLS) {
    const v = sp.get(`f.${c}`)
    if (v) out[c] = v
  }
  return out
}
