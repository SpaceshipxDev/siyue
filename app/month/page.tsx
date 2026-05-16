import Link from 'next/link'
import {
  blockActivityLabel,
  blockClosedAt,
  formatCny,
  vendorById,
  type OpenBlockRow,
  type Vendor,
} from '@/lib/data'
import { today } from '@/lib/today'
import { getMasterRows, getOutsourceBlockRows, getVendors } from '@/lib/db'
import { requireCommerce } from '@/lib/auth'
import type { MasterRow } from '@/lib/master'
import { TopBar } from '../_ui'

export const dynamic = 'force-dynamic'
const MONTHS = [
  '01', '02', '03', '04', '05', '06',
  '07', '08', '09', '10', '11', '12',
]

// Date strings come in two shapes in this codebase: 'YYYY-MM-DD' (forms) and
// 'MM-DD' (stage completedAt). Both expose the month at the same logical slot.
function monthOf(dateStr?: string): string | undefined {
  if (!dateStr) return undefined
  const parts = dateStr.split('-')
  if (parts.length === 3) return parts[1]
  if (parts.length === 2) return parts[0]
  return undefined
}

function dayOf(dateStr?: string): string {
  if (!dateStr) return ''
  const parts = dateStr.split('-')
  if (parts.length === 3) return `${parts[1]}-${parts[2]}`
  if (parts.length === 2) return dateStr
  return dateStr
}

type ClosedBlock = {
  jobId: string
  jobNo: string
  customer: string
  product: string
  componentName: string
  vendorName: string
  activity: string
  amountCny: number | null
  closedAt: string
}

function collectClosedBlocks(
  blocks: OpenBlockRow[],
  vendors: Vendor[],
  month: string,
): ClosedBlock[] {
  const out: ClosedBlock[] = []
  for (const r of blocks) {
    const closedAt = blockClosedAt(r.block)
    if (!closedAt) continue
    if (monthOf(closedAt) !== month) continue
    const v = vendorById(r.block.vendorId, vendors)
    const summary =
      r.block.members.length === 1
        ? r.block.members[0].name
        : `${r.block.members[0]?.name ?? ''} 等 ${r.block.members.length} 件`
    out.push({
      jobId: r.jobId,
      jobNo: r.jobNo,
      customer: r.customer,
      product: r.product,
      componentName: summary,
      vendorName: v?.name ?? r.block.vendorId,
      activity: blockActivityLabel(r.block),
      amountCny: r.block.amountCny,
      closedAt,
    })
  }
  out.sort((a, b) => a.closedAt.localeCompare(b.closedAt))
  return out
}

type ShippedRow = { row: MasterRow; shippedAt: string }

export default async function MonthSettlement({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>
}) {
  const user = await requireCommerce()
  const params = await searchParams
  const todayStr = today()
  const year = todayStr.slice(0, 4)
  const currentMonth = todayStr.slice(5, 7)
  const month = params.m && MONTHS.includes(params.m) ? params.m : currentMonth
  const monthIdx = MONTHS.indexOf(month)
  const prevMonth = MONTHS[(monthIdx + 11) % 12]
  const nextMonth = MONTHS[(monthIdx + 1) % 12]
  const isCurrent = month === currentMonth

  const [rows, blockRows, vendors] = await Promise.all([
    getMasterRows(),
    getOutsourceBlockRows(),
    getVendors(),
  ])
  const live = rows.filter(
    (r) => r.status !== 'parsing' && r.status !== 'draft' && r.status !== 'failed',
  )

  // "Shipped this month" = isShipped row whose 出货 latest completion lands
  // in the picked month. The 出货 cell's latest_completed_at is precomputed
  // by the rollup view (MM-DD).
  const shipped: ShippedRow[] = live
    .filter((r) => r.isShipped)
    .map<ShippedRow | null>((r) => {
      const at = r.cells['出货']?.latestCompletedAt
      return at ? { row: r, shippedAt: at } : null
    })
    .filter((r): r is ShippedRow => r !== null)
    .filter((r) => monthOf(r.shippedAt) === month)
    .sort((a, b) => a.shippedAt.localeCompare(b.shippedAt))

  const closed = collectClosedBlocks(blockRows, vendors, month)

  const inProgress = live
    .filter((r) => !r.isShipped)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))

  // Match the 商务 board pills: per-job summation across all live jobs, with
  // no 出货 gate. Counting revenue only after every component ships makes the
  // top line lag reality by weeks and decouples it from the external spend
  // (which is keyed off block closure date) — so margin came out nonsensical.
  const revenue = live.reduce((s, r) => s + (r.amountCny ?? 0), 0)
  const externalSpend = live.reduce((s, r) => s + r.externalSpendCny, 0)
  const margin = revenue - externalSpend
  const marginRate = revenue > 0 ? Math.round((margin / revenue) * 100) : 0

  const monthLabel = `${year}年 ${parseInt(month, 10)}月`

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="月结"
        subtitle="月度结算"
        currentTab="月结"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
      />
      <main className="mx-auto w-full max-w-[1100px] px-4 md:px-10 py-8 md:py-16 flex-1">
        <div className="flex items-center justify-center gap-10 mb-20">
          <Link
            href={`/month?m=${prevMonth}`}
            aria-label="上月"
            className="text-[20px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] px-3 py-1"
          >
            ‹
          </Link>
          <h1 className="text-[40px] font-semibold tracking-tight text-[var(--color-ink)] tabular-nums">
            {monthLabel}
            {!isCurrent && (
              <span className="ml-3 align-middle text-[12px] tracking-[0.22em] text-[var(--color-ink-3)] uppercase">
                历史
              </span>
            )}
          </h1>
          <Link
            href={`/month?m=${nextMonth}`}
            aria-label="下月"
            className="text-[20px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] px-3 py-1"
          >
            ›
          </Link>
        </div>

        <div className="grid grid-cols-3 gap-12 mb-24 text-center">
          <Stat
            label="收入"
            value={formatCny(revenue)}
            sub={`${inProgress.length} 个在产工单`}
          />
          <Stat
            label="外协支出"
            value={formatCny(externalSpend)}
            sub={`本月已结 ${formatCny(closed.reduce((s, b) => s + (b.amountCny ?? 0), 0))}`}
          />
          <Stat
            label="毛利"
            value={formatCny(margin)}
            sub={revenue > 0 ? `${marginRate}% 毛利率` : '—'}
            tone="success"
          />
        </div>

        <Section title="本月出货" count={shipped.length} empty="本月暂无出货">
          {shipped.length > 0 && (
            <table className="w-full">
              <tbody>
                {shipped.map((r) => (
                  <tr
                    key={r.row.id}
                    className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface)]"
                  >
                    <td className="py-3 pr-6 label tabular-nums w-[80px] text-[var(--color-ink-3)]">
                      {dayOf(r.shippedAt)}
                    </td>
                    <td className="py-3 pr-6">
                      <Link
                        href={`/jobs/${r.row.id}`}
                        className="text-[14px] tabular-nums text-[var(--color-ink)] hover:underline"
                      >
                        {r.row.jobNo}
                      </Link>
                    </td>
                    <td className="py-3 pr-6 text-[14px] text-[var(--color-ink)]">
                      {r.row.customer}
                    </td>
                    <td className="py-3 pr-6 text-[13px] text-[var(--color-ink-2)]">
                      {r.row.product}
                    </td>
                    <td className="py-3 text-[14px] tabular-nums text-right text-[var(--color-ink)]">
                      {formatCny(r.row.amountCny)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title="本月外协" count={closed.length} empty="本月暂无外协">
          {closed.length > 0 && (
            <table className="w-full">
              <tbody>
                {closed.map((b, i) => (
                  <tr
                    key={`${b.jobId}-${i}`}
                    className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface)]"
                  >
                    <td className="py-3 pr-6 label tabular-nums w-[80px] text-[var(--color-ink-3)]">
                      {dayOf(b.closedAt)}
                    </td>
                    <td className="py-3 pr-6 text-[14px] text-[var(--color-ink)]">
                      {b.vendorName}
                    </td>
                    <td className="py-3 pr-6 text-[13px] text-[var(--color-ink-2)]">
                      <Link href={`/jobs/${b.jobId}`} className="hover:underline">
                        {b.jobNo} · {b.componentName}
                      </Link>
                    </td>
                    <td className="py-3 pr-6 text-[12px] text-[var(--color-ink-3)] tracking-wider">
                      {b.activity}
                    </td>
                    <td className="py-3 text-[14px] tabular-nums text-right text-[var(--color-ink)]">
                      {formatCny(b.amountCny)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section
          title="在制"
          subtitle="尚未出货的工单"
          count={inProgress.length}
          empty="无在制工单"
        >
          {inProgress.length > 0 && (
            <table className="w-full">
              <tbody>
                {inProgress.map((j) => (
                  <tr
                    key={j.id}
                    className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface)]"
                  >
                    <td className="py-3 pr-6 label tabular-nums w-[110px] text-[var(--color-ink-3)]">
                      交 {j.dueDate.slice(5)}
                    </td>
                    <td className="py-3 pr-6">
                      <Link
                        href={`/jobs/${j.id}`}
                        className="text-[14px] tabular-nums text-[var(--color-ink)] hover:underline"
                      >
                        {j.jobNo}
                      </Link>
                    </td>
                    <td className="py-3 pr-6 text-[14px] text-[var(--color-ink)]">
                      {j.customer}
                    </td>
                    <td className="py-3 pr-6 text-[13px] text-[var(--color-ink-2)]">
                      {j.product}
                    </td>
                    <td className="py-3 text-[14px] tabular-nums text-right text-[var(--color-ink)]">
                      {formatCny(j.amountCny)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </main>
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub: string
  tone?: 'success'
}) {
  const valueColor =
    tone === 'success' ? 'text-[var(--color-success)]' : 'text-[var(--color-ink)]'
  return (
    <div>
      <p className={`text-[44px] font-semibold tracking-tight tabular-nums ${valueColor}`}>
        {value}
      </p>
      <p className="label mt-3">{label}</p>
      <p className="text-[12px] text-[var(--color-ink-3)] mt-1 tabular-nums">{sub}</p>
    </div>
  )
}

function Section({
  title,
  subtitle,
  count,
  empty,
  children,
}: {
  title: string
  subtitle?: string
  count: number
  empty: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-16">
      <div className="flex items-baseline justify-between mb-5">
        <div>
          <h2 className="text-[20px] font-semibold tracking-tight text-[var(--color-ink)]">
            {title}
          </h2>
          {subtitle && (
            <p className="text-[12px] text-[var(--color-ink-3)] mt-0.5">{subtitle}</p>
          )}
        </div>
        <p className="label tabular-nums">{count}</p>
      </div>
      {count === 0 ? (
        <p className="text-[13px] text-[var(--color-ink-3)] py-10 text-center border-t border-[var(--color-border)]">
          {empty}
        </p>
      ) : (
        children
      )}
    </section>
  )
}
