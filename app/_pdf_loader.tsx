'use client'

import { useEffect, useState } from 'react'

// Shown while the /pdf page is fetching the actual PDF bytes from /pdf/raw.
// Cold renders (Lambda warm-up + font fetch + image fetch + layout) take a
// few seconds; a blank tab during that window felt broken to the user. We
// fetch as a blob, then swap location.href to the blob URL so the browser's
// PDF viewer takes over in the same tab.

export function PdfLoader({
  rawHref,
  title,
}: {
  rawHref: string
  title: string
}) {
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string>('正在生成…')

  useEffect(() => {
    let cancelled = false
    let blobUrl: string | null = null

    const tick = setInterval(() => {
      if (cancelled) return
      setProgress((p) =>
        p.endsWith('……') ? '正在生成…' : p + '·',
      )
    }, 600)

    ;(async () => {
      try {
        const res = await fetch(rawHref, { cache: 'no-store' })
        if (cancelled) return
        if (!res.ok) {
          setError(`生成失败 (${res.status})`)
          return
        }
        const blob = await res.blob()
        if (cancelled) return
        blobUrl = URL.createObjectURL(blob)
        // Replace history entry so the back button skips the loader.
        window.location.replace(blobUrl)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : '网络错误')
      } finally {
        clearInterval(tick)
      }
    })()

    return () => {
      cancelled = true
      clearInterval(tick)
      // Don't revoke immediately — the navigation to blobUrl needs it alive.
      // Browser will GC when the tab closes.
    }
  }, [rawHref])

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-ink)]">
      <div className="flex flex-col items-center gap-5 px-8 py-10">
        <Spinner />
        <div className="text-center">
          <p className="text-[14px] font-medium tracking-wide">{title}</p>
          {error ? (
            <p className="mt-2 text-[12px] text-[var(--color-overdue)] max-w-[280px]">
              {error}
              <br />
              <a
                href={rawHref}
                className="underline mt-2 inline-block text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
              >
                直接打开 PDF
              </a>
            </p>
          ) : (
            <p className="mt-2 text-[11px] tracking-[0.18em] uppercase text-[var(--color-ink-3)]">
              {progress}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <div
      className="w-7 h-7 rounded-full border-2 border-[var(--color-border-strong)] border-t-[var(--color-ink)] animate-spin"
      aria-label="loading"
    />
  )
}
