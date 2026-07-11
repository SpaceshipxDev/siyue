'use client'

// Job classification UI — the single global priority signal.
//
// Square solid tag that sits inline BEFORE the 工号 in every list. One
// unit, one color, one label — it IS the color stripe (scannable across
// 300 rows) AND the Chinese chip (readable up close). 加急 is filled;
// the three duration tags are outlined so the row only reads as
// escalated when 加急 is set.
//
// Clicking the chip (for 商务 + 工程 head) opens a small popover with
// the four options + 清除. Workers see it read-only.

import { useCallback, useEffect, useRef, useState } from 'react'
// (useEffect is still used by TypeChip for click-outside / Esc handling.)
import {
  JOB_TYPES,
  JOB_TYPE_LABEL,
  type JobType,
} from '@/lib/data'
import { mutate } from '@/lib/mutate'
import { showToast } from './_toast'

// --------------------------------------------------------------------------
// Inline chip + popover editor. Controlled by the parent so it can share
// optimistic state across the row (chip + stripe both reflect the pending
// type before the server round-trip).
// --------------------------------------------------------------------------

export function TypeChip({
  jobType,
  isProduct,
  paused,
  pauseReason,
  jobNo,
  canEdit,
  canPause,
  onChange,
  onProductChange,
  onPauseChange,
}: {
  jobType?: JobType
  isProduct?: boolean
  /** 暂停 — job is on hold. Independent of jobType/isProduct. */
  paused?: boolean
  /** Optional free-text reason, shown in the popover input + chip tooltip. */
  pauseReason?: string
  jobNo: string
  /** Commerce/工程 can edit the duration/priority bucket + 产品. */
  canEdit: boolean
  /** Anyone logged in can toggle 暂停 — a wider gate than canEdit so the floor
   *  can flag blockers. When true (and canEdit false) the popover opens but
   *  shows ONLY the 暂停 control. */
  canPause?: boolean
  /** Called with the next jobType (or null to clear). Parent runs the
   *  mutate + optimistic overlay — keeps THIS component reusable across
   *  master grid, station workbench, and job detail. */
  onChange?: (next: JobType | null) => void
  /** Called when the 产品 tag is toggled. Independent of onChange so a
   *  job can carry both a duration bucket AND 产品. */
  onProductChange?: (next: boolean) => void
  /** Called when 暂停 is toggled or its reason edited. `(paused, reason)`. */
  onPauseChange?: (next: boolean, reason?: string) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)

  // Click-outside + Esc to close.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const onPick = (next: JobType | null) => {
    setOpen(false)
    if (next === (jobType ?? null)) return
    onChange?.(next)
  }

  const onPickProduct = (next: boolean) => {
    setOpen(false)
    if (next === Boolean(isProduct)) return
    onProductChange?.(next)
  }

  // 暂停 toggle / reason edit. Unlike onPick* this does NOT close the popover —
  // the user typically wants to type a reason right after pausing.
  const onPickPaused = (next: boolean, reason?: string) => {
    if (next === Boolean(paused) && (reason ?? '') === (pauseReason ?? '')) return
    onPauseChange?.(next, reason)
  }

  if (!canEdit && !canPause) {
    if (!jobType && !isProduct && !paused) return null
    return (
      <span className="inline-flex flex-col items-start gap-1">
        {jobType && (
          <span
            className="type-chip"
            data-job-type={jobType}
            aria-label={`类别 · ${JOB_TYPE_LABEL[jobType]}`}
            title={JOB_TYPE_LABEL[jobType]}
          >
            {JOB_TYPE_LABEL[jobType]}
          </span>
        )}
        {isProduct && (
          <span
            className="type-chip"
            data-job-type="product"
            aria-label="类别 · 产品"
            title="产品"
          >
            产品
          </span>
        )}
        {paused && (
          <span
            className="type-chip"
            data-job-type="paused"
            aria-label={pauseReason ? `暂停 · ${pauseReason}` : '暂停'}
            title={pauseReason ? `暂停 · ${pauseReason}` : '暂停'}
          >
            暂停
          </span>
        )}
      </span>
    )
  }

  // Span with role="button" rather than a real <button>: the chip frequently
  // lives inside <Link> (workbench row), and a <button> inside an <a> is
  // invalid HTML. Span-in-anchor is fine; we provide keyboard + ARIA equiv.
  const toggle = (e: React.SyntheticEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setOpen((v) => !v)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') toggle(e)
  }

  const hasAnyTag = Boolean(jobType) || Boolean(isProduct) || Boolean(paused)
  // Empty-state affordance: managers get "类别" (they edit the bucket); a
  // pause-only worker gets "暂停" so the entry point names what they can do.
  const emptyLabel = canEdit ? '类别' : '暂停'

  return (
    <span ref={wrapRef} className="relative inline-flex flex-col items-start gap-1">
      {hasAnyTag ? (
        <>
          {jobType && (
            <span
              role="button"
              tabIndex={0}
              className="type-chip cursor-pointer select-none"
              data-job-type={jobType}
              onClick={toggle}
              onKeyDown={onKey}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label={`${JOB_TYPE_LABEL[jobType]} · 点击修改类别`}
              title={`${JOB_TYPE_LABEL[jobType]} · 点击修改`}
            >
              {JOB_TYPE_LABEL[jobType]}
            </span>
          )}
          {isProduct && (
            <span
              role="button"
              tabIndex={0}
              className="type-chip cursor-pointer select-none"
              data-job-type="product"
              onClick={toggle}
              onKeyDown={onKey}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label="产品 · 点击修改类别"
              title="产品 · 点击修改"
            >
              产品
            </span>
          )}
          {paused && (
            <span
              role="button"
              tabIndex={0}
              className="type-chip cursor-pointer select-none"
              data-job-type="paused"
              onClick={toggle}
              onKeyDown={onKey}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label={pauseReason ? `暂停 · ${pauseReason} · 点击修改` : '暂停 · 点击修改'}
              title={pauseReason ? `暂停 · ${pauseReason} · 点击修改` : '暂停 · 点击修改'}
            >
              暂停
            </span>
          )}
        </>
      ) : (
        <span
          role="button"
          tabIndex={0}
          className="type-chip-empty cursor-pointer select-none"
          onClick={toggle}
          onKeyDown={onKey}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${jobNo} · 设置${emptyLabel}`}
          title={`设置${emptyLabel}`}
        >
          {emptyLabel}
        </span>
      )}

      {open && (
        <TypePopover
          current={jobType ?? null}
          isProduct={Boolean(isProduct)}
          paused={Boolean(paused)}
          pauseReason={pauseReason ?? ''}
          canEdit={canEdit}
          canPause={Boolean(canPause)}
          onPick={onPick}
          onPickProduct={onPickProduct}
          onPickPaused={onPickPaused}
        />
      )}
    </span>
  )
}

function TypePopover({
  current,
  isProduct,
  paused,
  pauseReason,
  canEdit,
  canPause,
  onPick,
  onPickProduct,
  onPickPaused,
}: {
  current: JobType | null
  isProduct: boolean
  paused: boolean
  pauseReason: string
  canEdit: boolean
  canPause: boolean
  onPick: (next: JobType | null) => void
  onPickProduct: (next: boolean) => void
  onPickPaused: (next: boolean, reason?: string) => void
}) {
  // Local draft of the reason so typing doesn't round-trip on every keystroke;
  // committed on blur / Enter. Seeded from the server value; re-seeds if the
  // popover reopens with a different reason (key on pauseReason via the parent
  // remount is overkill — a plain initializer is fine since the popover is
  // re-created each open).
  const [reasonDraft, setReasonDraft] = useState(pauseReason)

  const commitReason = () => {
    if (reasonDraft === pauseReason) return
    onPickPaused(true, reasonDraft)
  }

  // Sorted with 加急 on top — it's the high-affordance action; everything
  // else is a passive label. Then the duration ladder short → long, then
  // 产品 below the divider as an independent stack-on-top tag. 暂停 sits last,
  // its own section — it's orthogonal to all of the above and open to workers
  // (canPause) even when the duration/产品 section (canEdit) is hidden.
  return (
    <div
      role="menu"
      className="absolute top-full left-0 z-30 mt-1.5 min-w-[140px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-[0_8px_28px_rgba(20,19,15,0.12)]"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {canEdit && (
        <>
          {JOB_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              role="menuitemradio"
              aria-checked={current === t}
              onClick={(e) => {
                // The chip may sit inside a <Link>; stop the click before the
                // parent anchor sees it and navigates.
                e.preventDefault()
                e.stopPropagation()
                onPick(t)
              }}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--color-muted-bg)] ${
                current === t ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-2)]'
              }`}
            >
              <span
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ background: `var(--color-type-${t})` }}
                aria-hidden="true"
              />
              <span className="flex-1">{JOB_TYPE_LABEL[t]}</span>
              {current === t && (
                <span aria-hidden="true" className="text-[var(--color-ink-3)]">
                  ✓
                </span>
              )}
            </button>
          ))}
          <div className="my-1 h-px bg-[var(--color-border)]" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={isProduct}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onPickProduct(!isProduct)
            }}
            className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--color-muted-bg)] ${
              isProduct ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-2)]'
            }`}
          >
            <span
              className="inline-block h-2 w-2 rounded-[2px]"
              style={{ background: 'var(--color-type-product)' }}
              aria-hidden="true"
            />
            <span className="flex-1">产品</span>
            {isProduct && (
              <span aria-hidden="true" className="text-[var(--color-ink-3)]">
                ✓
              </span>
            )}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              // 清除 wipes the bucket + 产品 (not 暂停 — that's its own toggle).
              if (current !== null) onPick(null)
              if (isProduct) onPickProduct(false)
            }}
            disabled={current === null && !isProduct}
            className="flex w-full items-center px-2.5 py-1.5 text-left text-[12px] text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-muted-bg)] disabled:opacity-40 disabled:hover:bg-transparent"
          >
            清除
          </button>
        </>
      )}
      {canPause && (
        <>
          {canEdit && <div className="my-1 h-px bg-[var(--color-border)]" />}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={paused}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              // Toggling on keeps the existing reason; off clears it server-side.
              onPickPaused(!paused, paused ? undefined : pauseReason)
            }}
            className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--color-muted-bg)] ${
              paused ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-2)]'
            }`}
          >
            <span
              className="inline-block h-2 w-2 rounded-[2px]"
              style={{ background: 'var(--color-type-paused)' }}
              aria-hidden="true"
            />
            <span className="flex-1">暂停</span>
            {paused && (
              <span aria-hidden="true" className="text-[var(--color-ink-3)]">
                ✓
              </span>
            )}
          </button>
          {paused && (
            <div className="px-2.5 pt-0.5 pb-1.5">
              <input
                type="text"
                value={reasonDraft}
                onChange={(e) => setReasonDraft(e.target.value)}
                onBlur={commitReason}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitReason()
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                placeholder="暂停原因（可选）"
                className="w-full rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[12px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)] focus:outline-none"
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// Single-job version — used on the job detail page header. Owns its own
// optimistic state (no list-overlay machinery needed). Same chip + popover
// + write path; nothing else differs.
// --------------------------------------------------------------------------

export function JobTypeEditor({
  jobId,
  jobNo,
  initialType,
  initialIsProduct,
  initialPaused,
  initialPauseReason,
  canEdit,
  canPause = true,
}: {
  jobId: string
  jobNo: string
  initialType?: JobType
  initialIsProduct?: boolean
  initialPaused?: boolean
  initialPauseReason?: string
  canEdit: boolean
  /** 暂停 is open to anyone logged in — defaults true so every viewer of the
   *  detail page can pause/resume. */
  canPause?: boolean
}) {
  const [type, setLocalType] = useState<JobType | undefined>(initialType)
  const [isProduct, setLocalIsProduct] = useState<boolean>(
    Boolean(initialIsProduct),
  )
  const [paused, setLocalPaused] = useState<boolean>(Boolean(initialPaused))
  const [pauseReason, setLocalPauseReason] = useState<string>(
    initialPauseReason ?? '',
  )

  const onPauseChange = (next: boolean, reason?: string) => {
    const prevPaused = paused
    const prevReason = pauseReason
    setLocalPaused(next)
    setLocalPauseReason(next ? (reason ?? '') : '')
    mutate({ kind: 'setJobPaused', jobId, paused: next, reason: reason ?? null })
      .then(() => {
        showToast(next ? `${jobNo} · 已暂停` : `${jobNo} · 已恢复`)
      })
      .catch(() => {
        setLocalPaused(prevPaused)
        setLocalPauseReason(prevReason)
        showToast('暂停修改失败,请重试', 'neutral')
      })
  }

  const onChange = (next: JobType | null) => {
    const prev = type
    setLocalType(next ?? undefined)
    mutate({ kind: 'setJobType', jobId, jobType: next })
      .then(() => {
        showToast(
          next
            ? `${jobNo} · 已标记为 ${JOB_TYPE_LABEL[next]}`
            : `${jobNo} · 已清除类别`,
        )
      })
      .catch(() => {
        setLocalType(prev)
        showToast('类别修改失败,请重试', 'neutral')
      })
  }

  const onProductChange = (next: boolean) => {
    const prev = isProduct
    setLocalIsProduct(next)
    mutate({ kind: 'setJobIsProduct', jobId, isProduct: next })
      .then(() => {
        showToast(
          next ? `${jobNo} · 已标记为 产品` : `${jobNo} · 已取消 产品 标记`,
        )
      })
      .catch(() => {
        setLocalIsProduct(prev)
        showToast('类别修改失败,请重试', 'neutral')
      })
  }

  return (
    <TypeChip
      jobType={type}
      isProduct={isProduct}
      paused={paused}
      pauseReason={pauseReason}
      jobNo={jobNo}
      canEdit={canEdit}
      canPause={canPause}
      onChange={onChange}
      onProductChange={onProductChange}
      onPauseChange={onPauseChange}
    />
  )
}

// --------------------------------------------------------------------------
// Convenience hook used by surfaces that own a list of rows. Mirrors the
// pin optimistic-overlay pattern from _master_filter / _workbench so the
// chip + stripe + sort all update in the same React tick as the click.
// --------------------------------------------------------------------------

export function useOptimisticJobType<T extends { id: string; jobType?: JobType; isProduct?: boolean; pausedAt?: string; jobNo: string }>(
  _rows: T[],
) {
  // Overlay map: per-jobId, the type the user JUST picked. `null` (explicit)
  // = "the user just cleared it"; missing key = no overlay. We never evict
  // entries here — `effectiveType` falls through to the server value as soon
  // as the prop catches up (overlay === server is a no-op), so dead entries
  // are harmless. Avoids the React-19 lint rule against setState-in-effect.
  const [overlay, setOverlay] = useState<Record<string, JobType | null>>({})
  // Parallel overlay for the independent 产品 tag. Same fall-through rules.
  const [productOverlay, setProductOverlay] = useState<Record<string, boolean>>({})
  // Parallel overlay for the independent 暂停 flag — drives the chip + the
  // 在产/暂停/已出货 count split in the same React tick as the click. Tracks the
  // boolean only; the reason isn't sorted/counted on, so it rides the server
  // round-trip + revalidate.
  const [pausedOverlay, setPausedOverlay] = useState<Record<string, boolean>>({})

  const effectiveType = useCallback(
    (row: { id: string; jobType?: JobType }): JobType | undefined => {
      if (!(row.id in overlay)) return row.jobType
      const desired = overlay[row.id] ?? undefined
      // Server has caught up — the overlay entry is moot; return server.
      // Keeps the row at the just-clicked position via stable sort input
      // even after the round-trip lands.
      if (desired === row.jobType) return row.jobType
      return desired
    },
    [overlay],
  )

  const effectiveIsProduct = useCallback(
    (row: { id: string; isProduct?: boolean }): boolean => {
      if (!(row.id in productOverlay)) return Boolean(row.isProduct)
      const desired = productOverlay[row.id]
      if (desired === Boolean(row.isProduct)) return Boolean(row.isProduct)
      return desired
    },
    [productOverlay],
  )

  const effectiveIsPaused = useCallback(
    (row: { id: string; pausedAt?: string }): boolean => {
      const server = Boolean(row.pausedAt)
      if (!(row.id in pausedOverlay)) return server
      const desired = pausedOverlay[row.id]
      if (desired === server) return server
      return desired
    },
    [pausedOverlay],
  )

  const setType = useCallback(
    (row: { id: string; jobNo: string }, next: JobType | null) => {
      setOverlay((prev) => ({ ...prev, [row.id]: next }))
      mutate({ kind: 'setJobType', jobId: row.id, jobType: next })
        .then(() => {
          showToast(
            next
              ? `${row.jobNo} · 已标记为 ${JOB_TYPE_LABEL[next]}`
              : `${row.jobNo} · 已清除类别`,
          )
        })
        .catch(() => {
          // Reset overlay so chip snaps back to the server's view.
          setOverlay((prev) => {
            const copy = { ...prev }
            delete copy[row.id]
            return copy
          })
          showToast('类别修改失败,请重试', 'neutral')
        })
    },
    [],
  )

  const setIsProduct = useCallback(
    (row: { id: string; jobNo: string }, next: boolean) => {
      setProductOverlay((prev) => ({ ...prev, [row.id]: next }))
      mutate({ kind: 'setJobIsProduct', jobId: row.id, isProduct: next })
        .then(() => {
          showToast(
            next
              ? `${row.jobNo} · 已标记为 产品`
              : `${row.jobNo} · 已取消 产品 标记`,
          )
        })
        .catch(() => {
          setProductOverlay((prev) => {
            const copy = { ...prev }
            delete copy[row.id]
            return copy
          })
          showToast('类别修改失败,请重试', 'neutral')
        })
    },
    [],
  )

  const setPaused = useCallback(
    (row: { id: string; jobNo: string }, next: boolean, reason?: string) => {
      setPausedOverlay((prev) => ({ ...prev, [row.id]: next }))
      mutate({
        kind: 'setJobPaused',
        jobId: row.id,
        paused: next,
        reason: reason ?? null,
      })
        .then(() => {
          showToast(next ? `${row.jobNo} · 已暂停` : `${row.jobNo} · 已恢复`)
        })
        .catch(() => {
          setPausedOverlay((prev) => {
            const copy = { ...prev }
            delete copy[row.id]
            return copy
          })
          showToast('暂停修改失败,请重试', 'neutral')
        })
    },
    [],
  )

  return {
    effectiveType,
    effectiveIsProduct,
    effectiveIsPaused,
    setType,
    setIsProduct,
    setPaused,
  }
}
