import Link from 'next/link'
import { TopBar } from '../_ui'
import { requireCommerce } from '@/lib/auth'
import { getCaiwuRows, getMasterRows } from '@/lib/db'
import type { CaiwuSheet } from '@/lib/data'
import type { MasterRow } from '@/lib/master'
import { CaiwuSheetGrid, type CaiwuJobLite } from './_caiwu'

export const dynamic = 'force-dynamic'

// 财务 — the finance clerk's two spreadsheets, nothing more. She kept these in
// raw Excel; this is the same sheet with the retyping removed (and the job link
// for free prefill). NOTHING is computed — see app/finance/_caiwu.tsx and
// supabase/migrations/0070_caiwu_rows.sql.
//
//   未开票 (default) — orders delivered/ordered but not yet (fully) invoiced.
//   已开票 · 收款    — invoices issued, now chasing collection.
//
// 财务 is money, so the page is commerce-only (requireCommerce); production
// never reaches it.

const TABS: { key: CaiwuSheet; label: string; href: string }[] = [
  { key: 'weikaipiao', label: '未开票', href: '/finance' },
  { key: 'kaipiao', label: '已开票 · 收款', href: '/finance?tab=kaipiao' },
]

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const user = await requireCommerce()
  const { tab } = await searchParams
  const sheet: CaiwuSheet = tab === 'kaipiao' ? 'kaipiao' : 'weikaipiao'

  const [items, masterRows] = await Promise.all([getCaiwuRows(sheet), getMasterRows()])

  const toLite = (r: MasterRow): CaiwuJobLite => ({
    id: r.id,
    jobNo: r.jobNo,
    customer: r.customer,
    contact: r.engineer ?? '',
    isShipped: r.isShipped,
  })

  // Join data for linked rows (shipped included — a row stays meaningful after
  // the job ships). Autocomplete offers 在产 jobs only.
  const jobById: Record<string, CaiwuJobLite> = {}
  const jobIndex: CaiwuJobLite[] = []
  for (const r of masterRows) {
    if (r.status === 'parsing' || r.status === 'draft' || r.status === 'failed') continue
    const lite = toLite(r)
    jobById[r.id] = lite
    if (!r.isShipped) jobIndex.push(lite)
  }

  const subtitle = sheet === 'weikaipiao' ? '未开票台账' : '已开票 · 收款'

  return (
    <div className="flex-1 flex flex-col">
      <TopBar
        title="财务"
        subtitle={subtitle}
        currentTab="财务"
        role={user.role}
        defaultStage={user.defaultStage}
        userName={user.name}
      />
      <main className="px-4 md:px-10 py-8 flex-1">
        <FinanceTabs sheet={sheet} />
        <CaiwuSheetGrid
          // Keyed by sheet: switching tabs remounts with that sheet's rows
          // instead of merging into the previous tab's local state.
          key={sheet}
          sheet={sheet}
          items={items}
          jobById={jobById}
          jobIndex={jobIndex}
        />
      </main>
    </div>
  )
}

// Sub-tab row — the same underline-active link idiom the page has always used.
// Server-rendered so the gate stays on the server.
function FinanceTabs({ sheet }: { sheet: CaiwuSheet }) {
  return (
    <div role="tablist" aria-label="财务视图" className="flex items-baseline gap-x-7 mb-7">
      {TABS.map((t) => {
        const active = t.key === sheet
        return (
          <Link
            key={t.key}
            href={t.href}
            role="tab"
            aria-selected={active}
            className={`pb-1 border-b transition-colors text-[15px] tracking-tight ${
              active
                ? 'border-[var(--color-ink)] font-semibold text-[var(--color-ink)]'
                : 'border-transparent font-medium text-[var(--color-ink-3)] hover:text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)]'
            }`}
          >
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}
