'use client'

import Link from 'next/link'
import { withBase } from '@/lib/base-path'
import { useEffect, useId, useRef, useState, useTransition } from 'react'
import {
  OUTSOURCEABLE_STAGES,
  OUTSOURCE_ACTIVITIES,
  blockActivityLabel,
  daysFromToday,
  isBlockClosed,
  isMemberFullyReturned,
  isMemberPartiallyReturned,
  memberRemainingQty,
  memberReturnedQty,
  outsourceLabel,
  stageRangeLabel,
  type OutsourceBlock,
  type Stage,
  type Vendor,
} from '@/lib/data'
import { mutate } from '@/lib/mutate'
import type { Vendor as VendorRow } from '@/lib/data'

import { today } from '@/lib/today'
import { DatePop } from './_datepop'
import {
  BlockMemberQty,
  NameCombobox,
  OutsourceBlockAmount,
  OutsourceBlockDate,
  OutsourceBlockNotes,
} from './_editable'
import { BlockShareButton, VendorStateChip } from './_vendor_share'

function fieldStyles(): string {
  return 'bg-transparent border border-[var(--color-border)] rounded-[2px] px-2 py-1 text-[13px] text-[var(--color-ink)] focus:outline-none focus:border-[var(--color-ink)] disabled:opacity-50'
}

// '2026-06-18' → '6月18日' — the part rows read in plain dates, not ISO.
function mdLabel(iso?: string): string {
  if (!iso) return ''
  const p = iso.split('-')
  if (p.length < 3) return iso
  return `${Number(p[1])}月${Number(p[2])}日`
}

export type ComponentOption = {
  id: string
  name: string
  qty: number
  // Stages of this part currently OUT at a vendor (un-returned coverage),
  // plus that vendor's name — rendered as a faint 在外 hint beside the
  // checkbox. Parts are never filtered out anymore: a part can be outsourced
  // any number of times (外发CNC then 外发氧化, second batches, rework).
  openStages?: Stage[]
  openVendorName?: string
}

// Overlap conflict surfaced by the server when a dispatch would cover stages
// that are still out at another vendor. Mirror of lib/db BlockOverlapConflict
// with the vendor name resolved by the caller.
type OverlapConflict = {
  componentId: string
  name: string
  stages: Stage[]
  vendorId: string
}

type BlockMutateResult =
  | { ok: true; id: string; docNo?: string }
  | { ok: false; reason: 'overlap'; conflicts: OverlapConflict[] }
  | { ok: false; reason: 'invalid' }

// === Stage multi-select — checkbox chips ===
//
// Free pick over OUTSOURCEABLE_STAGES, replacing the 从/到 range dropdowns
// the floor found too rigid ("工序灵活选 选错就只能重新做外协登记"). Visual
// vocabulary borrowed from _stagechips: filled square = covered.
function StageMultiSelect({
  value,
  onToggle,
  disabled,
}: {
  value: Set<Stage>
  onToggle: (s: Stage) => void
  disabled?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {OUTSOURCEABLE_STAGES.map((s) => {
        const on = value.has(s)
        return (
          <button
            key={s}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(s)}
            aria-pressed={on}
            className={`rounded-[2px] border px-2.5 py-1 text-[12px] mono transition-colors disabled:opacity-40 ${
              on
                ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-surface)]'
                : 'border-[var(--color-border)] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]'
            }`}
          >
            {s}
          </button>
        )
      })}
    </div>
  )
}

// Inline warn-and-confirm panel for the open-overlap case — the server
// flagged units still out at a vendor for the same stage(s); the operator
// decides (split quantities across vendors are a real case).
function OverlapConfirm({
  conflicts,
  vendors,
  pending,
  onConfirm,
  onCancel,
}: {
  conflicts: OverlapConflict[]
  vendors: Vendor[]
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="rounded-[2px] border border-[var(--color-warning)] bg-[color-mix(in_srgb,var(--color-warning)_8%,transparent)] px-3 py-2.5 text-[12px]">
      <p className="text-[var(--color-ink)]">
        {conflicts.map((c) => {
          const vendorName =
            vendors.find((v) => v.id === c.vendorId)?.name ?? c.vendorId
          return (
            <span key={c.componentId} className="block">
              「{c.name}」的 {c.stages.join('、')} 仍在外协中（{vendorName}）
            </span>
          )
        })}
      </p>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={onConfirm}
          className="px-3 py-1 text-[12px] tracking-wider rounded-[2px] bg-[var(--color-ink)] text-[var(--color-surface)] hover:opacity-80 disabled:opacity-40"
        >
          确认再次外协
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={onCancel}
          className="label text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
        >
          取消
        </button>
      </div>
    </div>
  )
}

// === Activity picker ===
//
// Selection-only from the fixed list in lib/data.ts (the boss's vocabulary
// from the 金蝶 reference). Native <select> — minimal widget, all options
// visible on one click, no risk of typos or "外发CNC" vs "CNC外发" drift.
// Empty value = placeholder state; submit is gated on a real selection.
function ActivityPicker({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (next: string) => void
  disabled?: boolean
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="bg-transparent border border-[var(--color-border)] rounded-[2px] px-3 py-2 text-[15px] text-[var(--color-ink)] focus:outline-none focus:border-[var(--color-ink)] disabled:opacity-50 w-full"
    >
      <option value="" disabled>
        选择工序…
      </option>
      {OUTSOURCE_ACTIVITIES.map((a) => (
        <option key={a} value={a}>
          {a}
        </option>
      ))}
    </select>
  )
}

function SearchGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.4" />
      <line
        x1="10.5"
        y1="10.5"
        x2="14"
        y2="14"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function ChevronGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CheckGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// === Vendor picker ===
//
// The 外协厂 directory grows without bound — a native <select> turns into a
// long scroll the moment there are more than a screen's worth, with no way to
// jump to the one you mean. This is a searchable combobox: a clean trigger
// showing the current pick, a popover with a type-to-filter search at the top
// and a keyboard-navigable result list below (↑/↓ to move, ↵ to choose, esc to
// close). Selection-only — the "+ 新增" toggle beside the field still owns
// vendor creation — so on commit we just hand the chosen id back to the form.
function VendorPicker({
  vendors,
  value,
  onChange,
  disabled,
}: {
  vendors: Vendor[]
  value: string
  onChange: (id: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const selected = vendors.find((v) => v.id === value)
  const q = query.trim().toLowerCase()
  const filtered = q
    ? vendors.filter((v) => v.name.toLowerCase().includes(q))
    : vendors

  // Close when a click lands outside the widget — same gesture as the ⋯ menu.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Opening clears the query and points the highlight at the current pick;
  // doing it here (rather than in an effect reacting to `open`) keeps state
  // updates out of render-time effects.
  const openPicker = () => {
    setQuery('')
    const idx = vendors.findIndex((v) => v.id === value)
    setActiveIndex(idx < 0 ? 0 : idx)
    setOpen(true)
  }

  // Focus the search field once open so you can just start typing.
  useEffect(() => {
    if (!open) return
    const t = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(t)
  }, [open])

  // Keep the highlighted row in view as you arrow through a filtered list.
  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  const choose = (id: string) => {
    onChange(id)
    setOpen(false)
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPicker())}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`${fieldStyles()} w-full flex items-center justify-between gap-2 text-left ${open ? 'border-[var(--color-ink)]' : ''}`}
      >
        <span
          className={`flex-1 min-w-0 truncate ${selected ? '' : 'text-[var(--color-ink-3)]'}`}
        >
          {selected ? selected.name : '选择外协厂…'}
        </span>
        <span
          className={`shrink-0 text-[var(--color-ink-3)] transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        >
          <ChevronGlyph />
        </span>
      </button>

      {open ? (
        <div className="absolute left-0 right-0 z-20 mt-1 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg overflow-hidden">
          <div className="flex items-center gap-2 px-2.5 py-2 border-b border-[var(--color-border)] text-[var(--color-ink-3)]">
            <SearchGlyph />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setActiveIndex((i) => Math.min(i + 1, filtered.length - 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActiveIndex((i) => Math.max(i - 1, 0))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  const pick = filtered[activeIndex]
                  if (pick) choose(pick.id)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setOpen(false)
                }
              }}
              placeholder={`搜索 ${vendors.length} 家外协厂…`}
              autoComplete="off"
              spellCheck={false}
              className="flex-1 min-w-0 bg-transparent text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-3)] focus:outline-none"
            />
          </div>
          <div
            ref={listRef}
            role="listbox"
            id={listId}
            className="max-h-[200px] overflow-auto py-1"
          >
            {filtered.length === 0 ? (
              <p className="px-2.5 py-2 text-[12px] text-[var(--color-ink-3)]">
                无匹配的外协厂
              </p>
            ) : (
              filtered.map((v, i) => {
                const isActive = i === activeIndex
                const isSelected = v.id === value
                return (
                  <button
                    key={v.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-idx={i}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => choose(v.id)}
                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[13px] text-[var(--color-ink)] ${isActive ? 'bg-[var(--color-active-bg)]' : ''}`}
                  >
                    <span className="flex-1 min-w-0 truncate">{v.name}</span>
                    {isSelected ? (
                      <span className="shrink-0 text-[var(--color-ink)]">
                        <CheckGlyph />
                      </span>
                    ) : null}
                  </button>
                )
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
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
  // Every part is always offered — a part can be outsourced any number of
  // times over its life (外发CNC to one vendor, later 外发氧化 to another, a
  // second batch, rework). Units still out for a same-stage dispatch are the
  // only thing worth flagging, and the server returns that as a
  // warn-and-confirm (see OverlapConfirm) rather than a hard block.
  const available = components
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
  // Per-component vendor unit prices, keyed by componentId. Free-form
  // text input (matches the existing 金额 input) so empty/non-numeric
  // means "no price yet" and the row prints "—". A user typing a number
  // in any selected component's row commits a real unit_price_cny on
  // submit.
  const [unitPrices, setUnitPrices] = useState<Record<string, string>>({})
  const setUnitPriceFor = (id: string, v: string) =>
    setUnitPrices((prev) => ({ ...prev, [id]: v }))
  // Per-component outsource quantity. Keyed by componentId, free-form text so
  // an in-progress edit (empty field) doesn't snap. A blank or untouched entry
  // means "send all" — submit falls back to the part's full qty. The input is
  // seeded with the part qty (see qtyFor) so the common case is one glance.
  const [qtys, setQtys] = useState<Record<string, string>>({})
  const setQtyFor = (id: string, v: string) =>
    setQtys((prev) => ({ ...prev, [id]: v }))
  const [sentDate, setSentDate] = useState(() => today())
  const [expectedReturn, setExpectedReturn] = useState(() => today())
  // Named activity is the primary thing — selected from the fixed list
  // in OUTSOURCE_ACTIVITIES. Empty until the user picks.
  const [activity, setActivity] = useState('')
  // Covered stages — free multi-select (checkbox chips). Defaults to the
  // first outsourceable stage; most blocks cover one stage once activities
  // are how the boss thinks.
  const [stages, setStages] = useState<Set<Stage>>(
    () => new Set([OUTSOURCEABLE_STAGES[0]]),
  )
  const toggleStage = (s: Stage) =>
    setStages((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  // Server-flagged open overlap awaiting the operator's 确认.
  const [overlap, setOverlap] = useState<OverlapConflict[] | null>(null)

  const stageRange = OUTSOURCEABLE_STAGES.filter((s) => stages.has(s))

  // 金额 is always optional. Empty → null in DB, surfaced as 待补金额 on the
  // row so commerce can fill it in later. The user-facing label/placeholder
  // makes "可留空 · 之后可补" obvious; there is no separate 加急 toggle.
  const vendorReady = vendorMode === 'select' ? !!vendorId : !!newVendorName.trim()
  const amountTrim = amount.trim()
  const amountValid = amountTrim === '' || Number(amountTrim) > 0
  const activityTrim = activity.trim()
  const valid =
    activityTrim.length > 0 &&
    selected.size > 0 &&
    vendorReady &&
    amountValid &&
    sentDate &&
    expectedReturn &&
    stageRange.length > 0

  const submit = (force = false) => {
    if (!valid) return
    setError(null)
    if (!force) setOverlap(null)
    start(async () => {
      let useVendorId = vendorId
      if (vendorMode === 'create') {
        const r = await mutate<{ vendor: VendorRow | undefined }>({
          kind: 'createVendor',
          name: newVendorName.trim(),
          address: newVendorAddress.trim() || undefined,
        })
        const created = r.data.vendor
        if (!created) {
          setError('外协厂创建失败')
          return
        }
        useVendorId = created.id
      }
      // Collect per-component prices for just the selected components.
      // A non-empty input that parses to a positive number is kept; empty
      // or invalid → omit (column is nullable, prints "—").
      const unitPricesCny: Record<string, number | null> = {}
      for (const cid of selected) {
        const raw = unitPrices[cid]?.trim() ?? ''
        if (raw === '') continue
        const n = Number(raw)
        if (Number.isFinite(n) && n >= 0) unitPricesCny[cid] = n
      }
      // Outsource quantity per selected component. Only send an explicit qty
      // when the typed value differs from the part's full qty — leaving it at
      // (or blanking it to) the part qty keeps the row NULL = "send all".
      const qtysByComponent: Record<string, number> = {}
      for (const cid of selected) {
        const c = components.find((x) => x.id === cid)
        const raw = qtys[cid]?.trim() ?? ''
        if (raw === '') continue
        const n = Math.floor(Number(raw))
        if (!Number.isFinite(n) || n < 1) continue
        if (c && n === c.qty) continue
        qtysByComponent[cid] = n
      }
      const r = await mutate<{ result: BlockMutateResult | undefined }>({
        kind: 'createOutsourceBlock',
        jobId,
        componentIds: [...selected],
        input: {
          vendorId: useVendorId,
          activity: activityTrim,
          stages: stageRange,
          amountCny: amountTrim === '' ? null : Number(amountTrim),
          sentDate,
          expectedReturn,
          unitPricesCny,
          qtysByComponent,
          force,
        },
      })
      const result = r.data.result
      if (!result || !result.ok) {
        if (result && result.reason === 'overlap') {
          // Same stage(s) still out at a vendor — surface the warn-and-confirm
          // panel; 确认再次外协 resubmits with force.
          setOverlap(result.conflicts)
          if (vendorMode === 'create') {
            // The vendor row was already created — don't create it twice on
            // the forced resubmit.
            setVendorId(useVendorId)
            setVendorMode('select')
            setNewVendorName('')
            setNewVendorAddress('')
          }
          return
        }
        setError('创建失败 · 请刷新页面后重试')
        return
      }
      setOverlap(null)
      setAmount('')
      setUnitPrices({})
      setQtys({})
      setSelected(new Set())
      setActivity('')
      setStages(new Set([OUTSOURCEABLE_STAGES[0]]))
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
        当前工单无可外协零件
      </p>
    )
  }

  return (
    <div className="rounded-[2px] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-4">
      <div className="flex items-baseline justify-between mb-4">
        <p className="label">新增外协 · 送出</p>
      </div>

      {/* ── 送什么 ──
          Selection from the fixed list of named outsource activities — the
          same vocabulary the boss reads in the 金蝶 reference. One click,
          one choice. */}
      <label className="flex flex-col gap-1.5 mb-4">
        <span className="label">送什么 · 工序</span>
        <ActivityPicker
          value={activity}
          onChange={setActivity}
          disabled={pending}
        />
      </label>

      <div className="grid grid-cols-2 md:grid-cols-12 gap-3">
        <div className="col-span-2 md:col-span-3 flex flex-col gap-1">
          <span className="label">零件 · 数量 + 单价</span>
          <div className="flex flex-col gap-1 max-h-[180px] overflow-auto border border-[var(--color-border)] rounded-[2px] bg-[var(--color-surface)] px-2 py-1.5">
            {available.map((c) => {
              const isSelected = selected.has(c.id)
              return (
                <div
                  key={c.id}
                  className="flex flex-col gap-1 py-0.5 text-[13px] text-[var(--color-ink)]"
                >
                  {/* Name gets the full column width on its own line so long
                      零件名 wrap cleanly instead of being squeezed by the badge
                      + qty + 单价 controls. */}
                  <label className="flex items-start gap-2 min-w-0 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggle(c.id)}
                      disabled={pending}
                      className="accent-[var(--color-ink)] mt-0.5 shrink-0"
                    />
                    <span className="flex-1 min-w-0 break-words leading-snug">{c.name}</span>
                  </label>
                  {/* 在外 tag + 外协数量 + 单价 — one tidy line under the name,
                      indented to align past the checkbox. */}
                  <div className="flex items-center gap-2 pl-6">
                    {c.openStages && c.openStages.length > 0 ? (
                      <span
                        className="mono text-[10px] tracking-wider px-1 rounded-[2px] border border-[var(--color-info)] text-[var(--color-info)] shrink-0"
                        title={`仍在外协 · ${c.openStages.join('、')}${c.openVendorName ? ` · ${c.openVendorName}` : ''}`}
                      >
                        在外·{c.openStages[0]}
                        {c.openStages.length > 1 ? `+${c.openStages.length - 1}` : ''}
                      </span>
                    ) : null}
                    <span
                      className={`mono text-[11px] shrink-0 inline-flex items-center gap-0.5 ${isSelected ? 'text-[var(--color-ink-3)]' : 'text-[var(--color-ink-4)]'}`}
                    >
                      <input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        step={1}
                        value={qtys[c.id] ?? String(c.qty)}
                        onChange={(e) => setQtyFor(c.id, e.target.value)}
                        disabled={pending || !isSelected}
                        title={`外协数量 · 共 ${c.qty} 件`}
                        className="mono text-[12px] w-[46px] text-right px-1 py-0.5 rounded-[2px] bg-transparent border border-[var(--color-border)] focus:border-[var(--color-ink)] focus:outline-none disabled:opacity-40"
                      />
                      <span className="shrink-0">/{c.qty}</span>
                    </span>
                    <span
                      className={`mono text-[11px] shrink-0 ${isSelected ? 'text-[var(--color-ink-3)]' : 'text-[var(--color-ink-4)]'}`}
                    >
                      ¥
                    </span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={1}
                      value={unitPrices[c.id] ?? ''}
                      onChange={(e) => setUnitPriceFor(c.id, e.target.value)}
                      disabled={pending || !isSelected}
                      placeholder="单价"
                      title="每件单价 · 可留空"
                      className="mono text-[12px] w-[68px] text-right px-1 py-0.5 rounded-[2px] bg-transparent border border-[var(--color-border)] focus:border-[var(--color-ink)] focus:outline-none disabled:opacity-40"
                    />
                  </div>
                </div>
              )
            })}
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
            <VendorPicker
              vendors={vendors}
              value={vendorId}
              onChange={setVendorId}
              disabled={pending}
            />
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
        <div className="col-span-1 md:col-span-2 flex flex-col gap-1">
          <span className="label">寄出</span>
          <DatePop value={sentDate} onChange={setSentDate} disabled={pending} />
        </div>
        <div className="col-span-1 md:col-span-2 flex flex-col gap-1">
          <span className="label">预计回厂</span>
          <DatePop
            value={expectedReturn}
            onChange={setExpectedReturn}
            disabled={pending}
          />
        </div>
        <div className="col-span-2 md:col-span-12 flex flex-col gap-1.5">
          <span className="label">
            外协承接的工段 ·{' '}
            <span className="text-[var(--color-ink-3)]">可多选 · 送出后仍可修改</span>
          </span>
          <StageMultiSelect value={stages} onToggle={toggleStage} disabled={pending} />
        </div>
        {overlap ? (
          <div className="col-span-2 md:col-span-12">
            <OverlapConfirm
              conflicts={overlap}
              vendors={vendors}
              pending={pending}
              onConfirm={() => submit(true)}
              onCancel={() => setOverlap(null)}
            />
          </div>
        ) : null}
        <div className="col-span-2 md:col-span-12 flex items-end gap-3 flex-wrap">
          <button
            type="button"
            disabled={!valid || pending}
            onClick={() => submit()}
            className="px-4 py-1.5 text-[13px] tracking-wider rounded-[2px] bg-[var(--color-ink)] text-[var(--color-surface)] hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            送出 · 生成外协单
          </button>
          {!activityTrim && selected.size > 0 ? (
            <span className="label text-[var(--color-ink-3)]">
              请先在「送什么」填写工序名称
            </span>
          ) : null}
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
// Three lines per shipment, in priority order:
//
//   Line 1 — what · vendor · ¥ · expected return · [收件] · ⋯
//            (the scan line — everything that matters lives here)
//   Line 2 — provenance: optional job no + customer · stage range · 寄 sent
//            (smaller, ink-3; click any token to edit)
//   Line 3 — 备注 (Things-style inline, faint hint when empty)
//
// The per-member list collapses to nothing in the common single-member /
// no-partial case. It expands inline only when there are 2+ members OR any
// member is partially returned. 收件 always opens a tray with per-member
// qty inputs + a receive date picker — even in the single-member case, so
// the operator can record partial returns or backdate the receive without
// a special "everything came back today" shortcut.
//
// `jobNo` / `customer` are optional context strings the parent passes when
// the row is rendered outside the job detail page (where they'd be redundant
// since you're already on that job's page).
export function BlockRow({
  jobId,
  jobNo,
  customer,
  block,
  vendor,
  vendors,
  componentOptions,
}: {
  jobId: string
  jobNo?: string
  customer?: string
  block: OutsourceBlock
  vendor?: Vendor
  vendors: Vendor[]
  /** The job's parts — enables the + 添加零件 affordance. Omitted on views
   * outside the job detail page (station board), where adding members has
   * no natural picker. */
  componentOptions?: ComponentOption[]
}) {
  const [pending, start] = useTransition()
  // Local optimistic copies of the two block facets that are now editable
  // in place (stages via the popover editor, members via + 添加零件). Server
  // revalidation catches up on the next navigation.
  const [localStages, setLocalStages] = useState<Stage[]>(block.stages)
  const [addedMembers, setAddedMembers] = useState<OutsourceBlock['members']>([])

  // Local state for the receive flow. `receiveQty` holds the per-member
  // quantity the user has typed for this batch; default = remaining qty so
  // the common "everything came back" path is one click on 收件. Empty
  // string = skip this member in the next 收件 submit.
  const [receiveDate, setReceiveDate] = useState(() => today())
  const [receiveQty, setReceiveQty] = useState<Record<string, string>>({})
  const [trayOpen, setTrayOpen] = useState(false)
  // Member list collapse — long blocks (e.g. 81 components on one CNC
  // shipment) make the row taller than the screen. Default collapsed when
  // members exceed PREVIEW_COUNT * 1.5 so we don't hide just a couple lines.
  const [expanded, setExpanded] = useState(false)
  // Two-step arming for per-member 撤销 — guards against fat-finger removal of
  // a component the operator actually wanted to keep on the shipment.
  const [armedRemoveId, setArmedRemoveId] = useState<string | null>(null)
  // Optimistic per-member removal. After the user confirms 撤销 on a row,
  // we add the componentId here so the row vanishes immediately — no wait
  // for the server, no router.refresh() (which would scroll the page back to
  // top and re-stream the full RSC tree). The DB write still fires; on the
  // next natural navigation the server-side state catches up and these IDs
  // simply no longer match anything in block.members.
  const [removedIds, setRemovedIds] = useState<Set<string>>(() => new Set())

  const closed = isBlockClosed(block)

  // All member-derived state runs off `members` (post-optimistic-removal,
  // post-optimistic-add), not `block.members`. Keeps the row's headline
  // count, 收件 button, and member list consistent the instant the user
  // clicks 撤销 / 添加 on a row.
  const baseMembers = addedMembers.length === 0
    ? block.members
    : [
        ...block.members,
        ...addedMembers.filter(
          (a) => !block.members.some((m) => m.componentId === a.componentId),
        ),
      ]
  const members = removedIds.size === 0
    ? baseMembers
    : baseMembers.filter((m) => !removedIds.has(m.componentId))

  const pendingMembers = members.filter((m) => !isMemberFullyReturned(m))
  const partialMembers = members.filter((m) => isMemberPartiallyReturned(m))
  const fullyReturnedMembers = members.filter(isMemberFullyReturned)
  const totalQty = members.reduce((s, m) => s + m.qty, 0)
  const totalReturnedUnits = members.reduce((s, m) => s + memberReturnedQty(m), 0)

  // The single number of "everything that would come back if you tap 收件
  // right now and don't open the tray". For one-member blocks that's the
  // full remaining qty; for multi it's the sum of remainings.
  const remainingTotal = pendingMembers.reduce(
    (s, m) => s + memberRemainingQty(m),
    0,
  )

  // The list/tray only adds information when there's >1 member, a member is
  // mid-return, OR any member has an explicit per-line price (because the
  // 单价 editor itself lives in the list — single-member blocks where the
  // user typed a vendor unit price need the list shown so they can change it).
  const hasAnyLinePrice = members.some((m) => m.unitPriceCny != null)
  const needsList =
    members.length > 1 || partialMembers.length > 0 || hasAnyLinePrice

  // The headline — the boss's word for what this is.
  // Prefer the named activity (外发氧化, 外发CNC, …). When there's no
  // activity (the implicit "全程" or stage-range fallback), use the first
  // member's name — it's the most concrete thing the boss can recognize.
  const headline = block.activity?.trim() || (members[0]?.name ?? '—')

  // The expected return — drives all "is this late" signaling on the row.
  const daysLeft = daysFromToday(block.expectedReturn)
  const overdue = !closed && daysLeft < 0
  const dueSoon = !closed && daysLeft >= 0 && daysLeft <= 2
  const status: 'closed' | 'overdue' | 'soon' | 'open' = closed
    ? 'closed'
    : overdue
      ? 'overdue'
      : dueSoon
        ? 'soon'
        : 'open'
  const dotColor = {
    closed: 'var(--color-ink-3)',
    overdue: 'var(--color-overdue)',
    soon: 'var(--color-warning)',
    open: 'var(--color-success)',
  }[status]

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

  // Sum of pending units that 确认 in the tray will commit if pressed now.
  const batchTotal = pendingMembers.reduce((s, m) => {
    const v = parseInt(draftFor(m.componentId, memberRemainingQty(m)), 10)
    if (!Number.isFinite(v) || v <= 0) return s
    return s + Math.min(v, memberRemainingQty(m))
  }, 0)

  // Commit the receive batch. Used by both the one-click 收件 (with all
  // defaults — everything came back today) and the tray's 确认 button.
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
      await mutate({
        kind: 'setBlockMembersReturnedQty',
        blockId: block.id,
        items,
        date: receiveDate,
        jobId,
      })
      clearAllDrafts()
      setTrayOpen(false)
    })
  }

  const unreturn = (componentId: string) => {
    start(async () => {
      await mutate({
        kind: 'setMemberReturnedQty',
        blockId: block.id,
        componentId,
        qty: 0,
        date: null,
        jobId,
      })
    })
  }

  // Remove one component from this block. If it was the last remaining
  // member, the server deletes the whole block (see removeOutsourceBlockMember
  // in lib/db.ts). The arming check lives in the caller.
  //
  // We optimistically add the componentId to `removedIds` BEFORE awaiting
  // the server — the row disappears the instant the user confirms 撤销, no
  // network wait, no scroll jump. If the mutate fails we roll the local
  // state back so the row reappears and surface the failure as a toast
  // would, but in this codebase the mutate path is fire-and-forget for the
  // destructive cases (see deleteOutsourceBlock above) so we match.
  const removeMember = (componentId: string) => {
    setArmedRemoveId(null)
    setRemovedIds((prev) => {
      if (prev.has(componentId)) return prev
      const next = new Set(prev)
      next.add(componentId)
      return next
    })
    start(async () => {
      try {
        await mutate({
          kind: 'removeOutsourceBlockMember',
          blockId: block.id,
          componentId,
          jobId,
        })
      } catch (e) {
        // Roll back the optimistic removal — the row should reappear so the
        // operator notices nothing actually got deleted.
        setRemovedIds((prev) => {
          if (!prev.has(componentId)) return prev
          const next = new Set(prev)
          next.delete(componentId)
          return next
        })
        throw e
      }
    })
  }


  const dueDisplay =
    overdue
      ? `逾期 ${Math.abs(daysLeft)} 天`
      : closed
        ? '已回'
        : daysLeft === 0
          ? '今天到期'
          : `剩 ${daysLeft} 天`
  const dueClass = overdue
    ? 'text-[var(--color-overdue)]'
    : dueSoon
      ? 'text-[var(--color-warning)]'
      : 'text-[var(--color-ink-3)]'

  // Whole-block optimistic vanish — when the user removes the last remaining
  // member, the server deletes the block; render nothing locally so the row
  // disappears immediately without waiting for revalidation.
  if (members.length === 0) return null

  return (
    <div
      className={`relative py-3 pl-4 pr-1 border-b border-[var(--color-border)] last:border-b-0 ${closed ? 'opacity-60' : ''}`}
    >
      {/* Status dot — colored bullet hung in the gutter. */}
      <span
        aria-hidden
        className="absolute left-1 top-[19px] inline-block h-[7px] w-[7px] rounded-[2px]"
        style={{ backgroundColor: dotColor }}
      />

      {/* Line 1 — the scan line. */}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <div className="flex items-baseline gap-2 min-w-0 basis-[280px]">
          <span
            className="text-[14px] font-semibold text-[var(--color-ink)] tracking-tight truncate"
            title={
              members.length > 1
                ? members.map((m) => `${m.name} ×${m.qty}`).join(' · ')
                : headline
            }
          >
            {headline}
          </span>
          {/* Outsource qty. Single-member blocks edit it right here — they
              usually don't expand the member list, so this is the one reachable
              handle. Multi-member blocks show the read-only sum and edit each
              member's qty inside the list below. */}
          {members.length === 1 ? (
            <span className="mono text-[12px] text-[var(--color-ink-3)] shrink-0 inline-flex items-baseline gap-0.5">
              <span>×</span>
              <BlockMemberQty
                blockId={block.id}
                componentId={members[0].componentId}
                jobId={jobId}
                value={members[0].qty}
                className="text-[12px] text-[var(--color-ink-3)] text-right [field-sizing:content] min-w-[2ch]"
              />
            </span>
          ) : (
            <span className="mono text-[12px] text-[var(--color-ink-3)] shrink-0">
              × {totalQty}
            </span>
          )}
        </div>
        <div className="basis-[140px] shrink-0">
          <NameCombobox
            target={{ kind: 'vendor', blockId: block.id, jobId }}
            value={vendor?.name ?? block.vendorId}
            options={vendors.map((v) => ({ id: v.id, name: v.name }))}
            className="text-[13px] text-[var(--color-ink)]"
          />
        </div>
        <div className="basis-[110px] shrink-0 flex items-baseline gap-0.5">
          <span className="mono text-[12px] text-[var(--color-ink-3)]">¥</span>
          <OutsourceBlockAmount
            blockId={block.id}
            jobId={jobId}
            value={block.amountCny}
            className="text-[13px] text-[var(--color-ink)] [field-sizing:content] min-w-[3ch]"
          />
        </div>
        <div className="basis-[180px] shrink-0 flex items-baseline gap-2">
          <OutsourceBlockDate
            blockId={block.id}
            jobId={jobId}
            field="expectedReturn"
            value={block.expectedReturn}
            className="text-[12px] text-[var(--color-ink-2)]"
            formatLabel={mdLabel}
            hideIcon
          />
          <span className={`label ${dueClass}`}>{dueDisplay}</span>
        </div>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <BlockShareButton vendor={vendor} block={block} />
          {!closed && pendingMembers.length > 0 ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => setTrayOpen((v) => !v)}
              aria-expanded={trayOpen}
              title="展开收件明细 · 可调整数量与日期"
              className={`px-3 py-1 text-[12px] tracking-wider rounded-[2px] hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed ${
                trayOpen
                  ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
                  : 'bg-[var(--color-success)] text-[var(--color-surface)]'
              }`}
            >
              收件 <span className="ml-1 mono">{trayOpen ? '⌃' : `${remainingTotal} ⌄`}</span>
            </button>
          ) : null}
          <BlockKebab
            blockId={block.id}
            pending={pending}
            onDelete={() => {
              start(async () => {
                await mutate({
                  kind: 'deleteOutsourceBlock',
                  blockId: block.id,
                  jobId,
                })
              })
            }}
          />
        </div>
      </div>

      {/* Line 2 — provenance. Smaller, lower contrast; everything clickable. */}
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[12px] text-[var(--color-ink-3)]">
        {jobNo ? (
          <Link
            href={`/jobs/${jobId}`}
            className="mono text-[var(--color-ink-2)] hover:underline underline-offset-4"
          >
            {jobNo}
          </Link>
        ) : null}
        {customer ? <span>{customer}</span> : null}
        {block.docNo ? (
          <span className="mono text-[var(--color-ink-2)]" title="外协单号">
            {block.docNo}
          </span>
        ) : null}
        <BlockStagesEditor
          blockId={block.id}
          jobId={jobId}
          stages={localStages}
          activity={block.activity}
          vendors={vendors}
          disabled={pending}
          onSaved={setLocalStages}
        />
        <span className="flex items-baseline gap-1">
          <span>寄</span>
          <OutsourceBlockDate
            blockId={block.id}
            jobId={jobId}
            field="sentDate"
            value={block.sentDate}
            className="text-[12px] text-[var(--color-ink-3)]"
            formatLabel={mdLabel}
            hideIcon
          />
        </span>
        {totalReturnedUnits > 0 && !closed ? (
          <span className="text-[var(--color-warning)]">
            已回 {totalReturnedUnits}/{totalQty}
          </span>
        ) : null}
        {!closed ? <VendorStateChip block={block} /> : null}
      </div>

      {/* Line 3 — notes. Things-style: borderless, hint when empty. */}
      <div className="mt-1 text-[12px] leading-snug">
        <OutsourceBlockNotes
          blockId={block.id}
          jobId={jobId}
          value={block.notes}
          className={`${block.notes ? 'text-[var(--color-ink-2)]' : 'text-[var(--color-ink-3)]'}`}
        />
      </div>

      {/* Member list — only renders when it adds information.
          Long lists (e.g. 81 components on one CNC shipment) collapse to a
          PREVIEW_COUNT-row preview with a "+ N · 展开" toggle. Threshold is
          set so a list that's only one or two rows past PREVIEW_COUNT just
          renders in full — collapsing a 9-row list to 6 isn't worth it. */}
      {needsList ? (() => {
        const PREVIEW_COUNT = 6
        const COLLAPSE_AT = 10
        const collapsible = members.length >= COLLAPSE_AT
        const visible = !collapsible || expanded
          ? members
          : members.slice(0, PREVIEW_COUNT)
        const hiddenCount = members.length - visible.length
        return (
        <ul className="mt-2 ml-1 flex flex-col gap-0.5">
          {visible.map((m) => {
            const fullyReturned = isMemberFullyReturned(m)
            const partial = isMemberPartiallyReturned(m)
            const remaining = memberRemainingQty(m)
            const returnedSoFar = memberReturnedQty(m)
            const armed = armedRemoveId === m.componentId
            // One part, one plain line: 名称 · 数量 · 状态(人话). Prices live on
            // the printed 外协单, not here — the panel reads, it doesn't tally.
            return (
              <li
                key={m.componentId}
                className={`flex items-baseline gap-3 py-0.5 text-[13px] group ${armed ? 'bg-[color-mix(in_srgb,var(--color-overdue)_8%,transparent)] rounded-[2px] -mx-1 px-1' : ''}`}
              >
                <span
                  className={`flex-1 min-w-0 break-words leading-snug ${fullyReturned ? 'text-[var(--color-ink-3)]' : 'text-[var(--color-ink)]'}`}
                >
                  {m.name}
                </span>
                {members.length > 1 ? (
                  <span className="mono text-[12px] text-[var(--color-ink-3)] shrink-0 inline-flex items-baseline gap-0.5">
                    <BlockMemberQty
                      blockId={block.id}
                      componentId={m.componentId}
                      jobId={jobId}
                      value={m.qty}
                      className="text-[12px] text-[var(--color-ink-3)] text-right [field-sizing:content] min-w-[2ch]"
                    />
                    <span>件</span>
                  </span>
                ) : (
                  <span className="mono text-[12px] text-[var(--color-ink-3)] shrink-0">
                    {m.qty} 件
                  </span>
                )}
                <span className="shrink-0 w-[128px] text-right text-[12px]">
                  {fullyReturned ? (
                    <span className="text-[var(--color-success)]">
                      已回{m.returnedAt ? ` · ${mdLabel(m.returnedAt)}` : ''}
                    </span>
                  ) : partial ? (
                    <span className="text-[var(--color-warning)]">
                      回 {returnedSoFar} · 在外 {remaining}
                    </span>
                  ) : (
                    <span className="text-[var(--color-ink-3)]">在外 {remaining}</span>
                  )}
                </span>
                {returnedSoFar > 0 && !closed ? (
                  <button
                    type="button"
                    onClick={() => unreturn(m.componentId)}
                    disabled={pending}
                    title="撤销回厂"
                    className="label text-[var(--color-ink-4)] hover:text-[var(--color-ink)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                  >
                    撤销
                  </button>
                ) : null}
                {!closed ? (
                  <MemberRemoveButton
                    armed={armed}
                    pending={pending}
                    fullyReturned={fullyReturned}
                    onArm={() => setArmedRemoveId(m.componentId)}
                    onCancel={() => setArmedRemoveId(null)}
                    onConfirm={() => removeMember(m.componentId)}
                  />
                ) : null}
              </li>
            )
          })}
          {collapsible ? (
            <li className="mt-0.5">
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="label text-[var(--color-ink-3)] hover:text-[var(--color-ink)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] rounded-[2px] px-0.5"
                aria-expanded={expanded}
              >
                {expanded
                  ? `折叠 ⌃`
                  : `+ ${hiddenCount} 个零件 · 展开 ⌄`}
              </button>
            </li>
          ) : null}
        </ul>
        )
      })() : null}

      {/* + 添加零件 — append parts to an existing dispatch instead of
          delete-and-recreate ("遇到多件的情况 很不好操作"). Only on views
          that can supply the job's part list. */}
      {!closed && componentOptions ? (
        <AddMembersRow
          blockId={block.id}
          jobId={jobId}
          stages={localStages}
          componentOptions={componentOptions.filter(
            (c) => !members.some((m) => m.componentId === c.id),
          )}
          vendors={vendors}
          onAdded={(newMembers) =>
            setAddedMembers((prev) => [...prev, ...newMembers])
          }
        />
      ) : null}

      {/* Receive tray — only renders when 收件 is in dropdown mode AND open. */}
      {!closed && trayOpen && pendingMembers.length > 0 ? (
        <div className="mt-3 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-active-bg)] p-3">
          <p className="label mb-2 text-[var(--color-ink-3)]">
            本批次收件 · 修改数量则记录部分回厂
          </p>
          <ul className="flex flex-col gap-1">
            {pendingMembers.map((m) => {
              const remaining = memberRemainingQty(m)
              const returnedSoFar = memberReturnedQty(m)
              const draft = draftFor(m.componentId, remaining)
              const draftN = parseInt(draft, 10)
              const draftValid =
                Number.isFinite(draftN) && draftN >= 0 && draftN <= remaining
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
                    className={`mono text-[12px] w-[44px] text-right px-1 py-0.5 rounded-[2px] bg-transparent border ${
                      draftValid
                        ? 'border-[var(--color-border)] focus:border-[var(--color-ink)]'
                        : 'border-[var(--color-overdue)]'
                    } focus:outline-none`}
                  />
                  <span className="mono text-[11px] text-[var(--color-ink-3)]">
                    / {remaining}
                  </span>
                  <span className="text-[var(--color-ink-2)] min-w-0 break-words leading-snug">{m.name}</span>
                  {returnedSoFar > 0 ? (
                    <span className="mono text-[11px] text-[var(--color-warning)]">
                      · 已回 {returnedSoFar}
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <span className="label text-[var(--color-ink-3)]">收件日期</span>
            <DatePop
              value={receiveDate}
              onChange={setReceiveDate}
              allowFuture={false}
              disabled={pending}
            />
            <button
              type="button"
              disabled={pending || batchTotal <= 0}
              onClick={submitReceive}
              className="px-3 py-1 text-[12px] tracking-wider bg-[var(--color-success)] text-[var(--color-surface)] rounded-[2px] hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              确认 <span className="ml-1 mono">{batchTotal} 件</span>
            </button>
            <button
              type="button"
              onClick={() => {
                clearAllDrafts()
                setTrayOpen(false)
              }}
              disabled={pending}
              className="label text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      {/* Closed-block tail: latest returned date + the unreturn affordance.
          Single-member closed blocks would otherwise have no member list and
          nothing showing the closure date, since needsList is false. */}
      {closed && !needsList && fullyReturnedMembers[0] ? (
        <div className="mt-1 flex items-baseline gap-2 text-[12px] group">
          <span className="text-[var(--color-success)]">
            已回
            {fullyReturnedMembers[0].returnedAt
              ? ` · ${mdLabel(fullyReturnedMembers[0].returnedAt)}`
              : ''}
          </span>
          <button
            type="button"
            onClick={() => unreturn(fullyReturnedMembers[0].componentId)}
            disabled={pending}
            title="撤销回厂"
            className="label text-[var(--color-ink-4)] hover:text-[var(--color-ink)] opacity-0 group-hover:opacity-100 transition-opacity"
          >
            撤销
          </button>
        </div>
      ) : null}
    </div>
  )
}

// Per-member 撤销. Hover-revealed × on each member row in BlockRow.
// One click = arm (turns red and asks for confirmation inline). Second click
// on "撤销" fires the removal. Clicking anywhere else (handled by the parent's
// armedRemoveId state being reset by the next click) cancels.
//
// We render a slightly louder warning when the member is fully returned —
// removing a 已回 member silently is exactly the kind of thing the operator
// would later swear they didn't do.
function MemberRemoveButton({
  armed,
  pending,
  fullyReturned,
  onArm,
  onCancel,
  onConfirm,
}: {
  armed: boolean
  pending: boolean
  fullyReturned: boolean
  onArm: () => void
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!armed) {
    return (
      <button
        type="button"
        onClick={onArm}
        disabled={pending}
        title="从此外协单移除该零件"
        aria-label="移除零件"
        className="ml-1 label leading-none text-[var(--color-ink-4)] opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-[var(--color-overdue)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] rounded-[2px] px-0.5 transition-opacity disabled:opacity-30"
      >
        移除
      </button>
    )
  }
  return (
    <span className="ml-1 inline-flex items-baseline gap-1 mono text-[11px]">
      <span className="text-[var(--color-overdue)]">
        {fullyReturned ? '已回 · 确认移除?' : '移除?'}
      </span>
      <button
        type="button"
        onClick={onConfirm}
        disabled={pending}
        className="text-[var(--color-overdue)] hover:opacity-70 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] rounded-[2px] px-0.5 disabled:opacity-40"
      >
        撤销
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={pending}
        className="text-[var(--color-ink-3)] hover:text-[var(--color-ink)] focus:outline-none rounded-[2px] px-0.5"
      >
        取消
      </button>
    </span>
  )
}

// === Editable stage coverage on an existing block ===
//
// The 工段 label on line 2 is the click target; it opens a small popover with
// the same checkbox-chip multi-select as the create form. Saving goes through
// setOutsourceBlockStages — added stages pause in-house work + get route rows
// server-side; removed stages just stop being covered (derivation is live).
export function BlockStagesEditor({
  blockId,
  jobId,
  stages,
  activity,
  vendors,
  disabled,
  onSaved,
}: {
  blockId: string
  jobId: string
  stages: Stage[]
  activity?: string
  vendors: Vendor[]
  disabled?: boolean
  onSaved: (stages: Stage[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Set<Stage>>(() => new Set(stages))
  const [overlap, setOverlap] = useState<OverlapConflict[] | null>(null)
  const [pending, start] = useTransition()
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setOverlap(null)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        setOverlap(null)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const openEditor = () => {
    setDraft(new Set(stages))
    setOverlap(null)
    setOpen(true)
  }

  const orderedDraft = OUTSOURCEABLE_STAGES.filter((s) => draft.has(s))

  const save = (force = false) => {
    if (orderedDraft.length === 0) return
    start(async () => {
      const r = await mutate<{ result: BlockMutateResult | undefined }>({
        kind: 'setOutsourceBlockStages',
        blockId,
        jobId,
        stages: orderedDraft,
        force,
      })
      const result = r.data.result
      if (!result || !result.ok) {
        if (result && result.reason === 'overlap') {
          setOverlap(result.conflicts)
        }
        return
      }
      onSaved(orderedDraft)
      setOpen(false)
      setOverlap(null)
    })
  }

  const label = activity?.trim() ? stageRangeLabel(stages) : outsourceLabel(stages)

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openEditor())}
        title="工段范围 · 点击修改"
        aria-expanded={open}
        className="rounded-[2px] px-0.5 -mx-0.5 hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink)] transition-colors disabled:opacity-50"
      >
        {label}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="修改外协工段"
          className="absolute left-0 top-[calc(100%+6px)] z-30 w-[320px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[0_8px_28px_rgba(0,0,0,0.12),0_0_0_0.5px_rgba(0,0,0,0.04)]"
        >
          <p className="label mb-2">外协承接的工段</p>
          <StageMultiSelect
            value={draft}
            onToggle={(s) =>
              setDraft((prev) => {
                const next = new Set(prev)
                if (next.has(s)) next.delete(s)
                else next.add(s)
                return next
              })
            }
            disabled={pending}
          />
          {overlap ? (
            <div className="mt-2.5">
              <OverlapConfirm
                conflicts={overlap}
                vendors={vendors}
                pending={pending}
                onConfirm={() => save(true)}
                onCancel={() => setOverlap(null)}
              />
            </div>
          ) : null}
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              disabled={pending || orderedDraft.length === 0}
              onClick={() => save()}
              className="px-3 py-1 text-[12px] tracking-wider rounded-[2px] bg-[var(--color-ink)] text-[var(--color-surface)] hover:opacity-80 disabled:opacity-40"
            >
              保存
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setOpen(false)
                setOverlap(null)
              }}
              className="label text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            >
              取消
            </button>
            <span className="label text-[var(--color-ink-4)] ml-auto">
              移除的工段恢复厂内进度
            </span>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// === + 添加零件 on an existing block ===
//
// Collapsed to a faint one-liner; expands into a checkbox picker of the
// job's parts not already on this dispatch. Quantities/prices stay editable
// in the member list afterwards — this row only appends membership.
export function AddMembersRow({
  blockId,
  jobId,
  stages,
  componentOptions,
  vendors,
  onAdded,
}: {
  blockId: string
  jobId: string
  stages: Stage[]
  componentOptions: ComponentOption[]
  vendors: Vendor[]
  onAdded: (members: OutsourceBlock['members']) => void
}) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [overlap, setOverlap] = useState<OverlapConflict[] | null>(null)
  const [pending, start] = useTransition()

  if (componentOptions.length === 0) return null

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const submit = (force = false) => {
    if (selected.size === 0) return
    start(async () => {
      const r = await mutate<{ result: BlockMutateResult | undefined }>({
        kind: 'addOutsourceBlockMembers',
        blockId,
        jobId,
        items: [...selected].map((componentId) => ({ componentId })),
        force,
      })
      const result = r.data.result
      if (!result || !result.ok) {
        if (result && result.reason === 'overlap') setOverlap(result.conflicts)
        return
      }
      const added = componentOptions
        .filter((c) => selected.has(c.id))
        .map((c) => ({ componentId: c.id, name: c.name, qty: c.qty }))
      onAdded(added)
      setSelected(new Set())
      setOverlap(null)
      setOpen(false)
    })
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1.5 label text-[var(--color-ink-3)] hover:text-[var(--color-ink)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] rounded-[2px] px-0.5"
      >
        + 添加零件
      </button>
    )
  }

  return (
    <div className="mt-2 rounded-[2px] border border-dashed border-[var(--color-border-strong)] p-3">
      <p className="label mb-2 text-[var(--color-ink-3)]">
        添加零件到此外协单 · 承接 {stageRangeLabel(stages)}
      </p>
      <div className="flex flex-col gap-1 max-h-[150px] overflow-auto">
        {componentOptions.map((c) => (
          <label
            key={c.id}
            className="flex items-center gap-2 text-[13px] text-[var(--color-ink)] cursor-pointer"
          >
            <input
              type="checkbox"
              checked={selected.has(c.id)}
              onChange={() => toggle(c.id)}
              disabled={pending}
              className="accent-[var(--color-ink)]"
            />
            <span className="flex-1 truncate">{c.name}</span>
            <span className="mono text-[11px] text-[var(--color-ink-3)]">×{c.qty}</span>
            {c.openStages && c.openStages.length > 0 ? (
              <span
                className="mono text-[10px] tracking-wider px-1 rounded-[2px] border border-[var(--color-info)] text-[var(--color-info)] shrink-0"
                title={`仍在外协 · ${c.openStages.join('、')}${c.openVendorName ? ` · ${c.openVendorName}` : ''}`}
              >
                在外
              </span>
            ) : null}
          </label>
        ))}
      </div>
      {overlap ? (
        <div className="mt-2.5">
          <OverlapConfirm
            conflicts={overlap}
            vendors={vendors}
            pending={pending}
            onConfirm={() => submit(true)}
            onCancel={() => setOverlap(null)}
          />
        </div>
      ) : null}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={pending || selected.size === 0}
          onClick={() => submit()}
          className="px-3 py-1 text-[12px] tracking-wider rounded-[2px] bg-[var(--color-ink)] text-[var(--color-surface)] hover:opacity-80 disabled:opacity-40"
        >
          添加 {selected.size > 0 ? `· ${selected.size} 件` : ''}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setOpen(false)
            setSelected(new Set())
            setOverlap(null)
          }}
          className="label text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
        >
          取消
        </button>
      </div>
    </div>
  )
}

// Kebab menu — print + arming-confirm delete, both moved off the row to
// stop the deletion text link from sitting at full weight next to print.
// Click ⋯ to open; click outside (or pick an item) to close.
export function BlockKebab({
  blockId,
  pending,
  onDelete,
}: {
  blockId: string
  pending: boolean
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const [armed, setArmed] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false)
        setArmed(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        aria-haspopup="menu"
        aria-expanded={open}
        title="更多"
        className="px-1.5 py-0.5 text-[16px] leading-none text-[var(--color-ink-3)] hover:text-[var(--color-ink)] rounded-[2px] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] disabled:opacity-40"
      >
        ⋯
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-10 mt-1 min-w-[160px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg py-1 text-[12px]"
        >
          <a
            href={withBase(`/print/outsource/${blockId}`)}
            target="_blank"
            rel="noopener"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-1.5 text-[var(--color-ink)] hover:bg-[var(--color-active-bg)]"
          >
            <PrintIcon />
            打印外协单
          </a>
          {armed ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setArmed(false)
                onDelete()
              }}
              disabled={pending}
              className="w-full text-left px-3 py-1.5 text-[var(--color-overdue)] hover:bg-[var(--color-active-bg)] disabled:opacity-40"
            >
              确认撤销外协
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setArmed(true)}
              disabled={pending}
              className="w-full text-left px-3 py-1.5 text-[var(--color-ink-2)] hover:bg-[var(--color-active-bg)] hover:text-[var(--color-overdue)] disabled:opacity-40"
            >
              撤销外协
            </button>
          )}
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
      await mutate({
        kind: 'updateVendor',
        vendorId: vendor.id,
        patch: { address: address.trim() || null },
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
