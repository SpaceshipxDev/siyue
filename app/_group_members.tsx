'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'

// 今日产出卡片标题旁边那一小块 —— 组里算了谁, 点一下改组员 (lib/report-group)。
// 组员报的工 (不管在哪台机器、哪个账号上报的) 一起算进这张卡。
export function GroupMembers({
  members,
  listed,
}: {
  /** 一起算进来的人 (写下来的 + 在这个账号上报过工的)。 */
  members: string[]
  /** 写下来的那几个 —— 编辑框里改的就是它。 */
  listed: string[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, start] = useTransition()

  const save = () =>
    start(async () => {
      try {
        await mutate({
          kind: 'setReportGroup',
          members: draft.split(/[、,，\s]+/).filter(Boolean),
        })
        setOpen(false)
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '没存上', 'warning')
      }
    })

  if (open) {
    return (
      <span className="flex min-w-0 items-center gap-2">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) save()
            if (e.key === 'Escape') setOpen(false)
          }}
          placeholder="组员名字，用顿号隔开"
          className="w-[220px] border-b border-[var(--color-border-strong)] bg-transparent py-0.5 text-[12.5px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-ink)]"
        />
        <button
          type="button"
          disabled={pending}
          onClick={save}
          className="text-[12px] text-[var(--color-ink)] hover:underline underline-offset-2 disabled:opacity-50"
        >
          存
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
        >
          取消
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(listed.join('、'))
        setOpen(true)
      }}
      title="组里有谁 —— 他们报的工一起算进这张卡"
      className="truncate text-left text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
    >
      {members.length > 0 ? `含 ${members.join('、')}` : '＋组员'}
    </button>
  )
}
