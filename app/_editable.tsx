'use client'

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react'
import type {
  BlockPatch,
  ComponentPatch,
  CustomerPatch,
  JobPatch,
  VendorPatch,
} from '@/lib/db'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'

// Every primitive in this file commits via /api/mutate (~30-byte JSON
// request/response) instead of a server action. Server-action responses
// inline the current page's RSC payload — that fat HTTP/2 stream is what
// the GFW kept truncating for mainland users editing 工号 / parts /
// outsource fields against the HK VM. The JSON path here matches the
// survivability profile of the existing /api/job-status poller.

const baseInputClass =
  'block w-full bg-transparent border-0 outline-none rounded-sm px-1 -mx-1 py-0.5 transition-[background-color,box-shadow] duration-150 hover:bg-[var(--color-active-bg)] hover:shadow-[inset_0_-1px_0_var(--color-border-strong)] focus:bg-[var(--color-active-bg)] focus:shadow-[inset_0_-1px_0_var(--color-ink)]'

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
}: {
  value: number | undefined
  onSave: (next: number) => Promise<void>
  className?: string
  min?: number
  step?: number
}) {
  const ref = useRef<HTMLInputElement>(null)
  const initial = value ?? 0
  const initialStr = String(initial)
  const { draft, setDraft, setFocused, pending, safeStart } =
    useDraft(initialStr)

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

export function JobAmount({
  jobId,
  value,
  className,
}: {
  jobId: string
  value: number | undefined
  className?: string
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
      safeStart(
        () =>
          mutate({ kind: 'updateJob', jobId, patch: { amountCny: null } }),
        initialStr,
      )
      return
    }
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n < 0) return
    if (n === initial) return
    safeStart(
      () => mutate({ kind: 'updateJob', jobId, patch: { amountCny: n } }),
      initialStr,
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

type ComponentTextField = 'name' | 'material' | 'surfaceTreatment'

export function ComponentText({
  jobId,
  componentId,
  field,
  value,
  className,
  placeholder,
}: {
  jobId: string
  componentId: string
  field: ComponentTextField
  value: string | undefined
  className?: string
  placeholder?: string
}) {
  return (
    <EditableText
      value={value}
      onSave={async (v) => {
        const patch: ComponentPatch =
          field === 'name'
            ? { name: v }
            : field === 'material'
              ? { material: v.length === 0 ? null : v }
              : { surfaceTreatment: v.length === 0 ? null : v }
        await mutate({ kind: 'updateComponent', jobId, componentId, patch })
      }}
      className={className}
      placeholder={placeholder}
    />
  )
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
  return (
    <EditableNumber
      value={value}
      min={0}
      onSave={async (n) => {
        await mutate({
          kind: 'updateComponent',
          jobId,
          componentId,
          patch: { qty: n },
        })
      }}
      className={className}
    />
  )
}

// Per-line money input. Nullable: blanking clears it (sends null), so a
// stray AI guess can be fully removed rather than coerced to 0 — important
// when the part actually has no quoted price and we don't want it polluting
// the breakdown total. Mirrors JobAmount's behavior.
function ComponentMoney({
  jobId,
  componentId,
  value,
  field,
  className,
}: {
  jobId: string
  componentId: string
  value: number | undefined
  field: 'unitPriceCny' | 'lineTotalCny'
  className?: string
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
      safeStart(
        () =>
          mutate({
            kind: 'updateComponent',
            jobId,
            componentId,
            patch: { [field]: null },
          }),
        initialStr,
      )
      return
    }
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n < 0) return
    if (n === initial) return
    safeStart(
      () =>
        mutate({
          kind: 'updateComponent',
          jobId,
          componentId,
          patch: { [field]: n },
        }),
      initialStr,
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
      className={`${baseInputClass} mono text-right ${pending ? 'opacity-60' : ''} ${className ?? ''}`}
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
  return (
    <ComponentMoney
      jobId={jobId}
      componentId={componentId}
      value={value}
      field="unitPriceCny"
      className={className}
    />
  )
}

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
  return (
    <ComponentMoney
      jobId={jobId}
      componentId={componentId}
      value={value}
      field="lineTotalCny"
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
}: {
  jobId: string
  componentId: string
  value: string | undefined
  className?: string
  placeholder?: string
}) {
  return (
    <EditableText
      value={value}
      onSave={async (v) => {
        await mutate({
          kind: 'updateComponent',
          jobId,
          componentId,
          patch: { notes: v.length === 0 ? null : v },
        })
      }}
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

export function OutsourceBlockDate({
  blockId,
  jobId,
  field,
  value,
  className,
}: {
  blockId: string
  jobId?: string
  field: 'sentDate' | 'expectedReturn'
  value: string
  className?: string
}) {
  return (
    <EditableDate
      value={value}
      className={className}
      onSave={async (v) => {
        const patch: BlockPatch =
          field === 'sentDate' ? { sentDate: v } : { expectedReturn: v }
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

type JobShippingField = 'createdBy' | 'contractNo' | 'batchNo'

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
              : { batchNo: next }
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
