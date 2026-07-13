'use client'

import { useEffect, useRef, useState } from 'react'
import { useFormStatus } from 'react-dom'
import type { DueState } from '@/lib/data'
import { updatePartHeaderAction } from './_header_actions'

type HeaderFacts = {
  name: string
  customer: string
  partNo: string
  drawingNo: string
  qty: number
  dueDate: string
  material: string
}

function DueDelta({ state, days }: { state: DueState; days: number }) {
  if (state === 'overdue') {
    return (
      <span className="label text-[var(--color-overdue)]">
        逾期 {Math.abs(days)} 天
      </span>
    )
  }
  if (state === 'today') {
    return <span className="label text-[var(--color-warning)]">今日</span>
  }
  return <span className="label text-[var(--color-ink-3)]">{days} 天后</span>
}

function SaveButton() {
  const { pending } = useFormStatus()

  return (
    <button
      type="submit"
      disabled={pending}
      className="h-8 px-3 text-[12px] font-semibold bg-[var(--color-ink)] text-[var(--color-surface)] rounded-[3px] disabled:opacity-50"
    >
      {pending ? '保存中…' : '保存'}
    </button>
  )
}

// The identity card itself is the editor. Clicking 编辑 keeps every fact in
// place and swaps only its text for a native input, so the user's eyes and
// pointer never have to jump to a second, duplicated form.
export function HeaderEdit({
  jobId,
  componentId,
  partId,
  initial,
  dueState,
  dueDays,
  progress,
}: {
  jobId: string
  componentId: string
  partId?: string
  initial: HeaderFacts
  dueState: DueState
  dueDays: number
  progress: { percent: number; done: number; total: number }
}) {
  const [editing, setEditing] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    nameInput.current?.focus()
    nameInput.current?.select()
  }, [editing])

  const input =
    'border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] outline-none focus:border-[var(--color-ink)] focus:ring-2 focus:ring-[var(--color-border)]'

  return (
    <form
      action={updatePartHeaderAction}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setEditing(false)
      }}
    >
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="componentId" value={componentId} />
      {partId ? <input type="hidden" name="partId" value={partId} /> : null}
      <input type="hidden" name="material" value={initial.material} />

      <div className="flex items-start justify-between gap-4">
        {editing ? (
          <input
            name="customer"
            aria-label="客户"
            defaultValue={initial.customer}
            className={`${input} h-8 min-w-0 w-full max-w-[320px] px-2 label text-[var(--color-ink)]`}
          />
        ) : (
          <p className="label mb-1">{initial.customer}</p>
        )}

        {editing ? (
          <div className="flex shrink-0 gap-2">
            <SaveButton />
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="h-8 px-3 text-[12px] border border-[var(--color-border)] rounded-[3px]"
            >
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="label shrink-0 text-[var(--color-ink-3)] hover:text-[var(--color-ink)] border border-[var(--color-border)] rounded-[3px] px-2.5 py-1.5"
          >
            ✎ 编辑
          </button>
        )}
      </div>

      {editing ? (
        <input
          ref={nameInput}
          name="name"
          aria-label="名称"
          defaultValue={initial.name}
          className={`${input} mt-1 h-11 w-full max-w-[720px] px-2.5 text-[22px] md:text-[26px] font-semibold tracking-tight`}
        />
      ) : (
        <h1 className="text-[26px] font-semibold tracking-tight text-[var(--color-ink)]">
          {initial.name}
        </h1>
      )}

      {editing ? (
        <div className="mt-1 flex w-full max-w-[720px] flex-wrap gap-2">
          <input
            name="partNo"
            aria-label="货号"
            placeholder="货号"
            defaultValue={initial.partNo}
            className={`${input} h-8 min-w-[180px] flex-1 px-2 mono text-[12px]`}
          />
          <input
            name="drawingNo"
            aria-label="图纸号"
            placeholder="图纸号"
            defaultValue={initial.drawingNo}
            className={`${input} h-8 min-w-[180px] flex-1 px-2 mono text-[12px]`}
          />
        </div>
      ) : (
        (initial.partNo || initial.drawingNo) && (
          <p className="mono text-[12px] text-[var(--color-ink-2)] mt-1 break-all">
            {initial.partNo}
            {initial.partNo && initial.drawingNo ? ' · ' : ''}
            {initial.drawingNo}
          </p>
        )
      )}

      <div className="mt-4 flex flex-wrap items-baseline gap-x-8 gap-y-2">
        <div>
          <p className="label mb-0.5">数量</p>
          {editing ? (
            <div className="flex items-center gap-1.5">
              <input
                name="qty"
                aria-label="数量"
                type="number"
                inputMode="numeric"
                min={1}
                defaultValue={initial.qty}
                className={`${input} h-9 w-28 px-2 mono text-[15px] font-semibold`}
              />
              <span className="mono text-[15px] font-semibold">件</span>
            </div>
          ) : (
            <p className="mono text-[15px] font-semibold">{initial.qty} 件</p>
          )}
        </div>

        <div>
          <p className="label mb-0.5">交期</p>
          <div className="flex items-baseline gap-2">
            {editing ? (
              <input
                name="dueDate"
                aria-label="交期"
                type="date"
                defaultValue={initial.dueDate}
                className={`${input} h-9 px-2 mono text-[14px]`}
              />
            ) : (
              <>
                <span className="mono text-[15px]">{initial.dueDate || '—'}</span>
                <DueDelta state={dueState} days={dueDays} />
              </>
            )}
          </div>
        </div>

        <div className="min-w-[180px]">
          <p className="label mb-0.5">进度</p>
          <div className="flex items-baseline gap-2">
            <span className="mono text-[15px] font-semibold">{progress.percent}%</span>
            <span className="label">{progress.done}/{progress.total}</span>
          </div>
          <div className="mt-1.5 h-[2px] w-full bg-[var(--color-border)]">
            <div
              className="h-full bg-[var(--color-ink)]"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      </div>
    </form>
  )
}
