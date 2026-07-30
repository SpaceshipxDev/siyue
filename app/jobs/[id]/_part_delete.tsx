'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'

// Trash-bin delete for one part row on the job page. Sits on the row scan
// path, so the icon alone never mutates — the confirm dialog is the gate.
export function DeletePartButton({
  jobId,
  componentId,
  componentName,
}: {
  jobId: string
  componentId: string
  componentName: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  return (
    <button
      type="button"
      disabled={pending}
      aria-label="删除零件"
      title="删除零件"
      onClick={() => {
        const label = componentName || '该零件'
        if (!confirm(`删除「${label}」？此操作不可撤销。`)) return
        start(async () => {
          await mutate({ kind: 'deleteComponent', jobId, componentId })
          router.refresh()
        })
      }}
      className="inline-flex items-center justify-center p-1.5 rounded-[2px] text-[var(--color-ink-3)] hover:text-[var(--color-overdue)] hover:bg-[var(--color-overdue-soft)] transition-colors disabled:opacity-50"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="square"
      >
        <path d="M4 7h16" />
        <path d="M9 7V4h6v3" />
        <path d="M6 7l1 14h10l1-14" />
        <path d="M10 11v6M14 11v6" />
      </svg>
    </button>
  )
}
