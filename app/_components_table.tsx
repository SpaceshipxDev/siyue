'use client'

import { useEffect, useRef, type ReactNode } from 'react'

/**
 * Wraps the components table's horizontal scroll area. Two jobs:
 *
 *  1. On mount (and when myStage changes) scroll so the user's stage column
 *     lands just past the frozen identifier columns — earlier stages get
 *     pushed off-screen left so the highlighted column reads as the focus,
 *     even when it sits late in the stack.
 *
 *  2. 冻结表头. On a 60-part job the column names scroll off the top of the
 *     window and every ✓ below turns into a guess ("is this 编程 or 操机?").
 *     So the header is rendered a second time (`pinnedHeader`) into a strip
 *     that pins to the top of the window for exactly as long as the sheet's
 *     rows are on screen. Excel's frozen top row.
 *
 *     Why a copy instead of `position: sticky` on the <th>: the wrapper is a
 *     horizontal scroll container, which makes it the sticky containing block
 *     — a sticky header would freeze against the wrapper's own top edge, which
 *     never moves. The page, not the wrapper, is what scrolls vertically.
 *
 *     The strip is a label row and nothing more: no funnels, no hover, no
 *     clickable anything. It does absorb clicks rather than pass them through
 *     — a click falling through would land on a row hidden behind it.
 */
export function ComponentsScrollArea({
  myStage,
  className,
  pinnedHeader,
  children,
}: {
  myStage: string | null | undefined
  className?: string
  /** A copy of the sheet's <colgroup> + <thead>. Omit to disable the pin. */
  pinnedHeader?: ReactNode
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const initial = useRef(true)
  const stripRef = useRef<HTMLDivElement>(null)
  const stripTableRef = useRef<HTMLTableElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || !myStage) return
    const target = el.querySelector<HTMLElement>(
      `[data-stage-col="${CSS.escape(myStage)}"]`,
    )
    const edge = el.querySelector<HTMLElement>('[data-sticky-edge]')
    if (!target || !edge) return
    const targetRect = target.getBoundingClientRect()
    const edgeRect = edge.getBoundingClientRect()
    const delta = targetRect.left - edgeRect.right - 12
    if (delta <= 0) return
    el.scrollBy({ left: delta, behavior: initial.current ? 'auto' : 'smooth' })
    initial.current = false
  }, [myStage])

  useEffect(() => {
    const pane = ref.current
    const strip = stripRef.current
    const stripTable = stripTableRef.current
    if (!pane || !strip || !stripTable) return

    // The strip's own frozen columns: it isn't a scroll container, so they are
    // re-frozen by cancelling the table's translate on those cells (see
    // .pinned-head in globals.css).
    const frozen = Array.from(
      stripTable.querySelectorAll<HTMLElement>('th.sticky-col'),
    )
    let queued = false
    let shown = false

    const hide = () => {
      if (!shown) return
      strip.style.visibility = 'hidden'
      shown = false
    }

    const sync = () => {
      queued = false
      const table = pane.querySelector('table')
      const head = table?.querySelector('thead')
      // offsetParent === null: the 零件 tab is hidden (工单 tabs toggle it).
      if (!table || !head || pane.offsetParent === null) return hide()
      const paneRect = pane.getBoundingClientRect()
      const headRect = head.getBoundingClientRect()
      const h = headRect.height
      // Pin only while the real header has left the top of the window AND
      // there are still rows under it. Never a header floating over the page.
      if (headRect.top >= 0 || paneRect.bottom < h + 48) return hide()
      // Content box of the pane — the strip has to overlay the sheet exactly.
      strip.style.left = `${paneRect.left + pane.clientLeft}px`
      strip.style.width = `${pane.clientWidth}px`
      strip.style.height = `${h}px`
      stripTable.style.width = `${table.offsetWidth}px`
      const x = pane.scrollLeft
      stripTable.style.transform = `translateX(${-x}px)`
      for (const th of frozen) th.style.transform = `translateX(${x}px)`
      strip.style.visibility = 'visible'
      shown = true
    }

    const schedule = () => {
      if (queued) return
      queued = true
      requestAnimationFrame(sync)
    }

    schedule()
    // capture: scroll doesn't bubble, and this has to catch both the window
    // and the pane's own horizontal scrolling.
    window.addEventListener('scroll', schedule, { passive: true, capture: true })
    window.addEventListener('resize', schedule)
    // Rows added/removed, images loading, the window narrowing.
    const ro = new ResizeObserver(schedule)
    ro.observe(pane)
    // 零件 → 外协 tab switch flips `hidden` without firing a scroll event.
    const tab = pane.closest('[data-jobtab]')
    const mo = tab ? new MutationObserver(schedule) : null
    if (tab && mo) mo.observe(tab, { attributes: true, attributeFilter: ['hidden'] })

    return () => {
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      ro.disconnect()
      mo?.disconnect()
    }
  }, [pinnedHeader])

  return (
    <>
      <div ref={ref} className={className}>
        {children}
      </div>
      {pinnedHeader && (
        <div
          ref={stripRef}
          aria-hidden
          className="pinned-head"
          style={{ visibility: 'hidden' }}
        >
          <table ref={stripTableRef} className="sheet text-left text-[13px]">
            {pinnedHeader}
          </table>
        </div>
      )}
    </>
  )
}
