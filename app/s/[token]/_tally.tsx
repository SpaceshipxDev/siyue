'use client'

import { useEffect, useState } from 'react'

// The worker's daily tally — the number that makes 报工 feel like scoring,
// not paperwork. Counts up on every render so each report visibly moves it.
export function TallyStrip({
  pieces,
  reports,
  justAdded,
}: {
  pieces: number
  reports: number
  justAdded?: number
}) {
  const [shown, setShown] = useState(Math.max(0, pieces - (justAdded ?? pieces)))

  useEffect(() => {
    if (shown >= pieces) return
    const start = shown
    const delta = pieces - start
    const t0 = performance.now()
    const dur = Math.min(900, 250 + delta * 8)
    let raf = 0
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / dur)
      const eased = 1 - (1 - k) * (1 - k) * (1 - k)
      setShown(Math.round(start + delta * eased))
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pieces])

  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-[3px] px-4 py-3 flex items-baseline justify-between">
      <span className="text-[11px] text-[var(--color-ink-2)]">我今天已报</span>
      <span className="font-mono text-[26px] font-semibold tabular-nums leading-none">
        {shown}
        <span className="text-[12px] font-normal text-[var(--color-ink-2)] ml-1">件</span>
      </span>
      <span className="text-[11px] text-[var(--color-ink-3)]">{reports} 次</span>
    </div>
  )
}
