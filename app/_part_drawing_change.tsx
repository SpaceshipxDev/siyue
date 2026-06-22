'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  formatShipmentTimestamp,
  revisionLabel,
  type PartDrawingChange as Change,
} from '@/lib/data'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'

// 零件图纸变更 — the per-part version of the job alarm. A part's drawing can be
// revised 一次/二次/三次…; each revision is recorded with what changed + who/
// when, and the floor sees a red flag on THAT part until it's marked handled.
// The badge sits in the 零件 column next to the inspection/return tags. Floor
// users see it read-only; 商务/工程 head raise + clear.

function openRevision(changes: Change[]): Change | undefined {
  let best: Change | undefined
  for (const d of changes) {
    if (!d.clearedAt && (!best || d.revision > best.revision)) best = d
  }
  return best
}

export function PartDrawingChange({
  jobId,
  partId,
  partName,
  changes,
  canEdit,
}: {
  jobId: string
  partId: string
  partName: string
  changes: Change[]
  canEdit: boolean
}) {
  const [open, setOpen] = useState(false)
  const live = openRevision(changes)
  const count = changes.reduce((m, d) => Math.max(m, d.revision), 0)

  // Nothing to show for a read-only viewer with a clean part.
  if (!canEdit && count === 0) return null

  return (
    <span className="block mt-1">
      <button type="button" onClick={() => setOpen(true)} className="text-left">
        {live ? (
          <span className="inline-flex items-center rounded-[2px] border border-[var(--color-overdue)] bg-[var(--color-overdue-soft)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-[var(--color-overdue)]">
            图纸变更 · {revisionLabel(live.revision)}
            {live.note ? (
              <span className="ml-1 max-w-[120px] truncate font-normal">{live.note}</span>
            ) : null}
          </span>
        ) : count > 0 ? (
          <span className="inline-flex items-center rounded-[2px] border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] tracking-wider text-[var(--color-ink-3)]">
            图纸 {revisionLabel(count)} · 已处理
          </span>
        ) : (
          <span className="text-[10px] tracking-wider text-[var(--color-ink-4)] hover:text-[var(--color-overdue)] transition-colors">
            ＋图纸变更
          </span>
        )}
      </button>
      {open && (
        <DrawingChangeModal
          jobId={jobId}
          partId={partId}
          partName={partName}
          changes={changes}
          live={live}
          count={count}
          canEdit={canEdit}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  )
}

function DrawingChangeModal({
  jobId,
  partId,
  partName,
  changes,
  live,
  count,
  canEdit,
  onClose,
}: {
  jobId: string
  partId: string
  partName: string
  changes: Change[]
  live: Change | undefined
  count: number
  canEdit: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, pending])

  const raise = () => {
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'raisePartDrawingChange',
          jobId,
          partId,
          note: note.trim() || null,
        })
        showToast(`已记 ${partName} 图纸变更 · ${revisionLabel(count + 1)}`, 'warning')
        router.refresh()
        onClose()
      } catch (e) {
        setError(e instanceof Error ? e.message : '提交失败')
      }
    })
  }

  const clear = () => {
    setError(null)
    start(async () => {
      try {
        await mutate({ kind: 'clearPartDrawingChange', jobId, partId })
        router.refresh()
        onClose()
      } catch (e) {
        setError(e instanceof Error ? e.message : '解除失败')
      }
    })
  }

  // History newest-first for reading.
  const history = changes.slice().sort((a, b) => b.revision - a.revision)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`图纸变更 · ${partName}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => {
        if (!pending) onClose()
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-[460px] flex-col rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-xl"
      >
        <header className="border-b border-[var(--color-border)] px-6 py-4">
          <p className="label mb-1 text-[var(--color-ink-3)]">图纸变更 · 零件</p>
          <h2 className="text-[16px] font-semibold tracking-tight text-[var(--color-ink)]">
            {partName}
          </h2>
          <p className="mt-1 text-[12px] text-[var(--color-ink-3)]">
            {live
              ? `当前第 ${live.revision} 次变更未处理 · 核对新图纸后再加工`
              : count > 0
                ? `共 ${count} 次变更 · 均已处理`
                : '记录客户改图，逐次留痕，避免照旧图加工'}
          </p>
        </header>

        {/* History — 一次/二次/三次, newest first. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {history.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-[var(--color-ink-4)]">
              暂无图纸变更记录
            </p>
          ) : (
            <ol className="flex flex-col gap-3">
              {history.map((d) => (
                <li
                  key={d.id}
                  className={`rounded-[2px] border px-3 py-2.5 ${
                    !d.clearedAt
                      ? 'border-[var(--color-overdue)] bg-[var(--color-overdue-soft)]'
                      : 'border-[var(--color-border)]'
                  }`}
                >
                  <div className="flex items-baseline justify-between">
                    <span
                      className={`text-[13px] font-semibold ${
                        !d.clearedAt
                          ? 'text-[var(--color-overdue)]'
                          : 'text-[var(--color-ink-2)]'
                      }`}
                    >
                      {revisionLabel(d.revision)}变更
                    </span>
                    <span className="mono text-[11px] text-[var(--color-ink-3)]">
                      {formatShipmentTimestamp(d.raisedAt)}
                      {d.raisedBy ? ` · ${d.raisedBy}` : ''}
                    </span>
                  </div>
                  <p className="mt-1 text-[13px] text-[var(--color-ink)]">
                    {d.note?.trim() || '（未填写变更内容）'}
                  </p>
                  {d.clearedAt && (
                    <p className="mt-1 text-[11px] text-[var(--color-ink-4)]">
                      已处理 · {formatShipmentTimestamp(d.clearedAt)}
                      {d.clearedBy ? ` · ${d.clearedBy}` : ''}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>

        {/* Actions — raise the next revision, or mark the open one handled. */}
        {canEdit && (
          <div className="border-t border-[var(--color-border)] px-6 py-4">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="这次改了什么 · 例如「孔位偏移 / 厚度 5→6」"
              rows={2}
              disabled={pending}
              className="w-full resize-none border-b border-[var(--color-ink)] bg-transparent py-1.5 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] focus:outline-none"
            />
            {error && (
              <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>
            )}
            <div className="mt-3 flex items-center justify-between gap-2">
              {live ? (
                <button
                  type="button"
                  onClick={clear}
                  disabled={pending}
                  className="text-[12px] tracking-wider text-[var(--color-ink-3)] underline underline-offset-2 hover:text-[var(--color-ink)] disabled:opacity-50"
                >
                  {pending ? '处理中…' : '图纸已下发 · 标记处理'}
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={raise}
                disabled={pending}
                className="rounded-[2px] bg-[var(--color-overdue)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-surface)] hover:opacity-85 disabled:opacity-40"
              >
                {pending ? '提交中…' : `报警 · ${revisionLabel(count + 1)}变更`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
