// 出厂检验报告 (factory outgoing QC report) domain — pure types + constants
// shared by the editable print page, the PDF render, and lib/db. Modeled
// field-for-field on the shop's standard QR0707-004 Excel template:
// dimension rows with tolerances → 实测 → 判定, other-process checks,
// product performance, appearance (色差 ⊿E≤1.5 + defects), packaging,
// disposition, final verdict, signatures.

export type DimVerdict = 'OK' | 'NG' | 'Marginal' | ''

export type DimRow = {
  label: string // 位置 (线性尺寸1 …)
  nominal: string // 标准值
  unit: string // 单位
  tolUp: string // 上公差
  tolDown: string // 下公差
  measured: string // 实测数值
  verdict: DimVerdict // 判定
  gauge: string // 使用量具
}

export function emptyDimRow(i: number): DimRow {
  return {
    label: `线性尺寸${i}`,
    nominal: '',
    unit: 'mm',
    tolUp: '',
    tolDown: '',
    measured: '',
    verdict: '',
    gauge: '',
  }
}

// 上限/下限 derived from 标准值 ± 公差 — display only, never stored.
export function dimLimit(nominal: string, tol: string): string {
  const n = Number(nominal)
  const t = Number(tol)
  if (!nominal.trim() || !Number.isFinite(n) || !Number.isFinite(t)) return ''
  const v = n + t
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

// 其他工序检查 — the template's fixed checklist.
export const PROCESS_CHECKS = [
  '氧化',
  '钝化',
  '电镀',
  '电泳',
  '背胶',
  '贴膜',
  '线割',
  '焊接',
  '攻牙',
  '牙套',
  '抛光',
  '镭雕',
  '喷漆',
  '染色',
] as const

export type Performance = {
  coatingAdhesion: string // 涂层附着力
  silkAlcohol: string // 丝印耐醇性
  silkAdhesion: string // 丝印附着力
  nutGauge: string // 螺母通止规
  other: string // 其他项
}

export type Appearance = {
  colorDiffMeasured: string // 色差实测 (要求 ⊿E≤1.5)
  defects: string // 外观缺陷
  defectDesc: string // 外观不良描述
}

export type Packaging = {
  method: string // 打包方式
  boxAppearance: string // 外箱外观
  boxLabel: string // 外箱标识
  documents: string // 随货文件
}

export type InspectionReport = {
  id: string
  partId: string
  reportNo?: string // QR0707-004 style, editable
  inspectMethod?: string // 检验方法
  dims: DimRow[]
  processChecks: string[] // ticked PROCESS_CHECKS entries
  performance: Performance
  appearance: Appearance
  packaging: Packaging
  disposition?: string // 本批次产品处理方案
  customerPlan?: string // 客户沟通后处理方案
  finalVerdict?: string // 最终判定结果
  evaluation?: string // 评估处理结果
  confirmer?: string // 确认人
  inspector?: string // 质检员
  approver?: string // 审核/批准
  inspectedAt?: string // 检验时间 YYYY-MM-DD
  createdBy?: string
  createdAt?: string
  updatedAt?: string
  updatedBy?: string
}

export const EMPTY_PERFORMANCE: Performance = {
  coatingAdhesion: '',
  silkAlcohol: '',
  silkAdhesion: '',
  nutGauge: '',
  other: '',
}

export const EMPTY_APPEARANCE: Appearance = {
  colorDiffMeasured: '',
  defects: '',
  defectDesc: '',
}

export const EMPTY_PACKAGING: Packaging = {
  method: '',
  boxAppearance: '',
  boxLabel: '',
  documents: '',
}

// A fresh report opens with six dimension rows — enough for most parts, with
// + 添加尺寸 for the rest. (The Excel template ships 18 blank rows; printing
// 12 empty lines on every report is noise.)
export function emptyReport(partId: string): Omit<InspectionReport, 'id'> {
  return {
    partId,
    dims: Array.from({ length: 6 }, (_, i) => emptyDimRow(i + 1)),
    processChecks: [],
    performance: { ...EMPTY_PERFORMANCE },
    appearance: { ...EMPTY_APPEARANCE },
    packaging: { ...EMPTY_PACKAGING },
  }
}

// The wire patch — the editor commits the whole document (one inspector,
// one report; last write wins is fine at this scale).
export type InspectionReportPatch = {
  reportNo?: string | null
  inspectMethod?: string | null
  dims?: DimRow[]
  processChecks?: string[]
  performance?: Performance
  appearance?: Appearance
  packaging?: Packaging
  disposition?: string | null
  customerPlan?: string | null
  finalVerdict?: string | null
  evaluation?: string | null
  confirmer?: string | null
  inspector?: string | null
  approver?: string | null
  inspectedAt?: string | null
}

export function isDimVerdict(x: unknown): x is DimVerdict {
  return x === 'OK' || x === 'NG' || x === 'Marginal' || x === ''
}

export function isDimRow(x: unknown): x is DimRow {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  for (const f of ['label', 'nominal', 'unit', 'tolUp', 'tolDown', 'measured', 'gauge']) {
    if (typeof o[f] !== 'string') return false
  }
  return isDimVerdict(o.verdict)
}
