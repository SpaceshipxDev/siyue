'use client'

import { useState, useTransition } from 'react'
import { mutate } from '@/lib/mutate'
import type { OutsourceState } from '@/lib/data'

// 外协预警 control on the job-detail page. This is 工程's UPSTREAM heads-up
// that a job needs outsourcing — the missing first stage of the lifecycle
// 待外协 → 外协中 → 已回. It only ever AUTHORS the 待外协 flag; once 商务 makes
// a vendor block (state becomes 外协中) the operational truth lives in the
// blocks table + the 外协 section below, so here we just show a calm read-only
// status. No messaging — toggling the flag is the whole "notify 商务" gesture;
// it surfaces passively on the 商务 master grid.
export function OutsourceFlag({
  jobId,
  state,
  initialNeeds,
  initialNote,
}: {
  jobId: string
  /** Derived lifecycle state from the server snapshot. */
  state: OutsourceState | null
  initialNeeds: boolean
  initialNote?: string
}) {
  const [needs, setNeeds] = useState(initialNeeds)
  const [note, setNote] = useState(initialNote ?? '')
  const [savedNote, setSavedNote] = useState(initialNote ?? '')
  const [pending, start] = useTransition()

  // Once a vendor block exists, the flag is no longer the source of truth.
  // Render the live lifecycle state read-only and let the 外协 section drive.
  if (state === '外协中' || state === '已回') {
    return (
      <div>
        <p className="label mb-2">外协</p>
        <span
          className="row-badge"
          data-tone={state === '外协中' ? 'info' : 'neutral'}
        >
          {state}
        </span>
        <p className="mt-2 text-[11px] text-[var(--color-ink-3)]">
          见下方 外协 · 送出 / 回厂
        </p>
      </div>
    )
  }

  function commit(nextNeeds: boolean, nextNote: string) {
    start(async () => {
      await mutate({
        kind: 'setJobOutsourceFlag',
        jobId,
        needs: nextNeeds,
        note: nextNeeds ? (nextNote.trim() || null) : null,
      })
      setSavedNote(nextNeeds ? nextNote : '')
    })
  }

  function toggle() {
    const next = !needs
    setNeeds(next)
    if (!next) setNote('')
    commit(next, next ? note : '')
  }

  function saveNote() {
    if (note === savedNote) return
    commit(true, note)
  }

  return (
    <div>
      <p className="label mb-2">外协</p>
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={toggle}
          disabled={pending}
          role="switch"
          aria-checked={needs}
          aria-label="标记需外协"
          className={`relative inline-flex h-[20px] w-[34px] shrink-0 items-center rounded-[2px] border transition-colors disabled:opacity-50 ${
            needs
              ? 'border-[var(--color-warning)]/40 bg-[var(--color-warning-soft)]'
              : 'border-[var(--color-border-strong)] bg-[var(--color-surface)]'
          }`}
        >
          <span
            className={`inline-block h-[14px] w-[14px] rounded-[1px] transition-transform ${
              needs
                ? 'translate-x-[16px] bg-[var(--color-warning)]'
                : 'translate-x-[3px] bg-[var(--color-ink-4)]'
            }`}
          />
        </button>
        <span
          className={`text-[13px] ${
            needs
              ? 'font-medium text-[var(--color-warning)]'
              : 'text-[var(--color-ink-3)]'
          }`}
        >
          {needs ? '需外协 · 待商务安排' : '标记需外协'}
        </span>
      </div>
      {needs && (
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={saveNote}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          placeholder="外协零件 / 工艺 · 如 D20腰部 需外发CNC"
          className="mt-2 w-full rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
        />
      )}
    </div>
  )
}
