'use client'

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

// The answer to "why did nothing happen?" — shown at the button the user just
// pressed, never as a page-blocking modal or a browser alert().
//
// The rule it enforces lives in lib/auth.ts (canDeletePartRow etc); this only
// states it. One eyebrow, one sentence of what, one sentence of who — no
// apology, no icon, no color. Anchored to the trigger rather than centered on
// screen so the eye never leaves the row it was on.

const W = 260

export function PermissionDenied({
  anchor,
  eyebrow = '权限',
  title,
  body,
  onClose,
}: {
  // The trigger's bounding rect, captured at click time.
  anchor: DOMRect
  eyebrow?: string
  title: string
  body: string
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  // Same dismissal rules as the 工序 picker: outside click, Escape, or any
  // scroll (a fixed panel's anchor rect goes stale the moment the sheet moves).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  // Centered on the trigger, clamped to the viewport; flips above when the
  // trigger sits near the bottom of the window.
  const left = Math.max(
    8,
    Math.min(anchor.left + anchor.width / 2 - W / 2, window.innerWidth - W - 8),
  )
  const openUp = window.innerHeight - anchor.bottom < 150
  const pos = openUp
    ? { left, bottom: window.innerHeight - anchor.top + 8 }
    : { left, top: anchor.bottom + 8 }

  return createPortal(
    <div
      ref={ref}
      role="alertdialog"
      aria-label={title}
      style={{ ...pos, width: W }}
      className="fixed z-50 rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[0_10px_32px_rgba(0,0,0,0.14),0_0_0_0.5px_rgba(0,0,0,0.05)]"
    >
      <div className="px-4 pt-3 pb-3.5">
        <p className="label text-[var(--color-ink-4)]">{eyebrow}</p>
        <h3 className="mt-1.5 text-[14px] font-semibold tracking-tight text-[var(--color-ink)]">
          {title}
        </h3>
        <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-ink-2)]">
          {body}
        </p>
      </div>
      <div className="border-t border-[var(--color-border)] px-1.5 py-1.5">
        <button
          type="button"
          autoFocus
          onClick={onClose}
          className="w-full rounded-[2px] py-1.5 text-[12px] tracking-wider text-[var(--color-ink-2)] transition-colors hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)]"
        >
          知道了
        </button>
      </div>
    </div>,
    document.body,
  )
}

// One wording for the 删除零件 refusal, shared by the job sheet and the import
// draft so the floor hears the same sentence on both screens.
export const DELETE_PART_DENIED = {
  title: '无删除权限',
  body: '删除零件会一并删掉它的报工记录，仅限授权人员操作。需要删除请找 于海伟 或 商务。',
} as const
