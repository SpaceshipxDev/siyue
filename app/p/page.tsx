import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { BRAND } from '@/lib/brand'
import { SESSION_COOKIE } from '@/lib/session'
import { ScanClient } from './_client'
import { resolveActor } from '../s/[token]/_worker'
import { MobileNav } from '../_mobile_nav'
import { workerToday } from '@/lib/packets'
import { TallyStrip } from '../s/[token]/_tally'

// 拍照报工 — the floor's front door, and the phone's default landing (the
// proxy sends session-less mobile hits on / here). A worker takes one still
// photo, reviews it, and explicitly confirms before matching starts. A match
// lands on the same /s/<token> surface the printed QR opens. Public like /s:
// the sheet in hand is the credential.

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: `拍照报工 · ${BRAND.shortName}`,
  description: '对准单子，自动识别，直接报工',
}

export default async function PhotoScanPage() {
  const jar = await cookies()
  // Same resolution as /s and scanReport: logged-in floor account first,
  // remembered public-scan name as the session-less fallback.
  const workerName = (await resolveActor()) || undefined
  const hasSession = Boolean(jar.get(SESSION_COOKIE)?.value)
  const tally = workerName ? await workerToday(workerName) : undefined
  return (
    <main className="min-h-dvh bg-[var(--color-bg)] pb-20 md:pb-0">
      <header className="h-12 px-4 bg-[var(--color-surface)] border-b border-[var(--color-border)] flex items-center justify-between">
        <span className="text-[13px] font-semibold">
          {BRAND.shortName} · 拍照报工
        </span>
        <span className="flex items-center gap-3">
          {workerName ? (
            <span className="text-[11px] text-[var(--color-ink-2)]">{workerName}</span>
          ) : null}
        </span>
      </header>
      <div className="mx-auto max-w-md px-4 pt-4">
        <TallyStrip pieces={tally?.pieces ?? 0} reports={tally?.reports ?? 0} />
      </div>
      <ScanClient workerName={workerName} />
      <p className="text-center text-[10px] text-[var(--color-ink-4)] pt-2 pb-6">
        {BRAND.software} · {BRAND.domain}
      </p>
      <MobileNav current="scan" authenticated={hasSession} />
    </main>
  )
}
