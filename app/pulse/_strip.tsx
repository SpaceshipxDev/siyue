'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useOptimistic, useTransition } from 'react'
import { formatCny, STAGES, type Stage } from '@/lib/data'
import type { StationWipRow } from '@/lib/pulse'

// Client-side strip so chip clicks give instant visual feedback. Without
// this, every chip click waits for proxy + cookie verify + master query
// before the highlight moves — the strip felt buggy and slow on real
// network.
//
// Two pieces of state at play:
//   • Reality: the `?stage=` URL param, read via useSearchParams. Drives
//     the eventually-correct highlight after the server roundtrip.
//   • Optimism: useOptimistic mirror that flips the moment the user
//     clicks. Renders before the route has finished resolving.
//
// router.push is wrapped in startTransition so React keeps the existing
// feed visible during the swap (no skeleton blink); the chip inversion
// covers the "I heard you" feedback.
export function StationStrip({
  wip,
  showMoney,
}: {
  wip: StationWipRow[]
  showMoney: boolean
}) {
  const router = useRouter()
  const sp = useSearchParams()
  const [, startTransition] = useTransition()

  const rawStage = sp.get('stage') ?? undefined
  const urlStage: Stage | undefined =
    rawStage && (STAGES as readonly string[]).includes(rawStage)
      ? (rawStage as Stage)
      : undefined

  // Optimistic mirror of urlStage. setActive(undefined) clears, setActive(s)
  // selects. Auto-resyncs to urlStage on every render that follows a real
  // URL change, so divergence can only persist for the transition window.
  const [active, setActive] = useOptimistic<Stage | undefined>(urlStage)

  const navigate = (next: Stage | undefined) => {
    const href = next === undefined
      ? '/pulse'
      : `/pulse?stage=${encodeURIComponent(next)}`
    startTransition(() => {
      setActive(next)
      router.push(href, { scroll: false })
    })
  }

  return (
    <nav
      aria-label="工段筛选"
      className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-9 gap-px bg-[var(--color-border)] border border-[var(--color-border)] rounded-md overflow-hidden mb-12"
    >
      {wip.map((row) => {
        const isActive = active === row.stage
        const isEmpty = row.partsHere === 0
        const next: Stage | undefined = isActive ? undefined : row.stage
        const href = next === undefined
          ? '/pulse'
          : `/pulse?stage=${encodeURIComponent(next)}`
        const headlineText = showMoney
          ? formatCny(row.wipCny)
          : isEmpty
            ? '—'
            : `${new Intl.NumberFormat('zh-CN').format(row.partsHere)} 件`
        const sublineText = isEmpty
          ? '—'
          : showMoney
            ? `${row.jobsHere} 单 · ${row.partsHere} 件`
            : `${row.jobsHere} 单`
        return (
          <Link
            key={row.stage}
            href={href}
            aria-current={isActive ? 'true' : undefined}
            // Intercept the click so we can paint the optimistic highlight
            // *before* the router starts navigating. The Link href is kept
            // so middle-click / cmd-click / right-click "open in new tab"
            // still works.
            onClick={(e) => {
              if (
                e.defaultPrevented ||
                e.metaKey ||
                e.ctrlKey ||
                e.shiftKey ||
                e.altKey ||
                e.button !== 0
              ) {
                return
              }
              e.preventDefault()
              navigate(next)
            }}
            className={`group flex flex-col gap-2 px-3 md:px-4 py-4 md:py-5 transition-colors ${
              isActive
                ? 'bg-[var(--color-ink)] text-[var(--color-bg)]'
                : 'bg-[var(--color-surface)] text-[var(--color-ink)] hover:bg-[var(--color-active-bg)]'
            }`}
          >
            <span
              className={`label tracking-[0.22em] ${
                isActive
                  ? 'text-[var(--color-bg)] opacity-70'
                  : 'text-[var(--color-ink-3)]'
              }`}
            >
              {row.stage}
            </span>
            <span
              className={`text-[18px] md:text-[22px] font-semibold tabular-nums tracking-tight ${
                isEmpty
                  ? isActive
                    ? 'opacity-50'
                    : 'text-[var(--color-ink-3)]'
                  : ''
              }`}
            >
              {headlineText}
            </span>
            <span
              className={`text-[11px] md:text-[12px] tabular-nums ${
                isActive
                  ? 'text-[var(--color-bg)] opacity-70'
                  : 'text-[var(--color-ink-3)]'
              }`}
            >
              {sublineText}
            </span>
            {row.partsUnpriced > 0 && (
              <span
                className={`text-[10px] tabular-nums tracking-wide ${
                  isActive
                    ? 'text-[var(--color-bg)] opacity-60'
                    : 'text-[var(--color-warning)]'
                }`}
              >
                {row.partsUnpriced} 未定价
              </span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
