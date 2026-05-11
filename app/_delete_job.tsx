'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { deleteJobAction } from './actions'

type Props = {
  jobId: string
  jobNo: string
  customer?: string | null
  product?: string | null
  componentCount?: number
}

export function DeleteJobButton({
  jobId,
  jobNo,
  customer,
  product,
  componentCount,
}: Props) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const [pending, start] = useTransition()

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] tracking-wider text-[var(--color-ink-3)] hover:text-[var(--color-overdue)] rounded-sm transition-colors"
        title={`删除工单 ${jobNo}`}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-[14px] h-[14px]"
          aria-hidden
        >
          <path d="M3 6h18" />
          <path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6" />
          <path d="M18.5 6l-.8 12.1A2 2 0 0 1 15.7 20H8.3a2 2 0 0 1-2-1.9L5.5 6" />
          <path d="M10 10.5v5.5" />
          <path d="M14 10.5v5.5" />
        </svg>
        <span>删除工单</span>
      </button>

      {open ? (
        <DeleteConfirmDialog
          jobNo={jobNo}
          customer={customer}
          product={product}
          componentCount={componentCount}
          pending={pending}
          onCancel={() => {
            if (!pending) setOpen(false)
          }}
          onConfirm={() => {
            start(async () => {
              await deleteJobAction(jobId)
              router.push('/')
            })
          }}
        />
      ) : null}
    </>
  )
}

function DeleteConfirmDialog({
  jobNo,
  customer,
  product,
  componentCount,
  pending,
  onCancel,
  onConfirm,
}: {
  jobNo: string
  customer?: string | null
  product?: string | null
  componentCount?: number
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !pending) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pending, onCancel])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`删除工单 ${jobNo}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[460px] bg-[var(--color-surface)] border border-[var(--color-ink)] rounded-sm shadow-xl"
      >
        <header className="px-7 pt-7 pb-5">
          <p className="label text-[var(--color-overdue)] mb-2">永久删除</p>
          <h2 className="text-[20px] font-semibold tracking-tight text-[var(--color-ink)] leading-tight">
            删除此工单？
          </h2>
        </header>

        <div className="px-7 pb-6">
          <dl className="grid grid-cols-[68px_1fr] gap-y-2.5 gap-x-4 text-[13px]">
            <dt className="label text-[var(--color-ink-3)] pt-0.5">工号</dt>
            <dd className="mono text-[13px] text-[var(--color-ink)]">{jobNo}</dd>

            {customer ? (
              <>
                <dt className="label text-[var(--color-ink-3)] pt-0.5">客户</dt>
                <dd className="text-[var(--color-ink)] truncate">{customer}</dd>
              </>
            ) : null}

            {product ? (
              <>
                <dt className="label text-[var(--color-ink-3)] pt-0.5">产品</dt>
                <dd className="text-[var(--color-ink-2)] truncate">{product}</dd>
              </>
            ) : null}

            {typeof componentCount === 'number' && componentCount > 0 ? (
              <>
                <dt className="label text-[var(--color-ink-3)] pt-0.5">零件</dt>
                <dd className="mono text-[var(--color-ink-2)]">
                  {componentCount} 个
                </dd>
              </>
            ) : null}
          </dl>

          <p className="mt-6 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
            将一并删除该工单的零件、工段记录、外协与退货记录。此操作无法撤销。
          </p>
        </div>

        <footer className="px-7 py-4 border-t border-[var(--color-border)] flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="px-4 py-1.5 text-[12px] tracking-wider border border-[var(--color-border)] text-[var(--color-ink-2)] hover:bg-[#f1eee4] rounded-sm disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            autoFocus
            className="px-4 py-1.5 text-[12px] tracking-wider bg-[var(--color-overdue)] text-[var(--color-surface)] rounded-sm hover:opacity-85 disabled:opacity-60"
          >
            {pending ? '删除中…' : '删除工单'}
          </button>
        </footer>
      </div>
    </div>
  )
}
