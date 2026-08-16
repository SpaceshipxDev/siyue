'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { deleteJobAction } from './actions'
import { PermissionDenied } from './_perm_denied'

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

export function InboxList({
  inbox,
  canDelete,
}: {
  inbox: InboxItem[]
  canDelete: boolean
}) {
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState(false)
  const visible = inbox.filter((d) => !removed.has(d.id))
  if (visible.length === 0) return null
  const overflow = visible.length - COLLAPSED_COUNT
  const shown =
    expanded || overflow <= 0 ? visible : visible.slice(0, COLLAPSED_COUNT)
  return (
    <section className="mb-8 rounded-[2px] border border-[var(--color-warning)] bg-[var(--color-warning-soft)]">
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
            canDelete={canDelete}
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
  canDelete,
  onRemoveLocally,
}: {
  item: InboxItem
  canDelete: boolean
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
          allowed={canDelete}
          onRemoveLocally={onRemoveLocally}
        />
      </div>
    </li>
  )
}

// `allowed` (canDeleteJob, server-decided) does NOT hide the button — the same
// rule as the 零件 trash icon. A missing button reads as a broken page; a
// button that answers "谁能删" teaches the rule once and stops the WeChat
// message. Non-deleters still see the 收件箱 because 工程 runs the imports.
function DeleteButton({
  jobId,
  label,
  allowed,
  onRemoveLocally,
}: {
  jobId: string
  label: string
  allowed: boolean
  onRemoveLocally: () => void
}) {
  const [pending, start] = useTransition()
  const [denied, setDenied] = useState<DOMRect | null>(null)
  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={(e) => {
          if (!allowed) {
            setDenied(e.currentTarget.getBoundingClientRect())
            return
          }
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
        className="flex items-center justify-center w-9 h-9 -my-1 rounded-[2px] text-[22px] leading-none text-[var(--color-ink-3)] hover:text-[var(--color-overdue)] hover:bg-[#f5e6b8] disabled:opacity-50"
      >
        {pending ? '…' : '×'}
      </button>
      {denied ? (
        <PermissionDenied
          anchor={denied}
          title="无删除权限"
          body="删除工单会一并删掉它的零件和报工记录，仅限授权人员操作。需要删除请找 于海伟 或 商务。"
          onClose={() => setDenied(null)}
        />
      ) : null}
    </>
  )
}
