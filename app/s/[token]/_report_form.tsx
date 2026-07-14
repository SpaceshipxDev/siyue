'use client'

import { useState } from 'react'
import { scanReport } from './_actions'

// One control, one button. The number arrives prefilled with everything
// still open at the selected stage (the 9-of-10 case is "I finished the
// rest"); −10/−/+/+10 or typing over it adjusts. Submitting IS the report —
// no mode choice, no second path. The button names the stage — the final
// confirmation of what's about to happen at the moment of commitment. The
// stage rides along as a hidden field and is re-validated server-side
// against the part's own route.
export function ReportForm({
  token,
  src,
  stage,
  stageName,
  remaining,
  actor,
  roster,
}: {
  token: string
  src: string
  stage: string
  stageName: string
  remaining: number
  actor?: string
  roster: string[]
}) {
  const [qty, setQty] = useState(remaining)

  const clamp = (n: number) => Math.max(1, Math.min(remaining, Math.floor(n) || 1))

  const step = (d: number, label?: string) => (
    <button
      type="button"
      aria-label={d > 0 ? `加${d}件` : `减${-d}件`}
      onClick={() => setQty((q) => clamp(q + d))}
      className="h-14 w-full font-semibold border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] active:bg-[var(--color-bg)] text-[20px]"
    >
      {label ?? (d > 0 ? '+' : '−')}
    </button>
  )

  return (
    <form action={scanReport} className="mt-3">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="src" value={src} />
      <input type="hidden" name="stage" value={stage} />
      <input type="hidden" name="mode" value="some" />
      {!actor ? (
        <label className="mb-3 block">
          <span className="mb-1.5 block text-[12px] font-semibold">报工人</span>
          <input
            name="actor"
            required
            maxLength={20}
            list={`worker-roster-${stage}`}
            autoComplete="name"
            placeholder={roster.length > 0 ? '选择或输入你的名字' : '输入你的名字'}
            className="h-12 w-full px-3 text-[16px] border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] outline-none focus:border-[var(--color-ink)]"
          />
          {roster.length > 0 ? (
            <datalist id={`worker-roster-${stage}`}>
              {roster.map((name) => <option key={name} value={name} />)}
            </datalist>
          ) : null}
          <span className="mt-1 block text-[11px] text-[var(--color-ink-3)]">
            这台手机第一次报工需要填一次，以后会自动记住。
          </span>
        </label>
      ) : null}
      {/* Keep the quantity at a guaranteed readable width on 320px phones.
          The old five-controls-in-one-row layout squeezed this input down to
          only a few pixels on narrow WeChat webviews. */}
      <div className="grid grid-cols-[3.5rem_minmax(5rem,1fr)_3.5rem] gap-2">
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
          className="min-w-0 h-14 text-center text-[26px] font-semibold font-mono border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] outline-none focus:border-[var(--color-ink)] tabular-nums"
        />
        {step(1)}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {step(-10, '−10 件')}
        {step(10, '+10 件')}
      </div>
      <button
        type="submit"
        className="mt-3 w-full h-14 text-[16px] font-semibold bg-[var(--color-success)] text-white rounded-[3px]"
      >
        {stageName} 报工 · {qty} 件{qty >= remaining ? ' · 本工序完成' : ''}
      </button>
    </form>
  )
}
