// Top-of-viewport indeterminate progress bar shown while a route's
// loading.tsx is rendering — i.e. while RSC for the next page is in flight.
//
// Two behaviors deliberately tuned for the cross-border (China) hot path:
//   • 150ms delay before paint — sub-150ms nav doesn't flicker the bar at
//     all. Matches Safari's "don't flash spinner for instant loads."
//   • Indeterminate slide, not a fake-percent fill. A %-fill that doesn't
//     correspond to anything real reads as dishonest. The slide just says
//     "something is happening," which is the only truth we have here.
//
// Mounts inside each loading.tsx; React unmounts the loading boundary when
// the page resolves, taking the bar with it — no event plumbing required.

'use client'

import { useEffect, useState } from 'react'

export function NavProgress() {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 150)
    return () => clearTimeout(t)
  }, [])

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        zIndex: 9999,
        pointerEvents: 'none',
        overflow: 'hidden',
        opacity: visible ? 1 : 0,
        transition: 'opacity 120ms ease-out',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: '-30%',
          top: 0,
          bottom: 0,
          width: '30%',
          background:
            'linear-gradient(90deg, transparent 0%, var(--color-ink-2) 50%, transparent 100%)',
          animation: 'siyue-nav-slide 1.4s cubic-bezier(0.65, 0, 0.35, 1) infinite',
        }}
      />
      <style>{`
        @keyframes siyue-nav-slide {
          0%   { transform: translateX(0); }
          100% { transform: translateX(433%); }
        }
      `}</style>
    </div>
  )
}
