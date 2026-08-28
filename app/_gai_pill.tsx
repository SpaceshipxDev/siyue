'use client'
// The prod-side 改一下 pill: one link to the same page on the mirror.
// allowed=false → the pill is still there, greyed with a lock; tapping it explains who can open it.
import { useEffect, useState } from 'react'

const pillStyle = (locked: boolean): React.CSSProperties => ({
  position: 'fixed', left: '50%', bottom: 'max(20px, env(safe-area-inset-bottom))', transform: 'translateX(-50%)',
  zIndex: 2147483000, display: 'inline-flex', alignItems: 'center', gap: 7, height: 40, padding: '0 16px 0 14px',
  borderRadius: 999, fontSize: 14, fontWeight: 500, textDecoration: 'none', whiteSpace: 'nowrap', border: 0, cursor: 'pointer',
  background: locked ? 'var(--color-muted-bg, #f1efe9)' : 'var(--color-ink, #14130f)',
  color: locked ? 'var(--color-ink-3, #9b988f)' : 'var(--color-bg, #fbfaf7)',
  boxShadow: locked ? '0 4px 14px rgba(20,19,15,.10)' : '0 8px 24px rgba(20,19,15,.18)',
  font: 'inherit',
})

function Pen() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}
function Lock() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

export function GaiPill({ host, allowed, skip }: { host: string; allowed: boolean; skip?: string }) {
  const [href, setHref] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const p = window.location.pathname
    let hidden = false
    try { hidden = new RegExp(skip || '^/(login|w/|join)|/print/|/pdf$').test(p) } catch { hidden = /^\/(login|w\/|join)/.test(p) }
    if (hidden) return
    setHref(host.replace(/\/$/, '') + p + window.location.search)
  }, [host, skip])
  if (!href) return null
  if (allowed) {
    return (
      <a href={href} title="在镜像上改这一页，改好再上线" style={pillStyle(false)}>
        <Pen /><span>改一下</span>
      </a>
    )
  }
  return (
    <>
      {open && (
        <div
          role="dialog"
          style={{
            position: 'fixed', left: '50%', bottom: 'calc(max(20px, env(safe-area-inset-bottom)) + 52px)', transform: 'translateX(-50%)',
            zIndex: 2147483001, width: 'min(360px, calc(100vw - 24px))', padding: '16px 18px 14px', background: '#fff',
            border: '1px solid var(--color-border, #e7e5e0)', borderRadius: 18, boxShadow: '0 12px 40px rgba(20,19,15,.14)',
            display: 'flex', flexDirection: 'column', gap: 10, color: 'var(--color-ink, #14130f)',
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600 }}>「改一下」还没对你开通</div>
          <div style={{ fontSize: 13, lineHeight: '19px', color: 'var(--color-ink-2, #5a5851)' }}>
            这个功能可以直接改这个系统并上线，所以只对老板开通的人开放。让老板在「管理员工」里为你打开这个开关就行。
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setOpen(false)} style={{ height: 34, padding: '0 16px', borderRadius: 10, border: 0, background: 'var(--color-ink, #14130f)', color: 'var(--color-bg, #fbfaf7)', font: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>好</button>
          </div>
        </div>
      )}
      <button type="button" onClick={() => setOpen((v) => !v)} title="需要老板开通" style={pillStyle(true)}>
        <Lock /><span>改一下</span>
      </button>
    </>
  )
}
