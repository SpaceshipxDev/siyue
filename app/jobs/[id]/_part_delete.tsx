'use client'

import { useRef, useState, useTransition } from 'react'
import { mutate } from '@/lib/mutate'
import { DELETE_PART_DENIED, PermissionDenied } from '@/app/_perm_denied'

// Trash-bin delete for one part row on the job page. Sits on the row scan
// path, so the icon alone never mutates — the confirm dialog is the gate.
// After the 30-byte mutate response the row is removed LOCALLY (state
// callback or DOM) — never router.refresh(), whose RSC payload the GFW
// truncates for mainland users, leaving the deleted row visibly stuck.
//
// `allowed` (canDeletePartRow, server-decided) does NOT hide the button: an
// icon that silently vanishes reads as a broken page to someone who used it
// last week. It stays where it was and says why instead.
export function DeletePartButton({
  jobId,
  componentId,
  componentName,
  allowed,
  onDeleted,
}: {
  jobId: string
  componentId: string
  componentName: string
  allowed: boolean
  onDeleted?: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [denied, setDenied] = useState<DOMRect | null>(null)
  const [pending, start] = useTransition()
  return (
    <>
      <button
        ref={ref}
        type="button"
        disabled={pending}
        aria-label="删除零件"
        title={allowed ? '删除零件' : '无删除权限'}
        onClick={() => {
          if (!allowed) {
            setDenied(ref.current?.getBoundingClientRect() ?? null)
            return
          }
          const label = componentName || '该零件'
          if (!confirm(`删除「${label}」？此操作不可撤销。`)) return
          start(async () => {
            await mutate({ kind: 'deleteComponent', jobId, componentId })
            if (onDeleted) onDeleted()
            // Server-rendered rows: drop the <tr> directly. Server truth is
            // already updated; the next natural page load agrees.
            else ref.current?.closest('tr')?.remove()
          })
        }}
        className={`inline-flex items-center justify-center p-1.5 rounded-[2px] transition-colors disabled:opacity-50 ${
          allowed
            ? 'text-[var(--color-ink-3)] hover:text-[var(--color-overdue)] hover:bg-[var(--color-overdue-soft)]'
            : 'text-[var(--color-ink-4)] hover:text-[var(--color-ink-3)]'
        }`}
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
      {denied ? (
        <PermissionDenied
          anchor={denied}
          title={DELETE_PART_DENIED.title}
          body={DELETE_PART_DENIED.body}
          onClose={() => setDenied(null)}
        />
      ) : null}
    </>
  )
}
