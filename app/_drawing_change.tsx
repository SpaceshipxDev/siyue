'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatShipmentTimestamp } from '@/lib/data'
import { mutate } from '@/lib/mutate'

// 图纸变更 — the system's one true alarm. The customer revised drawings
// mid-production; anyone still cutting to the old sheet is making scrap.
// Lifecycle mirrors 退货: a quiet toolbar button raises it (with a note —
// what changed, which parts), a full-width banner headlines the job detail
// page until 商务 / 工程 head clears it after redistributing drawings.
// Inform-only by design: stations keep working — unaffected parts shouldn't
// freeze, and the floor is trusted to read the headline.

// Toolbar entry point on the job-detail header. Only rendered when no alarm
// is open — while one is, the slot belongs to the banner's presence and
// re-raising is meaningless (single live alarm per job).
export function DrawingChangeButton({
  jobId,
  jobNo,
}: {
  jobId: string
  jobNo: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-[12px] tracking-wider border border-[var(--color-border-strong)] text-[var(--color-ink-2)] rounded-[2px] hover:border-[var(--color-overdue)] hover:text-[var(--color-overdue)] transition-colors"
      >
        图纸变更
      </button>
      {open && (
        <DrawingChangeComposer
          jobId={jobId}
          jobNo={jobNo}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

// Minimal dialog: one textarea, one action. The note is the alarm's content —
// it travels to every row tooltip and the banner, so it should name what
// changed and which parts. Empty is allowed (speed beats ceremony when the
// boss is on the phone with the customer); the banner falls back to a
// generic headline.
function DrawingChangeComposer({
  jobId,
  jobNo,
  onClose,
}: {
  jobId: string
  jobNo: string
  onClose: () => void
}) {
  const [note, setNote] = useState('')
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

  const submit = () => {
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'setDrawingChange',
          jobId,
          open: true,
          note: note.trim() || null,
        })
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
      aria-label={`图纸变更 · ${jobNo}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => {
        if (!pending) onClose()
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] bg-[var(--color-surface)] border border-[var(--color-ink)] rounded-[2px] shadow-xl"
      >
        <header className="px-6 py-5 border-b border-[var(--color-border)]">
          <p className="label text-[var(--color-ink-3)] mb-1">
            图纸变更 · {jobNo}
          </p>
          <h2 className="text-[18px] font-semibold tracking-tight text-[var(--color-ink)]">
            客户修改了图纸
          </h2>
          <p className="mt-1 text-[12px] text-[var(--color-ink-3)]">
            报警后此工单在所有页面置顶警示,直到图纸确认下发后解除。
          </p>
        </header>

        <div className="px-6 py-5">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="客户改了什么 · 哪些零件受影响"
            rows={3}
            autoFocus
            disabled={pending}
            className="w-full resize-none text-[13px] text-[var(--color-ink)] bg-transparent border-b border-[var(--color-ink)] py-1.5 placeholder:text-[var(--color-ink-4)] focus:outline-none"
          />
        </div>

        {error && (
          <p className="px-6 pb-2 text-[12px] text-[var(--color-overdue)]">
            {error}
          </p>
        )}

        <footer className="px-6 py-4 border-t border-[var(--color-border)] flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="px-3 py-1.5 text-[12px] tracking-wider border border-[var(--color-border)] text-[var(--color-ink-2)] hover:bg-[#f1eee4] rounded-[2px] disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="px-3 py-1.5 text-[12px] tracking-wider bg-[var(--color-overdue)] text-[var(--color-surface)] rounded-[2px] hover:opacity-80 disabled:opacity-40"
          >
            {pending ? '提交中…' : '报警'}
          </button>
        </footer>
      </div>
    </div>
  )
}

// The headline. First element on the job-detail page while the alarm is
// open — full-width, one line when it fits, the note as the dominant text.
// The clear action lives here (mirrors ActiveReturnBadge's 关闭) and is
// gated to 商务 + 工程 head.
export function DrawingChangeBanner({
  jobId,
  note,
  by,
  at,
  canEdit,
}: {
  jobId: string
  note?: string
  by?: string
  at?: string
  canEdit: boolean
}) {
  const [pending, start] = useTransition()
  const router = useRouter()
  const clear = () => {
    if (!confirm('确认解除图纸变更报警?请确保新图纸已下发到位。')) return
    start(async () => {
      await mutate({ kind: 'setDrawingChange', jobId, open: false })
      router.refresh()
    })
  }
  return (
    <div
      role="alert"
      className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-1 border border-[var(--color-overdue)] bg-[var(--color-overdue-soft)] rounded-[2px] px-5 py-3.5"
    >
      <span className="label text-[var(--color-overdue)] shrink-0">
        图纸变更
      </span>
      <span className="flex-1 min-w-[200px] text-[14px] font-medium text-[var(--color-ink)]">
        {note?.trim() || '客户已修改图纸,请核对最新图纸后再加工。'}
      </span>
      <span className="mono text-[11px] text-[var(--color-ink-2)] shrink-0">
        {at ? formatShipmentTimestamp(at) : ''}
        {by ? ` · ${by} 提报` : ''}
      </span>
      {canEdit && (
        <button
          type="button"
          onClick={clear}
          disabled={pending}
          className="text-[11px] tracking-wider text-[var(--color-overdue)] hover:text-[var(--color-ink)] underline underline-offset-2 disabled:opacity-50 shrink-0"
        >
          {pending ? '解除中…' : '图纸已确认 · 解除'}
        </button>
      )}
    </div>
  )
}
