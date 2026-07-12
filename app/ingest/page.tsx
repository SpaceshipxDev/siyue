import type { Metadata } from 'next'
import { requireUser } from '@/lib/auth'
import { BRAND } from '@/lib/brand'
import { IngestClient } from './_client'

// 拍照录入 — the programmer's whole job here: photograph every page of the
// printed packet (stamped 2D drawing + each CNC程序单), tap 完成, walk away.
// AI builds the component, sizes the OP route, mints the QR token, and
// registers the pages as matching references for the floor's /p loop.

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: `拍照录入 · ${BRAND.shortName}`,
  description: '拍下资料袋的每一页，自动建立生产零件',
}

export default async function IngestPage() {
  const user = await requireUser()
  return (
    <main className="min-h-dvh bg-[var(--color-bg)]">
      <header className="h-12 px-4 bg-[var(--color-surface)] border-b border-[var(--color-border)] flex items-center justify-between">
        <span className="text-[13px] font-semibold">
          {BRAND.shortName} · 拍照录入
        </span>
        <span className="text-[11px] text-[var(--color-ink-2)]">{user.name}</span>
      </header>
      <IngestClient />
    </main>
  )
}
