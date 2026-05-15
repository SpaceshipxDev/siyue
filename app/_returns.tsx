'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { RETURN_REASONS, type Component, type JobReturn, type ReturnReason } from '@/lib/data'
import { today } from '@/lib/today'
import { mutate } from '@/lib/mutate'

// Minimal shape the composer needs — id/name/qty are enough to drive the
// pick list. Stays a structural subtype of Component so the job-detail page
// can keep passing job.components verbatim.
export type ReturnComposerComponent = Pick<Component, 'id' | 'name' | 'qty'>

// 退货 entry point on the job-detail header. Only renders when the job has
// fully shipped and there's no open return — otherwise the slot belongs to
// the active-return badge (rendered by the caller).
export function OpenReturnButton({
  jobId,
  jobNo,
  components,
}: {
  jobId: string
  jobNo: string
  components: ReturnComposerComponent[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-[12px] tracking-wider border border-[var(--color-ink)] text-[var(--color-ink)] rounded-sm hover:bg-[var(--color-ink)] hover:text-[var(--color-surface)] transition-colors"
      >
        开退货
      </button>
      {open && (
        <ReturnComposer
          jobId={jobId}
          jobNo={jobNo}
          components={components}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function defaultDueDate(): string {
  // Two weeks out, anchored to factory time (today() = Asia/Shanghai). A
  // typical rework round-trip — re-machine + re-finish + re-ship — fits in
  // that window; anything tighter and the floor head will just override it.
  const [y, m, d] = today().split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d + 14))
  const yy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

export function ReturnComposer({
  jobId,
  jobNo,
  components,
  onClose,
}: {
  jobId: string
  jobNo: string
  components: ReturnComposerComponent[]
  onClose: () => void
}) {
  const [picks, setPicks] = useState<Record<string, number>>({})
  const [reason, setReason] = useState<ReturnReason>(RETURN_REASONS[0])
  const [reasonText, setReasonText] = useState('')
  const [dueDate, setDueDate] = useState<string>(defaultDueDate())
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const router = useRouter()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, pending])

  const selectedCount = useMemo(
    () => Object.values(picks).filter((q) => q > 0).length,
    [picks],
  )

  const toggle = (c: ReturnComposerComponent) => {
    setPicks((prev) => {
      const next = { ...prev }
      if (next[c.id]) delete next[c.id]
      else next[c.id] = c.qty
      return next
    })
  }

  const setQty = (c: ReturnComposerComponent, q: number) => {
    setPicks((prev) => {
      const next = { ...prev }
      const clamped = Math.max(1, Math.min(c.qty, Math.floor(q || 0)))
      next[c.id] = clamped
      return next
    })
  }

  const submit = () => {
    setError(null)
    const parts = Object.entries(picks)
      .filter(([, q]) => q > 0)
      .map(([componentId, qty]) => ({ componentId, qty }))
    if (parts.length === 0) {
      setError('请至少选择一个零件')
      return
    }
    start(async () => {
      try {
        await mutate({
          kind: 'createReturn',
          input: {
            jobId,
            parts,
            reason,
            reasonText: reasonText.trim() || undefined,
            dueDate,
          },
        })
        // /jobs/[id] is force-dynamic, so the next nav re-renders fresh.
        // Stay-on-page reflects the new return via router.refresh — but
        // /jobs/[id]'s RSC payload is moderate (single-job scope) and
        // creating a return is a once-per-rework action, not per-keystroke,
        // so the GFW exposure is acceptable here. Inline edits already
        // bypass router.refresh entirely.
        router.refresh()
        onClose()
      } catch (e) {
        setError(e instanceof Error ? e.message : '提交失败')
      }
    })
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`退货 · ${jobNo}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => {
        if (!pending) onClose()
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[640px] max-h-[90vh] flex flex-col bg-[var(--color-surface)] border border-[var(--color-ink)] rounded-sm shadow-xl"
      >
        <header className="px-6 py-5 border-b border-[var(--color-border)]">
          <p className="label text-[var(--color-ink-3)] mb-1">退货 · {jobNo}</p>
          <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-ink)]">
            选择退回零件
          </h2>
          <p className="mt-1 text-[12px] text-[var(--color-ink-3)]">
            勾选的零件会重回 工程,由工程头清理实际返工路线。
          </p>
        </header>

        <div className="flex-1 overflow-y-auto">
          <ul className="divide-y divide-[var(--color-border)]">
            {components.map((c) => {
              const checked = c.id in picks
              const qty = picks[c.id] ?? c.qty
              return (
                <li key={c.id} className="flex items-center gap-3 px-6 py-3">
                  <label className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(c)}
                      disabled={pending}
                      className="h-4 w-4 accent-[var(--color-ink)]"
                    />
                    <span className="text-[13px] text-[var(--color-ink)] truncate">
                      {c.name}
                    </span>
                    <span className="label text-[var(--color-ink-3)] shrink-0">
                      共 {c.qty} 件
                    </span>
                  </label>
                  {checked && (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <input
                        type="number"
                        min={1}
                        max={c.qty}
                        step={1}
                        value={qty}
                        onChange={(e) => setQty(c, Number(e.target.value))}
                        disabled={pending}
                        className="w-16 mono text-[13px] text-right border-b border-[var(--color-ink)] bg-transparent py-1 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                      />
                      <span className="label text-[var(--color-ink-3)]">件</span>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>

        <div className="px-6 py-4 border-t border-[var(--color-border)] grid grid-cols-2 gap-4">
          <div>
            <p className="label mb-2">退货原因</p>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as ReturnReason)}
              disabled={pending}
              className="w-full text-[13px] text-[var(--color-ink)] bg-transparent border-b border-[var(--color-ink)] py-1.5 focus:outline-none"
            >
              {RETURN_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            {reason === '其他' && (
              <input
                type="text"
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                placeholder="补充说明"
                disabled={pending}
                className="mt-2 w-full text-[12px] text-[var(--color-ink)] bg-transparent border-b border-[var(--color-border)] py-1 focus:outline-none focus:border-[var(--color-ink)]"
              />
            )}
          </div>
          <div>
            <p className="label mb-2">内部交期</p>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              disabled={pending}
              className="w-full mono text-[13px] text-[var(--color-ink)] bg-transparent border-b border-[var(--color-ink)] py-1.5 focus:outline-none"
            />
            <p className="mt-1 label text-[var(--color-ink-3)]">
              退货期间总览按此日期排序
            </p>
          </div>
        </div>

        {error && (
          <p className="px-6 pb-2 text-[12px] text-[var(--color-overdue)]">
            {error}
          </p>
        )}

        <footer className="px-6 py-4 border-t border-[var(--color-border)] flex items-center justify-between">
          <span className="label text-[var(--color-ink-3)]">
            已选 {selectedCount} 件零件
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="px-3 py-1.5 text-[12px] tracking-wider border border-[var(--color-border)] text-[var(--color-ink-2)] hover:bg-[#f1eee4] rounded-sm disabled:opacity-60"
            >
              取消
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={pending || selectedCount === 0}
              className="px-3 py-1.5 text-[12px] tracking-wider bg-[var(--color-ink)] text-[var(--color-surface)] rounded-sm hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {pending ? '提交中…' : '开退货'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

// Active-return badge on the job-detail header. Shows reason + internal due
// date + a 关闭 affordance for the editor (commerce + 工程 head).
export function ActiveReturnBadge({
  ret,
  canEdit,
}: {
  ret: JobReturn
  canEdit: boolean
}) {
  const [pending, start] = useTransition()
  const router = useRouter()
  const close = () => {
    if (!confirm('确认关闭此次退货?关闭后该工单将不再标记为退货中。')) return
    start(async () => {
      await mutate({ kind: 'closeReturn', returnId: ret.id })
      router.refresh()
    })
  }
  return (
    <div className="inline-flex items-center gap-3 px-3 py-1.5 border border-[var(--color-overdue)] bg-[var(--color-overdue-soft)] rounded-sm">
      <span className="label text-[var(--color-overdue)]">退货中</span>
      <span className="text-[12px] text-[var(--color-ink)]">{ret.reason}</span>
      {ret.reasonText && (
        <span className="text-[11px] text-[var(--color-ink-3)] truncate max-w-[180px]">
          {ret.reasonText}
        </span>
      )}
      <span className="mono text-[11px] text-[var(--color-ink-2)]">
        交期 {ret.dueDate}
      </span>
      {canEdit && (
        <button
          type="button"
          onClick={close}
          disabled={pending}
          className="text-[11px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] underline underline-offset-2 disabled:opacity-50"
        >
          {pending ? '关闭中…' : '关闭'}
        </button>
      )}
    </div>
  )
}

// Compact pill for the master grid + /退货 listing. Reuses the same color
// language as the badge so the visual mapping is consistent.
export function ReturnChip({ ret }: { ret: JobReturn }) {
  return (
    <span
      className="inline-flex items-baseline gap-1 px-1.5 py-px rounded-sm border border-[var(--color-overdue)] text-[var(--color-overdue)] mono text-[10px] tracking-wider leading-tight"
      title={`退货中 · ${ret.reason}${ret.reasonText ? ` · ${ret.reasonText}` : ''} · 交期 ${ret.dueDate}`}
      aria-label={`此工单退货中,内部交期 ${ret.dueDate}`}
    >
      退货
    </span>
  )
}
