import type { Metadata } from 'next'
import { BRAND } from '@/lib/brand'
import { ScanClient } from './_client'

// 拍照报工 — the floor's front door. A worker photographs the packet's page
// (usually the stamped drawing), the matcher resolves which part that
// physical sheet belongs to, and the phone lands on the same /s/<token>
// surface the printed QR opens. Public like /s: the sheet in hand is the
// credential.

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: `拍照报工 · ${BRAND.shortName}`,
  description: '拍一下单子，直接报工',
}

export default function PhotoScanPage() {
  return (
    <main className="min-h-dvh bg-[var(--color-bg)]">
      <header className="h-12 px-4 bg-[var(--color-surface)] border-b border-[var(--color-border)] flex items-center justify-between">
        <span className="text-[13px] font-semibold">
          {BRAND.shortName} · 拍照报工
        </span>
      </header>
      <ScanClient />
      <p className="text-center text-[10px] text-[var(--color-ink-4)] pt-2 pb-6">
        {BRAND.software} · {BRAND.domain}
      </p>
    </main>
  )
}
