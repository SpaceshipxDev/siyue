'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { deleteJobAction } from './actions'

type InboxItem = {
  id: string
  jobNo: string
  customer: string
  product: string
  status: 'parsing' | 'draft' | 'failed'
  componentCount: number
}

// Owns the inbox list rendering so we can optimistically hide a row the
// instant the user clicks ×. Mainland users hit the HK VM across the GFW;
// the server-action response (which carries the fresh RSC payload back) often
// gets truncated mid-stream and the action LOOKS failed even though the DB
// delete succeeded. Optimistic removal hides this entirely — the row vanishes
// immediately, and the next full page load confirms the deletion.
const COLLAPSED_COUNT = 3

export function InboxList({ inbox }: { inbox: InboxItem[] }) {
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState(false)
  const visible = inbox.filter((d) => !removed.has(d.id))
  if (visible.length === 0) return null
  const overflow = visible.length - COLLAPSED_COUNT
  const shown = expanded || overflow <= 0 ? visible : visible.slice(0, COLLAPSED_COUNT)
  return (
    <section className="mb-8 rounded-sm border border-[var(--color-warning)] bg-[var(--color-warning-soft)]">
      <div className="flex items-baseline justify-between px-5 py-3 border-b border-[var(--color-warning)]">
        <p className="label text-[var(--color-ink)]">
          导入收件箱 · {visible.length}
        </p>
        <p className="text-[12px] text-[var(--color-ink-2)]">
          解析完成后逐项核对、配图、确认才会进入看板
        </p>
      </div>
      <ul className="divide-y divide-[var(--color-warning)]">
        {shown.map((d) => (
          <InboxRow
            key={d.id}
            item={d}
            onRemoveLocally={() =>
              setRemoved((prev) => {
                const next = new Set(prev)
                next.add(d.id)
                return next
              })
            }
          />
        ))}
      </ul>
      {overflow > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="label w-full px-5 py-2 border-t border-[var(--color-warning)] text-[var(--color-ink-2)] hover:bg-[#f5e6b8] hover:text-[var(--color-ink)] text-left"
        >
          {expanded ? '收起 ↑' : `展开全部 ${visible.length} 条 ↓`}
        </button>
      ) : null}
    </section>
  )
}

function InboxRow({
  item,
  onRemoveLocally,
}: {
  item: InboxItem
  onRemoveLocally: () => void
}) {
  const tone =
    item.status === 'parsing'
      ? 'text-[var(--color-warning)]'
      : item.status === 'failed'
        ? 'text-[var(--color-overdue)]'
        : 'text-[var(--color-ink)]'
  const label =
    item.status === 'parsing'
      ? '解析中'
      : item.status === 'failed'
        ? '解析失败'
        : '待审核'
  return (
    <li className="flex items-stretch hover:bg-[#f5e6b8]">
      <Link
        href={`/import/${item.id}`}
        className="flex items-baseline gap-4 px-5 py-3 text-[13px] flex-1 min-w-0"
      >
        <span className={`label w-16 shrink-0 ${tone}`}>{label}</span>
        <span className="mono font-medium text-[var(--color-ink)] w-32 shrink-0 truncate">
          {item.jobNo}
        </span>
        <span className="text-[var(--color-ink)] flex-1 truncate">
          {item.customer}
          <span className="ml-2 text-[var(--color-ink-3)]">{item.product}</span>
        </span>
        <span className="label text-[var(--color-ink-2)]">
          {item.status === 'parsing' ? '—' : `${item.componentCount} 件`}
        </span>
        <span className="label text-[var(--color-ink)]">打开 →</span>
      </Link>
      <div className="flex items-center pr-3">
        <DeleteButton
          jobId={item.id}
          label={`${item.jobNo} · ${item.customer}`}
          onRemoveLocally={onRemoveLocally}
        />
      </div>
    </li>
  )
}

function DeleteButton({
  jobId,
  label,
  onRemoveLocally,
}: {
  jobId: string
  label: string
  onRemoveLocally: () => void
}) {
  const [pending, start] = useTransition()
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!confirm(`删除「${label}」？`)) return
        // Hide the row immediately. The DB delete is reliable; only the
        // response RSC payload is at risk on cross-border links.
        onRemoveLocally()
        start(async () => {
          try {
            await deleteJobAction(jobId)
          } catch {
            // Action threw — most likely the response was truncated. The
            // delete itself almost certainly succeeded; let the next nav
            // confirm it rather than restore the row and confuse the user.
          }
        })
      }}
      title="删除此条草稿 / 解析失败 / 卡住的条目"
      className="flex items-center justify-center w-9 h-9 -my-1 rounded-sm text-[22px] leading-none text-[var(--color-ink-3)] hover:text-[var(--color-overdue)] hover:bg-[#f5e6b8] disabled:opacity-50"
    >
      {pending ? '…' : '×'}
    </button>
  )
}
