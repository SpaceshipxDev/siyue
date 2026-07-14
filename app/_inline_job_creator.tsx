'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CNC_OP_STAGES, stageLabel, type Stage } from '@/lib/data'
import { withBase } from '@/lib/base-path'
import { showToast } from './_toast'
import { OPEN_NEW_JOB_EVENT } from './_create_job_button'

type Draft = {
  customer: string
  partNo: string
  name: string
  dueDate: string
  drawingNo: string
  qty: string
  stages: Stage[]
}

const INITIAL_STAGES = CNC_OP_STAGES.slice(0, 3)

function emptyDraft(): Draft {
  return {
    customer: '',
    partNo: '',
    name: '',
    dueDate: '',
    drawingNo: '',
    qty: '',
    stages: [...INITIAL_STAGES],
  }
}

const cell =
  'h-[58px] border-r border-[var(--color-border)] p-0 last:border-r-0 focus-within:bg-[var(--color-info-soft)] focus-within:shadow-[inset_0_-2px_0_var(--color-info)]'
const input =
  'h-full w-full min-w-0 bg-transparent px-3 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)]'

export function InlineJobCreator({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const router = useRouter()
  const customerRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(defaultOpen)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const reveal = () => {
      setOpen(true)
      setError(undefined)
      requestAnimationFrame(() => customerRef.current?.focus())
    }
    window.addEventListener(OPEN_NEW_JOB_EVENT, reveal)
    return () => window.removeEventListener(OPEN_NEW_JOB_EVENT, reveal)
  }, [])

  useEffect(() => {
    if (defaultOpen) requestAnimationFrame(() => customerRef.current?.focus())
  }, [defaultOpen])

  const nextStage = useMemo(
    () => CNC_OP_STAGES.find((stage) => !draft.stages.includes(stage)),
    [draft.stages],
  )
  const quantity = Number(draft.qty)
  const canSave =
    draft.customer.trim().length > 0 &&
    draft.partNo.trim().length > 0 &&
    draft.name.trim().length > 0 &&
    draft.dueDate.length > 0 &&
    Number.isInteger(quantity) &&
    quantity > 0

  function setField<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
    setError(undefined)
  }

  function close() {
    if (saving) return
    setOpen(false)
    setDraft(emptyDraft())
    setError(undefined)
    if (defaultOpen) router.replace('/')
  }

  async function save() {
    if (!canSave || saving) return
    setSaving(true)
    setError(undefined)
    try {
      const response = await fetch(withBase('/api/manual-job'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: draft.customer,
          partNo: draft.partNo,
          name: draft.name,
          drawingNo: draft.drawingNo,
          qty: quantity,
          dueDate: draft.dueDate,
          stages: draft.stages,
        }),
      })
      const result = (await response.json()) as {
        ok?: boolean
        jobId?: string
        error?: string
      }
      if (!response.ok || !result.ok) throw new Error(result.error || '新建失败')
      setOpen(false)
      setDraft(emptyDraft())
      showToast('工单已添加到看板')
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '新建失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <section className="mb-4" aria-label="新建工单编辑行">
      <div className="mb-2 flex items-baseline justify-between gap-4 px-0.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] font-semibold text-[var(--color-ink)]">新工单</span>
          <span className="text-[11px] text-[var(--color-ink-3)]">直接在单元格中输入</span>
        </div>
        {error ? (
          <span role="alert" className="text-[11px] text-[var(--color-overdue)]">
            {error}
          </span>
        ) : null}
      </div>

      <div className="overflow-x-auto border-y border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-[0_8px_24px_-22px_rgba(20,19,15,0.7)]">
        <table className="w-max min-w-full border-collapse">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left">
              {['客户', '货号', '描述', '交期', '图纸号', '数量', '工序', ''].map((label, index) => (
                <th
                  key={`${label}-${index}`}
                  className={`h-8 px-3 text-[10px] font-semibold tracking-[0.08em] text-[var(--color-ink-3)] ${
                    label === '工序' ? 'min-w-[390px]' : label === '' ? 'w-[146px]' : 'min-w-[132px]'
                  }`}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="bg-[color-mix(in_srgb,var(--color-info)_3%,var(--color-surface))]">
              <td className={cell}>
                <input
                  ref={customerRef}
                  aria-label="客户"
                  value={draft.customer}
                  onChange={(event) => setField('customer', event.target.value)}
                  placeholder="输入客户"
                  className={input}
                />
              </td>
              <td className={cell}>
                <input
                  aria-label="货号"
                  value={draft.partNo}
                  onChange={(event) => setField('partNo', event.target.value)}
                  placeholder="输入货号"
                  className={`${input} font-mono`}
                />
              </td>
              <td className={cell}>
                <input
                  aria-label="描述"
                  value={draft.name}
                  onChange={(event) => setField('name', event.target.value)}
                  placeholder="输入描述"
                  className={input}
                />
              </td>
              <td className={cell}>
                <input
                  aria-label="交期"
                  type="date"
                  value={draft.dueDate}
                  onChange={(event) => setField('dueDate', event.target.value)}
                  className={`${input} font-mono`}
                />
              </td>
              <td className={cell}>
                <input
                  aria-label="图纸号"
                  value={draft.drawingNo}
                  onChange={(event) => setField('drawingNo', event.target.value)}
                  placeholder="输入图纸号"
                  className={`${input} font-mono`}
                />
              </td>
              <td className={cell}>
                <input
                  aria-label="数量"
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  value={draft.qty}
                  onChange={(event) => setField('qty', event.target.value)}
                  placeholder="0"
                  className={`${input} w-24 font-mono font-semibold`}
                />
              </td>
              <td className={`${cell} px-3`}>
                <div className="flex min-w-max items-center gap-1.5">
                  {draft.stages.map((stage) => (
                    <span
                      key={stage}
                      className="inline-flex h-7 items-center overflow-hidden rounded-[3px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[11px] font-medium text-[var(--color-ink-2)]"
                    >
                      <span className="pl-2.5 pr-1.5">{stageLabel(stage)}</span>
                      <button
                        type="button"
                        onClick={() => setField('stages', draft.stages.filter((item) => item !== stage))}
                        aria-label={`删除 ${stageLabel(stage)}`}
                        title={`删除 ${stageLabel(stage)}`}
                        className="flex h-full w-6 items-center justify-center text-[14px] text-[var(--color-ink-3)] transition-colors hover:bg-[var(--color-overdue-soft)] hover:text-[var(--color-overdue)]"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {nextStage ? (
                    <button
                      type="button"
                      onClick={() => setField('stages', [...draft.stages, nextStage].sort((a, b) => CNC_OP_STAGES.indexOf(a) - CNC_OP_STAGES.indexOf(b)))}
                      className="h-7 rounded-[3px] border border-dashed border-[var(--color-border-strong)] px-2.5 text-[11px] text-[var(--color-ink-3)] transition-colors hover:border-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
                    >
                      ＋ 添加工序
                    </button>
                  ) : null}
                </div>
              </td>
              <td className="h-[58px] px-3">
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={close}
                    className="h-8 px-2 text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] disabled:opacity-40"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={!canSave || saving}
                    onClick={() => void save()}
                    className="h-8 whitespace-nowrap rounded-[3px] bg-[var(--color-ink)] px-3 text-[12px] font-semibold text-[var(--color-surface)] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    {saving ? '添加中…' : '确认添加'}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}
