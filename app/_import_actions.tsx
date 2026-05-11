'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { STAGES, type Stage } from '@/lib/data'
import {
  appendComponentAction,
  confirmJobAction,
  deleteComponentAction,
} from './actions'

// Two-step deliberate confirm:
//   1. Optionally click "→ 发往工段" to expose the station chips, then tap the
//      target station (it highlights — this is just a *selection*, not a
//      submit).
//   2. Click 确认导入 to actually commit. The button label reflects the
//      chosen destination (e.g. "确认导入 → 切割") so the boss can't miss
//      what's about to happen.
//
// On confirm, every part's pending stages strictly before the chosen station
// are flipped to `done` (not deleted) — upstream stages render ✓ on the
// rollup so it's clear they were skipped, not absent. Without a chosen
// station, a plain confirm runs the standard pipeline from 编程.
export function ConfirmImportButton({ jobId }: { jobId: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Stage | undefined>(undefined)
  const [conflict, setConflict] = useState<
    { id: string; jobNo: string; customer: string } | null
  >(null)
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    setConflict(null)
    setError(null)
    start(async () => {
      const result = await confirmJobAction(jobId, selected)
      if (result.ok) {
        router.push(`/jobs/${jobId}`)
        return
      }
      if ('conflict' in result) {
        setConflict(result.conflict)
        return
      }
      setError(result.error)
    })
  }

  return (
    <div className="inline-flex flex-col items-end gap-2"><div className="inline-flex items-center gap-2 flex-wrap justify-end">
      {open && (
        <div className="inline-flex items-center gap-1.5 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5">
          <span className="label text-[var(--color-ink-3)] mr-1">发往</span>
          {STAGES.map((s) => {
            const isSelected = selected === s
            return (
              <button
                key={s}
                type="button"
                disabled={pending}
                onClick={() => setSelected(isSelected ? undefined : s)}
                className={`px-2 py-1 text-[12px] tracking-wider rounded-sm transition-colors disabled:opacity-50 ${
                  isSelected
                    ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
                    : 'text-[var(--color-ink-2)] hover:bg-[var(--color-muted-bg)] hover:text-[var(--color-ink)]'
                }`}
              >
                {s}
              </button>
            )
          })}
          <button
            type="button"
            onClick={() => {
              setSelected(undefined)
              setOpen(false)
            }}
            aria-label="关闭"
            className="ml-1 px-1 text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            ×
          </button>
        </div>
      )}
      {!open && (
        <button
          type="button"
          disabled={pending}
          onClick={() => setOpen(true)}
          className="px-3 py-2 text-[12px] tracking-wider border border-[var(--color-border-strong)] text-[var(--color-ink-2)] rounded-sm hover:text-[var(--color-ink)] hover:border-[var(--color-ink)] disabled:opacity-50"
        >
          → 发往工段
        </button>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={submit}
        className="px-4 py-2 text-[13px] tracking-wider bg-[var(--color-ink)] text-[var(--color-surface)] rounded-sm hover:opacity-80 disabled:opacity-50"
      >
        {pending
          ? '导入中…'
          : selected
            ? `确认导入 → ${selected}`
            : '确认导入'}
      </button>
      </div>
      {conflict ? (
        <div className="inline-flex items-center gap-2 rounded-sm border border-[var(--color-overdue)] bg-[var(--color-overdue-soft)] px-3 py-2 text-[12px] text-[var(--color-ink)]">
          <span>
            工号 <span className="mono text-[var(--color-ink)]">{conflict.jobNo}</span>{' '}
            已存在
            {conflict.customer ? (
              <span className="text-[var(--color-ink-2)]"> · {conflict.customer}</span>
            ) : null}
          </span>
          <Link
            href={`/jobs/${conflict.id}`}
            className="underline underline-offset-2 text-[var(--color-ink)] hover:opacity-70"
          >
            打开已存在工单 →
          </Link>
        </div>
      ) : error ? (
        <p className="text-[12px] text-[var(--color-overdue)]">{error}</p>
      ) : null}
    </div>
  )
}

export function AddComponentButton({ jobId }: { jobId: string }) {
  const [pending, start] = useTransition()
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await appendComponentAction(jobId)
        })
      }
      className="px-3 py-1.5 text-[12px] tracking-wider border border-[var(--color-border-strong)] text-[var(--color-ink-2)] rounded-sm hover:text-[var(--color-ink)] hover:border-[var(--color-ink)] disabled:opacity-50"
    >
      + 添加零件
    </button>
  )
}

export function DeleteComponentButton({
  jobId,
  componentId,
  componentName,
}: {
  jobId: string
  componentId: string
  componentName: string
}) {
  const [pending, start] = useTransition()
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        const label = componentName || '该零件'
        if (!confirm(`删除「${label}」？此操作不可撤销。`)) return
        start(async () => {
          await deleteComponentAction(jobId, componentId)
        })
      }}
      className="label text-[var(--color-ink-3)] hover:text-[var(--color-overdue)] disabled:opacity-50"
    >
      删除
    </button>
  )
}
