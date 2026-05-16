'use client'

import { useEffect, useState } from 'react'

// Tiny event-bus toast. The pattern: any client component calls `showToast`,
// the singleton ToastHost mounted in layout.tsx renders the pill.
//
// Visual reference: ChatGPT's "Link copied!" — top-center, green-tinted glass
// pill, soft drop, hold ~1.6s, dissolve. Single message at a time; a new
// showToast replaces whatever is on screen (the boss may pin three jobs in a
// row and the last one is the one he cares about).

type Tone = 'success' | 'neutral'
type ToastPayload = { id: number; text: string; tone: Tone }

const EVENT_NAME = '__siyue_toast__'

export function showToast(text: string, tone: Tone = 'success'): void {
  if (typeof window === 'undefined') return
  const detail: Omit<ToastPayload, 'id'> = { text, tone }
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }))
}

export function ToastHost() {
  const [toast, setToast] = useState<ToastPayload | null>(null)

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<Omit<ToastPayload, 'id'>>
      const next: ToastPayload = {
        id: Date.now() + Math.random(),
        text: ce.detail.text,
        tone: ce.detail.tone,
      }
      setToast(next)
    }
    window.addEventListener(EVENT_NAME, handler)
    return () => window.removeEventListener(EVENT_NAME, handler)
  }, [])

  // Auto-dismiss the *current* toast 1.6s after it lands. Keyed by id so a
  // new toast restarts the clock cleanly instead of inheriting the old one.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => {
      setToast((cur) => (cur && cur.id === toast.id ? null : cur))
    }, 1600)
    return () => clearTimeout(t)
  }, [toast])

  if (!toast) return null

  const accent =
    toast.tone === 'success'
      ? 'text-emerald-700 ring-emerald-200/70 bg-emerald-50/95'
      : 'text-[var(--color-ink)] ring-black/10 bg-white/95'

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed inset-x-0 top-4 z-[100] flex justify-center"
    >
      <div
        key={toast.id}
        className={`siyue-toast pointer-events-auto inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] font-medium shadow-[0_10px_30px_-12px_rgba(0,0,0,0.25)] ring-1 backdrop-blur ${accent}`}
        role="status"
      >
        {toast.tone === 'success' && (
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="shrink-0"
          >
            <path
              d="M3.5 8.4 6.5 11.4 12.5 5.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
        <span className="tracking-tight">{toast.text}</span>
      </div>
      <style jsx>{`
        .siyue-toast {
          animation: siyue-toast-in 220ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        @keyframes siyue-toast-in {
          from {
            opacity: 0;
            transform: translateY(-8px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
    </div>
  )
}
