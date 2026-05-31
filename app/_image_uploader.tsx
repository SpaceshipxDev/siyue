'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { mutate } from '@/lib/mutate'
import { proxiedStorageUrl } from '@/lib/storage-url'

// Cross-component event used by the batch photo uploader on /import/[id] to
// tell each per-row ComponentImageUploader that its component just got a new
// image. Avoids the router.refresh() that would otherwise be needed to pick
// up the change — refresh is a fat RSC stream and the GFW kills it.
type ImageUpdatedDetail = { componentId: string; url: string | null }
const IMAGE_UPDATED_EVENT = 'siyue:component-image-updated'

export function dispatchComponentImageUpdated(detail: ImageUpdatedDetail) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<ImageUpdatedDetail>(IMAGE_UPDATED_EVENT, { detail }),
  )
}

type Props = {
  jobId: string
  componentId: string
  imageUrl: string | undefined
  size?: number
  readOnly?: boolean
}

export function ComponentImageUploader({
  jobId,
  componentId,
  imageUrl,
  size = 64,
  readOnly = false,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  // Local override for the server-rendered URL prop. After a successful
  // upload/clear we update this and render it instead of the prop, so the
  // user sees the new state immediately without a router.refresh() (which
  // would trigger the fat RSC re-stream that the GFW kills on mainland → HK
  // links). The next natural navigation re-renders /jobs/[id] or
  // /import/[id] from the DB and the prop catches up.
  // `null` = explicitly cleared. `undefined` = no local change yet.
  const [override, setOverride] = useState<string | null | undefined>(undefined)
  const effectiveUrl = override === undefined ? imageUrl : override ?? undefined

  // Listen for batch uploads from BatchPhotoUploader (sibling component on
  // the import page that uploads N images at once). It dispatches one event
  // per successful upload so we can update our local override without a
  // page-wide refresh.
  useEffect(() => {
    const onUpdate = (e: Event) => {
      const ce = e as CustomEvent<ImageUpdatedDetail>
      if (ce.detail.componentId !== componentId) return
      setOverride(ce.detail.url)
    }
    window.addEventListener(IMAGE_UPDATED_EVENT, onUpdate)
    return () => window.removeEventListener(IMAGE_UPDATED_EVENT, onUpdate)
  }, [componentId])

  const upload = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        setError('需图片文件')
        return
      }
      setBusy(true)
      setError(undefined)
      try {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('jobId', jobId)
        fd.append('componentId', componentId)
        const r = await fetch('/api/upload-image', { method: 'POST', body: fd })
        const data = (await r.json()) as
          | { ok: true; url: string }
          | { ok: false; error: string }
        if (!('ok' in data) || !data.ok) {
          setError('error' in data ? data.error : '上传失败')
          return
        }
        setOverride(data.url)
        dispatchComponentImageUpdated({ componentId, url: data.url })
      } catch (err) {
        setError(err instanceof Error ? err.message : '上传失败')
      } finally {
        setBusy(false)
      }
    },
    [componentId, jobId],
  )

  const onPick = (files: FileList | null) => {
    if (!files || files.length === 0) return
    void upload(files[0])
  }

  const clear = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await mutate({
        kind: 'setComponentImage',
        jobId,
        componentId,
        imageUrl: null,
      })
      setOverride(null)
      dispatchComponentImageUpdated({ componentId, url: null })
    } catch (err) {
      setError(err instanceof Error ? err.message : '移除失败')
    } finally {
      setBusy(false)
    }
  }

  const px = `${size}px`

  if (readOnly) {
    return (
      <div
        style={{ width: px, height: px }}
        className="relative overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]"
      >
        {effectiveUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={proxiedStorageUrl(effectiveUrl)}
            alt="零件图"
            loading="lazy"
            decoding="async"
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] tracking-wider text-[var(--color-ink-4)]">
            —
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          if (e.dataTransfer.files?.[0]) void upload(e.dataTransfer.files[0])
        }}
        onClick={() => inputRef.current?.click()}
        title={effectiveUrl ? '点击更换 / 拖拽图片' : '点击或拖拽图片上传'}
        style={{ width: px, height: px }}
        className={`relative cursor-pointer overflow-hidden rounded-[2px] border transition-colors ${
          drag
            ? 'border-[var(--color-ink)] bg-[var(--color-active-bg)]'
            : effectiveUrl
              ? 'border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:border-[var(--color-ink)]'
              : 'border-dashed border-[var(--color-border-strong)] bg-[var(--color-muted-bg)] hover:border-[var(--color-ink)]'
        } ${busy ? 'opacity-60' : ''}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => onPick(e.target.files)}
        />
        {effectiveUrl ? (
          // Plain <img> is intentional: dynamic local /uploads paths shouldn't go
          // through next/image's optimizer (no static analysis, and we want
          // print-template friendly raw bytes).
          // loading="lazy" so dozens of part thumbs on a job page don't all
          // race onto window.load — China clients otherwise sit on Chrome's
          // tab spinner until every image finishes through the GFW link.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={proxiedStorageUrl(effectiveUrl)}
            alt="零件图"
            loading="lazy"
            decoding="async"
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] tracking-wider text-[var(--color-ink-3)]">
            {busy ? '…' : '+ 图'}
          </div>
        )}
      </div>
      {effectiveUrl ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            void clear()
          }}
          className="label text-[var(--color-ink-3)] hover:text-[var(--color-overdue)]"
        >
          移除
        </button>
      ) : null}
      {error ? (
        <span className="label text-[var(--color-overdue)]" title={error}>
          失败
        </span>
      ) : null}
    </div>
  )
}
