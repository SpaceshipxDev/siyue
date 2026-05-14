'use client'

import { useEffect, useState } from 'react'

// Sits at /…/pdf and immediately bounces to /…/pdf/raw, where the
// browser's native PDF viewer handles streaming, slow renders, and the
// 保存 / 下载 action.
//
// Earlier this page fetch()'d the raw URL into a JS blob and navigated
// to a blob:… URL. That looked snappy in Chrome on desktop but broke
// the download path in mainland-mobile browsers (WeChat in-app, UC, QQ):
// the blob URL rendered the PDF fine on screen, but tapping 保存 made
// the browser try to re-resolve a blob:… URL via HTTP, which fails as
// "无网络连接". Plus, JS-buffering the whole PDF into memory before
// displaying it made the GFW-truncation failure mode (the *entire*
// response must arrive intact before anything appears) much more likely
// to surface. A direct location.replace lets the browser stream the
// bytes natively, render the head of the PDF as soon as it arrives,
// and 保存 just re-uses the response from cache.
//
// We still render the spinner card for the brief moment between mount
// and the navigation taking effect, plus as a fallback if location
// changes are blocked (some embedded webviews refuse replace()).

export function PdfLoader({
  rawHref,
  title,
}: {
  rawHref: string
  title: string
}) {
  const [progress, setProgress] = useState<string>('正在生成…')

  useEffect(() => {
    const tick = setInterval(() => {
      setProgress((p) => (p.endsWith('……') ? '正在生成…' : p + '·'))
    }, 600)
    // replace() so the back button skips this loader page; the user's
    // history reads as if they went straight to the PDF.
    try {
      window.location.replace(rawHref)
    } catch {
      // Some embedded webviews block programmatic replace(). The
      // manual "如未跳转…" link below is the fallback.
    }
    return () => clearInterval(tick)
  }, [rawHref])

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-ink)]">
      <div className="flex flex-col items-center gap-5 px-8 py-10">
        <Spinner />
        <div className="text-center">
          <p className="text-[14px] font-medium tracking-wide">{title}</p>
          <p className="mt-2 text-[11px] tracking-[0.18em] uppercase text-[var(--color-ink-3)]">
            {progress}
          </p>
          <a
            href={rawHref}
            className="mt-4 inline-block text-[12px] text-[var(--color-ink-3)] underline underline-offset-4 hover:text-[var(--color-ink)]"
          >
            如未跳转，点此打开 PDF
          </a>
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
