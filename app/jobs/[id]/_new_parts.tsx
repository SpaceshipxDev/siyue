'use client'

import { useMemo, useState } from 'react'
import { DEFAULT_ROUTE_STAGES, STAGES, type Component } from '@/lib/data'
import { mutate } from '@/lib/mutate'
import {
  ComponentLineTotal,
  ComponentNotes,
  ComponentQty,
  ComponentText,
  ComponentUnitPrice,
} from '@/app/_editable'
import { ComponentImageUploader } from '@/app/_image_uploader'
import { EffectiveStageCell } from '@/app/_stagecell'
import { DeletePartButton } from './_part_delete'

// Parts added in THIS visit, rendered as a second <tbody> continuing the
// server-rendered sheet. The row appears the moment appendComponent's
// 30-byte response lands — never via router.refresh(), whose full RSC
// payload the GFW truncates for mainland users (the "click add, wait,
// F5" experience). A reload folds these rows into the server table.
export function NewPartsBody({
  jobId,
  startIndex,
  canEditFields,
  showMoney,
}: {
  jobId: string
  startIndex: number
  canEditFields: boolean
  showMoney: boolean
}) {
  const [ids, setIds] = useState<string[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!canEditFields) return null

  // 9 leading cols + stage grid + 出货记录/动态 + 备注 + money + 删除. Must
  // track the server table's colgroup (canEditFields is true here by gate).
  const totalCols = 9 + STAGES.length + 2 + 1 + (showMoney ? 2 : 0) + 1

  const add = async () => {
    setPending(true)
    setError(null)
    try {
      const r = await mutate<{ id?: string }>({ kind: 'appendComponent', jobId })
      const id = 'data' in r ? r.data?.id : undefined
      if (!id) throw new Error('服务器未返回零件 ID')
      setIds((prev) => [...prev, id])
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加失败')
    } finally {
      setPending(false)
    }
  }

  return (
    <tbody>
      {ids.map((id, i) => (
        <NewPartRow
          key={id}
          jobId={jobId}
          componentId={id}
          ordinal={startIndex + i + 1}
          showMoney={showMoney}
          onDeleted={() => setIds((prev) => prev.filter((x) => x !== id))}
        />
      ))}
      <tr>
        <td colSpan={totalCols} className="px-3 py-2">
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={pending}
              onClick={add}
              className="px-3 py-1.5 text-[12px] tracking-wider border border-[var(--color-border-strong)] text-[var(--color-ink-2)] rounded-[2px] hover:text-[var(--color-ink)] hover:border-[var(--color-ink)] disabled:opacity-50"
            >
              {pending ? '添加中…' : '+ 添加零件'}
            </button>
            {error && (
              <span className="text-[12px] text-[var(--color-overdue)]">
                {error}
              </span>
            )}
          </div>
        </td>
      </tr>
    </tbody>
  )
}

function NewPartRow({
  jobId,
  componentId,
  ordinal,
  showMoney,
  onDeleted,
}: {
  jobId: string
  componentId: string
  ordinal: number
  showMoney: boolean
  onDeleted: () => void
}) {
  // Server truth for a fresh part: every default-route stage seeded pending
  // (DEFAULT_NEW_PART_STAGES = DEFAULT_ROUTE_STAGES — the opt-in 采购/表处
  // are absent), nothing else set. Stage taps mutate the real part_stages
  // rows that appendComponent created; the absent stages render as n/a
  // slashes, matching the server exactly.
  const component = useMemo<Component>(
    () => ({
      id: componentId,
      name: '',
      qty: 0,
      stages: Object.fromEntries(
        DEFAULT_ROUTE_STAGES.map((s) => [s, { status: 'pending' as const }]),
      ),
    }),
    [componentId],
  )
  return (
    <tr className="align-middle">
      <td className="px-3 py-3 text-center mono text-[var(--color-ink-3)] text-[12px]">
        {String(ordinal).padStart(2, '0')}
      </td>
      <td className="px-3 py-2">
        <ComponentImageUploader
          jobId={jobId}
          componentId={componentId}
          imageUrl={undefined}
          size={56}
        />
      </td>
      <td className="px-3 py-3">
        <ComponentText
          jobId={jobId}
          componentId={componentId}
          field="name"
          value=""
          placeholder="零件名称"
          className="text-[14px] font-medium text-[var(--color-ink)]"
        />
      </td>
      <td className="px-3 py-3">
        <ComponentText
          jobId={jobId}
          componentId={componentId}
          field="partNo"
          value={undefined}
          placeholder="—"
          className="mono text-[12px] text-[var(--color-ink-2)]"
        />
      </td>
      <td className="px-3 py-3 align-top">
        <ComponentText
          jobId={jobId}
          componentId={componentId}
          field="process"
          value={undefined}
          placeholder="—"
          multiline
          className="text-[12px] text-[var(--color-ink-2)] leading-snug"
        />
      </td>
      <td className="px-3 py-3 align-top">
        <ComponentQty
          jobId={jobId}
          componentId={componentId}
          value={0}
          className="text-[13px] text-[var(--color-ink)]"
        />
      </td>
      <td className="px-3 py-3 align-top">
        <ComponentText
          jobId={jobId}
          componentId={componentId}
          field="material"
          value={undefined}
          placeholder="材料"
          multiline
          className="text-[12px] text-[var(--color-ink-2)] leading-snug"
        />
      </td>
      <td className="px-3 py-3 align-top">
        <ComponentText
          jobId={jobId}
          componentId={componentId}
          field="surfaceTreatment"
          value={undefined}
          placeholder="表面处理"
          multiline
          className="text-[12px] text-[var(--color-ink-2)] leading-snug"
        />
      </td>
      {/* 工序 chips need the full server component — prune the route after
          the next page load; a fresh part correctly routes through the
          default stages until then. */}
      <td className="px-3 py-3 align-top text-[12px] text-[var(--color-ink-4)]">
        全部工段
      </td>
      {STAGES.map((stage) => (
        <td key={stage} className="p-0 h-[60px]">
          <EffectiveStageCell
            jobId={jobId}
            component={component}
            stage={stage}
            interactive
          />
        </td>
      ))}
      <td className="px-3 py-3 align-top text-[var(--color-ink-4)] mono text-[11px]">
        —
      </td>
      <td className="px-3 py-3 align-top text-[var(--color-ink-4)] mono text-[11px]">
        —
      </td>
      <td className="px-3 py-3 align-top">
        <ComponentNotes
          jobId={jobId}
          componentId={componentId}
          value={undefined}
          placeholder="添加备注…"
          multiline
          className="text-[12px] text-[var(--color-ink-2)] leading-snug"
        />
      </td>
      {showMoney && (
        <td className="px-3 py-3">
          <ComponentUnitPrice
            jobId={jobId}
            componentId={componentId}
            value={undefined}
            className="text-[13px] text-[var(--color-ink)]"
          />
        </td>
      )}
      {showMoney && (
        <td className="px-3 py-3">
          <ComponentLineTotal
            jobId={jobId}
            componentId={componentId}
            value={undefined}
            className="text-[13px] text-[var(--color-ink)]"
          />
        </td>
      )}
      <td className="px-2 py-3 text-center align-middle">
        <DeletePartButton
          jobId={jobId}
          componentId={componentId}
          componentName=""
          onDeleted={onDeleted}
        />
      </td>
    </tr>
  )
}
