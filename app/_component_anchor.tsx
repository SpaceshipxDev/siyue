'use client'

import { useEffect } from 'react'

/**
 * When the URL hash is `#c-<id>`, scrolls the matching <tr id="c-<id>"> into
 * view. Used so a deep-link can jump to a specific component on the job detail
 * page. (No highlight — the row just scrolls into view.)
 *
 * No state. Runs once on mount and again on every `hashchange` (same-page
 * link clicks).
 */
export function ComponentAnchorScroller() {
  useEffect(() => {
    const apply = () => {
      const hash = window.location.hash
      if (!hash.startsWith('#c-')) return
      const el = document.getElementById(hash.slice(1))
      if (!el) return
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    // Defer once so the components table has mounted (ComponentsScrollArea
    // also runs an initial scroll on mount; we want to win the second turn).
    const t = window.setTimeout(apply, 30)
    window.addEventListener('hashchange', apply)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('hashchange', apply)
    }
  }, [])
  return null
}
