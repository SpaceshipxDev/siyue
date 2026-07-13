import type { Metadata } from 'next'
import { requireUser } from '@/lib/auth'
import { BRAND } from '@/lib/brand'
import { componentBoardRows } from '@/lib/packets'
import { MobileNav } from '../_mobile_nav'
import { MobileOrders } from './_mobile_orders'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: `工单历史 · ${BRAND.shortName}`,
}

export default async function OrdersPage() {
  const user = await requireUser()
  const rows = await componentBoardRows()
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] pb-24">
      <header className="h-12 px-4 bg-[var(--color-surface)] border-b border-[var(--color-border)] flex items-center justify-between">
        <span className="text-[13px] font-semibold">工单记录</span>
        <span className="text-[11px] text-[var(--color-ink-2)]">{user.name}</span>
      </header>
      <MobileOrders rows={rows} />
      <MobileNav current="history" authenticated />
    </main>
  )
}

