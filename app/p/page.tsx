import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { BRAND } from '@/lib/brand'
import { SESSION_COOKIE } from '@/lib/session'
import { ScanClient } from './_client'
import { WORKER_COOKIE, decodeWorker } from '../s/[token]/_worker'

// 拍照报工 — the floor's front door, and the phone's default landing (the
// proxy sends session-less mobile hits on / here). The page opens straight
// into a live camera port; the matcher resolves which part the sheet in view
// belongs to and the phone lands on the same /s/<token> surface the printed
// QR opens. Public like /s: the sheet in hand is the credential.

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: `拍照报工 · ${BRAND.shortName}`,
  description: '对准单子，自动识别，直接报工',
}

export default async function PhotoScanPage() {
  const jar = await cookies()
  const workerName = decodeWorker(jar.get(WORKER_COOKIE)?.value) || undefined
  // Mobile hits on '/' always land here (proxy) — logged-in staff (PMC/boss)
  // get a small escape back to the board; workers never see it.
  const hasSession = Boolean(jar.get(SESSION_COOKIE)?.value)
  return (
    <main className="min-h-dvh bg-[var(--color-bg)]">
      <header className="h-12 px-4 bg-[var(--color-surface)] border-b border-[var(--color-border)] flex items-center justify-between">
        <span className="text-[13px] font-semibold">
          {BRAND.shortName} · 拍照报工
        </span>
        <span className="flex items-center gap-3">
          {workerName ? (
            <span className="text-[11px] text-[var(--color-ink-2)]">{workerName}</span>
          ) : null}
          {hasSession ? (
            <a href="/?board=1" className="text-[11px] text-[var(--color-ink-3)] underline">
              工单
            </a>
          ) : null}
        </span>
      </header>
      <ScanClient workerName={workerName} />
      <p className="text-center text-[10px] text-[var(--color-ink-4)] pt-2 pb-6">
        {BRAND.software} · {BRAND.domain}
      </p>
    </main>
  )
}
