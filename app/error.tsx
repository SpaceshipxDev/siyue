'use client'

import { useEffect } from 'react'

// Defense in depth for the failure mode that drove this whole effort:
// mainland users hitting the HK VM across the GFW frequently see RSC
// streams (page navigations, stale-JS server-action responses) get
// truncated mid-flight. Without this file, Next.js renders its blank
// "this page couldn't load · a server error occurred" overlay with no
// recovery path. With it, users get a calm "网络中断 · 重试" surface
// that re-renders on click — matching the survival pattern of a fresh
// HTTP request, which usually succeeds even when streamed responses fail.
//
// Inline-edit writes have been moved to the JSON dispatcher
// (lib/mutate.ts → app/api/mutate), so they never reach this boundary
// in normal use. This is for the residual cases: navigation to a fat
// force-dynamic page, server-action calls from stale-JS sessions, etc.

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[error.tsx]', error.message, error.digest)
  }, [error])

  return (
    <div className="flex-1 flex items-center justify-center px-6 py-16 min-h-[60vh]">
      <div className="max-w-[420px] w-full text-center">
        <p className="label text-[var(--color-overdue)] mb-3">网络中断</p>
        <h2 className="text-[20px] font-semibold tracking-tight text-[var(--color-ink)] mb-3">
          页面未能加载完成
        </h2>
        <p className="text-[13px] text-[var(--color-ink-2)] leading-relaxed mb-8">
          通常是连接到香港服务器的链路被截断 · 数据已经写入，不必担心丢失。
          请点击下方按钮重试。
        </p>
        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="px-5 py-2 text-[13px] tracking-wider rounded-[2px] bg-[var(--color-ink)] text-[var(--color-surface)] hover:opacity-80"
          >
            重试
          </button>
          <button
            type="button"
            onClick={() => {
              if (typeof window !== 'undefined') window.location.reload()
            }}
            className="px-5 py-2 text-[13px] tracking-wider rounded-[2px] border border-[var(--color-border-strong)] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:border-[var(--color-ink)]"
          >
            刷新页面
          </button>
        </div>
        {error.digest ? (
          <p className="mt-8 mono text-[10px] text-[var(--color-ink-4)]">
            ref · {error.digest}
          </p>
        ) : null}
      </div>
    </div>
  )
}
