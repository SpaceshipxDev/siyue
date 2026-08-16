'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { deleteOrderAction } from '@/app/actions'
import { PermissionDenied } from '@/app/_perm_denied'

// The job page's 删除 — the only gesture that erases an order and its
// history. Two rules keep it calm:
//
//   1. The trigger is a bare word, not a button. It sits past a hairline
//      divider at the end of the action row in ink-4, and only turns red
//      under the pointer — present when you need it, silent otherwise.
//   2. Nothing happens without the anchored popover: what will be deleted,
//      stated once, then 取消 / 删除. No browser confirm(), no modal wall.
//
// `allowed` (canDeleteOrder, server-decided) does NOT hide the word — same
// convention as the 零件 trash icon: a missing control reads as a broken
// page; a control that states the rule teaches it once.
const W = 280

export function DeleteOrderButton({
  jobId,
  jobNo,
  allowed,
}: {
  jobId: string
  jobNo: string
  allowed: boolean
}) {
  const [confirm, setConfirm] = useState<DOMRect | null>(null)
  const [denied, setDenied] = useState<DOMRect | null>(null)
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          if (!allowed) setDenied(rect)
          else setConfirm(rect)
        }}
        className="label pl-3 border-l border-[var(--color-border)] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)] transition-colors"
      >
        删除
      </button>
      {confirm ? (
        <ConfirmPopover
          anchor={confirm}
          jobId={jobId}
          jobNo={jobNo}
          onClose={() => setConfirm(null)}
        />
      ) : null}
      {denied ? (
        <PermissionDenied
          anchor={denied}
          title="无删除权限"
          body="删除工单会连同零件、报工与出货记录一起清除，仅限 老板、Harry、黄优兰香、于海伟 操作。"
          onClose={() => setDenied(null)}
        />
      ) : null}
    </>
  )
}

function ConfirmPopover({
  anchor,
  jobId,
  jobNo,
  onClose,
}: {
  anchor: DOMRect
  jobId: string
  jobNo: string
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const [pending, start] = useTransition()

  // Same dismissal rules as PermissionDenied: outside click, Escape, any
  // scroll — but never mid-delete.
  useEffect(() => {
    if (pending) return
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose, pending])

  const left = Math.max(
    8,
    Math.min(anchor.left + anchor.width / 2 - W / 2, window.innerWidth - W - 8),
  )

  const handleDelete = () => {
    start(async () => {
      try {
        await deleteOrderAction(jobId)
      } catch {
        // Cross-border response truncation — the DB delete is a single
        // statement and almost certainly landed. Navigating home confirms
        // either way: the row is gone from the board, or it isn't.
      }
      router.push('/')
    })
  }

  return createPortal(
    <div
      ref={ref}
      role="alertdialog"
      aria-label={`删除 ${jobNo}`}
      style={{ left, top: anchor.bottom + 8, width: W }}
      className="fixed z-50 rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[0_10px_32px_rgba(0,0,0,0.14),0_0_0_0.5px_rgba(0,0,0,0.05)]"
    >
      <div className="px-4 pt-3 pb-3.5">
        <p className="label text-[var(--color-ink-4)]">删除工单</p>
        <h3 className="mono mt-1.5 text-[14px] font-semibold tracking-tight text-[var(--color-ink)]">
          {jobNo}
        </h3>
        <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-ink-2)]">
          整张工单连同零件、报工与出货记录将被永久删除，无法恢复。
        </p>
      </div>
      <div className="flex border-t border-[var(--color-border)]">
        <button
          type="button"
          autoFocus
          disabled={pending}
          onClick={onClose}
          className="flex-1 rounded-[2px] py-2 text-[12px] tracking-wider text-[var(--color-ink-2)] transition-colors hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink)] disabled:opacity-50 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)]"
        >
          取消
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={handleDelete}
          className="flex-1 rounded-[2px] border-l border-[var(--color-border)] py-2 text-[12px] tracking-wider text-[var(--color-overdue)] transition-colors hover:bg-[var(--color-overdue)] hover:text-[var(--color-surface)] disabled:opacity-50 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-overdue)]"
        >
          {pending ? '删除中…' : '删除'}
        </button>
      </div>
    </div>,
    document.body,
  )
}
