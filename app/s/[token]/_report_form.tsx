'use client'

import { useState } from 'react'
import { scanReport } from './_actions'

// One control, one button. The number arrives prefilled with everything
// still open at this OP (the 9-of-10 case is "I finished the rest"), and
// the worker can − / + or type over it. Submitting IS the report — no
// mode choice, no second path.
export function ReportForm({
  token,
  src,
  remaining,
}: {
  token: string
  src: string
  remaining: number
}) {
  const [qty, setQty] = useState(remaining)

  const clamp = (n: number) => Math.max(1, Math.min(remaining, Math.floor(n) || 1))

  return (
    <form action={scanReport} className="mt-4">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="src" value={src} />
      <input type="hidden" name="mode" value="some" />
      <div className="flex items-stretch gap-2">
        <button
          type="button"
          aria-label="减一件"
          onClick={() => setQty((q) => clamp(q - 1))}
          className="w-14 h-14 shrink-0 text-[22px] font-semibold border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] active:bg-[var(--color-bg)]"
        >
          −
        </button>
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
          className="flex-1 h-14 text-center text-[24px] font-semibold font-mono border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] outline-none focus:border-[var(--color-ink)] tabular-nums"
        />
        <button
          type="button"
          aria-label="加一件"
          onClick={() => setQty((q) => clamp(q + 1))}
          className="w-14 h-14 shrink-0 text-[22px] font-semibold border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] active:bg-[var(--color-bg)]"
        >
          +
        </button>
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
