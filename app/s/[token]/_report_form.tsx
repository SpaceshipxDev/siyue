'use client'

import { useState } from 'react'
import { scanReport } from './_actions'

// One control, one button. The number arrives prefilled with everything
// still open at the selected stage (the 9-of-10 case is "I finished the
// rest"); −10/−/+/+10 or typing over it adjusts. Submitting IS the report —
// no mode choice, no second path. The stage rides along as a hidden field
// and is re-validated server-side against the part's own route.
export function ReportForm({
  token,
  src,
  stage,
  remaining,
}: {
  token: string
  src: string
  stage: string
  remaining: number
}) {
  const [qty, setQty] = useState(remaining)

  const clamp = (n: number) => Math.max(1, Math.min(remaining, Math.floor(n) || 1))

  const step = (d: number) => (
    <button
      type="button"
      aria-label={d > 0 ? `加${d}件` : `减${-d}件`}
      onClick={() => setQty((q) => clamp(q + d))}
      className={`h-14 shrink-0 font-semibold border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] active:bg-[var(--color-bg)] ${
        Math.abs(d) === 10 ? 'w-14 text-[15px]' : 'w-12 text-[22px]'
      }`}
    >
      {d > 0 ? (d === 1 ? '+' : `+${d}`) : d === -1 ? '−' : `−${-d}`}
    </button>
  )

  return (
    <form action={scanReport} className="mt-4">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="src" value={src} />
      <input type="hidden" name="stage" value={stage} />
      <input type="hidden" name="mode" value="some" />
      <div className="flex items-stretch gap-1.5">
        {step(-10)}
        {step(-1)}
        <input
          name="qty"
          type="number"
          inputMode="numeric"
          min={1}
          max={remaining}
          value={qty}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10)
            setQty(Number.isFinite(n) ? Math.max(1, Math.min(remaining, n)) : 1)
          }}
          onFocus={(e) => e.target.select()}
          className="flex-1 min-w-0 h-14 text-center text-[26px] font-semibold font-mono border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] outline-none focus:border-[var(--color-ink)] tabular-nums"
        />
        {step(1)}
        {step(10)}
      </div>
      <button
        type="submit"
        className="mt-3 w-full h-14 text-[16px] font-semibold bg-[var(--color-success)] text-white rounded-[3px]"
      >
        报工 · {qty} 件{qty >= remaining ? ' · 本工序完成' : ''}
      </button>
    </form>
  )
}
