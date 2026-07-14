'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useRouter } from 'next/navigation'
import type { JobSourceImageGroup } from '@/lib/packets'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { withBase } from '@/lib/base-path'
import { JobPhotoUploader } from '@/app/_job_photo_uploader'

type BaseImage = {
  url: string
  label: string
  photoId?: string
  componentId: string
  name: string
  partNo?: string
}

type DisplayImage = BaseImage & {
  /** src actually rendered — carries a client cache-bust after a rotate. */
  displayUrl: string
  /** transient CSS rotation applied during a rotate round-trip (degrees). */
  rotation: number
  status?: 'rotating' | 'deleting'
}

function withCacheBust(url: string, token: string): string {
  return url + (url.includes('?') ? '&' : '?') + '_r=' + token
}

export function JobSourceImages({
  groups,
  jobId,
  partId,
  canAttach,
}: {
  groups: JobSourceImageGroup[]
  jobId: string
  partId?: string
  canAttach: boolean
}) {
  const router = useRouter()
  const images = useMemo<BaseImage[]>(
    () =>
      groups.flatMap((group) =>
        group.images.map((image) => ({
          url: image.url,
          label: image.label,
          photoId: image.photoId,
          componentId: group.componentId,
          name: group.name,
          partNo: group.partNo,
        })),
      ),
    [groups],
  )

  const [active, setActive] = useState<number | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [busts, setBusts] = useState<Record<string, string>>({})
  const [overlays, setOverlays] = useState<Record<string, number>>({})
  const [pending, setPending] = useState<Record<string, 'rotating' | 'deleting'>>(
    {},
  )
  const [error, setError] = useState<string>()
  const bustSeq = useRef(0)

  const display = useMemo<DisplayImage[]>(
    () =>
      images
        .filter((image) => !image.photoId || !hidden.has(image.photoId))
        .map((image) => {
          const bust = image.photoId ? busts[image.photoId] : undefined
          return {
            ...image,
            displayUrl: proxiedStorageUrl(
              bust ? withCacheBust(image.url, bust) : image.url,
            ),
            rotation: image.photoId ? overlays[image.photoId] ?? 0 : 0,
            status: image.photoId ? pending[image.photoId] : undefined,
          }
        }),
    [images, hidden, busts, overlays, pending],
  )

  // Keep the open index valid as photos are deleted out from under the viewer.
  // Reconciled during render (guarded, so it can't loop) rather than in an
  // effect, so the viewer never paints a frame pointed at a removed photo.
  if (active !== null) {
    if (display.length === 0) setActive(null)
    else if (active > display.length - 1) setActive(display.length - 1)
  }

  const rotate = useCallback(
    async (photoId: string, dir: 1 | -1) => {
      setPending((prev) => {
        if (prev[photoId]) return prev
        return { ...prev, [photoId]: 'rotating' }
      })
      setError(undefined)
      // Optimistic: spin the currently-shown image immediately.
      setOverlays((prev) => ({ ...prev, [photoId]: (prev[photoId] ?? 0) + dir * 90 }))
      try {
        const response = await fetch(withBase(`/api/job-photos/${photoId}`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ direction: dir < 0 ? 'ccw' : 'cw' }),
        })
        const json = (await response.json()) as { ok: boolean; error?: string }
        if (!response.ok || !json.ok) throw new Error(json.error || '旋转失败')

        // Server baked the rotation into the same key. Preload the re-encoded
        // image, THEN swap the src and unwind the overlay in one paint so the
        // corrected orientation never flashes double-rotated.
        const base = images.find((image) => image.photoId === photoId)?.url
        const token = String(++bustSeq.current)
        if (base) {
          const nextUrl = proxiedStorageUrl(withCacheBust(base, token))
          await new Promise<void>((resolve) => {
            const preload = new window.Image()
            preload.onload = () => resolve()
            preload.onerror = () => resolve()
            preload.src = nextUrl
          })
          setBusts((prev) => ({ ...prev, [photoId]: token }))
        }
        setOverlays((prev) => ({
          ...prev,
          [photoId]: (prev[photoId] ?? 0) - dir * 90,
        }))
      } catch (cause) {
        setOverlays((prev) => ({
          ...prev,
          [photoId]: (prev[photoId] ?? 0) - dir * 90,
        }))
        setError(cause instanceof Error ? cause.message : '旋转失败')
      } finally {
        setPending((prev) => {
          const next = { ...prev }
          delete next[photoId]
          return next
        })
      }
    },
    [images],
  )

  const remove = useCallback(
    async (photoId: string) => {
      let already = false
      setPending((prev) => {
        if (prev[photoId]) {
          already = true
          return prev
        }
        return { ...prev, [photoId]: 'deleting' }
      })
      if (already) return
      setError(undefined)
      // Optimistic hide — the viewer's index effect advances to the next photo.
      setHidden((prev) => new Set(prev).add(photoId))
      try {
        const response = await fetch(withBase(`/api/job-photos/${photoId}`), {
          method: 'DELETE',
        })
        const json = (await response.json()) as { ok: boolean; error?: string }
        if (!response.ok || !json.ok) throw new Error(json.error || '删除失败')
        router.refresh()
      } catch (cause) {
        setHidden((prev) => {
          const next = new Set(prev)
          next.delete(photoId)
          return next
        })
        setError(cause instanceof Error ? cause.message : '删除失败')
      } finally {
        setPending((prev) => {
          const next = { ...prev }
          delete next[photoId]
          return next
        })
      }
    },
    [router],
  )

  if (display.length === 0 && (!canAttach || !partId)) return null

  const activeImage =
    active !== null && active < display.length ? display[active] : null

  return (
    <section className="mb-8" aria-labelledby="job-source-images-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2
          id="job-source-images-title"
          className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]"
        >
          工单照片
        </h2>
        <div className="flex items-center gap-3">
          <p className="label text-[var(--color-ink-3)]">{display.length} 张</p>
          {canAttach && partId ? (
            <JobPhotoUploader jobId={jobId} partId={partId} />
          ) : null}
        </div>
      </div>
      {error ? (
        <p className="mb-2 text-[12px] text-[var(--color-overdue)]">{error}</p>
      ) : null}
      {display.length > 0 ? (
        <div className="flex gap-3 overflow-x-auto rounded-[3px] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          {display.map((image, index) => (
            <button
              key={`${image.componentId}-${image.photoId ?? image.url}-${index}`}
              type="button"
              onClick={() => setActive(index)}
              aria-label={`查看 ${image.partNo || image.name} 的${image.label}`}
              className="group w-28 shrink-0 text-left"
            >
              <span className="relative block h-24 overflow-hidden rounded-[3px] border border-[var(--color-border-strong)] bg-[var(--color-muted-bg)] transition-colors group-hover:border-[var(--color-ink)]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.displayUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  style={
                    image.rotation
                      ? { transform: `rotate(${image.rotation}deg)` }
                      : undefined
                  }
                  className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]"
                />
                {image.status ? (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/30">
                    <Spinner />
                  </span>
                ) : null}
              </span>
              <span className="mt-1.5 block truncate text-[11px] font-medium text-[var(--color-ink-2)]">
                {image.partNo || image.name}
              </span>
              <span className="block text-[10px] text-[var(--color-ink-4)]">
                {image.label}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="rounded-[3px] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-5 text-[12px] text-[var(--color-ink-3)]">
          还没有照片。现在添加,之后拍到同类照片即可匹配到此工单。
        </div>
      )}
      {activeImage ? (
        <JobSourceImageViewer
          images={display}
          index={active as number}
          onIndexChange={setActive}
          onClose={() => setActive(null)}
          onRotate={rotate}
          onDelete={remove}
        />
      ) : null}
    </section>
  )
}

function Spinner() {
  return (
    <svg
      className="h-5 w-5 animate-spin text-white"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        className="opacity-90"
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}

const MIN_SCALE = 1
const MAX_SCALE = 6

function JobSourceImageViewer({
  images,
  index,
  onIndexChange,
  onClose,
  onRotate,
  onDelete,
}: {
  images: DisplayImage[]
  index: number
  onIndexChange: (index: number) => void
  onClose: () => void
  onRotate: (photoId: string, dir: 1 | -1) => void
  onDelete: (photoId: string) => void
}) {
  const image = images[index]
  const stageRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const [interacting, setInteracting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Reset zoom/pan/confirm when a new photo enters the frame. Done during
  // render (the recommended pattern) rather than an effect so the fresh photo
  // never paints one frame at the previous photo's zoom.
  const [shownIndex, setShownIndex] = useState(index)
  if (shownIndex !== index) {
    setShownIndex(index)
    setScale(1)
    setTx(0)
    setTy(0)
    setConfirmDelete(false)
  }

  // Active pointers for pan/pinch, plus the gesture bookkeeping.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{
    mode: 'none' | 'pan' | 'pinch'
    startScale: number
    startDist: number
    startTx: number
    startTy: number
    lastX: number
    lastY: number
    moved: boolean
  }>({
    mode: 'none',
    startScale: 1,
    startDist: 0,
    startTx: 0,
    startTy: 0,
    lastX: 0,
    lastY: 0,
    moved: false,
  })
  const lastTap = useRef<{ t: number; x: number; y: number }>({ t: 0, x: 0, y: 0 })

  const resetView = useCallback(() => {
    setScale(1)
    setTx(0)
    setTy(0)
  }, [])

  const clampTranslate = useCallback(
    (nextScale: number, x: number, y: number) => {
      const stage = stageRef.current
      if (!stage) return { x, y }
      const limitX = ((nextScale - 1) * stage.clientWidth) / 2
      const limitY = ((nextScale - 1) * stage.clientHeight) / 2
      return {
        x: Math.max(-limitX, Math.min(limitX, x)),
        y: Math.max(-limitY, Math.min(limitY, y)),
      }
    },
    [],
  )

  const zoomAround = useCallback(
    (clientX: number, clientY: number, nextScaleRaw: number) => {
      const stage = stageRef.current
      if (!stage) return
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScaleRaw))
      const rect = stage.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const px = clientX - cx
      const py = clientY - cy
      setScale((prevScale) => {
        const ratio = nextScale / prevScale
        setTx((prevTx) => {
          const nx = px - (px - prevTx) * ratio
          return clampTranslate(nextScale, nx, ty).x
        })
        setTy((prevTy) => {
          const ny = py - (py - prevTy) * ratio
          return clampTranslate(nextScale, tx, ny).y
        })
        return nextScale
      })
    },
    [clampTranslate, tx, ty],
  )

  const toggleZoom = useCallback(
    (clientX: number, clientY: number) => {
      if (scale > 1) resetView()
      else zoomAround(clientX, clientY, 2.5)
    },
    [scale, resetView, zoomAround],
  )

  const go = useCallback(
    (delta: number) => {
      if (images.length < 2) return
      onIndexChange((index + delta + images.length) % images.length)
    },
    [images.length, index, onIndexChange],
  )

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowLeft') go(-1)
      if (event.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [go, onClose])

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      event.preventDefault()
      const factor = Math.exp(-event.deltaY * 0.0015)
      zoomAround(event.clientX, event.clientY, scale * factor)
    },
    [scale, zoomAround],
  )

  const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y)

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      ;(event.target as Element).setPointerCapture?.(event.pointerId)
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      const g = gesture.current
      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()]
        g.mode = 'pinch'
        g.startScale = scale
        g.startDist = distance(a, b) || 1
        g.startTx = tx
        g.startTy = ty
        g.moved = true
        setInteracting(true)
      } else if (pointers.current.size === 1) {
        g.mode = scale > 1 ? 'pan' : 'none'
        g.startTx = tx
        g.startTy = ty
        g.lastX = event.clientX
        g.lastY = event.clientY
        g.moved = false
        if (g.mode === 'pan') setInteracting(true)
      }
    },
    [scale, tx, ty],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const stored = pointers.current.get(event.pointerId)
      if (!stored) return
      stored.x = event.clientX
      stored.y = event.clientY
      const g = gesture.current
      if (g.mode === 'pinch' && pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()]
        const nextScale = Math.max(
          MIN_SCALE,
          Math.min(MAX_SCALE, (g.startScale * distance(a, b)) / g.startDist),
        )
        const clamped = clampTranslate(nextScale, g.startTx, g.startTy)
        setScale(nextScale)
        setTx(clamped.x)
        setTy(clamped.y)
      } else if (g.mode === 'pan') {
        const dx = event.clientX - g.lastX
        const dy = event.clientY - g.lastY
        g.lastX = event.clientX
        g.lastY = event.clientY
        if (Math.abs(dx) + Math.abs(dy) > 2) g.moved = true
        setTx((prev) => clampTranslate(scale, prev + dx, ty).x)
        setTy((prev) => clampTranslate(scale, tx, prev + dy).y)
      }
    },
    [clampTranslate, scale, tx, ty],
  )

  const endPointer = useCallback(
    (event: React.PointerEvent) => {
      const g = gesture.current
      const wasTap =
        pointers.current.size === 1 && g.mode !== 'pinch' && !g.moved
      pointers.current.delete(event.pointerId)
      if (pointers.current.size === 0) {
        g.mode = 'none'
        setInteracting(false)
      } else if (pointers.current.size === 1) {
        g.mode = scale > 1 ? 'pan' : 'none'
      }

      if (wasTap) {
        const now = performance.now()
        const prev = lastTap.current
        const isDouble =
          now - prev.t < 300 &&
          Math.hypot(event.clientX - prev.x, event.clientY - prev.y) < 30
        if (isDouble) {
          toggleZoom(event.clientX, event.clientY)
          lastTap.current = { t: 0, x: 0, y: 0 }
        } else {
          lastTap.current = { t: now, x: event.clientX, y: event.clientY }
        }
      }
    },
    [scale, toggleZoom],
  )

  if (!image) return null

  const editable = Boolean(image.photoId)
  const busy = image.status
  const rotation = image.rotation

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${image.partNo || image.name} · ${image.label}`}
      className="fixed inset-0 z-[100] flex flex-col bg-black/92 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && scale === 1) onClose()
      }}
    >
      {/* Top bar — identity + close. */}
      <div className="flex items-start justify-between gap-4 px-4 pt-4 text-white md:px-6 md:pt-5">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold">
            {image.partNo || image.name}
            <span className="ml-2 font-normal text-white/55">{image.label}</span>
          </p>
          <p className="mt-0.5 text-[11px] text-white/50">
            {index + 1} / {images.length}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        >
          <IconClose />
        </button>
      </div>

      {/* Stage — the zoom/pan surface. */}
      <div
        ref={stageRef}
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        style={{ cursor: scale > 1 ? 'grab' : 'default' }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && scale === 1) onClose()
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.displayUrl}
          alt={`${image.partNo || image.name} · ${image.label}`}
          draggable={false}
          className="pointer-events-none absolute inset-0 m-auto max-h-full max-w-full object-contain"
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale}) rotate(${rotation}deg)`,
            transition: interacting ? 'none' : 'transform 0.18s ease-out',
          }}
        />

        {images.length > 1 ? (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label="上一张"
              className="absolute left-2 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 md:left-4"
            >
              <IconChevron dir="left" />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              aria-label="下一张"
              className="absolute right-2 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 md:right-4"
            >
              <IconChevron dir="right" />
            </button>
          </>
        ) : null}

        {busy ? (
          <span className="absolute inset-0 z-20 flex items-center justify-center bg-black/20">
            <Spinner />
          </span>
        ) : null}
      </div>

      {/* Control pill — zoom always; rotate/delete only for user photos. */}
      <div className="flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
        <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/10 p-1 backdrop-blur-md">
          <PillButton
            label="缩小"
            onClick={() => {
              const stage = stageRef.current
              if (stage) {
                const rect = stage.getBoundingClientRect()
                zoomAround(rect.left + rect.width / 2, rect.top + rect.height / 2, scale / 1.5)
              }
            }}
            disabled={scale <= MIN_SCALE}
          >
            <IconZoomOut />
          </PillButton>
          <PillButton
            label="放大"
            onClick={() => {
              const stage = stageRef.current
              if (stage) {
                const rect = stage.getBoundingClientRect()
                zoomAround(rect.left + rect.width / 2, rect.top + rect.height / 2, scale * 1.5)
              }
            }}
            disabled={scale >= MAX_SCALE}
          >
            <IconZoomIn />
          </PillButton>

          {editable ? (
            <>
              <span className="mx-0.5 h-6 w-px bg-white/15" aria-hidden="true" />
              <PillButton
                label="旋转"
                onClick={() => image.photoId && onRotate(image.photoId, 1)}
                disabled={Boolean(busy)}
              >
                <IconRotate />
              </PillButton>
              {confirmDelete ? (
                <button
                  type="button"
                  onClick={() => image.photoId && onDelete(image.photoId)}
                  disabled={Boolean(busy)}
                  className="flex h-10 items-center gap-1.5 rounded-full bg-[#ff453a] px-3.5 text-[13px] font-semibold text-white transition-colors hover:bg-[#ff6961] disabled:opacity-50"
                >
                  <IconTrash />
                  确认删除
                </button>
              ) : (
                <PillButton
                  label="删除"
                  danger
                  onClick={() => setConfirmDelete(true)}
                  disabled={Boolean(busy)}
                >
                  <IconTrash />
                </PillButton>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function PillButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15 disabled:opacity-30 disabled:hover:bg-transparent ${
        danger ? 'hover:text-[#ff6961]' : ''
      }`}
    >
      {children}
    </button>
  )
}

function IconClose() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function IconChevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={dir === 'left' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconZoomIn() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path
        d="M11 8v6M8 11h6M20 20l-3.5-3.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function IconZoomOut() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path
        d="M8 11h6M20 20l-3.5-3.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function IconRotate() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 9a8 8 0 1 0 .5 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M20 4v5h-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconTrash() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M10 11v6M14 11v6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
