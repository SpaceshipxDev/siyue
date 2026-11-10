'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { withBase } from '@/lib/base-path'

// 名字旁边的「待办 N」—— 自己笔记里还没完成的事项。有过期的就标红。
// 零项不显示。笔记页上勾了完成会发 'notes-todo', 这里跟着重读。
export const NOTES_TODO_EVENT = 'notes-todo'

export function NotesTodoChip() {
  const [count, setCount] = useState<{ open: number; overdue: number } | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await fetch(withBase('/api/notes'), { cache: 'no-store' })
        const j = await r.json()
        if (alive && j.ok) setCount({ open: j.open, overdue: j.overdue })
      } catch {
        // 读不到就不显示, 不打扰
      }
    }
    load()
    window.addEventListener(NOTES_TODO_EVENT, load)
    return () => {
      alive = false
      window.removeEventListener(NOTES_TODO_EVENT, load)
    }
  }, [])

  if (!count || count.open === 0) return null
  return (
    <Link
      href="/notes"
      title={count.overdue ? `${count.overdue} 项已过需完成日期` : '笔记里还没完成的事项'}
      className={`label tabular-nums hover:opacity-60 ${
        count.overdue ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink)]'
      }`}
    >
      待办 {count.open}
    </Link>
  )
}
