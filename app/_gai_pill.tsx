'use client'
// The prod-side 改一下 button: one quiet frosted control, bottom-right, linking to the same page on the mirror.
// allowed=false → same button, greyed with a lock; tapping it explains who can open it.
// Visually identical to the mirror overlay's button (overlay.css) so the two never feel like different products.
import { useEffect, useState } from 'react'

const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", "Microsoft YaHei", sans-serif'
const glass = {
  background: 'rgba(255,255,255,.78)', WebkitBackdropFilter: 'saturate(180%) blur(18px)', backdropFilter: 'saturate(180%) blur(18px)',
  border: '1px solid rgba(0,0,0,.08)', boxShadow: '0 1px 2px rgba(0,0,0,.05), 0 12px 32px rgba(0,0,0,.12)',
} as const

function pillStyle(locked: boolean, bottom: number): React.CSSProperties {
  return {
    ...glass, position: 'fixed', left: 0, right: 0, margin: '0 auto', width: 'max-content', bottom: `calc(${bottom}px + env(safe-area-inset-bottom))`,
    zIndex: 40, display: 'inline-flex', alignItems: 'center', gap: 6, height: 36, padding: '0 13px 0 11px', borderRadius: 999,
    color: locked ? '#8e8e93' : '#1d1d1f', fontFamily: FONT, fontSize: 13, fontWeight: 500, letterSpacing: '.01em',
    textDecoration: 'none', whiteSpace: 'nowrap', cursor: 'pointer',
  }
}

function Pen() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}
function Lock() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

export function GaiPill({ host, allowed, skip, bottom = 18 }: { host: string; allowed: boolean; skip?: string; bottom?: number }) {
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
      <a href={href} title="在镜像上改这一页，改好再上线" style={pillStyle(false, bottom)}>
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
            ...glass, background: 'rgba(255,255,255,.92)', position: 'fixed', left: 0, right: 0, margin: '0 auto',
            bottom: `calc(${bottom + 46}px + env(safe-area-inset-bottom))`, zIndex: 41, width: 'min(340px, calc(100vw - 36px))',
            padding: '14px 16px 12px', borderRadius: 18, display: 'flex', flexDirection: 'column', gap: 10, color: '#1d1d1f', fontFamily: FONT,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-.01em' }}>「改一下」还没对你开通</div>
          <div style={{ fontSize: 13, lineHeight: '19px', color: '#6e6e73' }}>
            这个功能可以直接改这个系统并上线，所以只对老板开通的人开放。让老板在「管理员工」里为你打开这个开关就行。
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setOpen(false)} style={{ height: 32, padding: '0 16px', borderRadius: 10, border: 0, background: '#1d1d1f', color: '#fff', fontFamily: FONT, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>好</button>
          </div>
        </div>
      )}
      <button type="button" onClick={() => setOpen((v) => !v)} title="需要老板开通" style={pillStyle(true, bottom)}>
        <Lock /><span>改一下</span>
      </button>
    </>
  )
}
