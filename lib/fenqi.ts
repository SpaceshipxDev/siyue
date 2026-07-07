// 分期账 (installment ledger) domain logic — the 财务 rebuild.
//
// The primitive, lifted from the finance clerk's real Excel: money hangs off
// the 订单号 (PO line). A job carries 1..n PO lines; each line accumulates
// append-only 开票 / 收款 events (migration 0075). NOTHING here is stored as
// a balance — 待开票 = 订单额 − Σ开票, 未收 = Σ开票 − Σ收款, and her yellow
// "开票情况" cell is a SENTENCE GENERATED from the events, so she reads
// exactly what she has always read but never writes or computes it again.
//
// Pure functions only ⇒ safe to import from server (db.ts, export route) and
// client (the /finance ledger) alike. One derivation, every surface — her
// ledger, the boss's 看钱 wall, the master-board 收款 light, the Excel export
// — can never disagree.

export const FENQI_AGING_DAYS = 30

export type MoneyEventKind = 'invoice' | 'payment'

export type FenqiEvent = {
  id: string
  poLineId: string
  kind: MoneyEventKind
  amountCny: number
  eventDate: string // YYYY-MM-DD
  invoiceNo?: string
  note?: string
  /** 红冲 — this row voids the event it points at; both stay in the book. */
  reversalOf?: string
  createdBy?: string
  createdAt: string // ISO
}

export type FenqiLine = {
  id: string
  jobId: string
  poNo: string
  materialNo?: string
  amountCny: number
  createdAt: string // ISO — display order within a job
}

// One 单 in the pool. Rows are BORN from production (any job with a 出货单
// enters automatically — she never types a 流水号 again); po lines/events are
// what she adds.
export type FenqiJob = {
  jobId: string
  jobNo: string
  customer: string
  contact?: string // 联系人 (jobs.engineer)
  salesperson?: string // 商务
  shipDate?: string // YYYY-MM-DD — latest 出货; undefined if row exists only via po_lines
  billable: boolean // 是否收费 — false ⇒ 免收, out of every total
  jobAmountCny?: number // contract 金额, shown as a hint when she books the first PO line
}

export type FenqiData = {
  jobs: FenqiJob[]
  lines: FenqiLine[]
  events: FenqiEvent[]
}

// === status ===
//
// Derived, never stored, colored TEXT in the UI (the app's idiom). Anxiety
// order: the money most at risk sorts first on the boss's wall.
export type FenqiStatus =
  | 'overdue' // 逾期 — oldest un-cleared invoice past the aging window
  | 'unbooked' // 待录 — shipped, but no PO line / amount booked yet
  | 'await' // 待开票 — booked, still money left to invoice
  | 'collect' // 收款中 — fully derived from invoiced>paid within term
  | 'settled' // 已结清
  | 'free' // 免收 — 是否收费=否

export const FENQI_STATUS_LABEL: Record<FenqiStatus, string> = {
  overdue: '逾期',
  unbooked: '待录',
  await: '待开票',
  collect: '收款中',
  settled: '已结清',
  free: '免收',
}

export const FENQI_STATUS_WEIGHT: Record<FenqiStatus, number> = {
  overdue: 0,
  unbooked: 1,
  await: 2,
  collect: 3,
  settled: 4,
  free: 5,
}

// === derivation ===

// Whole-day gap between two YYYY-MM-DD strings (b − a). Factory-local dates,
// UTC-midnight math — no tz drift. Mirrors lib/finance.ts.
function daysBetween(aYmd: string, bYmd: string): number {
  const a = Date.parse(`${aYmd}T00:00:00Z`)
  const b = Date.parse(`${bYmd}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

// Chronological: by event_date, then insertion order (created_at, id) so two
// same-day entries keep her append order.
function chronological(evs: FenqiEvent[]): FenqiEvent[] {
  return [...evs].sort(
    (a, b) =>
      a.eventDate.localeCompare(b.eventDate) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  )
}

// A ledger row as the detail panel renders it: voided (红冲'd) events stay
// visible but struck through and never move the running remainder.
export type LedgerEvent = {
  ev: FenqiEvent
  voided: boolean
  /** Remainder AFTER this event, of the matching kind — invoice → 剩(待开),
   *  payment → 剩(未收). Exactly her Excel's "…开票2800元，剩余…". */
  remainder: number
  /** remainder hit zero — render 开完 / 收清. */
  cleared: boolean
}

export type LineVM = {
  line: FenqiLine
  ledger: LedgerEvent[]
  invoiced: number
  paid: number
  wait: number // 订单额 − Σ开票 (can go negative on over-invoice; display clamps)
  unpaid: number // Σ开票 − Σ收款
  overdueDays: number // FIFO-aged: the oldest invoice not yet covered by payments
}

// Split one line's events into display ledger + sums. `reversed` marks both
// the voided originals and hides the reversal markers themselves.
function buildLineVM(
  line: FenqiLine,
  evs: FenqiEvent[],
  todayYmd: string,
): LineVM {
  const ordered = chronological(evs)
  const reversedIds = new Set<string>()
  for (const e of ordered) if (e.reversalOf) reversedIds.add(e.reversalOf)

  let invoiced = 0
  let paid = 0
  const activeInvoices: FenqiEvent[] = []
  const ledger: LedgerEvent[] = []
  let curWait = line.amountCny
  let curUnpaid = 0

  for (const e of ordered) {
    if (e.reversalOf) continue // 红冲 marker — the original renders struck-through
    const voided = reversedIds.has(e.id)
    if (!voided) {
      if (e.kind === 'invoice') {
        invoiced += e.amountCny
        activeInvoices.push(e)
        curWait = line.amountCny - invoiced
      } else {
        paid += e.amountCny
        curUnpaid = invoiced - paid
      }
    }
    const remainder = e.kind === 'invoice' ? curWait : curUnpaid
    ledger.push({ ev: e, voided, remainder, cleared: remainder <= 0 })
  }

  const unpaid = invoiced - paid
  // FIFO aging: walk invoices oldest-first, consuming payments; the first
  // invoice with an uncovered balance sets the clock. An installment plan the
  // customer is actually paying down never shows a stale first-invoice age.
  let overdueDays = 0
  if (unpaid > 0) {
    let covered = paid
    for (const inv of activeInvoices) {
      if (covered >= inv.amountCny) {
        covered -= inv.amountCny
      } else {
        overdueDays = Math.max(
          0,
          daysBetween(inv.eventDate, todayYmd) - FENQI_AGING_DAYS,
        )
        break
      }
    }
  }

  return {
    line,
    ledger,
    invoiced,
    paid,
    wait: line.amountCny - invoiced,
    unpaid,
    overdueDays,
  }
}

export type RowVM = {
  job: FenqiJob
  lines: LineVM[]
  amountCny: number // Σ订单额 across lines
  invoiced: number
  paid: number
  wait: number
  unpaid: number
  overdueDays: number
  status: FenqiStatus
  invoiceNos: string[] // distinct 发票号 across active invoice events
  firstInvoiceDate?: string
}

export function buildRows(data: FenqiData, todayYmd: string): RowVM[] {
  const linesByJob = new Map<string, FenqiLine[]>()
  for (const l of data.lines) {
    const arr = linesByJob.get(l.jobId)
    if (arr) arr.push(l)
    else linesByJob.set(l.jobId, [l])
  }
  const eventsByLine = new Map<string, FenqiEvent[]>()
  for (const e of data.events) {
    const arr = eventsByLine.get(e.poLineId)
    if (arr) arr.push(e)
    else eventsByLine.set(e.poLineId, [e])
  }

  return data.jobs.map((job) => {
    const jobLines = (linesByJob.get(job.jobId) ?? []).sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
    const lines = jobLines.map((l) =>
      buildLineVM(l, eventsByLine.get(l.id) ?? [], todayYmd),
    )
    let amountCny = 0
    let invoiced = 0
    let paid = 0
    let overdueDays = 0
    const invoiceNoSet = new Set<string>()
    let firstInvoiceDate: string | undefined
    for (const lv of lines) {
      amountCny += lv.line.amountCny
      invoiced += lv.invoiced
      paid += lv.paid
      if (lv.overdueDays > overdueDays) overdueDays = lv.overdueDays
      for (const le of lv.ledger) {
        if (le.voided || le.ev.kind !== 'invoice') continue
        if (le.ev.invoiceNo) invoiceNoSet.add(le.ev.invoiceNo)
        if (!firstInvoiceDate || le.ev.eventDate < firstInvoiceDate) {
          firstInvoiceDate = le.ev.eventDate
        }
      }
    }
    const wait = amountCny - invoiced
    const unpaid = invoiced - paid

    let status: FenqiStatus
    if (!job.billable) status = 'free'
    else if (unpaid > 0 && overdueDays > 0) status = 'overdue'
    else if (lines.length === 0 || (amountCny <= 0 && invoiced <= 0))
      status = 'unbooked'
    else if (wait > 0) status = 'await'
    else if (unpaid > 0) status = 'collect'
    else status = 'settled'

    return {
      job,
      lines,
      amountCny,
      invoiced,
      paid,
      wait,
      unpaid,
      overdueDays,
      status,
      invoiceNos: Array.from(invoiceNoSet),
      firstInvoiceDate,
    }
  })
}

// Her sheet's order: newest delivery on top. Rows without a ship date (rare —
// booked before shipping) ride on their job number's recency.
export function sortRows(rows: RowVM[]): RowVM[] {
  return [...rows].sort(
    (a, b) =>
      (b.job.shipDate ?? '').localeCompare(a.job.shipDate ?? '') ||
      b.job.jobNo.localeCompare(a.job.jobNo),
  )
}

// === lenses — her two sheets, plus 全部 / 已结清 ===

export type FenqiLens = 'wei' | 'shou' | 'all' | 'settled'

export const FENQI_LENS_LABEL: Record<FenqiLens, string> = {
  wei: '未开票',
  shou: '已开待收',
  all: '全部',
  settled: '已结清',
}

export const FENQI_LENSES: FenqiLens[] = ['wei', 'shou', 'all', 'settled']

export function passLens(row: RowVM, lens: FenqiLens): boolean {
  if (lens === 'all') return true
  if (row.status === 'free') return false // 免收 lives in 全部 only
  switch (lens) {
    case 'wei':
      // Her first sheet: everything still owing an invoice — including rows
      // she hasn't booked yet (they're the top of her to-do).
      return row.status === 'unbooked' || row.wait > 0
    case 'shou':
      // Her second sheet: invoiced money not yet fully collected.
      return row.unpaid > 0
    case 'settled':
      return row.status === 'settled'
  }
}

export function matchesQuery(row: RowVM, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  const hay = [
    row.job.customer,
    row.job.jobNo,
    row.job.contact,
    row.job.salesperson,
    ...row.lines.map((l) => l.line.poNo),
    ...row.lines.map((l) => l.line.materialNo ?? ''),
    ...row.invoiceNos,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return hay.includes(needle)
}

export function lensCounts(rows: RowVM[]): Record<FenqiLens, number> {
  const counts: Record<FenqiLens, number> = { wei: 0, shou: 0, all: 0, settled: 0 }
  for (const r of rows) {
    for (const lens of FENQI_LENSES) if (passLens(r, lens)) counts[lens] += 1
  }
  return counts
}

// === totals (KPI strip + boss heroes) ===

export type FenqiTotals = {
  waitCny: number // 货出了、票没开
  unpaidCny: number // 票开了、钱没到
  overdueCny: number // 其中逾期
  overdueCount: number
  invoicedThisMonthCny: number
  paidThisMonthCny: number // 本月进账
}

// `month` is a 'YYYY-MM' prefix. Positions come from the derived rows (free
// rows excluded); month flows come from the raw events so a payment on an
// already-settled row still counts toward 本月进账.
export function fenqiTotals(
  rows: RowVM[],
  events: FenqiEvent[],
  month: string,
): FenqiTotals {
  let waitCny = 0
  let unpaidCny = 0
  let overdueCny = 0
  let overdueCount = 0
  for (const r of rows) {
    if (r.status === 'free') continue
    waitCny += Math.max(0, r.wait)
    unpaidCny += Math.max(0, r.unpaid)
    if (r.status === 'overdue') {
      overdueCny += Math.max(0, r.unpaid)
      overdueCount += 1
    }
  }
  const reversedIds = new Set<string>()
  for (const e of events) if (e.reversalOf) reversedIds.add(e.reversalOf)
  let invoicedThisMonthCny = 0
  let paidThisMonthCny = 0
  for (const e of events) {
    if (e.reversalOf || reversedIds.has(e.id)) continue
    if (!e.eventDate.startsWith(month)) continue
    if (e.kind === 'invoice') invoicedThisMonthCny += e.amountCny
    else paidThisMonthCny += e.amountCny
  }
  return {
    waitCny,
    unpaidCny,
    overdueCny,
    overdueCount,
    invoicedThisMonthCny,
    paidThisMonthCny,
  }
}

// === the auto-written sentences (her yellow / green cells) ===
//
// Segments, not JSX, so the client renders them with tone classes and the
// Excel export joins them into plain text — one generator, both surfaces.

export type SentenceSeg = {
  t: string
  k: 'po' | 'txt' | 'rem' | 'done'
}

export function formatNum(n: number): string {
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

// '2026-03-15' → '3月' (year-prefixed when it isn't this year: '2024.8月').
function monthLabel(ymd: string, todayYmd: string): string {
  const y = ymd.slice(0, 4)
  const m = String(parseInt(ymd.slice(5, 7), 10))
  return y === todayYmd.slice(0, 4) ? `${m}月` : `${y}.${m}月`
}

// 开票情况 — per PO line: "4513037836（820）3月开票470元，剩350元，4月开票350元，开完"
// Lines joined with '；'. Only lines that have at least one invoice appear.
export function invoiceSentence(row: RowVM, todayYmd: string): SentenceSeg[] {
  const segs: SentenceSeg[] = []
  const multi = row.lines.length > 1
  for (const lv of row.lines) {
    const invs = lv.ledger.filter((le) => !le.voided && le.ev.kind === 'invoice')
    if (invs.length === 0) continue
    if (segs.length > 0) segs.push({ t: '；', k: 'txt' })
    if (multi) {
      segs.push({
        t: `${lv.line.poNo || '未填订单号'}（${formatNum(lv.line.amountCny)}）`,
        k: 'po',
      })
    }
    invs.forEach((le, i) => {
      segs.push({
        t: `${i > 0 ? '，' : ''}${monthLabel(le.ev.eventDate, todayYmd)}开票${formatNum(le.ev.amountCny)}元`,
        k: 'txt',
      })
      if (le.remainder <= 0) segs.push({ t: '，开完', k: 'done' })
      else segs.push({ t: `，剩${formatNum(le.remainder)}元`, k: 'rem' })
    })
  }
  return segs
}

// 收款记录 — order-level (her second sheet's green cell):
// "5-21收款13,380，剩6,980；5-28收款4,440，剩2,540"
export function paymentSentence(row: RowVM): SentenceSeg[] {
  const pays: { ev: FenqiEvent }[] = []
  for (const lv of row.lines) {
    for (const le of lv.ledger) {
      if (!le.voided && le.ev.kind === 'payment') pays.push({ ev: le.ev })
    }
  }
  pays.sort(
    (a, b) =>
      a.ev.eventDate.localeCompare(b.ev.eventDate) ||
      a.ev.createdAt.localeCompare(b.ev.createdAt),
  )
  const segs: SentenceSeg[] = []
  let cum = 0
  pays.forEach(({ ev }, i) => {
    cum += ev.amountCny
    const rem = row.invoiced - cum
    const d = `${parseInt(ev.eventDate.slice(5, 7), 10)}-${parseInt(ev.eventDate.slice(8, 10), 10)}`
    segs.push({
      t: `${i > 0 ? '；' : ''}${d}收款${formatNum(ev.amountCny)}`,
      k: 'txt',
    })
    if (rem <= 0) segs.push({ t: '，收清', k: 'done' })
    else segs.push({ t: `，剩${formatNum(rem)}`, k: 'rem' })
  })
  return segs
}

export function sentenceText(segs: SentenceSeg[]): string {
  return segs.map((s) => s.t).join('')
}

// === 看钱 — the boss's per-customer wall ===

export type CustomerAgg = {
  customer: string
  waitCny: number
  unpaidCny: number
  overdueCny: number
  overdueDays: number // worst aging across the customer's rows
  jobCount: number
  totalCny: number // wait + unpaid — bar length
}

// Free rows never enter; customers with zero exposure drop out. Overdue
// customers first (they're the phone calls), then by total exposure.
export function customerWall(rows: RowVM[]): CustomerAgg[] {
  const byName = new Map<string, CustomerAgg>()
  for (const r of rows) {
    if (r.status === 'free') continue
    const name = r.job.customer || '未知'
    const g =
      byName.get(name) ??
      ({
        customer: name,
        waitCny: 0,
        unpaidCny: 0,
        overdueCny: 0,
        overdueDays: 0,
        jobCount: 0,
        totalCny: 0,
      } as CustomerAgg)
    g.waitCny += Math.max(0, r.wait)
    g.unpaidCny += Math.max(0, r.unpaid)
    if (r.status === 'overdue') {
      g.overdueCny += Math.max(0, r.unpaid)
      if (r.overdueDays > g.overdueDays) g.overdueDays = r.overdueDays
    }
    // Count only rows actually holding money — a 待录 row with nothing booked
    // shouldn't inflate "N 单压着钱".
    if (r.wait > 0 || r.unpaid > 0) g.jobCount += 1
    byName.set(name, g)
  }
  const out: CustomerAgg[] = []
  for (const g of byName.values()) {
    g.totalCny = g.waitCny + g.unpaidCny
    if (g.totalCny > 0) out.push(g)
  }
  return out.sort(
    (a, b) =>
      Number(b.overdueCny > 0) - Number(a.overdueCny > 0) ||
      b.totalCny - a.totalCny,
  )
}

// === Excel export — her accountant handoff, both sheets ===

export const FENQI_EXPORT_WEI_HEADERS = [
  '日期',
  '客户名称',
  '联系人',
  '订单号/物料号',
  '是否收费',
  '未开票金额',
  '内部流水号',
  '开票情况',
] as const

export const FENQI_EXPORT_SHOU_HEADERS = [
  '客户名称',
  '内部流水号',
  '订单金额',
  '开票日期',
  '发票号码',
  '未收金额',
  '收款记录',
] as const

function numCell(n: number): number | string {
  return Number.isFinite(n) && n !== 0 ? n : n === 0 ? 0 : ''
}

export function buildFenqiWeiAoa(
  rows: RowVM[],
  todayYmd: string,
): (string | number)[][] {
  const aoa: (string | number)[][] = [FENQI_EXPORT_WEI_HEADERS.slice() as string[]]
  for (const r of rows) {
    aoa.push([
      r.job.shipDate ?? '',
      r.job.customer,
      r.job.contact ?? '',
      r.lines
        .map((l) =>
          `${l.line.poNo}${l.line.materialNo ? `/${l.line.materialNo}` : ''}（${formatNum(l.line.amountCny)}）`,
        )
        .join('\n'),
      r.job.billable ? '是' : '否',
      numCell(Math.max(0, r.wait)),
      r.job.jobNo,
      sentenceText(invoiceSentence(r, todayYmd)),
    ])
  }
  return aoa
}

export function buildFenqiShouAoa(rows: RowVM[]): (string | number)[][] {
  const aoa: (string | number)[][] = [
    FENQI_EXPORT_SHOU_HEADERS.slice() as string[],
  ]
  for (const r of rows) {
    aoa.push([
      r.job.customer,
      r.job.jobNo,
      numCell(r.amountCny),
      r.firstInvoiceDate ?? '',
      r.invoiceNos.join('\n'),
      numCell(Math.max(0, r.unpaid)),
      sentenceText(paymentSentence(r)),
    ])
  }
  return aoa
}
