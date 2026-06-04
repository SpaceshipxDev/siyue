'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import type { PartPhoto, StageState, Verdict } from '@/lib/data'
import { BLOCKING_VERDICTS, isBlockingVerdict } from '@/lib/data'
import { mutate } from '@/lib/mutate'

// 检验 cell — replaces the ▶/⏸/✓ StageCellButton at the inspection stage.
// The inspector's gesture is a VERDICT, not a start/finish pair: clicking
// 重做/返修/外修 holds the part at 检验 with a red tag; clicking OK finishes
// the stage and the part flows to 手工. Clicking a verdict IS the inspection
// — no separate ▶ first (the mutation auto-promotes pending → in_progress).
//
// The cell itself stays compact (90×60 in the job-detail grid); clicking it
// opens a centered modal (same pattern as QtyEditor — a styled popover would
// get clipped by the grid overflow, see _cell.tsx). The modal carries the
// four verdict buttons plus the 检验照片 gallery/uploader. Read-only viewers
// (other stations browsing the job) still get the modal to SEE verdict +
// photos — they just can't click verdicts or upload.

const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif'

export function InspectionCell({
  jobId,
  componentId,
  componentName,
  state,
  canStart,
  photos,
  readOnly = false,
}: {
  jobId: string
  componentId: string
  componentName: string
  state: StageState
  canStart: boolean
  photos?: PartPhoto[]
  readOnly?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [optimistic, setOptimistic] = useState<StageState | null>(null)
  const [error, setError] = useState(false)

  // Same prev-prop sentinel as StageCellButton: hold the optimistic value
  // until the server-pushed prop catches up, killing the one-frame flicker.
  const [seenKey, setSeenKey] = useState(`${state.status}:${state.verdict ?? ''}`)
  const propKey = `${state.status}:${state.verdict ?? ''}`
  if (seenKey !== propKey) {
    setSeenKey(propKey)
    if (
      optimistic &&
      state.status === optimistic.status &&
      state.verdict === optimistic.verdict
    ) {
      setOptimistic(null)
    }
  }

  const display = optimistic ?? state

  const onVerdict = (verdict: Verdict) => {
    setError(false)
    setOptimistic(
      verdict === 'OK'
        ? { status: 'done', completedAt: undefined, verdict: 'OK' }
        : { status: 'in_progress', verdict },
    )
    setOpen(false)
    start(async () => {
      try {
        await mutate({ kind: 'setInspectionVerdict', jobId, componentId, verdict })
      } catch {
        setOptimistic(null)
        setError(true)
      }
    })
  }

  const onUndo = () => {
    setError(false)
    setOptimistic({ status: 'in_progress', verdict: display.verdict })
    setOpen(false)
    start(async () => {
      try {
        await mutate({ kind: 'undoStage', jobId, componentId, stage: '检验' })
      } catch {
        setOptimistic(null)
        setError(true)
      }
    })
  }

  const photoCount = photos?.length ?? 0

  // Blocked by upstream and nothing recorded here yet — same dim dash as the
  // standard cell, but still openable when there is something to look at.
  if (
    display.status === 'pending' &&
    !canStart &&
    photoCount === 0 &&
    !display.verdict
  ) {
    return (
      <div
        className="flex h-full w-full items-center justify-center py-2"
        aria-label="检验 · 待前序工段完成"
      >
        <span className="mono text-[13px] text-[var(--color-ink-4)]">—</span>
      </div>
    )
  }

  const blocking = isBlockingVerdict(display.verdict) && display.status !== 'done'

  let inner: React.ReactNode
  let cellBg = ''
  if (error) {
    cellBg = 'bg-[var(--color-overdue-soft)]'
    inner = (
      <span className="mono text-[11px] font-medium text-[var(--color-overdue)]">
        失败
      </span>
    )
  } else if (display.status === 'done') {
    inner = (
      <>
        <span className="text-[16px] leading-none font-semibold text-[var(--color-success)]">
          ✓
        </span>
        {state.completedAt ? (
          <span className="mono text-[10px] text-[var(--color-ink-3)]">
            {state.completedAt}
          </span>
        ) : null}
      </>
    )
  } else if (blocking) {
    cellBg = 'bg-[var(--color-overdue-soft)]'
    inner = (
      <span className="text-[12px] font-semibold tracking-wider text-[var(--color-overdue)]">
        {display.verdict}
      </span>
    )
  } else {
    // 待检 — arrived from 操机 (or mid-inspection without a verdict yet).
    const hot = display.status === 'in_progress' || canStart
    inner = (
      <span
        className={`text-[12px] font-medium tracking-wider ${
          hot ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-4)]'
        }`}
      >
        待检
      </span>
    )
    if (display.status === 'in_progress') cellBg = 'bg-[var(--color-warning-soft)]'
  }

  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(false)
          setOpen(true)
        }}
        title={
          display.verdictBy && display.verdict
            ? `检验 · ${display.verdict} · ${display.verdictBy}`
            : '检验 · 点击判定'
        }
        aria-label={`检验 · ${componentName}`}
        className={`flex h-full w-full flex-col items-center justify-center gap-0.5 py-2 transition-colors ${cellBg} ${
          error ? '' : 'hover:bg-[#f1eee4]'
        } focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] disabled:opacity-60`}
      >
        {inner}
        {photoCount > 0 ? (
          <span className="inline-flex items-center gap-0.5 mono text-[10px] text-[var(--color-ink-3)]">
            <CameraIcon />
            {photoCount}
          </span>
        ) : null}
      </button>
      {open ? (
        <InspectionModal
          jobId={jobId}
          componentId={componentId}
          componentName={componentName}
          state={display}
          serverState={state}
          readOnly={readOnly}
          pending={pending}
          photos={photos ?? []}
          onVerdict={onVerdict}
          onUndo={onUndo}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

function InspectionModal({
  jobId,
  componentId,
  componentName,
  state,
  serverState,
  readOnly,
  pending,
  photos,
  onVerdict,
  onUndo,
  onClose,
}: {
  jobId: string
  componentId: string
  componentName: string
  state: StageState
  serverState: StageState
  readOnly: boolean
  pending: boolean
  photos: PartPhoto[]
  onVerdict: (v: Verdict) => void
  onUndo: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const done = state.status === 'done'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`检验 · ${componentName}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[420px] max-w-[92vw] bg-[var(--color-surface)] border border-[var(--color-ink)] rounded-[2px] p-6 shadow-xl"
      >
        <p className="label text-[var(--color-ink-3)] mb-1">检验 · 判定</p>
        <h3 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)] mb-5 truncate">
          {componentName}
        </h3>

        {done ? (
          <div className="mb-5 flex items-center justify-between gap-3 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5">
            <span className="inline-flex items-baseline gap-2">
              <span className="text-[15px] font-semibold leading-none text-[var(--color-success)]">
                ✓ OK
              </span>
              {serverState.by ? (
                <span className="label text-[var(--color-ink-3)]">
                  经手 {serverState.by}
                  {serverState.completedAt ? ` · ${serverState.completedAt}` : ''}
                </span>
              ) : null}
            </span>
            {!readOnly ? (
              <button
                type="button"
                onClick={onUndo}
                disabled={pending}
                className="px-3 py-1.5 text-[12px] tracking-wider border border-[var(--color-border)] text-[var(--color-ink-2)] hover:bg-[#f1eee4] rounded-[2px] disabled:opacity-60"
              >
                撤销
              </button>
            ) : null}
          </div>
        ) : (
          <>
            {readOnly ? (
              <div className="mb-5 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5">
                {isBlockingVerdict(state.verdict) ? (
                  <span className="text-[13px] font-semibold text-[var(--color-overdue)]">
                    {state.verdict}
                    {state.verdictBy ? (
                      <span className="label ml-2 font-normal text-[var(--color-ink-3)]">
                        {state.verdictBy}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-[13px] text-[var(--color-ink-2)]">待检</span>
                )}
              </div>
            ) : (
              <div className="mb-5 grid grid-cols-4 gap-2">
                {BLOCKING_VERDICTS.map((v) => {
                  const active = state.verdict === v
                  return (
                    <button
                      key={v}
                      type="button"
                      disabled={pending}
                      onClick={() => onVerdict(v)}
                      aria-pressed={active}
                      className={`py-2.5 text-[13px] font-medium tracking-wider rounded-[2px] border transition-colors disabled:opacity-60 ${
                        active
                          ? 'border-[var(--color-overdue)] bg-[var(--color-overdue-soft)] text-[var(--color-overdue)]'
                          : 'border-[var(--color-border-strong)] text-[var(--color-ink-2)] hover:border-[var(--color-overdue)] hover:text-[var(--color-overdue)]'
                      }`}
                    >
                      {v}
                    </button>
                  )
                })}
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => onVerdict('OK')}
                  className="py-2.5 text-[13px] font-semibold tracking-wider rounded-[2px] bg-[var(--color-ink)] text-[var(--color-surface)] hover:opacity-80 disabled:opacity-60"
                >
                  OK
                </button>
              </div>
            )}
            {isBlockingVerdict(state.verdict) && !readOnly ? (
              <p className="label -mt-3 mb-5 text-[var(--color-ink-3)]">
                {state.verdict} 中 · 处理好后点 OK 放行
                {state.verdictBy ? ` · ${state.verdictBy}` : ''}
              </p>
            ) : null}
          </>
        )}

        <InspectionPhotos
          jobId={jobId}
          componentId={componentId}
          initial={photos}
          readOnly={readOnly}
        />

        <div className="mt-6 flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-[12px] tracking-wider border border-[var(--color-border)] text-[var(--color-ink-2)] hover:bg-[#f1eee4] rounded-[2px]"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

// Photo strip + uploader inside the modal. Local state seeded from the
// server-rendered list; uploads append optimistically from the API response
// so no router.refresh() (fat RSC stream, GFW-fragile) is needed.
function InspectionPhotos({
  jobId,
  componentId,
  initial,
  readOnly,
}: {
  jobId: string
  componentId: string
  initial: PartPhoto[]
  readOnly: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [photos, setPhotos] = useState<PartPhoto[]>(initial)
  const [busy, setBusy] = useState(0)
  const [failed, setFailed] = useState(0)

  const upload = async (files: FileList) => {
    const list = Array.from(files).filter(
      (f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(f.name),
    )
    if (list.length === 0) return
    setFailed(0)
    setBusy((n) => n + list.length)
    await Promise.all(
      list.map(async (file) => {
        try {
          const fd = new FormData()
          fd.append('file', file)
          fd.append('jobId', jobId)
          fd.append('componentId', componentId)
          const r = await fetch('/api/upload-inspection-photo', {
            method: 'POST',
            body: fd,
          })
          const data = (await r.json()) as
            | ({ ok: true } & PartPhoto)
            | { ok: false; error: string }
          if ('ok' in data && data.ok) {
            setPhotos((prev) => [
              ...prev,
              {
                id: data.id,
                url: data.url,
                createdBy: data.createdBy,
                createdAt: data.createdAt,
              },
            ])
          } else {
            setFailed((n) => n + 1)
          }
        } catch {
          setFailed((n) => n + 1)
        } finally {
          setBusy((n) => n - 1)
        }
      }),
    )
  }

  const remove = async (id: string) => {
    const prev = photos
    setPhotos((p) => p.filter((x) => x.id !== id))
    try {
      await mutate({ kind: 'deletePartPhoto', jobId, photoId: id })
    } catch {
      setPhotos(prev)
    }
  }

  if (readOnly && photos.length === 0) return null

  return (
    <div>
      <p className="label text-[var(--color-ink-3)] mb-2">
        检验照片
        {photos.length > 0 ? (
          <span className="mono ml-1.5 text-[var(--color-ink-2)]">{photos.length}</span>
        ) : null}
        {failed > 0 ? (
          <span className="ml-2 text-[var(--color-overdue)]">{failed} 上传失败</span>
        ) : null}
      </p>
      <div className="flex flex-wrap gap-2">
        {photos.map((p) => (
          <div
            key={p.id}
            className="relative h-20 w-20 overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-muted-bg)]"
          >
            <a href={p.url} target="_blank" rel="noreferrer" title={p.createdBy}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.url}
                alt="检验照片"
                className="h-full w-full object-cover"
                loading="lazy"
              />
            </a>
            {!readOnly ? (
              <button
                type="button"
                onClick={() => remove(p.id)}
                aria-label="删除照片"
                title="删除照片"
                className="absolute right-0.5 top-0.5 inline-flex h-5 w-5 items-center justify-center rounded-[2px] bg-[var(--color-surface)]/90 text-[var(--color-ink-2)] hover:text-[var(--color-overdue)]"
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
        {!readOnly ? (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy > 0}
            aria-label="上传检验照片"
            className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-[2px] border border-dashed border-[var(--color-border-strong)] text-[var(--color-ink-3)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] disabled:opacity-50"
          >
            {busy > 0 ? (
              <span className="mono text-[11px]">{busy}…</span>
            ) : (
              <>
                <CameraIcon size={16} />
                <span className="text-[10px] tracking-wider">上传</span>
              </>
            )}
          </button>
        ) : null}
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void upload(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

function CameraIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="1"
        y="3.5"
        width="12"
        height="9"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M4.5 3.5 L5.5 1.5 H8.5 L9.5 3.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="7" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}
