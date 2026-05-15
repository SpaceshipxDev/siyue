'use client'

import { useCallback, useRef, useState, useTransition } from 'react'
import { proxiedStorageUrl } from '@/lib/storage-url'

// 源文件 row — minimal commerce-only widget for the original Excel that
// kicked off the job. Filename is plain text; the trailing slot is two
// fixed-size icon buttons (download + replace). Geometry stays locked
// regardless of state — pending, error, or empty file all swap glyphs in
// place rather than nudging neighboring elements.

const ICON_BTN =
  'shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-sm transition-colors'

export function SourceFileRow({
  jobId,
  fileName,
  url,
}: {
  jobId: string
  fileName?: string
  url?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  // Hold the just-uploaded file locally so the row reflects the new state
  // without a router.refresh() — refresh would re-stream the whole job
  // detail RSC, which the GFW kills for mainland users on the HK VM.
  const [override, setOverride] = useState<{ url: string; name: string } | null>(
    null,
  )
  const effectiveUrl = override?.url ?? url
  const effectiveName = override?.name ?? fileName

  const upload = useCallback(
    (file: File) => {
      setError(null)
      start(async () => {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('jobId', jobId)
        const r = await fetch('/api/source-file', { method: 'POST', body: fd })
        const data = (await r.json()) as
          | { ok: true; url: string; fileName: string }
          | { ok: false; error: string }
        if (!data.ok) {
          setError(data.error || '替换失败')
          return
        }
        setOverride({ url: data.url, name: data.fileName })
      })
    },
    [jobId],
  )

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDrag(false)
    const f = e.dataTransfer.files?.[0]
    if (f) upload(f)
  }

  const hasFile = Boolean(effectiveName)
  const downloadName = effectiveName ?? '源文件'

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
      className={`flex items-center gap-3 px-4 h-12 rounded-sm border transition-colors ${
        drag
          ? 'border-[var(--color-ink)] bg-[var(--color-active-bg)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)]'
      }`}
    >
      <span className="label shrink-0 text-[var(--color-ink-3)]">源文件</span>

      <span
        className={`mono text-[13px] flex-1 min-w-0 truncate ${
          hasFile ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-4)]'
        }`}
        title={hasFile ? downloadName : '尚未保留源文件'}
      >
        {hasFile ? downloadName : '尚未保留源文件'}
      </span>

      {/* Download — always present, same square; live link when we have a
          URL, dimmed glyph (with explanatory title) otherwise. */}
      {effectiveUrl ? (
        <a
          href={proxiedStorageUrl(effectiveUrl)}
          download={downloadName}
          title={`下载 ${downloadName}`}
          aria-label="下载源文件"
          className={`${ICON_BTN} text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:bg-[var(--color-active-bg)]`}
        >
          <DownloadIcon />
        </a>
      ) : (
        <span
          title="无可下载源文件"
          aria-label="无可下载源文件"
          className={`${ICON_BTN} text-[var(--color-ink-4)] cursor-not-allowed`}
        >
          <DownloadIcon />
        </span>
      )}

      {/* Replace — same fixed square, different glyph for idle vs pending.
          Error surfaces as a red tint + hover tooltip rather than inline
          text that would shove the row around. */}
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) upload(f)
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={pending}
        title={error ?? (hasFile ? '替换源文件' : '上传源文件')}
        aria-label={hasFile ? '替换源文件' : '上传源文件'}
        className={`${ICON_BTN} ${
          pending
            ? 'text-[var(--color-ink-3)]'
            : error
              ? 'text-[var(--color-overdue)] hover:bg-[var(--color-active-bg)]'
              : 'text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:bg-[var(--color-active-bg)]'
        }`}
      >
        {pending ? <SpinnerIcon /> : <UploadIcon />}
      </button>
    </div>
  )
}

// Lucide-style 16px stroke icons. Inlined so we don't pull an icon dep just
// for two glyphs — keeps the bundle quiet and the line art crisp at the
// surrounding 13px label scale. All three icons share viewbox/stroke so
// they read as a coherent set inside their 28px square buttons.

function DownloadIcon() {
  return (
    <Glyph>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </Glyph>
  )
}

function UploadIcon() {
  return (
    <Glyph>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
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
