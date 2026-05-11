'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  OUTSOURCEABLE_STAGES,
  isBlockClosed,
  isMemberFullyReturned,
  isMemberPartiallyReturned,
  memberRemainingQty,
  memberReturnedQty,
  outsourceLabel,
  type OutsourceBlock,
  type Stage,
  type Vendor,
} from '@/lib/data'
import {
  createOutsourceBlockAction,
  createVendorAction,
  deleteOutsourceBlockAction,
  setBlockMembersReturnedQtyAction,
  setMemberReturnedQtyAction,
  updateVendorAction,
} from './actions'

import { today } from '@/lib/today'
import {
  NameCombobox,
  OutsourceBlockAmount,
  OutsourceBlockDate,
} from './_editable'

function fieldStyles(): string {
  return 'bg-transparent border border-[var(--color-border)] rounded-sm px-2 py-1 text-[13px] text-[var(--color-ink)] focus:outline-none focus:border-[var(--color-ink)] disabled:opacity-50'
}

export type ComponentOption = {
  id: string
  name: string
  qty: number
  hasAnyBlock: boolean
}

// === Stage picker ===
//
// Calendar-style two-click range: first click anchors one end, second click
// closes the range to that point. A third click starts over. Hovering while
// anchored previews the candidate range so the user sees the result before
// committing. No "closer endpoint" math — the user's two clicks are exactly
// the two endpoints, in either order.
//
// "Anchored" is derived from selected.length === 1, so a 全部 reset (or any
// external mutation of `selected`) implicitly clears the gesture without an
// internal anchor state to keep in sync.
function StageRangePicker({
  selected,
  onChange,
  disabled,
}: {
  selected: Stage[]
  onChange: (next: Stage[]) => void
  disabled?: boolean
}) {
  const [hover, setHover] = useState<Stage | null>(null)

  const idxOf = (s: Stage) => OUTSOURCEABLE_STAGES.indexOf(s)
  const indices = selected.map(idxOf).filter((i) => i >= 0).sort((a, b) => a - b)
  const minIdx = indices[0] ?? -1
  const maxIdx = indices[indices.length - 1] ?? -1
  const isSelected = (s: Stage) => {
    const i = idxOf(s)
    return minIdx >= 0 && i >= minIdx && i <= maxIdx
  }

  const anchored = selected.length === 1
  const anchorIdx = anchored ? idxOf(selected[0]) : -1
  const hoverIdx = hover !== null ? idxOf(hover) : -1
  const previewActive = anchored && hoverIdx >= 0
  const previewLo = previewActive ? Math.min(anchorIdx, hoverIdx) : -1
  const previewHi = previewActive ? Math.max(anchorIdx, hoverIdx) : -1

  const handle = (s: Stage) => {
    if (disabled) return
    const idx = idxOf(s)
    if (idx < 0) return
    if (anchored) {
      const lo = Math.min(anchorIdx, idx)
      const hi = Math.max(anchorIdx, idx)
      onChange(OUTSOURCEABLE_STAGES.slice(lo, hi + 1))
      setHover(null)
      return
    }
    onChange([s])
  }

  return (
    <span
      className="inline-flex flex-wrap items-center gap-x-1 gap-y-0.5 leading-none -ml-1"
      onMouseLeave={() => setHover(null)}
    >
      {OUTSOURCEABLE_STAGES.map((stage) => {
        const idx = idxOf(stage)
        const sel = isSelected(stage)
        const isAnchor = anchored && idx === anchorIdx
        const inPreview = previewActive && idx >= previewLo && idx <= previewHi
        // Treat the anchor as "in preview" too, so the start stays solid
        // while hovering anywhere — including back over the anchor itself.
        const filled = previewActive ? inPreview : sel
        const boxCls = filled
          ? 'bg-[var(--color-ink)] border-[var(--color-ink)]'
          : 'bg-transparent border-[var(--color-ink-4)]'
        const textCls = filled
          ? 'text-[var(--color-ink)] font-medium'
          : 'text-[var(--color-ink-3)]'
        const hoverCls = !disabled
          ? 'hover:bg-[#f1eee4] cursor-pointer'
          : 'cursor-default'
        const title = disabled
          ? stage
          : anchored
            ? isAnchor
              ? `${stage} · 起点 · 再点其他工段确定终点`
              : `${selected[0]} → ${stage}`
            : sel
              ? `${stage} · 点击为新起点`
              : `${stage} · 点击为起点`
        return (
          <button
            key={stage}
            type="button"
            disabled={disabled}
            onClick={() => handle(stage)}
            onMouseEnter={() => setHover(stage)}
            title={title}
            aria-pressed={sel}
            className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] ${hoverCls}`}
          >
            <span
              aria-hidden="true"
              className={`block h-[7px] w-[7px] rounded-[1px] border transition-colors ${boxCls}`}
            />
            <span className={`text-[11px] tracking-wider transition-colors ${textCls}`}>
              {stage}
            </span>
          </button>
        )
      })}
    </span>
  )
}

export function NewBlockForm({
  jobId,
  components,
  vendors,
}: {
  jobId: string
  components: ComponentOption[]
  vendors: Vendor[]
}) {
  // Components already covered by an outsource block can't be added again —
  // a block now covers a contiguous stage range and a second block on the
  // same range would overlap. Filter them out of the dropdown rather than
  // letting submit fail.
  const available = components.filter((c) => !c.hasAnyBlock)
  // Multi-select: track a Set of component ids. Default to first available.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(available[0]?.id ? [available[0].id] : []),
  )
  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? '')
  // Vendor list seeds empty — the form opens in create mode whenever there
  // are no existing vendors, and the user can flip back to that mode via
  // the "+ 新增" button next to the picker once some exist.
  const [vendorMode, setVendorMode] = useState<'select' | 'create'>(
    vendors.length === 0 ? 'create' : 'select',
  )
  const [newVendorName, setNewVendorName] = useState('')
  const [newVendorAddress, setNewVendorAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [sentDate, setSentDate] = useState(() => today())
  const [expectedReturn, setExpectedReturn] = useState(() => today())
  const [stageRange, setStageRange] = useState<Stage[]>([...OUTSOURCEABLE_STAGES])
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // 金额 is always optional. Empty → null in DB, surfaced as 待补金额 on the
  // row so commerce can fill it in later. The user-facing label/placeholder
  // makes "可留空 · 之后可补" obvious; there is no separate 加急 toggle.
  const vendorReady = vendorMode === 'select' ? !!vendorId : !!newVendorName.trim()
  const amountTrim = amount.trim()
  const amountValid = amountTrim === '' || Number(amountTrim) > 0
  const valid =
    selected.size > 0 &&
    vendorReady &&
    amountValid &&
    sentDate &&
    expectedReturn &&
    stageRange.length > 0

  const submit = () => {
    if (!valid) return
    setError(null)
    start(async () => {
      let useVendorId = vendorId
      if (vendorMode === 'create') {
        const created = await createVendorAction(
          newVendorName.trim(),
          undefined,
          newVendorAddress.trim() || undefined,
        )
        if (!created) {
          setError('外协厂创建失败')
          return
        }
        useVendorId = created.id
      }
      const id = await createOutsourceBlockAction(jobId, [...selected], {
        vendorId: useVendorId,
        stages: stageRange,
        amountCny: amountTrim === '' ? null : Number(amountTrim),
        sentDate,
        expectedReturn,
      })
      if (!id) {
        setError('创建失败：所选零件中可能已有外协记录')
        return
      }
      setAmount('')
      setSelected(new Set())
      setStageRange([...OUTSOURCEABLE_STAGES])
      if (vendorMode === 'create') {
        setVendorId(useVendorId)
        setVendorMode('select')
        setNewVendorName('')
        setNewVendorAddress('')
      }
    })
  }

  if (available.length === 0) {
    return (
      <p className="text-[12px] text-[var(--color-ink-3)] py-3">
        {components.length === 0
          ? '当前工单无可外协零件'
          : '所有零件均已外协 · 如需重新外协请先删除现有记录'}
      </p>
    )
  }

  return (
    <div className="rounded-sm border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <p className="label">新增外协 · 送出</p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-12 gap-3">
        <div className="col-span-2 md:col-span-3 flex flex-col gap-1">
          <span className="label">零件 · 多选</span>
          <div className="flex flex-col gap-1 max-h-[140px] overflow-auto border border-[var(--color-border)] rounded-sm bg-[var(--color-surface)] px-2 py-1.5">
            {available.map((c) => (
              <label
                key={c.id}
                className="flex items-center gap-2 text-[13px] text-[var(--color-ink)] cursor-pointer hover:text-[var(--color-ink)]"
              >
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  onChange={() => toggle(c.id)}
                  disabled={pending}
                  className="accent-[var(--color-ink)]"
                />
                <span className="flex-1 truncate">{c.name}</span>
                <span className="mono text-[11px] text-[var(--color-ink-3)] shrink-0">
                  {c.qty}件
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="col-span-2 md:col-span-3 flex flex-col gap-1">
          <div className="flex items-baseline justify-between">
            <span className="label">外协厂</span>
            {vendors.length > 0 ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  if (vendorMode === 'create') {
                    setVendorMode('select')
                    setNewVendorName('')
                  } else {
                    setVendorMode('create')
                  }
                }}
                className="label text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                {vendorMode === 'create' ? '选择已有' : '+ 新增'}
              </button>
            ) : null}
          </div>
          {vendorMode === 'select' ? (
            <select
              className={fieldStyles()}
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
              disabled={pending}
            >
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          ) : (
            <div className="flex flex-col gap-1.5">
              <input
                type="text"
                className={fieldStyles()}
                value={newVendorName}
                onChange={(e) => setNewVendorName(e.target.value)}
                placeholder="新外协厂名称"
                disabled={pending}
                autoFocus
              />
              <input
                type="text"
                className={fieldStyles()}
                value={newVendorAddress}
                onChange={(e) => setNewVendorAddress(e.target.value)}
                placeholder="供应商地址（可选）"
                disabled={pending}
              />
            </div>
          )}
        </div>
        <label className="col-span-1 md:col-span-2 flex flex-col gap-1">
          <span className="label">
            金额 · <span className="text-[var(--color-ink-3)]">可留空</span>
          </span>
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            className={`${fieldStyles()} mono text-right`}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="待定 · 之后可补"
            disabled={pending}
            title="可留空 — 送出后在该行点击 编辑 即可补填金额"
          />
        </label>
        <label className="col-span-1 md:col-span-2 flex flex-col gap-1">
          <span className="label">寄出</span>
          <input
            type="date"
            className={`${fieldStyles()} mono`}
            value={sentDate}
            onChange={(e) => setSentDate(e.target.value)}
            disabled={pending}
          />
        </label>
        <label className="col-span-1 md:col-span-2 flex flex-col gap-1">
          <span className="label">预计回厂</span>
          <input
            type="date"
            className={`${fieldStyles()} mono`}
            value={expectedReturn}
            onChange={(e) => setExpectedReturn(e.target.value)}
            disabled={pending}
          />
        </label>
        <div className="col-span-2 md:col-span-12 flex flex-col gap-1.5">
          <span className="label">范围 · 外协承接的工段</span>
          <div className="flex items-baseline gap-3 flex-wrap">
            <StageRangePicker
              selected={stageRange}
              onChange={setStageRange}
              disabled={pending}
            />
            <span className="label text-[var(--color-ink-3)]">
              {stageRange.length === 1
                ? `起点 ${stageRange[0]} · 再点工段确定终点`
                : (
                  <>
                    {outsourceLabel(stageRange)}
                    {stageRange.length < OUTSOURCEABLE_STAGES.length
                      ? ' · 其余环节在厂内'
                      : ' · 出货 在厂内完成'}
                  </>
                )}
            </span>
            {stageRange.length !== OUTSOURCEABLE_STAGES.length ? (
              <button
                type="button"
                onClick={() => setStageRange([...OUTSOURCEABLE_STAGES])}
                disabled={pending}
                className="label text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                全部
              </button>
            ) : null}
          </div>
        </div>
        <div className="col-span-2 md:col-span-12 flex items-end gap-3 flex-wrap">
          <button
            type="button"
            disabled={!valid || pending}
            onClick={submit}
            className="px-4 py-1.5 text-[13px] tracking-wider rounded-sm bg-[var(--color-ink)] text-[var(--color-surface)] hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            送出 · 生成外协单
          </button>
          {error ? (
            <span className="label text-[var(--color-overdue)]">{error}</span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

// === Block row ===
//
// One row per shipment (block). Three states it can render:
//
//   • Editing metadata (vendor / amount / dates) — same as before, unrelated
//     to returns.
//   • Open or partial — header + per-member receive list + footer with one
//     date input + 收件 button + 全选 link. Common case is "today's batch
//     came back": tick 全选, click 收件, two taps total. Rare case ("part X
//     came back yesterday") is editable on the closed-line.
//   • Fully closed (every member has returnedAt) — compact archived style
//     showing the latest member returnedAt as the closure date.
export function BlockRow({
  jobId,
  block,
  vendor,
  vendors,
}: {
  jobId: string
  block: OutsourceBlock
  vendor?: Vendor
  vendors: Vendor[]
}) {
  const [pending, start] = useTransition()

  // Local state for the receive flow. `receiveQty` holds the per-member
  // quantity the user has typed for this batch; default = remaining qty so
  // the common "everything came back" path is one click on 收件. Empty
  // string = skip this member in the next 收件 submit.
  const [receiveDate, setReceiveDate] = useState(() => today())
  const [receiveQty, setReceiveQty] = useState<Record<string, string>>({})

  const closed = isBlockClosed(block)

  const totalMembers = block.members.length
  const pendingMembers = block.members.filter((m) => !isMemberFullyReturned(m))
  const totalQty = block.members.reduce((s, m) => s + m.qty, 0)
  const totalReturnedUnits = block.members.reduce((s, m) => s + memberReturnedQty(m), 0)

  const summary =
    block.members.length === 1
      ? block.members[0].name
      : `${block.members[0]?.name ?? '—'} 等 ${block.members.length} 件`

  // For a given member, the qty the user has typed for this batch. Defaults
  // to the member's remaining qty (the natural "all back" choice).
  const draftFor = (componentId: string, fallback: number): string => {
    const v = receiveQty[componentId]
    if (v !== undefined) return v
    return String(fallback)
  }

  const setDraftFor = (componentId: string, v: string) => {
    setReceiveQty((prev) => ({ ...prev, [componentId]: v }))
  }

  const clearAllDrafts = () => setReceiveQty({})

  // Sum of pending units the 收件 button will commit if pressed now.
  const batchTotal = pendingMembers.reduce((s, m) => {
    const v = parseInt(draftFor(m.componentId, memberRemainingQty(m)), 10)
    if (!Number.isFinite(v) || v <= 0) return s
    // Clamp to remaining so a typo'd 99 doesn't show as 99 in the chip.
    return s + Math.min(v, memberRemainingQty(m))
  }, 0)

  const submitReceive = () => {
    if (batchTotal <= 0) return
    const items: { componentId: string; qty: number }[] = []
    for (const m of pendingMembers) {
      const raw = parseInt(draftFor(m.componentId, memberRemainingQty(m)), 10)
      if (!Number.isFinite(raw) || raw <= 0) continue
      const inc = Math.min(raw, memberRemainingQty(m))
      items.push({
        componentId: m.componentId,
        // Absolute, not delta — the action takes a running total.
        qty: memberReturnedQty(m) + inc,
      })
    }
    if (items.length === 0) return
    start(async () => {
      await setBlockMembersReturnedQtyAction(block.id, items, receiveDate, jobId)
      clearAllDrafts()
    })
  }

  const unreturn = (componentId: string) => {
    start(async () => {
      await setMemberReturnedQtyAction(block.id, componentId, 0, null, jobId)
    })
  }

  const editReturnDate = (componentId: string, date: string) => {
    if (!date) return
    const m = block.members.find((x) => x.componentId === componentId)
    if (!m) return
    start(async () => {
      await setMemberReturnedQtyAction(block.id, componentId, memberReturnedQty(m), date, jobId)
    })
  }

  return (
    <div className="py-3 border-b border-[var(--color-border)] last:border-b-0">
      {/* Header line — always visible */}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <div className="flex flex-col leading-tight basis-[200px]">
          <span
            className="text-[13px] font-medium text-[var(--color-ink)] truncate"
            title={block.members.map((m) => m.name).join(' · ')}
          >
            {summary}
          </span>
          <span className="mono text-[11px] text-[var(--color-ink-3)]">
            {totalQty}件
          </span>
        </div>
        {/* Vendor — combobox upserts the vendor and re-points the block. */}
        <div className="basis-[140px]">
          <NameCombobox
            target={{ kind: 'vendor', blockId: block.id, jobId }}
            value={vendor?.name ?? block.vendorId}
            options={vendors.map((v) => ({ id: v.id, name: v.name }))}
            className="text-[13px] text-[var(--color-ink)]"
          />
        </div>
        {/* Amount — empty input clears back to 待补金额. */}
        <div className="basis-[100px] flex items-baseline justify-end gap-0.5">
          <span className="mono text-[12px] text-[var(--color-ink-3)]">¥</span>
          <OutsourceBlockAmount
            blockId={block.id}
            jobId={jobId}
            value={block.amountCny}
            className="text-[13px] text-[var(--color-ink)] text-right [field-sizing:content] min-w-[3ch]"
          />
        </div>
        {/* Sent date — inline date input. */}
        <div className="flex items-baseline gap-1 basis-[150px]">
          <span className="label text-[var(--color-ink-3)]">寄</span>
          <OutsourceBlockDate
            blockId={block.id}
            jobId={jobId}
            field="sentDate"
            value={block.sentDate}
            className="text-[12px] text-[var(--color-ink-2)]"
          />
        </div>
        <div className="flex items-center gap-3 ml-auto">
          <a
            href={`/print/outsource/${block.id}`}
            target="_blank"
            rel="noopener"
            className="label inline-flex items-center gap-1.5 text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
          >
            打印外协单
            <PrintIcon />
          </a>
          <RemoveBlockControl
            pending={pending}
            onConfirm={() => {
              start(async () => {
                await deleteOutsourceBlockAction(block.id, jobId)
              })
            }}
          />
        </div>
      </div>

      {/* Body: per-member receive list. */}
      {totalMembers > 0 ? (
        <ul className="mt-2 ml-1 flex flex-col gap-0.5">
          {block.members.map((m) => {
            const fullyReturned = isMemberFullyReturned(m)
            const partial = isMemberPartiallyReturned(m)
            const remaining = memberRemainingQty(m)
            const returnedSoFar = memberReturnedQty(m)

            if (fullyReturned) {
              return (
                <li
                  key={m.componentId}
                  className="flex items-baseline gap-2 text-[12px]"
                >
                  {/* Spacer to align with the qty input column */}
                  <span className="inline-block w-[44px]" aria-hidden />
                  <span className="text-[var(--color-ink)] truncate">{m.name}</span>
                  <span className="mono text-[11px] text-[var(--color-ink-3)]">
                    {m.qty}件
                  </span>
                  <span className="ml-auto inline-flex items-baseline gap-1.5 text-[var(--color-success)]">
                    <span className="mono text-[11px]">回 ✓ {m.qty}/{m.qty}</span>
                    {m.returnedAt ? (
                      <input
                        type="date"
                        className="bg-transparent border-0 mono text-[11px] text-[var(--color-success)] focus:outline-none focus:bg-[var(--color-active-bg)] px-0.5 -mx-0.5 cursor-text"
                        value={m.returnedAt}
                        onChange={(e) => editReturnDate(m.componentId, e.target.value)}
                        disabled={pending}
                        title="点击修改回厂日期"
                      />
                    ) : null}
                    <button
                      type="button"
                      onClick={() => unreturn(m.componentId)}
                      disabled={pending}
                      title="撤销回厂"
                      className="text-[12px] leading-none text-[var(--color-success)] hover:text-[var(--color-overdue)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] rounded-sm px-0.5"
                    >
                      ↺
                    </button>
                  </span>
                </li>
              )
            }

            // Pending or partially returned. Single numeric input prefilled
            // with the remaining qty — common case is "all of what's left
            // came back today", press 收件, done. User can lower the number
            // to record a partial receive ("6 of the 11 are back"), or set
            // it to 0 to skip this member from this batch.
            const draft = draftFor(m.componentId, remaining)
            const draftN = parseInt(draft, 10)
            const draftValid = Number.isFinite(draftN) && draftN >= 0 && draftN <= remaining
            return (
              <li
                key={m.componentId}
                className="flex items-baseline gap-2 text-[12px]"
              >
                <input
                  type="text"
                  inputMode="numeric"
                  value={draft}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === '' || /^\d+$/.test(v)) setDraftFor(m.componentId, v)
                  }}
                  disabled={pending}
                  aria-label={`${m.name} 本次回件数`}
                  title={`本次回件数 (剩 ${remaining})`}
                  className={`mono text-[12px] w-[40px] text-right px-1 py-0.5 rounded-sm bg-transparent border ${
                    draftValid
                      ? 'border-[var(--color-border)] focus:border-[var(--color-ink)]'
                      : 'border-[var(--color-overdue)]'
                  } focus:outline-none`}
                />
                <span className="text-[var(--color-ink-2)] truncate">{m.name}</span>
                <span className="mono text-[11px] text-[var(--color-ink-3)]">
                  {m.qty}件
                </span>
                {partial ? (
                  <span className="ml-auto inline-flex items-baseline gap-2 label">
                    <span className="mono text-[11px] text-[var(--color-warning)]">
                      已回 {returnedSoFar}/{m.qty} · 在外 {remaining}
                    </span>
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}

      {/* Footer: receive controls. Hidden when fully closed. */}
      {!closed && pendingMembers.length > 0 ? (
        <div className="mt-2 flex items-center gap-3 flex-wrap">
          <input
            type="date"
            className={`${fieldStyles()} mono text-[12px]`}
            value={receiveDate}
            onChange={(e) => setReceiveDate(e.target.value)}
            disabled={pending}
            title="收件日期"
          />
          <button
            type="button"
            disabled={pending || batchTotal <= 0}
            onClick={submitReceive}
            className="px-3 py-0.5 text-[12px] tracking-wider bg-[var(--color-success)] text-[var(--color-surface)] rounded-sm hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            收件 →
            {batchTotal > 0 ? (
              <span className="ml-1.5 mono">{batchTotal} 件</span>
            ) : null}
          </button>
          {totalReturnedUnits > 0 ? (
            <span className="label text-[var(--color-ink-3)]">
              已回 {totalReturnedUnits}/{totalQty}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function VendorAddressEditor({ vendor }: { vendor: Vendor }) {
  const [editing, setEditing] = useState(false)
  const [address, setAddress] = useState(vendor.address ?? '')
  const [pending, start] = useTransition()

  if (!editing) {
    return (
      <span className="flex items-baseline gap-2 text-[12px] text-[var(--color-ink-3)]">
        {vendor.address ? <span>{vendor.address}</span> : null}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="label text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
        >
          {vendor.address ? '编辑地址' : '+ 添加地址'}
        </button>
      </span>
    )
  }

  const save = () => {
    start(async () => {
      await updateVendorAction(vendor.id, {
        address: address.trim() || null,
      })
      setEditing(false)
    })
  }

  return (
    <span className="flex items-baseline gap-2">
      <input
        type="text"
        className={`${fieldStyles()} text-[12px] min-w-[280px]`}
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="供应商地址"
        disabled={pending}
        autoFocus
      />
      <button
        type="button"
        disabled={pending}
        onClick={save}
        className="label text-[var(--color-ink)] hover:opacity-70"
      >
        保存
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setAddress(vendor.address ?? '')
          setEditing(false)
        }}
        className="label text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
      >
        取消
      </button>
    </span>
  )
}

// Two-step inline removal. A muted "撤销" label sits next to the print
// link — discoverable at rest, deepens to overdue-red on hover. First
// click arms it; the label flips to "取消 · 确认撤销" so the destructive
// action requires a deliberate second click. Mouse-leave or 4 s of
// inactivity disarms. Replaces the old window.confirm popup.
function RemoveBlockControl({
  pending,
  onConfirm,
}: {
  pending: boolean
  onConfirm: () => void
}) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])

  if (armed) {
    return (
      <span
        className="inline-flex items-baseline gap-2"
        onMouseLeave={() => setArmed(false)}
      >
        <button
          type="button"
          onClick={() => setArmed(false)}
          disabled={pending}
          className="label text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
        >
          取消
        </button>
        <button
          type="button"
          autoFocus
          disabled={pending}
          onClick={() => {
            setArmed(false)
            onConfirm()
          }}
          className="label text-[var(--color-overdue)] hover:opacity-70 disabled:opacity-40"
        >
          确认撤销
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => setArmed(true)}
      title="撤销外协"
      aria-label="撤销外协"
      className="label text-[var(--color-ink-3)] hover:text-[var(--color-overdue)] transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)]"
    >
      撤销
    </button>
  )
}

function PrintIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="square"
      strokeLinejoin="miter"
    >
      <rect x="4" y="2" width="8" height="4" />
      <rect x="2.5" y="6" width="11" height="6" rx="0.5" />
      <rect x="4.5" y="9.5" width="7" height="3.5" />
      <line x1="11.5" y1="8" x2="11.5" y2="8" strokeWidth="2" />
    </svg>
  )
}
