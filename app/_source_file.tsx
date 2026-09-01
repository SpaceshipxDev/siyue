'use client'

import { useCallback, useRef, useState, useTransition } from 'react'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { withBase } from '@/lib/base-path'

// 源文件 row — commerce-only widget for the original Excel that kicked off
// the job. Two things happen to this file and only two: 拿下来看 and 换一份。
//
// So the row says exactly that. The filename IS the download (click a
// filename to get the file — the same thing WeChat and every mail client
// do), which leaves ONE button in the row, and it carries a word rather than
// a glyph: 换一份. The old row had two near-identical arrows, one up one
// down, and you had to hover to find out which was which — a decision, every
// single time, on a row that only ever does two things.
//
// Dropping a file anywhere on the row works too and always did; now it says
// so while the row is empty, because that's the shortest path of all —
// straight from the chat window onto the order.
//
// Replacing overwrites in place, so the confirmation matters: with a
// same-named file nothing on screen would otherwise change. The button holds
// 已换 for a beat, then goes back to 换一份.

// One fixed width for 换一份 / 上传 / 已换 / 重试 / spinner, so committing a
// file never nudges the row.
const ACT_BTN =
  'shrink-0 inline-flex h-7 w-[62px] items-center justify-center rounded-[2px] border text-[12.5px] font-medium transition-colors disabled:opacity-60'

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

  // 已换 flash — a same-named replacement changes nothing on screen, so the
  // button says it happened.
  const [done, setDone] = useState(false)
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const upload = useCallback(
    (file: File) => {
      setError(null)
      if (doneTimer.current) clearTimeout(doneTimer.current)
      setDone(false)
      start(async () => {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('jobId', jobId)
        const r = await fetch(withBase('/api/source-file'), { method: 'POST', body: fd })
        const data = (await r.json()) as
          | { ok: true; url: string; fileName: string }
          | { ok: false; error: string }
        if (!data.ok) {
          setError(data.error || '替换失败')
          return
        }
        setOverride({ url: data.url, name: data.fileName })
        setDone(true)
        doneTimer.current = setTimeout(() => setDone(false), 2200)
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
      className={`flex items-center gap-3 px-4 h-12 rounded-[2px] border transition-colors ${
        drag
          ? 'border-[var(--color-ink)] bg-[var(--color-active-bg)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface)]'
      }`}
    >
      <span className="label shrink-0 text-[var(--color-ink-3)]">源文件</span>

      {/* 文件名就是下载 — 点名字拿文件, 微信和邮箱都是这样, 不用再认一个图标。 */}
      {hasFile && effectiveUrl ? (
        <a
          href={proxiedStorageUrl(effectiveUrl)}
          download={downloadName}
          title={`下载 ${downloadName}`}
          className="mono min-w-0 flex-1 truncate text-[13px] text-[var(--color-ink)] underline decoration-[var(--color-border-strong)] underline-offset-[3px] hover:decoration-[var(--color-ink)]"
        >
          {downloadName}
        </a>
      ) : (
        <span
          className={`mono min-w-0 flex-1 truncate text-[13px] ${
            hasFile ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-4)]'
          }`}
          title={hasFile ? downloadName : '尚未保留源文件'}
        >
          {hasFile ? downloadName : '尚未保留源文件 · 文件拖进来就行'}
        </span>
      )}

      {error && (
        <span
          className="shrink-0 truncate text-[12px] text-[var(--color-overdue)]"
          title={error}
        >
          {error}
        </span>
      )}

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
        title={hasFile ? '换一份源文件 · 也可以直接把文件拖到这一行' : '上传源文件 · 也可以直接拖进来'}
        className={`${ACT_BTN} ${
          error
            ? 'border-[var(--color-overdue)] text-[var(--color-overdue)] hover:bg-[var(--color-overdue-soft)]'
            : done
              ? 'border-[var(--color-success)] text-[var(--color-success)]'
              : 'border-[var(--color-border-strong)] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]'
        }`}
      >
        {pending ? (
          <SpinnerIcon />
        ) : error ? (
          '重试'
        ) : done ? (
          '已换'
        ) : hasFile ? (
          '换一份'
        ) : (
          '上传'
        )}
      </button>
    </div>
  )
}

// The only glyph left. 下载 and 上传 used to be two near-identical arrows
// here; the filename and the word 换一份 say it better than either did.

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
