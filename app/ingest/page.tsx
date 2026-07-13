import type { Metadata } from 'next'
import { requireUser } from '@/lib/auth'
import { BRAND } from '@/lib/brand'
import { IngestClient } from './_client'
import { MobileNav } from '../_mobile_nav'

// 拍照录入 — photograph the packet, review Gemini's structured extraction,
// choose how far production has already progressed, then publish. Nothing is
// persisted until the explicit final confirmation.

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: `拍照录入 · ${BRAND.shortName}`,
  description: '拍下资料袋，核对识别内容并建立生产零件',
}

export default async function IngestPage() {
  const user = await requireUser()
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] pb-20 md:pb-0">
      <header className="h-12 px-4 bg-[var(--color-surface)] border-b border-[var(--color-border)] flex items-center justify-between">
        <span className="text-[13px] font-semibold">
          {BRAND.shortName} · 拍照录入
        </span>
        <span className="text-[11px] text-[var(--color-ink-2)]">{user.name}</span>
      </header>
      <IngestClient />
      <MobileNav current="ingest" authenticated />
    </main>
  )
}
