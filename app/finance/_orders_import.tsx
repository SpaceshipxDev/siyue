'use client'

import { useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatCny, type OrderLedgerRow } from '@/lib/data'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'

// 订单账导入 (于海伟 2026-11-04) —— 导出去的那张「订单」表, 在系统外对完账、
// 开完票、收完款, 填好导回来。按工号对上系统里的订单, 先摆出来看一眼会记什么,
// 点「确认导入」才记。怎么记见 lib/order-import:
//   对账 —— 写了已对账 / 已回款 (或者填了应收单号) 的标上
//   开票 / 收款 —— 表上是合计, 比系统里多的那一截补进记账; 一样的不动, 少的不动
// 认的表头就是导出的那几个 (工号 · 对账 · 应收单号 · 开票 · 收款 · 开票日期 ·
// 发票号 · 收款日期), 顺序随意, 别的列不看。

type Parsed = {
  jobNo: string
  settle?: 'reconciled' | 'paid'
  settleNo?: string
  invoiceCny?: number
  invoiceDate?: string
  invoiceNo?: string
  paymentCny?: number
  paymentDate?: string
}

type Line = Parsed & {
  row?: OrderLedgerRow
  /** 这一行会记的事, 一句一句。空 = 没变化。 */
  changes: string[]
  /** 表上比系统里少的。 */
  lower: string[]
}

const HEADERS: Record<keyof Parsed, RegExp> = {
  jobNo: /^(工号|工单号|单号)$/,
  settle: /^(对账|对账状态)$/,
  settleNo: /^(应收单号|对账单号)$/,
  invoiceCny: /^(开票|开票金额|已开票)$/,
  invoiceDate: /^开票日期$/,
  invoiceNo: /^(发票号|发票号码)$/,
  paymentCny: /^(收款|收款金额|回款|回款金额|已收款)$/,
  paymentDate: /^(收款日期|回款日期)$/,
}

function cellText(v: unknown): string {
  if (v instanceof Date) return ymdOf(v) ?? ''
  return v == null ? '' : String(v).trim()
}

function ymdOf(v: unknown): string | undefined {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const y = v.getFullYear()
    const m = String(v.getMonth() + 1).padStart(2, '0')
    const d = String(v.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  const t = cellText(v)
  const m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(t)
  if (!m) return undefined
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

function moneyOf(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : undefined
  const t = cellText(v).replace(/[¥￥,，元\s]/g, '')
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function settleOf(v: unknown): 'reconciled' | 'paid' | undefined {
  const t = cellText(v)
  if (!t || /未|否|没|不/.test(t)) return undefined
  if (/回款|收清|已收/.test(t)) return 'paid'
  if (/对账|是|已|√|✓|y/i.test(t)) return 'reconciled'
  return undefined
}

function parseSheet(aoa: unknown[][]): Parsed[] | null {
  // 表头在前十行里找: 有「工号」的那一行。
  let head = -1
  for (let i = 0; i < Math.min(10, aoa.length); i++)
    if ((aoa[i] ?? []).some((c) => HEADERS.jobNo.test(cellText(c)))) {
      head = i
      break
    }
  if (head < 0) return null
  const col: Partial<Record<keyof Parsed, number>> = {}
  ;(aoa[head] ?? []).forEach((c, i) => {
    const t = cellText(c)
    for (const k of Object.keys(HEADERS) as (keyof Parsed)[])
      if (col[k] === undefined && HEADERS[k].test(t)) col[k] = i
  })
  const at = (r: unknown[], k: keyof Parsed) => (col[k] === undefined ? undefined : r[col[k]!])
  const out: Parsed[] = []
  for (const r of aoa.slice(head + 1)) {
    const jobNo = cellText(at(r ?? [], 'jobNo'))
    if (!jobNo) continue
    const settleNo = cellText(at(r, 'settleNo')) || undefined
    out.push({
      jobNo,
      // 只填了应收单号、对账那一格空着 —— 也算对过账了。
      settle: settleOf(at(r, 'settle')) ?? (settleNo ? 'reconciled' : undefined),
      settleNo,
      invoiceCny: moneyOf(at(r, 'invoiceCny')),
      invoiceDate: ymdOf(at(r, 'invoiceDate')),
      invoiceNo: cellText(at(r, 'invoiceNo')) || undefined,
      paymentCny: moneyOf(at(r, 'paymentCny')),
      paymentDate: ymdOf(at(r, 'paymentDate')),
    })
  }
  return out
}

const r2 = (n: number) => Math.round(n * 100) / 100

export function OrderImportButton({ rows, todayStr }: { rows: OrderLedgerRow[]; todayStr: string }) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [lines, setLines] = useState<Line[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [reading, setReading] = useState(false)
  const [pending, start] = useTransition()

  const byNo = useMemo(() => new Map(rows.map((r) => [r.jobNo.trim().toLowerCase(), r])), [rows])

  const take = async (f: File) => {
    setReading(true)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: true })
      const name = wb.SheetNames.includes('订单') ? '订单' : wb.SheetNames[0]
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: '' })
      const parsed = parseSheet(aoa)
      if (!parsed || parsed.length === 0) {
        showToast('表上没找到「工号」那一列 —— 用导出的那张表改了再导', 'warning')
        return
      }
      const seen = new Set<string>()
      const out: Line[] = []
      for (const p of parsed) {
        const key = p.jobNo.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        const row = byNo.get(key)
        const changes: string[] = []
        const lower: string[] = []
        if (row) {
          if (p.settle && !row.settle) changes.push(p.settle === 'paid' ? '标已回款' : '标已对账')
          // 已对账 / 开了票 —— 落应收单 (lib/order-import), 系统里还没进过应收的才进。
          if ((!row.settle || row.extSettle) && !row.free && (p.settle || (p.invoiceCny ?? 0) > 0))
            changes.push('进应收')
          if (!row.free) {
            if (p.invoiceCny !== undefined) {
              const d = r2(p.invoiceCny - row.invoicedCny)
              if (d > 0) changes.push(`开票 +${formatCny(d)}`)
              else if (d < 0) lower.push(`开票比系统少 ${formatCny(-d)}`)
            }
            if (p.paymentCny !== undefined) {
              const d = r2(p.paymentCny - row.paidCny)
              if (d > 0) changes.push(`收款 +${formatCny(d)}`)
              else if (d < 0) lower.push(`收款比系统少 ${formatCny(-d)}`)
            }
          }
        }
        // 发票号: 表上那一格是导出时带出去的老号加上新填的, 只留新的。
        let invoiceNo = p.invoiceNo
        if (row && invoiceNo) {
          const old = new Set(row.money.flatMap((m) => (m.invoiceNo ? [m.invoiceNo] : [])))
          invoiceNo = invoiceNo
            .split(/[、,，\s]+/)
            .filter((t) => t && !old.has(t))
            .join('、') || undefined
        }
        out.push({ ...p, invoiceNo, row, changes, lower })
      }
      setFileName(f.name)
      setLines(out)
    } catch {
      showToast('这个文件读不出来 —— 要 Excel 表格', 'warning')
    } finally {
      setReading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const todo = lines?.filter((l) => l.row && l.changes.length > 0) ?? []
  const unmatched = lines?.filter((l) => !l.row) ?? []
  const lower = lines?.filter((l) => l.row && l.lower.length > 0) ?? []
  const same = (lines?.length ?? 0) - todo.length - unmatched.length

  const confirm = () => {
    if (todo.length === 0) return
    start(async () => {
      try {
        const res = await mutate<{
          invoices: number
          payments: number
          settles: number
          receivables: number
          notReceivable: string[]
        }>({
          kind: 'importOrderLedger',
          items: todo.map(({ row: _r, changes: _c, lower: _l, ...p }) => {
            void _r
            void _c
            void _l
            return p
          }),
        })
        const d = res.data
        showToast(
          `导入好了 · 对账 ${d.settles} 单 · 开票 ${d.invoices} 笔 · 收款 ${d.payments} 笔 · 应收单 ${d.receivables} 张`,
          'success',
        )
        if (d.notReceivable.length > 0)
          showToast(`这几单没进应收：${d.notReceivable.slice(0, 6).join('；')}${d.notReceivable.length > 6 ? ' …' : ''}`, 'warning')
        setLines(null)
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '没导进去，再试一次', 'warning')
      }
    })
  }

  return (
    <>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={reading}
        title="系统外对账、开票、收款的表导回来 —— 用导出的那张表改"
        className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] text-[var(--color-ink-3)] transition-colors hover:text-[var(--color-ink)] disabled:text-[var(--color-ink-4)]"
      >
        {reading ? '读取中…' : '导入'}
        <span aria-hidden className="text-[14px] leading-none">↑</span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void take(f)
        }}
      />

      {lines && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="导入订单账"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => e.target === e.currentTarget && !pending && setLines(null)}
        >
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-[2px] bg-[var(--color-surface)] shadow-[0_12px_40px_rgba(20,19,15,0.2)]">
            <div className="border-b border-[var(--color-border)] px-6 py-4">
              <p className="label">导入 · {fileName}</p>
              <p className="mt-1.5 text-[14px] text-[var(--color-ink)]">
                {todo.length > 0 ? (
                  <>
                    <span className="font-semibold">{todo.length}</span> 单要记
                  </>
                ) : (
                  '没有要记的 —— 表上的数跟系统里一样'
                )}
                <span className="text-[var(--color-ink-3)]">
                  {same > 0 && ` · ${same} 单没变化`}
                  {unmatched.length > 0 && ` · ${unmatched.length} 个工号系统里没有`}
                </span>
              </p>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-3">
              {todo.map((l) => (
                <div
                  key={l.jobNo}
                  className="grid grid-cols-[150px_minmax(0,1fr)_minmax(0,1.3fr)] items-baseline gap-3 border-b border-[var(--color-border)] py-2 last:border-b-0"
                >
                  <span className="mono text-[12.5px] font-medium text-[var(--color-ink)]">{l.row!.jobNo}</span>
                  <span className="truncate text-[12.5px] text-[var(--color-ink-2)]">{l.row!.customer}</span>
                  <span className="text-[12.5px] text-[var(--color-ink)]">
                    {l.changes.join(' · ')}
                    {(l.invoiceDate || l.paymentDate || l.invoiceNo) && (
                      <span className="text-[var(--color-ink-3)]">
                        {l.invoiceNo ? ` · 发票 ${l.invoiceNo}` : ''}
                        {l.invoiceDate ? ` · 开票 ${l.invoiceDate.slice(5)}` : ''}
                        {l.paymentDate ? ` · 收款 ${l.paymentDate.slice(5)}` : ''}
                      </span>
                    )}
                  </span>
                </div>
              ))}
              {lower.length > 0 && (
                <p className="mt-3 text-[12px] leading-relaxed text-[var(--color-warning)]">
                  这几单表上的数比系统里少，没动（要减去记账里红冲）：
                  {lower.map((l) => `${l.row!.jobNo} ${l.lower.join('、')}`).join('；')}
                </p>
              )}
              {unmatched.length > 0 && (
                <p className="mt-3 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
                  系统里找不到这些工号，跳过：{unmatched.map((l) => l.jobNo).join('、')}
                </p>
              )}
              <p className="mt-3 text-[12px] leading-relaxed text-[var(--color-ink-4)]">
                开票、收款按表上的合计算，比系统里多的那一截补进记账；没填日期的按今天（{todayStr.slice(5)}）记。
                「进应收」的按客户、出货月份落应收单，金额照对账单的出货金额算；已回款的记一笔回款。
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-6 py-3">
              <button
                type="button"
                onClick={() => setLines(null)}
                disabled={pending}
                className="h-9 rounded-[2px] border border-[var(--color-border)] px-4 text-[13px] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={pending || todo.length === 0}
                className="h-9 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-40"
              >
                {pending ? '导入中…' : '确认导入'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
