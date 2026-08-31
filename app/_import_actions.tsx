'use client'

import Link from 'next/link'
import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { STAGES, type Stage, type JobStatus } from '@/lib/data'
import { confirmJobAction } from './actions'
import { mutate } from '@/lib/mutate'
import { EditableText } from './_editable'
import { DELETE_PART_DENIED, PermissionDenied } from './_perm_denied'

// Shared shape for a 工号 (job number) collision — a live/draft order already
// holding the number this draft wants. Mirrors lib/db's JobNoConflict, kept
// local so this client bundle never imports the server-only db module.
type JobNoConflict = {
  id: string
  jobNo: string
  customer: string
  status: JobStatus
}

// 客户工程师 didn't come out of the drawing pack, but this customer has an
// order in the system already — so the person they dealt with last time is one
// tap away instead of a trip through old orders. Never fills itself: they DO
// change people, and the one time they did is exactly when a silent auto-fill
// would put the wrong name on the order.
export function EngineerHint({
  jobId,
  name,
}: {
  jobId: string
  name: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await mutate({ kind: 'updateJob', jobId, patch: { engineer: name } })
          router.refresh()
        })
      }
      className="mt-1.5 text-[11.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] disabled:opacity-50"
    >
      这家上次是{' '}
      <span className="font-medium text-[var(--color-ink-2)]">{name}</span>
      <span className="text-[var(--color-ink-4)]"> · 点一下填上</span>
    </button>
  )
}

// Two-step deliberate confirm:
//   1. Optionally click "→ 发往工段" to expose the station chips, then tap the
//      target station (it highlights — this is just a *selection*, not a
//      submit).
//   2. Click 确认导入 to actually commit. The button label reflects the
//      chosen destination (e.g. "确认导入 → 切割") so the boss can't miss
//      what's about to happen.
//
// On confirm, every part's pending stages strictly before the chosen station
// are flipped to `done` (not deleted) — upstream stages render ✓ on the
// rollup so it's clear they were skipped, not absent. Without a chosen
// station, a plain confirm runs the standard pipeline from 编程.
export function ConfirmImportButton({
  jobId,
  conflict,
}: {
  jobId: string
  // Server-computed 工号 collision. When set, 确认导入 is disabled — the user
  // must rename the 工号 (which router.refresh()es this prop away) before the
  // draft can enter the board. The page renders the actual caution on the 工号
  // field; here we only gate the button + explain why.
  conflict?: JobNoConflict | null
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Stage | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  const blocked = Boolean(conflict)

  const submit = () => {
    setError(null)
    start(async () => {
      const result = await confirmJobAction(jobId, selected)
      if (result.ok) {
        router.push(`/jobs/${jobId}`)
        return
      }
      if ('conflict' in result) {
        // Lost a race — the 工号 got taken between page load and this confirm.
        // Refresh so the page recomputes the conflict, lighting up the 工号
        // caution and disabling this button.
        router.refresh()
        return
      }
      setError(result.error)
    })
  }

  return (
    <div className="inline-flex flex-col items-end gap-2"><div className="inline-flex items-center gap-2 flex-wrap justify-end">
      {open && (
        <div className="inline-flex items-center gap-1.5 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5">
          <span className="label text-[var(--color-ink-3)] mr-1">发往</span>
          {STAGES.map((s) => {
            const isSelected = selected === s
            return (
              <button
                key={s}
                type="button"
                disabled={pending}
                onClick={() => setSelected(isSelected ? undefined : s)}
                className={`px-2 py-1 text-[12px] tracking-wider rounded-[2px] transition-colors disabled:opacity-50 ${
                  isSelected
                    ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
                    : 'text-[var(--color-ink-2)] hover:bg-[var(--color-muted-bg)] hover:text-[var(--color-ink)]'
                }`}
              >
                {s}
              </button>
            )
          })}
          <button
            type="button"
            onClick={() => {
              setSelected(undefined)
              setOpen(false)
            }}
            aria-label="关闭"
            className="ml-1 px-1 text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            ×
          </button>
        </div>
      )}
      {!open && (
        <button
          type="button"
          disabled={pending}
          onClick={() => setOpen(true)}
          className="px-3 py-2 text-[12px] tracking-wider border border-[var(--color-border-strong)] text-[var(--color-ink-2)] rounded-[2px] hover:text-[var(--color-ink)] hover:border-[var(--color-ink)] disabled:opacity-50"
        >
          → 发往工段
        </button>
      )}
      <button
        type="button"
        disabled={pending || blocked}
        onClick={submit}
        title={blocked ? '工号重复，请先修改工号' : undefined}
        className="px-4 py-2 text-[13px] tracking-wider bg-[var(--color-ink)] text-[var(--color-surface)] rounded-[2px] hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {pending
          ? '导入中…'
          : selected
            ? `确认导入 → ${selected}`
            : '确认导入'}
      </button>
      </div>
      {blocked ? (
        <p className="text-[12px] text-[var(--color-overdue)]">
          工号重复 · 请先修改上方工号再导入
        </p>
      ) : error ? (
        <p className="text-[12px] text-[var(--color-overdue)]">{error}</p>
      ) : null}
    </div>
  )
}

// The 工号 field on the import review page. Same inline editor used everywhere
// else, but it (a) flags a red caution when the parsed 工号 collides with a
// live order and (b) re-runs the server-side duplicate check on every commit
// via router.refresh(), so the caution + 确认导入 gate clear the instant the
// operator renames it to a free number.
export function ImportJobNoField({
  jobId,
  value,
  conflict,
  className,
}: {
  jobId: string
  value: string
  conflict: JobNoConflict | null
  className?: string
}) {
  const router = useRouter()
  return (
    <div>
      <EditableText
        value={value}
        mono
        placeholder="工号"
        className={
          conflict ? `${className ?? ''} text-[var(--color-overdue)]` : className
        }
        onSave={async (v) => {
          try {
            await mutate({ kind: 'updateJob', jobId, patch: { jobNo: v } })
          } catch (e) {
            // updateJob rejects a rename INTO another taken 工号 with the
            // DUP_JOBNO sentinel — translate it to a readable toast rather than
            // leaking the wire format. (Renaming to a free 工号 is the normal
            // fix path and never throws.)
            if (e instanceof Error && e.message.includes('DUP_JOBNO')) {
              throw new Error('该工号已被占用，请改用其他工号')
            }
            throw e
          }
          // Recompute the server-side conflict so the caution + 确认导入 gate
          // reflect the new 工号. /import/[id] is force-dynamic and light.
          router.refresh()
        }}
      />
      {conflict ? (
        <div className="mt-2 flex flex-col gap-1 rounded-[2px] border border-[var(--color-overdue)] bg-[var(--color-overdue-soft)] px-2.5 py-2 text-[11px] leading-snug text-[var(--color-ink)]">
          <span className="font-medium">
            ⚠ 工号已存在 ·{' '}
            <span className="mono">{conflict.jobNo}</span>
            {conflict.customer ? (
              <span className="text-[var(--color-ink-2)]"> · {conflict.customer}</span>
            ) : null}
          </span>
          <span className="text-[var(--color-ink-2)]">
            改用其他工号后才能导入。
            <Link
              href={`/jobs/${conflict.id}`}
              className="ml-1 underline underline-offset-2 text-[var(--color-ink)] hover:opacity-70"
            >
              查看已存在工单 →
            </Link>
          </span>
        </div>
      ) : null}
    </div>
  )
}

// Same gesture as the job sheet: a + straddling the separator line under each
// row, dropping a 零件 right there. The draft review screen is where a missed
// row is noticed, and it's always noticed NEXT TO the row it belongs under.
// This page still takes the router.refresh (one job's parts, not the master
// board) — it's a once-per-click action on a page nobody scans from the floor.
export function InsertComponentButton({
  jobId,
  afterComponentId,
  allowed,
}: {
  jobId: string
  afterComponentId: string
  // canCreatePartRow — the + simply isn't there for someone who can't add.
  allowed: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  if (!allowed) return null
  return (
    <button
      type="button"
      disabled={pending}
      title="在此行下方插入零件"
      aria-label="在此行下方插入零件"
      onClick={() =>
        start(async () => {
          await mutate({ kind: 'insertComponentAfter', jobId, afterComponentId })
          router.refresh()
        })
      }
      className="row-insert absolute left-[18px] -bottom-[10px] z-10 inline-flex h-[20px] w-[20px] items-center justify-center rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-ink-3)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)] disabled:opacity-40"
    >
      <PlusGlyph />
    </button>
  )
}

// The only add affordance on a draft with no parts yet — nothing to hover.
export function AddComponentButton({
  jobId,
  allowed,
}: {
  jobId: string
  allowed: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  if (!allowed) return null
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await mutate({ kind: 'appendComponent', jobId })
          router.refresh()
        })
      }
      className="inline-flex items-center gap-1.5 text-[12px] tracking-wider text-[var(--color-ink-3)] hover:text-[var(--color-ink)] disabled:opacity-50"
    >
      <span className="inline-flex h-[16px] w-[16px] items-center justify-center rounded-[2px] border border-[var(--color-border-strong)]">
        <PlusGlyph />
      </span>
      添加零件
    </button>
  )
}

function PlusGlyph() {
  return (
    <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
      <path
        d="M4.5 0.5 V8.5 M0.5 4.5 H8.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="square"
      />
    </svg>
  )
}

// Same 权限 rule as the job sheet's trash icon (canDeletePartRow): the word
// stays put for every editor and says why when it can't act, rather than
// disappearing and leaving the draft looking half-broken.
export function DeleteComponentButton({
  jobId,
  componentId,
  componentName,
  allowed,
}: {
  jobId: string
  componentId: string
  componentName: string
  allowed: boolean
}) {
  const router = useRouter()
  const ref = useRef<HTMLButtonElement>(null)
  const [denied, setDenied] = useState<DOMRect | null>(null)
  const [pending, start] = useTransition()
  return (
    <>
      <button
        ref={ref}
        type="button"
        disabled={pending}
        title={allowed ? undefined : '无删除权限'}
        onClick={() => {
          if (!allowed) {
            setDenied(ref.current?.getBoundingClientRect() ?? null)
            return
          }
          const label = componentName || '该零件'
          if (!confirm(`删除「${label}」？此操作不可撤销。`)) return
          start(async () => {
            await mutate({ kind: 'deleteComponent', jobId, componentId })
            router.refresh()
          })
        }}
        className={`label disabled:opacity-50 ${
          allowed
            ? 'text-[var(--color-ink-3)] hover:text-[var(--color-overdue)]'
            : 'text-[var(--color-ink-4)] hover:text-[var(--color-ink-3)]'
        }`}
      >
        删除
      </button>
      {denied ? (
        <PermissionDenied
          anchor={denied}
          title={DELETE_PART_DENIED.title}
          body={DELETE_PART_DENIED.body}
          onClose={() => setDenied(null)}
        />
      ) : null}
    </>
  )
}
