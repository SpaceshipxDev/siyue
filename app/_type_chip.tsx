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
  jobNo,
  canEdit,
  onChange,
}: {
  jobType?: JobType
  jobNo: string
  canEdit: boolean
  /** Called with the next jobType (or null to clear). Parent runs the
   *  mutate + optimistic overlay — keeps THIS component reusable across
   *  master grid, station workbench, and job detail. */
  onChange?: (next: JobType | null) => void
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

  if (!canEdit) {
    if (!jobType) return null
    return (
      <span
        className="type-chip"
        data-job-type={jobType}
        aria-label={`类别 · ${JOB_TYPE_LABEL[jobType]}`}
        title={JOB_TYPE_LABEL[jobType]}
      >
        {JOB_TYPE_LABEL[jobType]}
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

  return (
    <span ref={wrapRef} className="relative inline-flex">
      {jobType ? (
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
      ) : (
        <span
          role="button"
          tabIndex={0}
          className="type-chip-empty cursor-pointer select-none"
          onClick={toggle}
          onKeyDown={onKey}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${jobNo} · 设置类别`}
          title="设置类别"
        >
          类别
        </span>
      )}

      {open && (
        <TypePopover current={jobType ?? null} onPick={onPick} />
      )}
    </span>
  )
}

function TypePopover({
  current,
  onPick,
}: {
  current: JobType | null
  onPick: (next: JobType | null) => void
}) {
  // Sorted with 加急 on top — it's the high-affordance action; everything
  // else is a passive label. Then the duration ladder short → long.
  return (
    <div
      role="menu"
      className="absolute top-full left-0 z-30 mt-1.5 min-w-[120px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-[0_8px_28px_rgba(20,19,15,0.12)]"
      onMouseDown={(e) => e.stopPropagation()}
    >
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
            className="inline-block h-2 w-2 rounded-full"
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
        role="menuitem"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onPick(null)
        }}
        disabled={current === null}
        className="flex w-full items-center px-2.5 py-1.5 text-left text-[12px] text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-muted-bg)] disabled:opacity-40 disabled:hover:bg-transparent"
      >
        清除
      </button>
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
  canEdit,
}: {
  jobId: string
  jobNo: string
  initialType?: JobType
  canEdit: boolean
}) {
  const [type, setLocalType] = useState<JobType | undefined>(initialType)

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

  return (
    <TypeChip jobType={type} jobNo={jobNo} canEdit={canEdit} onChange={onChange} />
  )
}

// --------------------------------------------------------------------------
// Convenience hook used by surfaces that own a list of rows. Mirrors the
// pin optimistic-overlay pattern from _master_filter / _workbench so the
// chip + stripe + sort all update in the same React tick as the click.
// --------------------------------------------------------------------------

export function useOptimisticJobType<T extends { id: string; jobType?: JobType; jobNo: string }>(
  _rows: T[],
) {
  // Overlay map: per-jobId, the type the user JUST picked. `null` (explicit)
  // = "the user just cleared it"; missing key = no overlay. We never evict
  // entries here — `effectiveType` falls through to the server value as soon
  // as the prop catches up (overlay === server is a no-op), so dead entries
  // are harmless. Avoids the React-19 lint rule against setState-in-effect.
  const [overlay, setOverlay] = useState<Record<string, JobType | null>>({})

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

  return { effectiveType, setType }
}
