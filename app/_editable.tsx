'use client'

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { formatCny } from '@/lib/data'
import type {
  BlockPatch,
  ComponentPatch,
  CustomerPatch,
  JobPatch,
  VendorPatch,
} from '@/lib/db'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { DatePop } from '@/app/_datepop'

// Every primitive in this file commits via /api/mutate (~30-byte JSON
// request/response) instead of a server action. Server-action responses
// inline the current page's RSC payload — that fat HTTP/2 stream is what
// the GFW kept truncating for mainland users editing 工号 / parts /
// outsource fields against the HK VM. The JSON path here matches the
// survivability profile of the existing /api/job-status poller.

// The look every inline field shares: invisible at rest, darkens on hover,
// underlines on focus. Split from its horizontal padding so a field in a narrow
// frozen cell (the # column) can own its own — restating `px-*` in a caller's
// className would race baseInputClass's in the stylesheet, not override it.
const fieldSkinClass =
  'block w-full bg-transparent border-0 outline-none rounded-[2px] py-0.5 transition-[background-color,box-shadow] duration-150 hover:bg-[var(--color-active-bg)] hover:shadow-[inset_0_-1px_0_var(--color-border-strong)] focus:bg-[var(--color-active-bg)] focus:shadow-[inset_0_-1px_0_var(--color-ink)]'

const baseInputClass = `${fieldSkinClass} px-1 -mx-1`

function useDraft<T>(value: T) {
  const [draft, setDraft] = useState<T>(value)
  const [focused, setFocused] = useState(false)
  const [pending, start] = useTransition()
  // Re-sync the draft from the upstream `value` only when it changes AND the
  // input is idle (not focused, no pending write). Done as a render-time
  // setState driven by a stored-prev-prop sentinel — the canonical React 19
  // replacement for the equivalent useEffect.
  const [syncedFrom, setSyncedFrom] = useState(value)
  if (syncedFrom !== value && !focused && !pending) {
    setSyncedFrom(value)
    setDraft(value)
  }
  // safeStart wraps a transition body in a try/catch so a network failure
  // during commit never propagates out of useTransition. The throw used to
  // bubble up to app/error.tsx, blanking the screen with the "网络中断"
  // overlay for mainland users when a single /api/mutate POST was killed by
  // GFW — even though lib/mutate.ts already retries internally and the
  // server-side idempotency cache makes the retries safe. On unrecoverable
  // failure we revert the local draft and toast the user; the rest of the
  // page keeps working and the user can re-Enter to try again.
  const safeStart = (run: () => Promise<unknown>, revertTo: T) => {
    start(async () => {
      try {
        await run()
      } catch (e) {
        const msg = e instanceof Error ? e.message : '网络中断'
        showToast(`保存失败 · ${msg}`, 'warning')
        setDraft(revertTo)
      }
    })
  }
  return { draft, setDraft, focused, setFocused, pending, start, safeStart }
}

export function EditableText({
  value,
  onSave,
  placeholder = '—',
  className = '',
  align = 'left',
  mono = false,
}: {
  value: string | undefined
  onSave: (next: string) => Promise<void>
  placeholder?: string
  className?: string
  align?: 'left' | 'right' | 'center'
  mono?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  const initial = value ?? ''
  const { draft, setDraft, setFocused, pending, safeStart } = useDraft(initial)

  const commit = (next: string) => {
    if (next === initial) return
    safeStart(() => onSave(next), initial)
  }

  return (
    <input
      ref={ref}
      type="text"
      value={draft}
      placeholder={placeholder}
      onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        commit(draft)
      }}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ref.current?.blur()
        } else if (e.key === 'Escape') {
          setDraft(initial)
          requestAnimationFrame(() => ref.current?.blur())
        }
      }}
      className={`${baseInputClass} ${mono ? 'mono' : ''} text-${align} ${pending ? 'opacity-60' : ''} ${className}`}
    />
  )
}

export function EditableNumber({
  value,
  onSave,
  className = '',
  min,
  step = 1,
  paste,
}: {
  value: number | undefined
  onSave: (next: number) => Promise<void>
  className?: string
  min?: number
  step?: number
  paste?: PasteFill
}) {
  const ref = useRef<HTMLInputElement>(null)
  const initial = value ?? 0
  const initialStr = String(initial)
  const { draft, setDraft, setFocused, pending, safeStart } =
    useDraft(initialStr)
  const onPaste = usePasteFill(paste, ref)

  const commit = (next: string) => {
    const n = Number(next)
    if (!Number.isFinite(n) || n === initial) return
    safeStart(() => onSave(n), initialStr)
  }

  return (
    <input
      ref={ref}
      type="number"
      inputMode="numeric"
      min={min}
      step={step}
      value={draft}
      onPaste={onPaste}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        commit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ref.current?.blur()
        } else if (e.key === 'Escape') {
          setDraft(String(initial))
          requestAnimationFrame(() => ref.current?.blur())
        }
      }}
      className={`${baseInputClass} mono text-right ${pending ? 'opacity-60' : ''} ${className}`}
    />
  )
}

export function EditableDate({
  value,
  onSave,
  className = '',
}: {
  value: string
  onSave: (next: string) => Promise<void>
  className?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const { draft, setDraft, setFocused, pending, safeStart } = useDraft(value)

  const commit = (next: string) => {
    if (next === value || !next) return
    safeStart(() => onSave(next), value)
  }

  // <input type="date"> shows the OS-localized date format (e.g. "25/04/2026")
  // and a calendar icon. For print we render the raw YYYY-MM-DD as plain mono
  // text so the doc reads consistently with the rest of the form.
  return (
    <>
      <input
        ref={ref}
        type="date"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          commit(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ref.current?.blur()
          } else if (e.key === 'Escape') {
            setDraft(value)
            requestAnimationFrame(() => ref.current?.blur())
          }
        }}
        className={`${baseInputClass} mono screen-only ${pending ? 'opacity-60' : ''} ${className}`}
      />
      <span className={`mono print-only ${className}`}>{draft}</span>
    </>
  )
}

export function EditableTextArea({
  value,
  onSave,
  placeholder = '添加备注…',
  className = '',
}: {
  value: string | undefined
  onSave: (next: string) => Promise<void>
  placeholder?: string
  className?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const initial = value ?? ''
  const { draft, setDraft, setFocused, pending, safeStart } = useDraft(initial)

  // Auto-resize
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])

  const commit = (next: string) => {
    if (next === initial) return
    safeStart(() => onSave(next), initial)
  }

  return (
    <textarea
      ref={ref}
      rows={1}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        commit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          ref.current?.blur()
        } else if (e.key === 'Escape') {
          setDraft(initial)
          requestAnimationFrame(() => ref.current?.blur())
        }
      }}
      className={`${baseInputClass} resize-none leading-snug ${pending ? 'opacity-60' : ''} ${className}`}
    />
  )
}

type JobTextField = 'jobNo' | 'customer' | 'product'

export function JobText({
  jobId,
  field,
  value,
  className,
  align,
  mono,
  placeholder,
  multiline,
}: {
  jobId: string
  field: JobTextField
  value: string | undefined
  className?: string
  align?: 'left' | 'right' | 'center'
  mono?: boolean
  placeholder?: string
  // 客户名称 can run long ("浙江艾罗网络能源技术股份有限公司") — set multiline so
  // the field renders as an auto-growing textarea that wraps onto a second line
  // instead of clipping inside a single-line <input>.
  multiline?: boolean
}) {
  const save = async (v: string) => {
    const patch: JobPatch = { [field]: v }
    await mutate({ kind: 'updateJob', jobId, patch })
  }
  if (multiline) {
    return (
      <EditableTextArea
        value={value}
        onSave={save}
        className={className}
        placeholder={placeholder}
      />
    )
  }
  return (
    <EditableText
      value={value}
      onSave={save}
      className={className}
      align={align}
      mono={mono}
      placeholder={placeholder}
    />
  )
}

export function JobDueDate({
  jobId,
  value,
  className,
}: {
  jobId: string
  value: string
  className?: string
}) {
  return (
    <EditableDate
      value={value}
      onSave={async (v) => {
        await mutate({ kind: 'updateJob', jobId, patch: { dueDate: v } })
      }}
      className={className}
    />
  )
}

// 二次交期 — optional second delivery date. Mirrors JobDueDate's native
// <input type="date"> so it reads identically to the primary 交期 field, but
// allows clearing back to blank (commit empty → secondaryDueDate: null). Most
// jobs have none, so an empty input shows the browser's date placeholder.
export function JobSecondaryDueDate({
  jobId,
  value,
  className,
}: {
  jobId: string
  value: string | undefined
  className?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const initial = value ?? ''
  const { draft, setDraft, setFocused, pending, safeStart } = useDraft(initial)

  const commit = (next: string) => {
    if (next === initial) return
    safeStart(
      () =>
        mutate({
          kind: 'updateJob',
          jobId,
          patch: { secondaryDueDate: next === '' ? null : next },
        }),
      initial,
    )
  }

  return (
    <>
      <input
        ref={ref}
        type="date"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          commit(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ref.current?.blur()
          } else if (e.key === 'Escape') {
            setDraft(initial)
            requestAnimationFrame(() => ref.current?.blur())
          }
        }}
        className={`${baseInputClass} mono screen-only ${pending ? 'opacity-60' : ''} ${className ?? ''}`}
      />
      <span className={`mono print-only ${className ?? ''}`}>
        {draft || '—'}
      </span>
    </>
  )
}

export function JobAmount({
  jobId,
  value,
  className,
  onEcho,
}: {
  jobId: string
  value: number | undefined
  className?: string
  // Local echo for a surface that derives from 金额 (JobMoneyPosition's 毛利).
  // Called synchronously — outside the commit transition, so dependents repaint
  // before the write returns. Returns the undo to run if the write fails.
  onEcho?: (next: number | null) => () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const initial = value
  const initialStr = typeof initial === 'number' ? String(initial) : ''
  const { draft, setDraft, setFocused, pending, safeStart } =
    useDraft(initialStr)

  const commit = (next: string) => {
    const trimmed = next.trim()
    if (trimmed === '') {
      if (initial === undefined) return
      const undo = onEcho?.(null)
      safeStart(async () => {
        try {
          await mutate({ kind: 'updateJob', jobId, patch: { amountCny: null } })
        } catch (e) {
          undo?.()
          throw e
        }
      }, initialStr)
      return
    }
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n < 0) return
    if (n === initial) return
    const undo = onEcho?.(n)
    safeStart(async () => {
      try {
        await mutate({ kind: 'updateJob', jobId, patch: { amountCny: n } })
      } catch (e) {
        undo?.()
        throw e
      }
    }, initialStr)
  }

  return (
    <input
      ref={ref}
      type="number"
      inputMode="decimal"
      min={0}
      step={1}
      value={draft}
      placeholder="—"
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        commit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ref.current?.blur()
        } else if (e.key === 'Escape') {
          setDraft(typeof initial === 'number' ? String(initial) : '')
          requestAnimationFrame(() => ref.current?.blur())
        }
      }}
      className={`${baseInputClass} mono ${pending ? 'opacity-60' : ''} ${className ?? ''}`}
    />
  )
}

// Job-level notes — the one field every authenticated user can edit (生产 +
// 商务). The dispatcher's `updateJobNotes` kind enforces "any logged-in
// user" via requireUser, matching the original action gate.
export function JobNotes({
  jobId,
  value,
  className,
  placeholder,
}: {
  jobId: string
  value: string | undefined
  className?: string
  placeholder?: string
}) {
  return (
    <EditableTextArea
      value={value}
      onSave={async (v) => {
        await mutate({
          kind: 'updateJobNotes',
          jobId,
          notes: v.length === 0 ? null : v,
        })
      }}
      className={className}
      placeholder={placeholder}
    />
  )
}

// Single-line variant for table cells — same save path, different chrome.
// Used by the master sheet's 备注 column where row height is fixed.
export function JobNotesInline({
  jobId,
  value,
  className,
  placeholder,
}: {
  jobId: string
  value: string | undefined
  className?: string
  placeholder?: string
}) {
  return (
    <EditableText
      value={value}
      onSave={async (v) => {
        await mutate({
          kind: 'updateJobNotes',
          jobId,
          notes: v.length === 0 ? null : v,
        })
      }}
      className={className}
      placeholder={placeholder}
    />
  )
}

type ComponentTextField =
  | 'name'
  | 'material'
  | 'surfaceTreatment'
  | 'partNo'
  | 'process'
  | 'shipmentLog'

export function ComponentText({
  jobId,
  componentId,
  field,
  value,
  className,
  placeholder,
  multiline,
}: {
  jobId: string
  componentId: string
  field: ComponentTextField
  value: string | undefined
  className?: string
  placeholder?: string
  // Spec columns (加工工艺 / 材料 / 表面处理) can run long. Set multiline so the
  // field renders as an auto-growing textarea that wraps onto further lines
  // instead of overflowing a single-line <input>.
  multiline?: boolean
}) {
  const onSave = async (v: string) => {
    const patch: ComponentPatch =
      field === 'name'
        ? { name: v }
        : field === 'material'
          ? { material: v.length === 0 ? null : v }
          : field === 'surfaceTreatment'
            ? { surfaceTreatment: v.length === 0 ? null : v }
            : field === 'process'
              ? { process: v.length === 0 ? null : v }
              : field === 'shipmentLog'
                ? // Trim before the null decision: an all-whitespace entry
                  // collapses to null so it can't mask the derived shipment log
                  // (and read-only floor users never see a blank-looking cell).
                  { shipmentLog: v.trim().length === 0 ? null : v }
                : { partNo: v.length === 0 ? null : v }
    await mutate({ kind: 'updateComponent', jobId, componentId, patch })
  }
  if (multiline) {
    return (
      <EditableTextArea
        value={value}
        onSave={onSave}
        className={className}
        placeholder={placeholder}
      />
    )
  }
  return (
    <EditableText
      value={value}
      onSave={onSave}
      className={className}
      placeholder={placeholder}
    />
  )
}

// ─── 小计 = 数量 × 单价 ──────────────────────────────────────────────────────
//
// 数量, 单价 and 小计 are three separate <td>s of a row rendered by a server
// component, so they cannot share React state — they share it here, in one slot
// per part. Type a 单价 and the 小计 beside it lands immediately: the slot
// recomputes and the 小计 cell, watching its slot, re-reads. Nobody multiplies
// by hand.
//
// The authority for what actually gets stored is syncedLineTotal() in
// lib/db.ts, which applies the same rule to every write server-side. This
// mirror exists only because mutate deliberately never refreshes the page (see
// the note at the top of this file) — the number on screen has to be right
// before any refresh would arrive.
type LineSlot = { qty?: number; unit?: number | null; total?: number | null }

const lineSlots = new Map<string, LineSlot>()
const lineWatchers = new Map<string, Set<() => void>>()

const lineKey = (jobId: string, componentId: string) => `${jobId}/${componentId}`

function lineSlot(key: string): LineSlot {
  let slot = lineSlots.get(key)
  if (!slot) {
    slot = {}
    lineSlots.set(key, slot)
  }
  return slot
}

function notifyLine(key: string) {
  for (const fn of lineWatchers.get(key) ?? []) fn()
  // 财务 tab totals watch the whole job — every line movement reaches them.
  notifyJob(key.slice(0, key.indexOf('/')))
}

function subscribeLine(key: string, fn: () => void) {
  let set = lineWatchers.get(key)
  if (!set) {
    set = new Set()
    lineWatchers.set(key, set)
  }
  set.add(fn)
  return () => {
    set.delete(fn)
    if (set.size === 0) lineWatchers.delete(key)
  }
}

// ¥0.01 is the smallest thing anyone quotes; without the rounding, plain float
// multiplication leaves 1.0000000000000002 sitting in the sheet.
const roundMoney = (n: number) => Math.round(n * 100) / 100

function derivedLineTotal(slot: LineSlot): number | undefined {
  const { qty, unit } = slot
  if (typeof qty !== 'number' || !Number.isFinite(qty)) return undefined
  if (typeof unit !== 'number' || !Number.isFinite(unit)) return undefined
  return roundMoney(qty * unit)
}

// Seed one field of the slot from the server, and re-seed it whenever the
// server's value actually changes (a refresh, someone else's edit). Done in an
// effect, not in render, so a cell can never set state on a sibling mid-render.
function useLineFact(
  key: string,
  field: 'qty' | 'unit' | 'total',
  value: number | null | undefined,
) {
  useEffect(() => {
    const slot: Record<string, number | null | undefined> = lineSlot(key)
    if (slot[field] === value) return
    slot[field] = value
    notifyLine(key)
  }, [key, field, value])
}

// What a cell reads at rest: the slot's value once anything has been committed
// on this page, the server's until then — and for 小计, the product as the last
// resort. A primitive, so it can be a useSyncExternalStore snapshot.
//
// Reading the slot rather than the prop is also what makes "clear the 单价 you
// just typed" work at all: nothing refreshes the page after a write, so the
// prop still says what the row said on arrival.
function lineAtRest(
  key: string,
  field: 'qty' | 'unit' | 'total',
  stored: number | undefined,
): number | undefined {
  const slot: Record<string, number | null | undefined> = lineSlot(key)
  const own = slot[field]
  const value = (own === undefined ? stored : own) ?? undefined
  if (field === 'total') return value ?? derivedLineTotal(lineSlot(key))
  return value
}

// Watch the row's money. useSyncExternalStore, not useState — the writes that
// move 小计 happen inside a transition (safeStart), and a plain setState from
// there is deferred behind the in-flight write, which is exactly the lag this
// whole thing exists to remove. An external store re-renders immediately, and
// React re-checks the snapshot right after subscribing, so a row that was
// already seeded before this cell mounted still paints its product.
function useLineAtRest(
  key: string,
  field: 'qty' | 'unit' | 'total',
  stored: number | undefined,
) {
  return useSyncExternalStore(
    (fn) => subscribeLine(key, fn),
    () => lineAtRest(key, field, stored),
    () => stored,
  )
}

// Count of price-touching edits (数量 / 单价 / 小计) committed per job this
// visit. JobMoneyPosition's 金额 mirror keys off it: the server's rollup runs
// on EVERY such edit — even one that leaves the sum unchanged — so "has the
// rollup fired since my settle point" is a count comparison, not a sum one.
const jobEditCounts = new Map<string, number>()

function bumpJobEdits(key: string, delta: number) {
  const jobId = key.slice(0, key.indexOf('/'))
  jobEditCounts.set(jobId, (jobEditCounts.get(jobId) ?? 0) + delta)
}

// Local twin of syncedLineTotal() in lib/db.ts — keep the two rules identical.
// Applies a committed 数量 / 单价 to the slot, moves 小计 with it, and tells the
// cells. Returns an undo so a failed write can put the row back.
function applyLineEdit(key: string, next: { qty?: number; unit?: number | null }) {
  const slot = lineSlot(key)
  const before: LineSlot = { ...slot }
  if (next.qty !== undefined) slot.qty = next.qty
  if (next.unit !== undefined) slot.unit = next.unit
  const derived = derivedLineTotal(slot)
  if (derived !== undefined) {
    slot.total = derived
  } else if (next.unit === null) {
    // 单价 cleared: the total goes with it, unless it was quoted on its own
    // rather than derived — same carve-out the server makes.
    const wasDerived =
      typeof before.unit === 'number' &&
      typeof before.qty === 'number' &&
      roundMoney(before.qty * before.unit) === before.total
    if (wasDerived) slot.total = null
  }
  bumpJobEdits(key, 1)
  notifyLine(key)
  return () => {
    lineSlots.set(key, before)
    bumpJobEdits(key, -1)
    notifyLine(key)
  }
}

// ─── 财务 position, live ─────────────────────────────────────────────────────
//
// The 财务 tab's 金额 / 毛利 / 零件合计 used to be server HTML frozen at page
// load — type a 单价 in the sheet and the position sat on yesterday's numbers
// until a hard reload (mutate deliberately never refreshes; see the top of
// this file). JobMoneyPosition recomputes them from the same line slots the
// row cells write, so the moment a 数量 / 单价 / 小计 lands, the position
// moves with it.
//
// 金额 additionally mirrors the server's 零件 → 订单 rollup in lib/db.ts
// updateComponent — keep the two rules identical: while 金额 is "auto" (blank,
// or still equal to what the parts summed to when it settled) it follows the
// parts total; a hand-typed 金额 stays put until blanked.

const jobWatchers = new Map<string, Set<() => void>>()

function notifyJob(jobId: string) {
  for (const fn of jobWatchers.get(jobId) ?? []) fn()
}

function subscribeJob(jobId: string, fn: () => void) {
  let set = jobWatchers.get(jobId)
  if (!set) {
    set = new Set()
    jobWatchers.set(jobId, set)
  }
  set.add(fn)
  return () => {
    set.delete(fn)
    if (set.size === 0) jobWatchers.delete(jobId)
  }
}

// Rows deleted this visit. The position's `lines` prop is the server's list,
// so a deleted row would keep counting until reload without this.
const deletedLines = new Map<string, Set<string>>()

export function removeLineFromTotals(jobId: string, componentId: string) {
  let set = deletedLines.get(jobId)
  if (!set) {
    set = new Set()
    deletedLines.set(jobId, set)
  }
  set.add(componentId)
  notifyJob(jobId)
}

// The last 金额 someone typed (or blanked) on this page — a settle point: the
// parts total and edit count at that moment, which the auto test compares
// against. (A blanked 金额 stays "—" until the NEXT price edit re-arms it,
// exactly like the server.)
type AmountEcho = {
  value: number | null
  partsTotalAtCommit: number
  editCountAtCommit: number
}
const jobAmountEchoes = new Map<string, AmountEcho>()

export type MoneyLine = {
  componentId: string
  qty: number
  unit?: number | null
  total?: number | null
}

// One line's contribution: slot value where an edit landed this visit, the
// server's otherwise — 小计 first, 数量 × 单价 second. Same derivation as
// componentLineTotal in lib/data.
function lineMoneyAtRest(jobId: string, line: MoneyLine): number | undefined {
  const slot = lineSlots.get(lineKey(jobId, line.componentId))
  const total =
    slot && slot.total !== undefined
      ? (slot.total ?? undefined)
      : (line.total ?? undefined)
  if (typeof total === 'number' && Number.isFinite(total)) return total
  const qty = slot && slot.qty !== undefined ? slot.qty : line.qty
  const unit =
    slot && slot.unit !== undefined
      ? (slot.unit ?? undefined)
      : (line.unit ?? undefined)
  if (
    typeof unit === 'number' &&
    Number.isFinite(unit) &&
    typeof qty === 'number' &&
    Number.isFinite(qty)
  ) {
    return roundMoney(qty * unit)
  }
  return undefined
}

function computeJobPartsTotal(jobId: string, lines: MoneyLine[]): number {
  const deleted = deletedLines.get(jobId)
  const listed = new Set<string>()
  let sum = 0
  for (const l of lines) {
    listed.add(l.componentId)
    if (deleted?.has(l.componentId)) continue
    sum += lineMoneyAtRest(jobId, l) ?? 0
  }
  // Rows inserted this visit exist only in the slots — count them too.
  const prefix = `${jobId}/`
  for (const [key, slot] of lineSlots) {
    if (!key.startsWith(prefix)) continue
    const componentId = key.slice(prefix.length)
    if (listed.has(componentId) || deleted?.has(componentId)) continue
    const total = slot.total ?? derivedLineTotal(slot)
    if (typeof total === 'number' && Number.isFinite(total)) sum += total
  }
  return roundMoney(sum)
}

export function JobMoneyPosition({
  jobId,
  amountCny,
  externalSpend,
  lines,
}: {
  jobId: string
  amountCny: number | undefined
  externalSpend: number
  lines: MoneyLine[]
}) {
  // Mount hygiene: the module maps outlive client-side navigations, so a
  // leftover echo or deletion marker from an earlier visit to this job would
  // override the FRESH truth the server just rendered (which already includes
  // everything those markers echoed). The edit counter is handled differently
  // — the mount baseline below — because decrementing it would race in-flight
  // undos. Render-phase on purpose (before the snapshots read), idempotent.
  useState(() => {
    jobAmountEchoes.delete(jobId)
    deletedLines.delete(jobId)
  })
  const [mountEditCount] = useState(() => jobEditCounts.get(jobId) ?? 0)

  const subscribe = useCallback(
    (fn: () => void) => subscribeJob(jobId, fn),
    [jobId],
  )
  const partsTotal = useSyncExternalStore(
    subscribe,
    () => computeJobPartsTotal(jobId, lines),
    () => computeJobPartsTotal(jobId, lines),
  )
  const echo = useSyncExternalStore(
    subscribe,
    () => jobAmountEchoes.get(jobId),
    () => undefined,
  )
  const editCount = useSyncExternalStore(
    subscribe,
    () => jobEditCounts.get(jobId) ?? 0,
    () => 0,
  )

  // What the parts summed to server-side — the settle point for the 金额 the
  // page arrived with. Slots deliberately ignored: this is "before any edit".
  let serverTotal = 0
  for (const l of lines) {
    const t =
      typeof l.total === 'number' && Number.isFinite(l.total)
        ? l.total
        : typeof l.unit === 'number' && Number.isFinite(l.unit)
          ? roundMoney(l.qty * l.unit)
          : undefined
    serverTotal += t ?? 0
  }
  serverTotal = roundMoney(serverTotal)

  const settle: AmountEcho = echo ?? {
    value: amountCny ?? null,
    partsTotalAtCommit: serverTotal,
    editCountAtCommit: mountEditCount,
  }
  // Server rule, mirrored: 金额 is auto while blank or equal to what the parts
  // summed to at its settle point. `touched` = the rollup has fired since —
  // every price-touching edit runs it (even one that leaves the sum where it
  // was: touching any 数量/单价/小计 fills a blank 金额 in), and a deletion
  // that carried money moves the sum without an edit count.
  const auto =
    settle.value === null ||
    settle.value === Math.round(settle.partsTotalAtCommit)
  const touched =
    editCount > settle.editCountAtCommit ||
    partsTotal !== settle.partsTotalAtCommit
  const displayAmount =
    auto && touched
      ? partsTotal > 0
        ? Math.round(partsTotal)
        : undefined
      : (settle.value ?? undefined)
  const margin =
    typeof displayAmount === 'number' ? displayAmount - externalSpend : undefined

  // Latest parts total for the blank-echo settle point, without making the
  // JobAmount callback a re-subscribe hazard.
  const partsTotalRef = useRef(partsTotal)
  partsTotalRef.current = partsTotal

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-x-10 gap-y-8">
      <MoneyStat label="金额">
        <span className="mono text-[24px] text-[var(--color-ink-3)]">¥</span>
        <JobAmount
          jobId={jobId}
          value={displayAmount}
          className="text-[24px] font-semibold tracking-tight text-[var(--color-ink)]"
          onEcho={(next) => {
            const before = jobAmountEchoes.get(jobId)
            jobAmountEchoes.set(jobId, {
              value: next,
              partsTotalAtCommit: partsTotalRef.current,
              editCountAtCommit: jobEditCounts.get(jobId) ?? 0,
            })
            notifyJob(jobId)
            return () => {
              if (before) jobAmountEchoes.set(jobId, before)
              else jobAmountEchoes.delete(jobId)
              notifyJob(jobId)
            }
          }}
        />
      </MoneyStat>
      <MoneyStat label="毛利">
        <span
          className={`mono text-[24px] font-semibold tracking-tight ${
            typeof margin === 'number' && margin < 0
              ? 'text-[var(--color-overdue)]'
              : 'text-[var(--color-ink)]'
          }`}
        >
          {typeof margin === 'number' ? formatCny(margin) : '—'}
        </span>
      </MoneyStat>
      <MoneyStat label="外发金额">
        <span className="mono text-[24px] font-semibold tracking-tight text-[var(--color-ink-2)]">
          {externalSpend > 0 ? formatCny(externalSpend) : '—'}
        </span>
      </MoneyStat>
      <MoneyStat label="零件合计">
        <span className="mono text-[24px] font-semibold tracking-tight text-[var(--color-ink-2)]">
          {partsTotal > 0 ? formatCny(partsTotal) : '—'}
        </span>
      </MoneyStat>
    </div>
  )
}

// One position stat — label over a single value line, baseline-aligned.
function MoneyStat({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div>
      <p className="label mb-2">{label}</p>
      <div className="flex items-baseline gap-1 leading-none">{children}</div>
    </div>
  )
}

// ─── Excel-style bulk paste (fill-down) ─────────────────────────────────────
//
// Copy a column in WPS/Excel, click the first 单价 cell, ⌘V — the values land
// downward row by row, like pasting into a spreadsheet. Every cell of a
// column registers under `${field}:${jobId}`; the cell that receives the
// paste finds itself and the cells below it in DOM order and hands each
// clipboard line to that cell's own commit path. A single-line clipboard is
// left to the browser (a normal paste into one input).
type PasteFill = { col: string; cellId: string; commitRaw: (raw: string) => void }
type PasteTarget = { el: HTMLInputElement; commitRaw: (raw: string) => void }

const pasteCols = new Map<string, Map<string, PasteTarget>>()

// Numbers as Excel money cells actually carry them: ¥/￥/$ signs, thousand
// separators (ASCII and full-width), stray spaces, a trailing 元. A dash or
// blank means "no value here" and the row is skipped, never cleared.
function parsePastedNumber(raw: string): number | undefined {
  const cleaned = raw.replace(/[¥￥$,，\s]/g, '').replace(/元$/, '')
  if (cleaned === '' || cleaned === '—' || cleaned === '-') return undefined
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) return undefined
  return n
}

function usePasteFill(
  fill: PasteFill | undefined,
  ref: RefObject<HTMLInputElement | null>,
) {
  // The registry keeps one closure per cell for the column's lifetime; route
  // it through a ref so a paste always runs the current render's commit.
  const commitRef = useRef(fill?.commitRaw)
  commitRef.current = fill?.commitRaw
  const col = fill?.col
  const cellId = fill?.cellId
  useEffect(() => {
    const el = ref.current
    if (!col || !cellId || !el) return
    let cells = pasteCols.get(col)
    if (!cells) {
      cells = new Map()
      pasteCols.set(col, cells)
    }
    cells.set(cellId, { el, commitRaw: (raw) => commitRef.current?.(raw) })
    return () => {
      cells.delete(cellId)
      if (cells.size === 0) pasteCols.delete(col)
    }
  }, [col, cellId, ref])

  if (!fill) return undefined
  return (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text/plain')
    // Only spreadsheet-shaped clipboards (Excel/WPS always append a trailing
    // newline, even for one cell) take this path; plain text pastes normally.
    // The 1-line case must be handled here too — Chrome silently drops a
    // paste containing "\n" into a type=number input.
    if (!text.includes('\n') && !text.includes('\r')) return
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    // A clipboard wider than one column (an Excel selection spanning 数量+单价,
    // say) pastes its FIRST column — the one under the cursor is unknowable.
    const values = lines.map((l) => l.split('\t')[0].trim())
    if (values.length === 0) return
    e.preventDefault()
    const registered = [...(pasteCols.get(fill.col)?.values() ?? [])].filter(
      (c) => c.el.isConnected,
    )
    registered.sort((a, b) =>
      a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1,
    )
    const startAt = registered.findIndex((c) => c.el === ref.current)
    if (startAt === -1) return
    // Blur before filling: the input still holds its pre-paste draft, so the
    // blur-commit is a no-op, and an unfocused cell repaints from the slot
    // the moment its commitRaw lands the new value.
    ref.current?.blur()
    let applied = 0
    for (let i = 0; i < values.length; i++) {
      const target = registered[startAt + i]
      if (!target) break
      if (values[i] === '') continue
      target.commitRaw(values[i])
      applied += 1
    }
    const overflow = values.length - (registered.length - startAt)
    showToast(
      overflow > 0
        ? `已粘贴 ${applied} 行 · 剪贴板多出 ${overflow} 行`
        : `已粘贴 ${applied} 行`,
    )
  }
}

export function ComponentQty({
  jobId,
  componentId,
  value,
  className,
}: {
  jobId: string
  componentId: string
  value: number
  className?: string
}) {
  const key = lineKey(jobId, componentId)
  useLineFact(key, 'qty', value)
  const atRest = useLineAtRest(key, 'qty', value)
  return (
    <EditableNumber
      value={atRest ?? value}
      min={0}
      onSave={async (n) => {
        const undo = applyLineEdit(key, { qty: n })
        try {
          await mutate({
            kind: 'updateComponent',
            jobId,
            componentId,
            patch: { qty: n },
          })
        } catch (e) {
          undo()
          throw e
        }
      }}
      paste={{
        col: `qty:${jobId}`,
        cellId: componentId,
        commitRaw: (raw) => {
          const parsed = parsePastedNumber(raw)
          if (parsed === undefined) return
          const n = Math.round(parsed)
          if (n === lineAtRest(key, 'qty', value)) return
          // Outside the cell's transition on purpose: while `pending` is up,
          // useDraft won't re-sync, and a bulk-filled unfocused cell must
          // repaint from the slot the moment the value lands.
          const undo = applyLineEdit(key, { qty: n })
          mutate({
            kind: 'updateComponent',
            jobId,
            componentId,
            patch: { qty: n },
          }).catch((e) => {
            undo()
            showToast(
              `保存失败 · ${e instanceof Error ? e.message : '网络中断'}`,
              'warning',
            )
          })
        },
      }}
      className={className}
    />
  )
}

// Per-line money input. Nullable: blanking clears it (sends null), so a
// stray AI guess can be fully removed rather than coerced to 0 — important
// when the part actually has no quoted price and we don't want it polluting
// the breakdown total. Mirrors JobAmount's behavior.
// `value` is what the cell reads at rest — for 小计 that can be a number the
// row derived rather than one the server stored, so the write itself is left to
// the caller via onCommit.
function ComponentMoney({
  value,
  onCommit,
  className,
  paste,
}: {
  value: number | undefined
  onCommit: (next: number | null) => Promise<unknown>
  className?: string
  paste?: PasteFill
}) {
  const ref = useRef<HTMLInputElement>(null)
  const initial = value
  const initialStr = typeof initial === 'number' ? String(initial) : ''
  const { draft, setDraft, setFocused, pending, safeStart } =
    useDraft(initialStr)
  const onPaste = usePasteFill(paste, ref)

  const commit = (next: string) => {
    const trimmed = next.trim()
    if (trimmed === '') {
      if (initial === undefined) return
      safeStart(() => onCommit(null), initialStr)
      return
    }
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n < 0) return
    if (n === initial) return
    safeStart(() => onCommit(n), initialStr)
  }

  return (
    <input
      ref={ref}
      type="number"
      inputMode="decimal"
      min={0}
      step={1}
      value={draft}
      placeholder="—"
      onPaste={onPaste}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        commit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ref.current?.blur()
        } else if (e.key === 'Escape') {
          setDraft(typeof initial === 'number' ? String(initial) : '')
          requestAnimationFrame(() => ref.current?.blur())
        }
      }}
      className={`${baseInputClass} mono text-right ${pending ? 'opacity-60' : ''} ${className ?? ''}`}
    />
  )
}

// 零件进度 的 # — the row number, editable in place (migration 0088).
//
// The number is normally DERIVED from the part's position in the job, so this
// field shows the derived value until someone types over it, and clearing it
// hands the row straight back to the sequence. `derived` therefore doubles as
// the empty state: it is what the cell reads, and what a cleared field returns
// to, without waiting for an RSC refresh (mutate deliberately never refreshes —
// see the note at the top of this file).
//
// Sized for the 56px # column: two mono digits, centered, and — since this is a
// value you replace whole rather than edit into — focus selects it all, so the
// gesture is click, type the new number, Enter.
export function ComponentSeqLabel({
  jobId,
  componentId,
  value,
  derived,
  className = '',
}: {
  jobId: string
  componentId: string
  // The stored override. undefined ⇒ this row still follows the sequence.
  value: string | undefined
  // The position-derived number, already zero-padded ("01").
  derived: string
  className?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  // The committed override, held locally so the cell keeps telling the truth
  // between mutate and the next page load. Re-adopts the server value whenever
  // that actually changes (someone else renumbered the row) via the same
  // stored-prev-prop sentinel useDraft uses.
  const [committed, setCommitted] = useState<string | null>(value ?? null)
  const [syncedFrom, setSyncedFrom] = useState(value)
  if (syncedFrom !== value) {
    setSyncedFrom(value)
    setCommitted(value ?? null)
  }
  const atRest = committed ?? derived
  const { draft, setDraft, setFocused, pending, safeStart } = useDraft(atRest)

  const commit = (raw: string) => {
    const t = raw.trim()
    // Bare digits take the column's zero-padded shape — typing 5 gives 05, so a
    // renumbered row still reads like its neighbours. Anything else is kept
    // verbatim: drawing sets number parts 1-1 / 2A as often as they do 03.
    const next = /^\d+$/.test(t) ? t.padStart(2, '0') : t
    // Blank, or the number the row would have derived anyway, means "no
    // override" — nothing is stored for a # that agrees with the sequence.
    const override = next === '' || next === derived ? null : next
    if (override === committed) {
      setDraft(atRest)
      return
    }
    const before = committed
    setCommitted(override)
    setDraft(override ?? derived)
    safeStart(async () => {
      try {
        await mutate({
          kind: 'updateComponent',
          jobId,
          componentId,
          patch: { seqLabel: override },
        })
      } catch (e) {
        setCommitted(before)
        throw e
      }
    }, before ?? derived)
  }

  return (
    <input
      ref={ref}
      type="text"
      inputMode="numeric"
      maxLength={6}
      value={draft}
      aria-label="序号"
      title="改序号"
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => {
        setFocused(true)
        e.currentTarget.select()
      }}
      onBlur={() => {
        setFocused(false)
        commit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ref.current?.blur()
        } else if (e.key === 'Escape') {
          setDraft(atRest)
          requestAnimationFrame(() => ref.current?.blur())
        }
      }}
      className={`${fieldSkinClass} px-0 mono text-center ${pending ? 'opacity-60' : ''} ${className}`}
    />
  )
}

export function ComponentUnitPrice({
  jobId,
  componentId,
  value,
  className,
}: {
  jobId: string
  componentId: string
  value: number | undefined
  className?: string
}) {
  const key = lineKey(jobId, componentId)
  useLineFact(key, 'unit', value)
  const atRest = useLineAtRest(key, 'unit', value)
  return (
    <ComponentMoney
      value={atRest}
      onCommit={async (next) => {
        // 小计 moves with the price, on screen before the write returns.
        const undo = applyLineEdit(key, { unit: next })
        try {
          await mutate({
            kind: 'updateComponent',
            jobId,
            componentId,
            patch: { unitPriceCny: next },
          })
        } catch (e) {
          undo()
          throw e
        }
      }}
      paste={{
        col: `unit:${jobId}`,
        cellId: componentId,
        commitRaw: (raw) => {
          const n = parsePastedNumber(raw)
          if (n === undefined) return
          if (n === lineAtRest(key, 'unit', value)) return
          // Outside the cell's transition on purpose — see ComponentQty.
          const undo = applyLineEdit(key, { unit: n })
          mutate({
            kind: 'updateComponent',
            jobId,
            componentId,
            patch: { unitPriceCny: n },
          }).catch((e) => {
            undo()
            showToast(
              `保存失败 · ${e instanceof Error ? e.message : '网络中断'}`,
              'warning',
            )
          })
        },
      }}
      className={className}
    />
  )
}

// 小计 — 数量 × 单价 unless someone typed over it. The cell reads the slot, so
// it shows the product for every row that has both numbers, including the ones
// no one has ever opened: an imported 单价 with a blank 小计 column is a total
// from the moment the sheet paints, not after an edit. Typing here stores an
// explicit line total (the discount case) and the sheet keeps it until 数量 or
// 单价 moves again.
export function ComponentLineTotal({
  jobId,
  componentId,
  value,
  className,
}: {
  jobId: string
  componentId: string
  value: number | undefined
  className?: string
}) {
  const key = lineKey(jobId, componentId)
  useLineFact(key, 'total', value)
  const atRest = useLineAtRest(key, 'total', value)
  return (
    <ComponentMoney
      value={atRest}
      onCommit={async (next) => {
        const slot = lineSlot(key)
        const before: LineSlot = { ...slot }
        slot.total = next
        bumpJobEdits(key, 1)
        notifyLine(key)
        try {
          await mutate({
            kind: 'updateComponent',
            jobId,
            componentId,
            patch: { lineTotalCny: next },
          })
        } catch (e) {
          lineSlots.set(key, before)
          bumpJobEdits(key, -1)
          notifyLine(key)
          throw e
        }
      }}
      paste={{
        col: `total:${jobId}`,
        cellId: componentId,
        commitRaw: (raw) => {
          const n = parsePastedNumber(raw)
          if (n === undefined) return
          if (n === lineAtRest(key, 'total', value)) return
          // Outside the cell's transition on purpose — see ComponentQty.
          const slot = lineSlot(key)
          const before: LineSlot = { ...slot }
          slot.total = n
          bumpJobEdits(key, 1)
          notifyLine(key)
          mutate({
            kind: 'updateComponent',
            jobId,
            componentId,
            patch: { lineTotalCny: n },
          }).catch((e) => {
            lineSlots.set(key, before)
            bumpJobEdits(key, -1)
            notifyLine(key)
            showToast(
              `保存失败 · ${e instanceof Error ? e.message : '网络中断'}`,
              'warning',
            )
          })
        },
      }}
      className={className}
    />
  )
}

export function ComponentNotes({
  jobId,
  componentId,
  value,
  className,
  placeholder,
  multiline,
}: {
  jobId: string
  componentId: string
  value: string | undefined
  className?: string
  placeholder?: string
  // Top-aligned auto-growing textarea (matches the 加工工艺 / 材料 spec columns)
  // instead of a vertically-centered single-line input. Notes can run long.
  multiline?: boolean
}) {
  const onSave = async (v: string) => {
    await mutate({
      kind: 'updateComponent',
      jobId,
      componentId,
      patch: { notes: v.length === 0 ? null : v },
    })
  }
  if (multiline) {
    return (
      <EditableTextArea
        value={value}
        onSave={onSave}
        className={className}
        placeholder={placeholder}
      />
    )
  }
  return (
    <EditableText
      value={value}
      onSave={onSave}
      className={className}
      placeholder={placeholder}
    />
  )
}

// === Doc-level wrappers (used by the printable 外协单 / 出货单) ===
//
// Each wrapper is a thin shell over EditableText/EditableTextArea/EditableNumber
// and a server action. Edits to a directory-backed field (vendor.notes, etc.)
// silently propagate to the canonical row, so the next doc rendered for the
// same supplier/customer pre-fills with the new value.

type VendorTextField = 'name' | 'notes' | 'address'
type CustomerTextField = 'name' | 'contact' | 'address' | 'phone'

export function VendorText({
  vendorId,
  field,
  value,
  className,
  placeholder = '—',
}: {
  vendorId: string | undefined
  field: VendorTextField
  value: string | undefined
  className?: string
  placeholder?: string
}) {
  return (
    <EditableText
      value={value}
      placeholder={placeholder}
      className={className}
      onSave={async (v) => {
        if (!vendorId) return
        const next = v.trim().length === 0 ? null : v
        const patch: VendorPatch =
          field === 'name'
            ? { name: v }
            : field === 'notes'
              ? { notes: next }
              : { address: next }
        await mutate({ kind: 'updateVendor', vendorId, patch })
      }}
    />
  )
}

export function CustomerText({
  customerId,
  jobId,
  field,
  value,
  className,
  placeholder = '—',
}: {
  customerId: string | undefined
  // When the host page knows which job this edit belongs to, pass jobId.
  // The save then resolves (and upserts/links) the customer on the server
  // so an edit can never be silently dropped just because the page render
  // happened before the customer row was linked. The dispatcher's
  // `setJobCustomerField` kind handles the upsert atomically.
  jobId?: string
  field: CustomerTextField
  value: string | undefined
  className?: string
  placeholder?: string
}) {
  return (
    <EditableText
      value={value}
      placeholder={placeholder}
      className={className}
      onSave={async (v) => {
        const next = v.trim().length === 0 ? null : v
        if (!customerId) {
          if (!jobId || field === 'name') return
          await mutate({
            kind: 'setJobCustomerField',
            jobId,
            field,
            value: next,
          })
          return
        }
        const patch: CustomerPatch =
          field === 'name'
            ? { name: v }
            : field === 'contact'
              ? { contact: next }
              : field === 'address'
                ? { address: next }
                : { phone: next }
        await mutate({ kind: 'updateCustomer', customerId, patch })
      }}
    />
  )
}

type BlockTextField =
  | 'createdBy'
  | 'recipientAddress'
  | 'recipientContactName'
  | 'recipientContactPhone'
  | 'notes'
  | 'docNo'
  | 'activity'

export function OutsourceBlockText({
  blockId,
  jobId,
  field,
  value,
  className,
  placeholder = '—',
}: {
  blockId: string
  jobId?: string
  field: BlockTextField
  value: string | undefined
  className?: string
  placeholder?: string
}) {
  return (
    <EditableText
      value={value}
      placeholder={placeholder}
      className={className}
      onSave={async (v) => {
        const next = v.trim().length === 0 ? null : v
        const patch: BlockPatch =
          field === 'createdBy'
            ? { createdBy: next }
            : field === 'recipientAddress'
              ? { recipientAddress: next }
              : field === 'recipientContactName'
                ? { recipientContactName: next }
                : field === 'recipientContactPhone'
                  ? { recipientContactPhone: next }
                  : field === 'docNo'
                    ? { docNo: next }
                    : field === 'activity'
                      ? { activity: next }
                      : { notes: next }
        await mutate({
          kind: 'updateOutsourceBlock',
          blockId,
          patch,
          jobId,
        })
      }}
    />
  )
}

// Per-member vendor unit price. Mirrors OutsourceBlockAmount's empty-clears
// semantic — leaving the input blank stores null (printed as "—" on the
// 外协单 PDF). Click-to-edit inline within the member list.
export function BlockMemberUnitPrice({
  blockId,
  componentId,
  jobId,
  value,
  className,
}: {
  blockId: string
  componentId: string
  jobId?: string
  value: number | null | undefined
  className?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const isPending = value == null
  const initial = isPending ? '' : String(value)
  const { draft, setDraft, setFocused, pending, safeStart } = useDraft(initial)

  const commit = (next: string) => {
    const trimmed = next.trim()
    if (trimmed === '') {
      if (isPending) return
      safeStart(
        () =>
          mutate({
            kind: 'setBlockMemberUnitPrice',
            blockId,
            componentId,
            unitPriceCny: null,
            jobId,
          }),
        initial,
      )
      return
    }
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n < 0) return
    if (!isPending && n === Number(initial)) return
    safeStart(
      () =>
        mutate({
          kind: 'setBlockMemberUnitPrice',
          blockId,
          componentId,
          unitPriceCny: n,
          jobId,
        }),
      initial,
    )
  }

  return (
    <input
      ref={ref}
      type="number"
      inputMode="decimal"
      min={0}
      step={1}
      value={draft}
      placeholder={isPending ? '单价' : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        commit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ref.current?.blur()
        } else if (e.key === 'Escape') {
          setDraft(initial)
          requestAnimationFrame(() => ref.current?.blur())
        }
      }}
      className={`${baseInputClass} mono ${pending ? 'opacity-60' : ''} ${className ?? ''}`}
    />
  )
}

// Per-member outsource quantity editor — how many units of this part go to the
// vendor on this block. Always a positive integer (min 1); a blank or invalid
// entry reverts to the last value rather than clearing. Mirrors
// BlockMemberUnitPrice's commit-on-blur / Enter / Escape behavior.
export function BlockMemberQty({
  blockId,
  componentId,
  jobId,
  value,
  className,
}: {
  blockId: string
  componentId: string
  jobId?: string
  value: number
  className?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const initial = String(value)
  const { draft, setDraft, setFocused, pending, safeStart } = useDraft(initial)

  const commit = (next: string) => {
    const trimmed = next.trim()
    const n = Math.floor(Number(trimmed))
    if (trimmed === '' || !Number.isFinite(n) || n < 1) {
      setDraft(initial)
      return
    }
    if (n === value) return
    safeStart(
      () =>
        mutate({
          kind: 'setBlockMemberQty',
          blockId,
          componentId,
          qty: n,
          jobId,
        }),
      initial,
    )
  }

  return (
    <input
      ref={ref}
      type="number"
      inputMode="numeric"
      min={1}
      step={1}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        commit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ref.current?.blur()
        } else if (e.key === 'Escape') {
          setDraft(initial)
          requestAnimationFrame(() => ref.current?.blur())
        }
      }}
      title="外协数量 · 可改"
      className={`${baseInputClass} mono ${pending ? 'opacity-60' : ''} ${className ?? ''}`}
    />
  )
}

// Multi-line notes editor for a block. Auto-grows. Empty input clears the
// field back to null (so the "+ 添加备注…" hint reappears).
export function OutsourceBlockNotes({
  blockId,
  jobId,
  value,
  placeholder = '+ 添加备注…',
  className,
}: {
  blockId: string
  jobId?: string
  value: string | undefined
  placeholder?: string
  className?: string
}) {
  return (
    <EditableTextArea
      value={value}
      placeholder={placeholder}
      className={className}
      onSave={async (v) => {
        const next = v.trim().length === 0 ? null : v
        await mutate({
          kind: 'updateOutsourceBlock',
          blockId,
          patch: { notes: next },
          jobId,
        })
      }}
    />
  )
}

export function OutsourceBlockAmount({
  blockId,
  jobId,
  value,
  className,
}: {
  blockId: string
  jobId?: string
  // null = 加急 block awaiting price (待补金额); render empty with a placeholder
  // and let commerce type in the quote when it lands.
  value: number | null | undefined
  className?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const isPending = value == null
  const initial = isPending ? '' : String(value)
  const { draft, setDraft, setFocused, pending, safeStart } = useDraft(initial)

  const commit = (next: string) => {
    const trimmed = next.trim()
    // Empty clears the price back to 待补金额 (null). When already pending,
    // emptying is a no-op.
    if (trimmed === '') {
      if (isPending) return
      safeStart(
        () =>
          mutate({
            kind: 'updateOutsourceBlock',
            blockId,
            patch: { amountCny: null },
            jobId,
          }),
        initial,
      )
      return
    }
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n < 0) return
    if (!isPending && n === Number(initial)) return
    safeStart(
      () =>
        mutate({
          kind: 'updateOutsourceBlock',
          blockId,
          patch: { amountCny: n },
          jobId,
        }),
      initial,
    )
  }

  return (
    <input
      ref={ref}
      type="number"
      inputMode="decimal"
      min={0}
      step={1}
      value={draft}
      placeholder={isPending ? '待定' : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        commit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ref.current?.blur()
        } else if (e.key === 'Escape') {
          setDraft(initial)
          requestAnimationFrame(() => ref.current?.blur())
        }
      }}
      className={`${baseInputClass} mono ${pending ? 'opacity-60' : ''} ${className ?? ''}`}
    />
  )
}

// Popover calendar (app/_datepop.tsx) instead of the native <input type=date>
// EditableDate still uses elsewhere — the outsource dates are the fields users
// kept mis-committing via the native widget. Optimistic local value with
// rollback on failure; print renders the plain mono string.
//
// The calendar is portalled by DEFAULT here: every 外协 date lives inside a
// horizontally-scrolling card or table (工单页 外协 block header, 外协台 ledger),
// and an absolute panel inside `overflow-x-auto` gets clipped to a sliver —
// the picker opened upward and only its last week row survived on screen.
export function OutsourceBlockDate({
  blockId,
  jobId,
  field,
  value,
  className,
  formatLabel,
  hideIcon,
  portal = true,
}: {
  blockId: string
  jobId?: string
  field: 'sentDate' | 'expectedReturn'
  value: string
  className?: string
  formatLabel?: (iso: string) => string
  hideIcon?: boolean
  portal?: boolean
}) {
  const [local, setLocal] = useState(value)
  const [pending, start] = useTransition()
  return (
    <>
      <span className={`screen-only inline-flex ${pending ? 'opacity-60' : ''}`}>
        <DatePop
          value={local}
          onChange={(next) => {
            if (next === local || !next) return
            const prev = local
            setLocal(next)
            start(async () => {
              try {
                const patch: BlockPatch =
                  field === 'sentDate' ? { sentDate: next } : { expectedReturn: next }
                await mutate({ kind: 'updateOutsourceBlock', blockId, patch, jobId })
              } catch (e) {
                setLocal(prev)
                showToast(
                  `保存失败 · ${e instanceof Error ? e.message : '网络中断'}`,
                  'warning',
                )
              }
            })
          }}
          className={className}
          formatLabel={formatLabel}
          hideIcon={hideIcon}
          portal={portal}
        />
      </span>
      <span className={`mono print-only ${className ?? ''}`}>{local}</span>
    </>
  )
}

type JobShippingField =
  | 'createdBy'
  | 'contractNo'
  | 'batchNo'
  | 'engineer'
  | 'yuenongBusiness'

export function JobShippingText({
  jobId,
  field,
  value,
  className,
  placeholder = '—',
}: {
  jobId: string
  field: JobShippingField
  value: string | undefined
  className?: string
  placeholder?: string
}) {
  return (
    <EditableText
      value={value}
      placeholder={placeholder}
      className={className}
      onSave={async (v) => {
        const next = v.trim().length === 0 ? null : v
        const patch: JobPatch =
          field === 'createdBy'
            ? { createdBy: next }
            : field === 'contractNo'
              ? { contractNo: next }
              : field === 'batchNo'
                ? { batchNo: next }
                : field === 'engineer'
                  ? { engineer: next }
                  : { yuenongBusiness: next }
        await mutate({ kind: 'updateJob', jobId, patch })
      }}
    />
  )
}

// === Name combobox (vendor / customer) ===
//
// Native <input list> + <datalist>: the browser handles substring filtering
// and dropdown rendering. On commit we hit the right pick* server action,
// which upserts the directory row and re-points the parent (block / job).
// No custom popover, no third-party combobox — one input per field.

type ComboKind =
  | { kind: 'vendor'; blockId: string; jobId?: string }
  | { kind: 'customer'; jobId: string }

export function NameCombobox({
  target,
  value,
  options,
  className,
  placeholder = '—',
  mono = false,
}: {
  target: ComboKind
  value: string | undefined
  options: { id: string; name: string }[]
  className?: string
  placeholder?: string
  mono?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  const listId = useId()
  const initial = value ?? ''
  const { draft, setDraft, setFocused, pending, safeStart } = useDraft(initial)

  const commit = (next: string) => {
    const trimmed = next.trim()
    if (trimmed === initial.trim()) return
    safeStart(async () => {
      if (target.kind === 'vendor') {
        if (!trimmed) return
        await mutate({
          kind: 'pickVendorForBlock',
          blockId: target.blockId,
          name: trimmed,
        })
      } else {
        await mutate({
          kind: 'pickCustomerForJob',
          jobId: target.jobId,
          name: trimmed,
        })
      }
    }, initial)
  }

  return (
    <>
      <input
        ref={ref}
        type="text"
        list={listId}
        value={draft}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          commit(draft)
        }}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ref.current?.blur()
          } else if (e.key === 'Escape') {
            setDraft(initial)
            requestAnimationFrame(() => ref.current?.blur())
          }
        }}
        className={`${baseInputClass} ${mono ? 'mono' : ''} ${pending ? 'opacity-60' : ''} ${className ?? ''}`}
      />
      <datalist id={listId} className="no-print">
        {options.map((o) => (
          <option key={o.id} value={o.name} />
        ))}
      </datalist>
    </>
  )
}
