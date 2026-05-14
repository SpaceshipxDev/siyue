import {
  allOutsourceBlocks,
  blockClosedAt,
  daysFromToday,
  formatCny,
  isBlockClosed,
  vendorById,
  type OpenBlockRow,
  type Vendor,
} from '@/lib/data'
import { getJobs, getVendors } from '@/lib/db'
import { requireOutsourceManager } from '@/lib/auth'
import { Pill, TopBar } from '@/app/_ui'
import { BlockRow, VendorAddressEditor } from '@/app/_routing'

export const dynamic = 'force-dynamic'

export default async function OutsourcePage() {
  const user = await requireOutsourceManager()
  const [jobs, vendors] = await Promise.all([getJobs(), getVendors()])
  const all = allOutsourceBlocks(jobs)
  const open = all.filter((r) => !isBlockClosed(r.block))
  const archived = all.filter((r) => isBlockClosed(r.block))

  // Rush blocks may not have a price yet — skip nulls so they don't poison
  // the sum into NaN. Backfill comes via the BlockRow edit flow.
  const totalAmount = open.reduce((s, r) => s + (r.block.amountCny ?? 0), 0)
  const overdueCount = open.filter(
    (r) => daysFromToday(r.block.expectedReturn) < 0,
  ).length
  const pendingPriceCount = open.filter((r) => r.block.amountCny == null).length

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="外协台"
        subtitle="送出 · 在外 · 回厂"
        currentTab="外协"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
        right={
          <div className="flex items-center gap-2">
            <Pill tone="overdue" label="逾期" value={overdueCount} />
            {pendingPriceCount > 0 ? (
              <Pill tone="warning" label="待补金额" value={pendingPriceCount} />
            ) : null}
            <Pill tone="warning" label="在外" value={open.length} />
            <Pill tone="info" label="外发" value={formatCny(totalAmount)} />
            <Pill tone="neutral" label="已归档" value={archived.length} />
          </div>
        }
      />

      <main className="mx-auto w-full max-w-[1500px] px-4 md:px-10 py-6 md:py-10 flex-1">
        <div className="mb-6 flex items-baseline justify-between">
          <div>
            <p className="label mb-1">外协台</p>
            <h2 className="text-[28px] font-semibold tracking-tight text-[var(--color-ink)]">
              在外零件
            </h2>
            <p className="mt-1 text-[13px] text-[var(--color-ink-2)]">
              按供应商分组 · 按预计回厂排序 · 点 [已回厂] 收件 · 已回的归档保留
            </p>
          </div>
          <p className="label">
            {open.length} 在外 · {archived.length} 已归档
          </p>
        </div>

        <Section
          title="在外"
          rows={open}
          vendors={vendors}
          sortBy="expectedReturn"
          empty="暂无在外零件 — 从工单明细页 · 新增外协 送出"
        />

        {archived.length > 0 ? (
          <div className="mt-10 opacity-80">
            <Section
              title="已归档"
              rows={archived}
              vendors={vendors}
              sortBy="closedAt"
              empty="无归档"
            />
          </div>
        ) : null}
      </main>
    </div>
  )
}

function Section({
  title,
  rows,
  vendors,
  sortBy,
  empty,
}: {
  title: string
  rows: OpenBlockRow[]
  vendors: Vendor[]
  sortBy: 'expectedReturn' | 'closedAt'
  empty: string
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-sm border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] py-12 text-center">
        <p className="label mb-2">{title}</p>
        <p className="text-[13px] text-[var(--color-ink-3)]">{empty}</p>
      </div>
    )
  }
  // Group by vendor.
  const groups = new Map<string, { vendor?: Vendor; rows: OpenBlockRow[] }>()
  for (const r of rows) {
    const key = r.block.vendorId
    let g = groups.get(key)
    if (!g) {
      g = { vendor: vendorById(key, vendors), rows: [] }
      groups.set(key, g)
    }
    g.rows.push(r)
  }
  for (const g of groups.values()) {
    g.rows.sort((a, b) => {
      const aDate =
        sortBy === 'expectedReturn'
          ? a.block.expectedReturn
          : blockClosedAt(a.block) ?? ''
      const bDate =
        sortBy === 'expectedReturn'
          ? b.block.expectedReturn
          : blockClosedAt(b.block) ?? ''
      return sortBy === 'closedAt'
        ? bDate.localeCompare(aDate) // newest archived first
        : aDate.localeCompare(bDate)
    })
  }
  const groupList = Array.from(groups.entries())
    .map(([id, g]) => ({
      vendorId: id,
      vendor: g.vendor,
      rows: g.rows,
      total: g.rows.reduce((s, r) => s + (r.block.amountCny ?? 0), 0),
      overdue: g.rows.filter(
        (r) =>
          !isBlockClosed(r.block) && daysFromToday(r.block.expectedReturn) < 0,
      ).length,
    }))
    .sort(
      (a, b) =>
        b.overdue - a.overdue ||
        (a.vendor?.name.localeCompare(b.vendor?.name ?? '') ?? 0),
    )
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <p className="label">{title}</p>
        <p className="label">
          {rows.length} 块 · 合计 {formatCny(rows.reduce((s, r) => s + (r.block.amountCny ?? 0), 0))}
        </p>
      </div>
      <div className="space-y-8">
        {groupList.map((g) => (
          <VendorGroup key={g.vendorId} group={g} vendors={vendors} />
        ))}
      </div>
    </section>
  )
}

function VendorGroup({
  group,
  vendors,
}: {
  group: {
    vendorId: string
    vendor?: Vendor
    rows: OpenBlockRow[]
    total: number
    overdue: number
  }
  vendors: Vendor[]
}) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between border-b border-[var(--color-border)] pb-2">
        <div className="flex items-baseline gap-4 flex-wrap">
          <h3 className="text-[16px] font-medium tracking-tight text-[var(--color-ink)]">
            {group.vendor?.name ?? group.vendorId}
          </h3>
          {group.vendor?.notes ? (
            <span className="text-[12px] text-[var(--color-ink-3)]">
              {group.vendor.notes}
            </span>
          ) : null}
          {group.vendor ? <VendorAddressEditor vendor={group.vendor} /> : null}
        </div>
        <div className="flex items-baseline gap-4">
          {group.overdue > 0 ? (
            <Pill tone="overdue" label="逾期" value={group.overdue} />
          ) : null}
          <Pill tone="info" label="件数" value={group.rows.length} />
          <Pill tone="info" label="金额" value={formatCny(group.total)} />
        </div>
      </div>
      <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2">
        {group.rows.map((r) => (
          <BlockRow
            key={r.block.id}
            jobId={r.jobId}
            jobNo={r.jobNo}
            customer={`${r.customer} · ${r.product}`}
            block={r.block}
            vendor={group.vendor}
            vendors={vendors}
          />
        ))}
      </div>
    </section>
  )
}
