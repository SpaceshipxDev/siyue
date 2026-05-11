'use client'

import { useTransition } from 'react'
import { deleteJobAction } from './actions'

export function DeleteInboxButton({
  jobId,
  label,
}: {
  jobId: string
  label: string
}) {
  const [pending, start] = useTransition()
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!confirm(`删除「${label}」？`)) return
        start(async () => {
          await deleteJobAction(jobId)
        })
      }}
      title="删除此条草稿 / 解析失败 / 卡住的条目"
      className="label px-2 py-1 -my-1 rounded-sm text-[var(--color-ink-3)] hover:text-[var(--color-overdue)] hover:bg-[#f5e6b8] disabled:opacity-50"
    >
      {pending ? '…' : '×'}
    </button>
  )
}
