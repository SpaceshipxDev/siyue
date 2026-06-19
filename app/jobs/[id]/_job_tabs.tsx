'use client'

import { useEffect, useState } from 'react'

// 工单明细 section tabs — 零件 / 外协 / 财务. The page was one long scroll: the
// big parts table, then 外协 below it, then money. Now each is a tab so nobody
// scrolls past the parts table to reach 外协 or the 财务 summary.
//
// Deliberately a thin DOM toggle, NOT a slot-prop wrapper: the parts table is a
// 300-line server-rendered block with sticky columns and stage cells, and moving
// it into a client prop slot would be churn + risk. Instead each section stays
// exactly where it is in the server JSX, wrapped in <div data-jobtab="...">; this
// client bar flips their `hidden` flag. SSR shows 零件 + hides the rest, so the
// first paint is already correct before hydration.
export function JobTabs({
  tabs,
  rootId = 'jobtabs-root',
}: {
  tabs: { key: string; label: string }[]
  rootId?: string
}) {
  const [active, setActive] = useState(tabs[0]?.key ?? '')

  useEffect(() => {
    const root = document.getElementById(rootId)
    if (!root) return
    root.querySelectorAll<HTMLElement>('[data-jobtab]').forEach((el) => {
      el.hidden = el.getAttribute('data-jobtab') !== active
    })
  }, [active, rootId])

  // One section ⇒ no bar (production floor only ever sees 零件).
  if (tabs.length <= 1) return null

  return (
    <div
      role="tablist"
      aria-label="工单明细"
      className="flex items-baseline gap-x-7 mb-8 border-b border-[var(--color-border)]"
    >
      {tabs.map((t) => {
        const a = t.key === active
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={a}
            onClick={() => setActive(t.key)}
            className={`-mb-px pb-2 border-b-2 transition-colors text-[15px] tracking-tight ${
              a
                ? 'border-[var(--color-ink)] font-semibold text-[var(--color-ink)]'
                : 'border-transparent font-medium text-[var(--color-ink-3)] hover:text-[var(--color-ink-2)]'
            }`}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
