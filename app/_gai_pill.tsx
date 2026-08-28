'use client'
// The prod-side 改一下 pill: one link to the same page on the mirror. Hidden on login, vendor portal and print views.
import { useEffect, useState } from 'react'

export function GaiPill({ host }: { host: string }) {
  const [href, setHref] = useState<string | null>(null)
  useEffect(() => {
    const p = window.location.pathname
    if (/^\/(login|w\/|join)/.test(p) || /\/print\//.test(p) || /\/pdf$/.test(p)) return
    setHref(host.replace(/\/$/, '') + p + window.location.search)
  }, [host])
  if (!href) return null
  return (
    <a
      href={href}
      title="在镜像上改这一页，改好再上线"
      style={{
        position: 'fixed', left: '50%', bottom: 'max(20px, env(safe-area-inset-bottom))', transform: 'translateX(-50%)',
        zIndex: 2147483000, display: 'inline-flex', alignItems: 'center', gap: 7, height: 40, padding: '0 16px 0 14px',
        borderRadius: 999, background: 'var(--color-ink, #14130f)', color: 'var(--color-bg, #fbfaf7)', fontSize: 14, fontWeight: 500,
        boxShadow: '0 8px 24px rgba(20,19,15,.18)', textDecoration: 'none', whiteSpace: 'nowrap',
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
      <span>改一下</span>
    </a>
  )
}
