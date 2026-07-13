'use client'

import { useEffect, useState } from 'react'

// Live elapsed-time readout used inline beside the per-stage count on the
// station board. Renders just the number + unit; color and weight are
// inherited from the parent so the timer can blend into the cell's existing
// type system (no clock icon, no verbose prefix — context does the work).
//
// Tones differ only in the "fresh enough to call it 刚到" cutoff:
//   pending     — flip to a real number after 30 min so the head can spot
//                 work that's been sitting.
//   in_progress — wait until 60 min; a row that just started reads weirdly
//                 with a clock immediately attached.
export function RowTimer({
  since,
  tone,
  className = '',
}: {
  /** ISO timestamp the clock starts counting from. */
  since: string
  tone: 'pending' | 'in_progress'
  className?: string
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5 * 60_000)
    return () => clearInterval(t)
  }, [])
  const start = Date.parse(since)
  if (!Number.isFinite(start)) return null
  const minutes = Math.max(0, Math.floor((now - start) / 60_000))
  return (
    <span className={`tabular-nums ${className}`}>
      {formatElapsed(minutes, tone)}
    </span>
  )
}

function formatElapsed(min: number, tone: 'pending' | 'in_progress'): string {
  const cutoff = tone === 'pending' ? 30 : 60
  if (min < cutoff) return '刚到'
  const h = min / 60
  if (h < 24) return `${Math.floor(h)} 时`
  const d = h / 24
  return `${d.toFixed(d < 10 ? 1 : 0)} 天`
}
