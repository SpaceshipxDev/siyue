'use client'

import { useRouter } from 'next/navigation'

export function BackButton({ fallback = '/' }: { fallback?: string }) {
  const router = useRouter()
  const onClick = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back()
    } else {
      router.push(fallback)
    }
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-[12px] tracking-wider text-[var(--color-ink-2)] hover:text-[var(--color-ink)] transition-colors"
    >
      <span aria-hidden>←</span>
      <span>返回</span>
    </button>
  )
}
