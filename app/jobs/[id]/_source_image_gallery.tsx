'use client'

import { useEffect, useState } from 'react'
import { proxiedStorageUrl } from '@/lib/storage-url'

export type JobSourceImage = {
  componentId: string
  name: string
  partNo?: string
  url: string
}

export function JobSourceImageGallery({ images }: { images: JobSourceImage[] }) {
  const [active, setActive] = useState<number | null>(null)
  if (images.length === 0) return null

  return (
    <section className="mb-8" aria-labelledby="source-image-title">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="source-image-title" className="text-[15px] font-medium tracking-tight">
          上传源图
        </h2>
        <p className="label text-[var(--color-ink-3)]">{images.length} 张</p>
      </div>
      <div className="flex gap-3 overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        {images.map((image, index) => (
          <button
            key={`${image.componentId}-${index}`}
            type="button"
            onClick={() => setActive(index)}
            aria-label={`查看 ${image.partNo || image.name} 的上传源图`}
            className="group w-28 shrink-0 text-left"
          >
            <span className="block h-24 overflow-hidden rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-muted-bg)] transition-colors group-hover:border-[var(--color-ink)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={proxiedStorageUrl(image.url)}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]"
              />
            </span>
            <span className="mt-1.5 block truncate text-[11px] font-medium text-[var(--color-ink-2)]">
              {image.partNo || image.name}
            </span>
          </button>
        ))}
      </div>
      {active !== null ? (
        <ImageViewer
          images={images}
          index={active}
          onIndexChange={setActive}
          onClose={() => setActive(null)}
        />
      ) : null}
    </section>
  )
}

function ImageViewer({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  images: JobSourceImage[]
  index: number
  onIndexChange: (index: number) => void
  onClose: () => void
}) {
  const image = images[index]

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowLeft' && images.length > 1)
        onIndexChange((index - 1 + images.length) % images.length)
      if (event.key === 'ArrowRight' && images.length > 1)
        onIndexChange((index + 1) % images.length)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [images.length, index, onClose, onIndexChange])

  if (!image) return null
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${image.partNo || image.name} 上传源图`}
      className="fixed inset-0 z-[100] flex flex-col bg-black/90 p-3 md:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 text-white">
        <div>
          <p className="text-[14px] font-semibold">{image.partNo || image.name}</p>
          <p className="mt-0.5 text-[11px] text-white/65">{index + 1}/{images.length}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭上传源图"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-[24px] hover:bg-white/20"
        >
          ×
        </button>
      </div>
      <div className="relative mx-auto mt-3 flex min-h-0 w-full max-w-6xl flex-1 items-center justify-center">
        {images.length > 1 ? (
          <button type="button" onClick={() => onIndexChange((index - 1 + images.length) % images.length)} aria-label="上一张上传源图" className="absolute left-0 z-10 flex h-12 w-10 items-center justify-center bg-black/50 text-[28px] text-white hover:bg-black/75">‹</button>
        ) : null}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={proxiedStorageUrl(image.url)} alt={`${image.partNo || image.name} 上传源图`} className="max-h-full max-w-full object-contain" />
        {images.length > 1 ? (
          <button type="button" onClick={() => onIndexChange((index + 1) % images.length)} aria-label="下一张上传源图" className="absolute right-0 z-10 flex h-12 w-10 items-center justify-center bg-black/50 text-[28px] text-white hover:bg-black/75">›</button>
        ) : null}
      </div>
    </div>
  )
}
