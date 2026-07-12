'use client'

import { useState } from 'react'
import { updatePartHeaderAction } from './_header_actions'

// Inline correction for the AI-extracted part card. Collapsed to one 编辑
// affordance; expanded it is a native form (works in any webview) with the
// six facts prefilled. Saving reloads the card via the server action.
export function HeaderEdit({
  jobId,
  componentId,
  partId,
  initial,
}: {
  jobId: string
  componentId: string
  partId?: string
  initial: {
    name: string
    customer: string
    partNo: string
    drawingNo: string
    qty: number
    dueDate: string
    material: string
  }
}) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="label text-[var(--color-ink-3)] hover:text-[var(--color-ink)] border border-[var(--color-border)] rounded-[3px] px-2.5 py-1.5"
      >
        ✎ 编辑
      </button>
    )
  }

  const field = 'h-10 px-2.5 text-[14px] w-full border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] outline-none focus:border-[var(--color-ink)]'
  return (
    <form
      action={updatePartHeaderAction}
      className="mt-3 w-full max-w-[720px] grid grid-cols-2 md:grid-cols-3 gap-2.5 border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] p-3"
    >
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="componentId" value={componentId} />
      {partId ? <input type="hidden" name="partId" value={partId} /> : null}
      <label className="col-span-2 md:col-span-1">
        <span className="label block mb-1">名称</span>
        <input name="name" defaultValue={initial.name} className={field} />
      </label>
      <label>
        <span className="label block mb-1">客户</span>
        <input name="customer" defaultValue={initial.customer} className={field} />
      </label>
      <label>
        <span className="label block mb-1">数量</span>
        <input
          name="qty"
          type="number"
          inputMode="numeric"
          min={1}
          defaultValue={initial.qty}
          className={`${field} font-mono`}
        />
      </label>
      <label>
        <span className="label block mb-1">货号</span>
        <input name="partNo" defaultValue={initial.partNo} className={`${field} font-mono`} />
      </label>
      <label>
        <span className="label block mb-1">图纸号</span>
        <input name="drawingNo" defaultValue={initial.drawingNo} className={`${field} font-mono`} />
      </label>
      <label>
        <span className="label block mb-1">材质</span>
        <input name="material" defaultValue={initial.material} className={field} />
      </label>
      <label>
        <span className="label block mb-1">交期</span>
        <input name="dueDate" type="date" defaultValue={initial.dueDate} className={`${field} font-mono`} />
      </label>
      <div className="col-span-2 md:col-span-3 flex gap-2 pt-1">
        <button
          type="submit"
          className="h-10 px-5 text-[13px] font-semibold bg-[var(--color-ink)] text-[var(--color-surface)] rounded-[3px]"
        >
          保存
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="h-10 px-4 text-[13px] border border-[var(--color-border)] rounded-[3px]"
        >
          取消
        </button>
      </div>
    </form>
  )
}
