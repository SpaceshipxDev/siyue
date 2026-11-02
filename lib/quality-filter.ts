// 质量模块各张表的表头筛选 (于海伟 2026-11-02: 全部都增加筛选功能) —— 跟
// 「质量异常」那张一样 (lib/defect-filter): 每一列点开列出这个月出现过的值,
// 选一个只看那些; 几列叠着筛。页面和导出走同一套, 导出的就是屏幕上那一批。
//
// 纯函数 + 每张表的列定义 —— 客户端和服务端共用 (行的类型只是 import type)。

import type { ProcessDefect } from './process-defects'
import type { ScrapRecord } from './scrap'
import type { IncomingDefect } from './incoming-defects'
import type { Complaint } from './complaints'
import type { ChangeRecord } from './changes'
import type { Improvement } from './improvements'

export type ColSpec<T> = { key: string; label: string; get: (r: T) => string }
export type ColFilters = Record<string, string>

/** 空的记成「(空)」, 也能筛出来 —— 比如"还没填责任人的"。 */
export function cellText(v: string | undefined | null): string {
  return (v ?? '').trim() || '(空)'
}

/** 措施这种长文字只分「已定 / 待定」。 */
function settled(v: string | undefined | null): string {
  return (v ?? '').trim() ? '已定' : '待定'
}

const day = (d: string) => d.slice(5, 10) || '(空)'

export function matchCols<T>(r: T, specs: ColSpec<T>[], filters: ColFilters, skip?: string): boolean {
  for (const s of specs) {
    if (s.key === skip) continue
    const want = filters[s.key]
    if (want && s.get(r) !== want) return false
  }
  return true
}

/** 导出链接上带的参数: f.owner=…&f.reason=… */
export function colFilterParams(filters: ColFilters): string {
  return Object.entries(filters)
    .filter(([, v]) => v)
    .map(([k, v]) => `&f.${k}=${encodeURIComponent(v)}`)
    .join('')
}

export function colFiltersFrom(sp: URLSearchParams): ColFilters {
  const out: ColFilters = {}
  for (const [k, v] of sp.entries()) if (k.startsWith('f.') && v) out[k.slice(2)] = v
  return out
}

export const PROCESS_COLS: ColSpec<ProcessDefect>[] = [
  { key: 'date', label: '日期', get: (r) => day(r.date) },
  { key: 'jobNo', label: '工单号', get: (r) => cellText(r.jobNo) },
  { key: 'reason', label: '不良原因', get: (r) => cellText(r.reason) },
  { key: 'handling', label: '处理方式', get: (r) => cellText(r.handling) },
  { key: 'owner', label: '直接责任', get: (r) => cellText(r.owner) },
  { key: 'coOwner', label: '间接责任', get: (r) => cellText(r.coOwner) },
  { key: 'action', label: '纠正预防措施', get: (r) => settled(r.action) },
  { key: 'by', label: '记录人', get: (r) => cellText(r.by) },
]

export const SCRAP_COLS: ColSpec<ScrapRecord>[] = [
  { key: 'date', label: '日期', get: (r) => day(r.date) },
  { key: 'jobNo', label: '工单号', get: (r) => cellText(r.jobNo) },
  { key: 'reason', label: '报废原因', get: (r) => cellText(r.reason) },
  { key: 'source', label: '来源', get: (r) => cellText(r.source) },
  { key: 'dept', label: '责任部门', get: (r) => cellText(r.dept) },
  { key: 'owner', label: '责任人', get: (r) => cellText(r.owner) },
  { key: 'action', label: '纠正预防措施', get: (r) => settled(r.action) },
  { key: 'by', label: '填写人', get: (r) => cellText(r.by) },
]

export const INCOMING_COLS: ColSpec<IncomingDefect>[] = [
  { key: 'date', label: '日期', get: (r) => day(r.date) },
  { key: 'docNo', label: '单号', get: (r) => cellText(r.docNo) },
  { key: 'supplier', label: '供应商', get: (r) => cellText(r.supplier) },
  { key: 'item', label: '品名', get: (r) => cellText(r.item) },
  { key: 'reason', label: '不良原因', get: (r) => cellText(r.reason) },
  { key: 'handling', label: '处理方式', get: (r) => cellText(r.handling) },
  { key: 'owner', label: '责任人', get: (r) => cellText(r.owner) },
  { key: 'by', label: '记录人', get: (r) => cellText(r.by) },
]

export const COMPLAINT_COLS: ColSpec<Complaint>[] = [
  { key: 'date', label: '日期', get: (r) => day(r.date) },
  { key: 'customer', label: '客户', get: (r) => cellText(r.customer) },
  { key: 'jobNo', label: '工号', get: (r) => cellText(r.jobNo) },
  { key: 'reason', label: '不良原因', get: (r) => cellText(r.reason) },
  { key: 'outflow', label: '流出原因', get: (r) => cellText(r.outflowReason) },
  { key: 'handling', label: '处理方式', get: (r) => cellText(r.handling) },
  { key: 'owner', label: '责任人', get: (r) => cellText(r.owner) },
  { key: 'action', label: '纠正预防措施', get: (r) => settled(r.action) },
]

export const CHANGE_COLS: ColSpec<ChangeRecord>[] = [
  { key: 'date', label: '变更日期', get: (r) => day(r.date) },
  { key: 'customer', label: '客户', get: (r) => cellText(r.customer) },
  { key: 'jobNo', label: '工号', get: (r) => cellText(r.jobNo) },
  { key: 'dept', label: '发起部门', get: (r) => cellText(r.dept) },
  { key: 'by', label: '记录人', get: (r) => cellText(r.by) },
]

export const IMPROVEMENT_COLS: ColSpec<Improvement>[] = [
  { key: 'reporter', label: '提报人', get: (r) => cellText(r.reporter) },
  { key: 'dept', label: '部门', get: (r) => cellText(r.dept) },
]
