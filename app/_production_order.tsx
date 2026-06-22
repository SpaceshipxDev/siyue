'use client'

import { useCallback, useState } from 'react'

// 生产单 export row — the "file out" twin of the 源文件 "file in" row, sharing
// its exact geometry so the two stack into one tidy documents zone. Clicking
// fetches the freshly built .xlsx as a blob and saves it; we don't use a plain
// <a download> because generation takes a few seconds (part-photo fetches) and
// a dead button reads as broken — the spinner gives that feedback. A blob
// download is plain bytes, not an RSC stream, so it's safe over the HK VM.

const ICON_BTN =
  'shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-[2px] transition-colors'

export function ProductionOrderRow({
  jobId,
  jobNo,
}: {
  jobId: string
  jobNo?: string
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const exportFile = useCallback(async () => {
    if (pending) return
    setError(null)
    setPending(true)
    try {
      const r = await fetch(`/jobs/${jobId}/production-order`)
      if (!r.ok) throw new Error(`导出失败 (${r.status})`)
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `生产单_${jobNo || 'draft'}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败')
    } finally {
      setPending(false)
    }
  }, [jobId, jobNo, pending])

  return (
    <div className="flex items-center gap-3 px-4 h-12 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
      <span className="label shrink-0 text-[var(--color-ink-3)]">生产单</span>

      <span className="mono text-[13px] flex-1 min-w-0 truncate text-[var(--color-ink-4)]">
        {pending ? '正在生成…' : '一键导出 Excel'}
      </span>

      <button
        type="button"
        onClick={exportFile}
        disabled={pending}
        title={error ?? '导出生产单'}
        aria-label="导出生产单"
        className={`${ICON_BTN} ${
          pending
            ? 'text-[var(--color-ink-3)]'
            : error
              ? 'text-[var(--color-overdue)] hover:bg-[var(--color-active-bg)]'
              : 'text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:bg-[var(--color-active-bg)]'
        }`}
      >
        {pending ? <SpinnerIcon /> : <DownloadIcon />}
      </button>
    </div>
  )
}

// Matches the glyph set in _source_file.tsx so the two rows read as siblings.
function DownloadIcon() {
  return (
    <Glyph>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </Glyph>
  )
}

function SpinnerIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="animate-spin"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}
