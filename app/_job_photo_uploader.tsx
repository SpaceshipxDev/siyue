'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { withBase } from '@/lib/base-path'
import { downscaleToJpeg } from './_camera'

type UploadResponse = {
  ok: boolean
  count?: number
  registered?: number
  error?: string
}

export function JobPhotoUploader({
  jobId,
  partId,
  compact = false,
}: {
  jobId: string
  partId: string
  compact?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const [error, setError] = useState<string>()

  async function upload(files: File[]) {
    if (files.length === 0 || busy) return
    setBusy(true)
    setMessage(undefined)
    setError(undefined)
    try {
      const selected = files.slice(0, 8)
      const images = await Promise.all(
        selected.map((file) => downscaleToJpeg(file, 1800, 0.84)),
      )
      const body = new FormData()
      body.set('jobId', jobId)
      body.set('partId', partId)
      images.forEach((image, index) => {
        body.append('images', image, `job-photo-${index + 1}.jpg`)
      })
      const response = await fetch(withBase('/api/job-photos'), {
        method: 'POST',
        body,
      })
      const json = (await response.json()) as UploadResponse
      if (!response.ok || !json.ok) throw new Error(json.error || '照片添加失败')
      const count = json.count ?? images.length
      setMessage(`已添加 ${count} 张`)
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '照片添加失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className={compact ? 'inline-flex min-w-0 flex-col items-end' : 'block'}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          // Snapshot BEFORE clearing: on iOS WebKit the FileList is live and
          // resetting input.value empties it, silently dropping the upload.
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          void upload(files)
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className={
          compact
            ? 'min-h-10 rounded-[6px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-[12px] font-semibold text-[var(--color-ink)] active:bg-[var(--color-muted-bg)] disabled:opacity-50'
            : 'min-h-11 rounded-[4px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 text-[13px] font-semibold text-[var(--color-ink)] hover:border-[var(--color-ink)] disabled:opacity-50'
        }
      >
        {busy ? '正在添加…' : '＋ 添加匹配照片'}
      </button>
      {message ? (
        <span className="mt-1 text-[10px] font-medium text-[var(--color-success)]">
          {message}
        </span>
      ) : null}
      {error ? (
        <span className="mt-1 max-w-48 text-right text-[10px] text-[var(--color-overdue)]">
          {error}
        </span>
      ) : null}
    </span>
  )
}
