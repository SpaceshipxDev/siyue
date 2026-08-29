'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'

// Floating horizontal scrollbar that stays in reach while a wide table
// extends past the window. The native horizontal bar on a wide table sits at
// the TABLE's bottom edge — two screens below wherever you are in a long list,
// so reading the far-right columns of row 12 meant scrolling to the end of the
// list, dragging sideways, and scrolling back. And on macOS (and most modern
// browsers with overlay scrollbars enabled) ::-webkit-scrollbar styling is
// overridden by the OS "autohide" preference. So we render our own thumb and
// place it ourselves: persistent on every platform, every browser.
//
// Where it sits: against the bottom of the window while the table runs past
// it, and against the table's own bottom edge once that edge comes into view
// — so the control is always touching the thing it scrolls, never stranded at
// the foot of a screen the table already ended on.
//
// Pair with `siyue-hscroll-hide-native` on the scroll container so the only
// horizontal control the user sees is this one.
export function StickyHorizontalScrollbar({
  containerRef,
}: {
  containerRef: RefObject<HTMLDivElement | null>
}) {
  const barRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  // Single recompute path. Imperative DOM writes — recompute fires on every
  // window/container scroll frame, so going through React state would re-
  // render the component (and any siblings sharing parent context) 60×/sec.
  useEffect(() => {
    const container = containerRef.current
    const bar = barRef.current
    const thumb = thumbRef.current
    if (!container || !bar || !thumb) return

    let lastVisible: boolean | null = null

    const recompute = () => {
      const rect = container.getBoundingClientRect()
      const sw = container.scrollWidth
      const cw = container.clientWidth
      const hasOverflow = sw > cw + 1
      const intersects = rect.bottom > 0 && rect.top < window.innerHeight
      const shouldShow = hasOverflow && intersects

      // Track aligns with the container's left edge / width — same metaphor
      // as the macOS "always visible" scrollbar that hugs its scroll region,
      // not the window edges. Vertically it rides the window's bottom while
      // the table runs past it, then parks on the table's own bottom edge.
      bar.style.left = `${rect.left}px`
      bar.style.width = `${rect.width}px`
      bar.style.bottom = `${Math.max(0, window.innerHeight - rect.bottom)}px`

      if (hasOverflow) {
        const trackWidth = rect.width
        // 44px minimum guarantees a thumb you can actually grab on touch
        // and avoids the "single pixel" feel on very-wide tables.
        const thumbWidth = Math.max(44, trackWidth * (cw / sw))
        const scrollable = sw - cw
        const ratio = scrollable > 0 ? container.scrollLeft / scrollable : 0
        const thumbLeft = (trackWidth - thumbWidth) * ratio
        thumb.style.width = `${thumbWidth}px`
        thumb.style.transform = `translate3d(${thumbLeft}px, 0, 0)`
      }

      if (shouldShow !== lastVisible) {
        lastVisible = shouldShow
        setVisible(shouldShow)
      }
    }

    recompute()

    const ro = new ResizeObserver(recompute)
    ro.observe(container)
    const inner = container.firstElementChild
    if (inner) ro.observe(inner)

    container.addEventListener('scroll', recompute, { passive: true })
    window.addEventListener('scroll', recompute, { passive: true })
    window.addEventListener('resize', recompute)
    return () => {
      ro.disconnect()
      container.removeEventListener('scroll', recompute)
      window.removeEventListener('scroll', recompute)
      window.removeEventListener('resize', recompute)
    }
  }, [containerRef])

  // Drag the thumb to scroll. Pointer events handle mouse + touch + pen with
  // one path, and pointer capture keeps the drag alive even if the cursor
  // leaves the thumb's box mid-drag.
  useEffect(() => {
    const container = containerRef.current
    const bar = barRef.current
    const thumb = thumbRef.current
    if (!container || !bar || !thumb) return

    let dragState: {
      pointerId: number
      startX: number
      startScrollLeft: number
      scrollPerPx: number
    } | null = null

    const onPointerDown = (e: PointerEvent) => {
      const sw = container.scrollWidth
      const cw = container.clientWidth
      const scrollable = sw - cw
      if (scrollable <= 0) return
      const trackWidth = bar.getBoundingClientRect().width
      const thumbWidth = Math.max(44, trackWidth * (cw / sw))
      const travel = trackWidth - thumbWidth
      if (travel <= 0) return
      dragState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startScrollLeft: container.scrollLeft,
        scrollPerPx: scrollable / travel,
      }
      thumb.setPointerCapture(e.pointerId)
      thumb.classList.add('is-dragging')
      e.preventDefault()
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return
      const dx = e.clientX - dragState.startX
      container.scrollLeft = dragState.startScrollLeft + dx * dragState.scrollPerPx
    }
    const onPointerUp = (e: PointerEvent) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return
      try {
        thumb.releasePointerCapture(e.pointerId)
      } catch {}
      thumb.classList.remove('is-dragging')
      dragState = null
    }

    thumb.addEventListener('pointerdown', onPointerDown)
    thumb.addEventListener('pointermove', onPointerMove)
    thumb.addEventListener('pointerup', onPointerUp)
    thumb.addEventListener('pointercancel', onPointerUp)
    return () => {
      thumb.removeEventListener('pointerdown', onPointerDown)
      thumb.removeEventListener('pointermove', onPointerMove)
      thumb.removeEventListener('pointerup', onPointerUp)
      thumb.removeEventListener('pointercancel', onPointerUp)
    }
  }, [containerRef])

  // Click anywhere on the track (outside the thumb) to page-jump the table.
  // Matches the macOS "jump to spot that's clicked" behavior at ~one viewport
  // per click, scaled down to 0.9 so each click leaves a sliver of visual
  // continuity with the previous frame.
  useEffect(() => {
    const container = containerRef.current
    const bar = barRef.current
    const thumb = thumbRef.current
    if (!container || !bar || !thumb) return

    const onClick = (e: MouseEvent) => {
      if (e.target === thumb || thumb.contains(e.target as Node)) return
      const barRect = bar.getBoundingClientRect()
      const thumbRect = thumb.getBoundingClientRect()
      const clickX = e.clientX
      const cw = container.clientWidth
      const direction = clickX < thumbRect.left ? -1 : clickX > thumbRect.right ? 1 : 0
      if (direction === 0) return
      container.scrollBy({ left: direction * cw * 0.9, behavior: 'smooth' })
      // No selection side-effects from bar clicks
      e.preventDefault()
      void barRect
    }
    bar.addEventListener('mousedown', onClick)
    return () => bar.removeEventListener('mousedown', onClick)
  }, [containerRef])

  // Forward wheel events on the bar to horizontal scroll of the container,
  // so a casual scroll over the strip moves the table even without grabbing
  // the thumb. Deltas from vertical wheel get mapped to horizontal.
  useEffect(() => {
    const container = containerRef.current
    const bar = barRef.current
    if (!container || !bar) return

    const onWheel = (e: WheelEvent) => {
      const dx = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      if (dx === 0) return
      container.scrollLeft += dx
      e.preventDefault()
    }
    bar.addEventListener('wheel', onWheel, { passive: false })
    return () => bar.removeEventListener('wheel', onWheel)
  }, [containerRef])

  return (
    <div
      ref={barRef}
      aria-hidden="true"
      className="siyue-sticky-hscroll"
      style={{
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      <div ref={thumbRef} className="siyue-sticky-hscroll-thumb" />
    </div>
  )
}
