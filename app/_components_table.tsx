'use client'

import { useEffect, useRef } from 'react'

/**
 * Wraps the components table's horizontal scroll area. On mount (and when
 * myStage changes) we scroll so the user's stage column lands just past the
 * frozen identifier columns — earlier stages get pushed off-screen left so the
 * highlighted column reads as the focus, even when it sits late in the stack.
 */
export function ComponentsScrollArea({
  myStage,
  className,
  children,
}: {
  myStage: string | null | undefined
  className?: string
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const initial = useRef(true)

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

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}
