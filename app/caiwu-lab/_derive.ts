// caiwu-lab — pure derivation. Every 余额 (remainder) is computed here and
// NOWHERE stored. One source of truth, shared by all three designs, so they
// render identical numbers. This module is the answer to her dread: she
// appends {amount, date}; these functions do the subtraction, forever.

import {
  TODAY,
  type Job,
  type MoneyEvent,
  type PoLine,
} from './_mock'

export const AR_AGING_DAYS = 30

export type MoneyStatus = 'overdue' | 'await_invoice' | 'collecting' | 'settled'

export const STATUS_TEXT: Record<MoneyStatus, string> = {
  overdue: '逾期',
  await_invoice: '待开票',
  collecting: '收款中',
  settled: '已结清',
}

// Sort weight — lower = more anxious = floats to top.
export const STATUS_WEIGHT: Record<MoneyStatus, number> = {
  overdue: 0,
  await_invoice: 1,
  collecting: 2,
  settled: 3,
}

// --- pure date math on YYYY-MM-DD (no tz drift) ---
function daysBetween(aIso: string, bIso: string): number {
  const a = Date.UTC(+aIso.slice(0, 4), +aIso.slice(5, 7) - 1, +aIso.slice(8, 10))
  const b = Date.UTC(+bIso.slice(0, 4), +bIso.slice(5, 7) - 1, +bIso.slice(8, 10))
  return Math.round((b - a) / 86400000)
}

function eventsForLine(events: MoneyEvent[], lineId: string): MoneyEvent[] {
  return events.filter((e) => e.poLineId === lineId)
}

// Chronological sort: by date, then insertion order (id suffix is monotonic
// for seeds; appended events sort last within a day, matching her append flow).
function chronological(evts: MoneyEvent[]): MoneyEvent[] {
  return [...evts].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

export function lineInvoiced(events: MoneyEvent[], lineId: string): number {
  return eventsForLine(events, lineId)
    .filter((e) => e.kind === 'invoice')
    .reduce((s, e) => s + e.amountCny, 0)
}

export function linePaid(events: MoneyEvent[], lineId: string): number {
  return eventsForLine(events, lineId)
    .filter((e) => e.kind === 'payment')
    .reduce((s, e) => s + e.amountCny, 0)
}

/** 待开票余额 = 订单额 − Σ已开票. Never negative in display, but kept exact. */
export function lineWaitInvoice(line: PoLine, events: MoneyEvent[]): number {
  return line.poAmountCny - lineInvoiced(events, line.id)
}

/** 未收余额 = Σ已开票 − Σ已收款. */
export function lineUnpaid(line: PoLine, events: MoneyEvent[]): number {
  return lineInvoiced(events, line.id) - linePaid(events, line.id)
}

/** Days the oldest unpaid-but-invoiced amount has aged. 0 if nothing owed. */
export function lineOverdueDays(
  line: PoLine,
  events: MoneyEvent[],
  today: string = TODAY,
): number {
  if (lineUnpaid(line, events) <= 0) return 0
  const invoices = chronological(eventsForLine(events, line.id).filter((e) => e.kind === 'invoice'))
  if (!invoices.length) return 0
  const aged = daysBetween(invoices[0].date, today) - AR_AGING_DAYS
  return aged > 0 ? aged : 0
}

export function lineStatus(
  line: PoLine,
  events: MoneyEvent[],
  today: string = TODAY,
): MoneyStatus {
  const wait = lineWaitInvoice(line, events)
  const unpaid = lineUnpaid(line, events)
  if (wait <= 0 && unpaid <= 0) return 'settled'
  if (unpaid > 0 && lineOverdueDays(line, events, today) > 0) return 'overdue'
  if (wait > 0) return 'await_invoice'
  return 'collecting'
}

// --- running remainder for the per-line ledger ---
export interface LedgerRow {
  event: MoneyEvent
  /** The remainder AFTER this event, of the kind matching the event:
   *  invoice → 待开票余额, payment → 未收余额. This is exactly her Excel:
   *  "6月开票2800元，剩余…". */
  running: number
  /** True for the most-recently-appended event (the only one that can be voided). */
  isLast: boolean
}

export function ledgerForLine(line: PoLine, events: MoneyEvent[]): LedgerRow[] {
  const evts = chronological(eventsForLine(events, line.id))
  let cumInvoice = 0
  let cumPayment = 0
  const rows: LedgerRow[] = evts.map((event) => {
    if (event.kind === 'invoice') {
      cumInvoice += event.amountCny
      return { event, running: line.poAmountCny - cumInvoice, isLast: false }
    }
    cumPayment += event.amountCny
    return { event, running: cumInvoice - cumPayment, isLast: false }
  })
  if (rows.length) rows[rows.length - 1].isLast = true
  return rows
}

// --- rollups ---
export interface Rollup {
  poAmount: number
  invoiced: number
  paid: number
  waitInvoice: number
  unpaid: number
}

function emptyRollup(): Rollup {
  return { poAmount: 0, invoiced: 0, paid: 0, waitInvoice: 0, unpaid: 0 }
}

export function rollupForLines(lines: PoLine[], events: MoneyEvent[]): Rollup {
  const r = emptyRollup()
  for (const line of lines) {
    const inv = lineInvoiced(events, line.id)
    const paid = linePaid(events, line.id)
    r.poAmount += line.poAmountCny
    r.invoiced += inv
    r.paid += paid
    r.waitInvoice += line.poAmountCny - inv
    r.unpaid += inv - paid
  }
  return r
}

// --- composed view models the designs consume ---
export interface OrderVM {
  job: Job
  lines: PoLine[]
  rollup: Rollup
  status: MoneyStatus
  overdueDays: number
}

export function linesOf(jobId: string, lines: PoLine[]): PoLine[] {
  return lines.filter((l) => l.jobId === jobId)
}

// --- scale: index every line's sums in ONE pass over events ---
interface LineSum {
  invoiced: number
  paid: number
  firstInvoiceDate?: string
}

function buildLineSums(events: MoneyEvent[]): Map<string, LineSum> {
  const m = new Map<string, LineSum>()
  for (const e of events) {
    let s = m.get(e.poLineId)
    if (!s) {
      s = { invoiced: 0, paid: 0 }
      m.set(e.poLineId, s)
    }
    if (e.kind === 'invoice') {
      s.invoiced += e.amountCny
      if (!s.firstInvoiceDate || e.date < s.firstInvoiceDate) s.firstInvoiceDate = e.date
    } else {
      s.paid += e.amountCny
    }
  }
  return m
}

function statusFromSums(
  poAmount: number,
  s: LineSum | undefined,
  today: string,
): { status: MoneyStatus; overdueDays: number } {
  const invoiced = s?.invoiced ?? 0
  const paid = s?.paid ?? 0
  const wait = poAmount - invoiced
  const unpaid = invoiced - paid
  let overdueDays = 0
  if (unpaid > 0 && s?.firstInvoiceDate) {
    const aged = daysBetween(s.firstInvoiceDate, today) - AR_AGING_DAYS
    overdueDays = aged > 0 ? aged : 0
  }
  let status: MoneyStatus
  if (wait <= 0 && unpaid <= 0) status = 'settled'
  else if (unpaid > 0 && overdueDays > 0) status = 'overdue'
  else if (wait > 0) status = 'await_invoice'
  else status = 'collecting'
  return { status, overdueDays }
}

export function buildOrders(
  jobs: Job[],
  lines: PoLine[],
  events: MoneyEvent[],
  today: string = TODAY,
): OrderVM[] {
  // O(events + lines + jobs): index sums once, group lines by job once.
  const sums = buildLineSums(events)
  const linesByJob = new Map<string, PoLine[]>()
  for (const l of lines) {
    const arr = linesByJob.get(l.jobId)
    if (arr) arr.push(l)
    else linesByJob.set(l.jobId, [l])
  }
  return jobs.map((job) => {
    const jobLines = linesByJob.get(job.id) ?? []
    const rollup = emptyRollup()
    let weight = 3
    let overdueDays = 0
    for (const line of jobLines) {
      const s = sums.get(line.id)
      const invoiced = s?.invoiced ?? 0
      const paid = s?.paid ?? 0
      rollup.poAmount += line.poAmountCny
      rollup.invoiced += invoiced
      rollup.paid += paid
      rollup.waitInvoice += line.poAmountCny - invoiced
      rollup.unpaid += invoiced - paid
      const st = statusFromSums(line.poAmountCny, s, today)
      if (STATUS_WEIGHT[st.status] < weight) weight = STATUS_WEIGHT[st.status]
      if (st.overdueDays > overdueDays) overdueDays = st.overdueDays
    }
    const status = (Object.keys(STATUS_WEIGHT) as MoneyStatus[]).find(
      (k) => STATUS_WEIGHT[k] === weight,
    ) as MoneyStatus
    return { job, lines: jobLines, rollup, status, overdueDays }
  })
}

/** Anxiety sort: 逾期 → 待开票 → 收款中 → 已结清, then oldest ship first. */
export function sortByAnxiety(orders: OrderVM[]): OrderVM[] {
  return [...orders].sort((a, b) => {
    const w = STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status]
    if (w !== 0) return w
    return a.job.shipDate < b.job.shipDate ? -1 : a.job.shipDate > b.job.shipDate ? 1 : 0
  })
}

// --- per-customer aggregation (对账) ---
export interface CustomerVM {
  customer: string
  orders: OrderVM[]
  rollup: Rollup
  status: MoneyStatus
  awaitInvoiceLineCount: number
}

export function buildCustomers(orders: OrderVM[]): CustomerVM[] {
  const byName = new Map<string, OrderVM[]>()
  for (const o of orders) {
    const arr = byName.get(o.job.customer) ?? []
    arr.push(o)
    byName.set(o.job.customer, arr)
  }
  const out: CustomerVM[] = []
  for (const [customer, custOrders] of byName) {
    const rollup = emptyRollup()
    let weight = 3
    let awaitInvoiceLineCount = 0
    for (const o of custOrders) {
      rollup.poAmount += o.rollup.poAmount
      rollup.invoiced += o.rollup.invoiced
      rollup.paid += o.rollup.paid
      rollup.waitInvoice += o.rollup.waitInvoice
      rollup.unpaid += o.rollup.unpaid
      if (STATUS_WEIGHT[o.status] < weight) weight = STATUS_WEIGHT[o.status]
      if (o.rollup.waitInvoice > 0) awaitInvoiceLineCount += 1
    }
    const status = (Object.keys(STATUS_WEIGHT) as MoneyStatus[]).find(
      (k) => STATUS_WEIGHT[k] === weight,
    ) as MoneyStatus
    out.push({ customer, orders: custOrders, rollup, status, awaitInvoiceLineCount })
  }
  return out.sort((a, b) => {
    const w = STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status]
    if (w !== 0) return w
    return b.rollup.unpaid - a.rollup.unpaid
  })
}

/** Filter helper shared by the lens toggles. */
export function matchesQuery(o: OrderVM, q: string): boolean {
  if (!q.trim()) return true
  const hay = [o.job.customer, o.job.id, o.job.product, o.job.salesperson, ...o.lines.map((l) => l.poNo), ...o.lines.map((l) => l.materialNo ?? '')]
    .join(' ')
    .toLowerCase()
  return hay.includes(q.trim().toLowerCase())
}

export function monthLabel(iso: string): string {
  return `${+iso.slice(5, 7)}月`
}
