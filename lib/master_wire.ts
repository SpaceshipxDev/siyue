import { STAGES, type JobStatus, type JobType, type ReturnReason, type Stage } from './data'
import type { MasterActiveReturn, MasterCell, MasterRow } from './master'
import type { OrderMoneyStatus } from './order-money'

type Scope = {
  role: 'commerce' | 'production'
  defaultStage?: Stage
}

type WireValue<T> = T | null

type CompactActiveReturn = [
  id: string,
  dueDate: string,
  reason: ReturnReason,
]

type CompactCell = [
  total: number,
  inHouseDone: number,
  outsourcedClosed: number,
  outsourcedOpen: number,
  inProgress: number,
  pending: number,
  inProgressDoneQtySum: number,
  earliestInProgressAt: WireValue<string>,
  latestFinishedAt: WireValue<string>,
  latestCompletedAt: WireValue<string>,
  latestBy: WireValue<string>,
  hasMinePending: 0 | 1,
  hasUpstreamActive: 0 | 1,
  pinnedAt: WireValue<string>,
]

export type CompactMasterRow = [
  id: string,
  jobNo: string,
  customer: string,
  product: string,
  engineer: WireValue<string>,
  amountCny: WireValue<number>,
  dueDate: string,
  effectiveDueDate: string,
  secondaryDueDate: WireValue<string>,
  notes: WireValue<string>,
  status: JobStatus,
  createdAt: WireValue<string>,
  jobType: WireValue<JobType>,
  isProduct: WireValue<boolean>,
  pausedAt: WireValue<string>,
  pauseReason: WireValue<string>,
  needsOutsource: WireValue<boolean>,
  outsourceNote: WireValue<string>,
  drawingChangeOpen: WireValue<boolean>,
  drawingChangeNote: WireValue<string>,
  pinnedAt: WireValue<string>,
  hasOpenOutsource: boolean,
  hasOpenInspectionVerdict: WireValue<boolean>,
  externalSpendCny: number,
  marginCny: WireValue<number>,
  isShipped: boolean,
  componentCount: number,
  searchHaystack: string,
  activeReturn: WireValue<CompactActiveReturn>,
  cells: Array<WireValue<CompactCell>>,
  // 收款 money light — appended after cells; commerce-only (null when scrubbed).
  moneyStatus: WireValue<OrderMoneyStatus>,
  outstandingCny: WireValue<number>,
  overdueDays: WireValue<number>,
]

function canSeeCustomerData(scope: Scope): boolean {
  return scope.role === 'commerce' || scope.defaultStage === '出货'
}

function canSeeMoney(scope: Scope): boolean {
  return scope.role === 'commerce'
}

function scrubForWire(row: MasterRow, scope: Scope): MasterRow {
  const customerOk = canSeeCustomerData(scope)
  const moneyOk = canSeeMoney(scope)
  if (customerOk && moneyOk) return row
  return {
    ...row,
    customer: customerOk ? row.customer : '',
    engineer: customerOk ? row.engineer : undefined,
    amountCny: moneyOk ? row.amountCny : undefined,
    externalSpendCny: moneyOk ? row.externalSpendCny : 0,
    marginCny: moneyOk ? row.marginCny : undefined,
    searchHaystack: customerOk ? row.searchHaystack : '',
    moneyStatus: moneyOk ? row.moneyStatus : undefined,
    outstandingCny: moneyOk ? row.outstandingCny : undefined,
    overdueDays: moneyOk ? row.overdueDays : undefined,
  }
}

function compactActiveReturn(r: MasterActiveReturn | undefined): WireValue<CompactActiveReturn> {
  return r ? [r.id, r.dueDate, r.reason] : null
}

function expandActiveReturn(r: WireValue<CompactActiveReturn>): MasterActiveReturn | undefined {
  return r ? { id: r[0], dueDate: r[1], reason: r[2] } : undefined
}

function compactCell(c: MasterCell | undefined): WireValue<CompactCell> {
  if (!c) return null
  return [
    c.total,
    c.inHouseDone,
    c.outsourcedClosed,
    c.outsourcedOpen,
    c.inProgress,
    c.pending,
    c.inProgressDoneQtySum,
    c.earliestInProgressAt ?? null,
    c.latestFinishedAt ?? null,
    c.latestCompletedAt ?? null,
    c.latestBy ?? null,
    c.hasMinePending ? 1 : 0,
    c.hasUpstreamActive ? 1 : 0,
    c.pinnedAt ?? null,
  ]
}

function expandCell(c: WireValue<CompactCell>): MasterCell | undefined {
  if (!c) return undefined
  return {
    total: c[0],
    inHouseDone: c[1],
    outsourcedClosed: c[2],
    outsourcedOpen: c[3],
    inProgress: c[4],
    pending: c[5],
    inProgressDoneQtySum: c[6],
    earliestInProgressAt: c[7] ?? undefined,
    latestFinishedAt: c[8] ?? undefined,
    latestCompletedAt: c[9] ?? undefined,
    latestBy: c[10] ?? undefined,
    hasMinePending: c[11] === 1,
    hasUpstreamActive: c[12] === 1,
    pinnedAt: c[13] ?? undefined,
  }
}

export function toMasterWireRows(rows: MasterRow[], scope: Scope): CompactMasterRow[] {
  return rows.map((row) => {
    const r = scrubForWire(row, scope)
    return [
      r.id,
      r.jobNo,
      r.customer,
      r.product,
      r.engineer ?? null,
      r.amountCny ?? null,
      r.dueDate,
      r.effectiveDueDate,
      r.secondaryDueDate ?? null,
      r.notes ?? null,
      r.status,
      r.createdAt ?? null,
      r.jobType ?? null,
      r.isProduct ?? null,
      r.pausedAt ?? null,
      r.pauseReason ?? null,
      r.needsOutsource ?? null,
      r.outsourceNote ?? null,
      r.drawingChangeOpen ?? null,
      r.drawingChangeNote ?? null,
      r.pinnedAt ?? null,
      r.hasOpenOutsource,
      r.hasOpenInspectionVerdict ?? null,
      r.externalSpendCny,
      r.marginCny ?? null,
      r.isShipped,
      r.componentCount,
      r.searchHaystack,
      compactActiveReturn(r.activeReturn),
      STAGES.map((stage) => compactCell(r.cells[stage])),
      r.moneyStatus ?? null,
      r.outstandingCny ?? null,
      r.overdueDays ?? null,
    ]
  })
}

export function expandMasterWireRows(rows: CompactMasterRow[]): MasterRow[] {
  return rows.map((r) => {
    const cells: Partial<Record<Stage, MasterCell>> = {}
    r[29].forEach((cell, i) => {
      const expanded = expandCell(cell)
      if (expanded) cells[STAGES[i]] = expanded
    })
    return {
      id: r[0],
      jobNo: r[1],
      customer: r[2],
      product: r[3],
      engineer: r[4] ?? undefined,
      amountCny: r[5] ?? undefined,
      dueDate: r[6],
      effectiveDueDate: r[7],
      secondaryDueDate: r[8] ?? undefined,
      notes: r[9] ?? undefined,
      status: r[10],
      createdAt: r[11] ?? undefined,
      jobType: r[12] ?? undefined,
      isProduct: r[13] ?? undefined,
      pausedAt: r[14] ?? undefined,
      pauseReason: r[15] ?? undefined,
      needsOutsource: r[16] ?? undefined,
      outsourceNote: r[17] ?? undefined,
      drawingChangeOpen: r[18] ?? undefined,
      drawingChangeNote: r[19] ?? undefined,
      pinnedAt: r[20] ?? undefined,
      hasOpenOutsource: r[21],
      hasOpenInspectionVerdict: r[22] ?? undefined,
      externalSpendCny: r[23],
      marginCny: r[24] ?? undefined,
      isShipped: r[25],
      componentCount: r[26],
      searchHaystack: r[27],
      activeReturn: expandActiveReturn(r[28]),
      cells,
      moneyStatus: r[30] ?? undefined,
      outstandingCny: r[31] ?? undefined,
      overdueDays: r[32] ?? undefined,
    }
  })
}
