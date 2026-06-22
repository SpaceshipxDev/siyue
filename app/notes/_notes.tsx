'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import type { Note } from '@/lib/data'

// 笔记 — Apple-Notes-simple: a column of cards, each a freeform note that grows
// as you type and saves on blur. 新建 prepends a blank one. Nothing to learn —
// the boss just writes. Per-author (the page already scopes to him).

export function NotesBoard({ initial }: { initial: Note[] }) {
  const [notes, setNotes] = useState<Note[]>(initial)
  const [, start] = useTransition()

  const addNote = () => {
    start(async () => {
      try {
        const res = await mutate<{ id: string }>({ kind: 'createNote' })
        const now = new Date().toISOString()
        setNotes((prev) => [
          { id: res.data.id, authorId: '', body: '', createdAt: now, updatedAt: now },
          ...prev,
        ])
      } catch (e) {
        showToast(`新建失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
      }
    })
  }

  const remove = (id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id))
    start(async () => {
      try {
        await mutate({ kind: 'deleteNote', noteId: id })
      } catch (e) {
        showToast(`删除失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
      }
    })
  }

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <p className="text-[13px] text-[var(--color-ink-3)] tabular-nums">
          {notes.length} 条笔记
        </p>
        <button
          type="button"
          onClick={addNote}
          className="rounded-[2px] bg-[var(--color-ink)] px-4 py-1.5 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 transition-opacity"
        >
          新建笔记
        </button>
      </div>

      {notes.length === 0 ? (
        <div className="py-24 text-center text-[14px] text-[var(--color-ink-4)]">
          还没有笔记 · 点「新建笔记」随手记点什么
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {notes.map((n) => (
            <NoteCard
              key={n.id}
              note={n}
              autoFocus={n.body === ''}
              onRemove={() => remove(n.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function NoteCard({
  note,
  autoFocus,
  onRemove,
}: {
  note: Note
  autoFocus: boolean
  onRemove: () => void
}) {
  const [body, setBody] = useState(note.body)
  const [saved, setSaved] = useState(note.body)
  const ref = useRef<HTMLTextAreaElement>(null)
  const [, start] = useTransition()
  const [confirming, setConfirming] = useState(false)

  // Grow to fit content (Apple-Notes feel), and focus a freshly-created card.
  const autosize = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }
  useEffect(() => {
    autosize()
    if (autoFocus) ref.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const commit = () => {
    if (body === saved) return
    const prev = saved
    setSaved(body)
    start(async () => {
      try {
        await mutate({ kind: 'updateNote', noteId: note.id, body })
      } catch (e) {
        showToast(`保存失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
        setSaved(prev)
      }
    })
  }

  return (
    <div className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-colors focus-within:border-[var(--color-border-strong)]">
      <textarea
        ref={ref}
        value={body}
        onChange={(e) => {
          setBody(e.target.value)
          autosize()
        }}
        onBlur={commit}
        rows={2}
        placeholder="随手记…"
        spellCheck={false}
        className="block w-full resize-none overflow-hidden bg-transparent text-[14px] leading-relaxed text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)]"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="mono text-[11px] text-[var(--color-ink-4)]">
          {dateLabel(note.updatedAt)}
        </span>
        {confirming ? (
          <span className="flex items-center gap-3">
            <button
              type="button"
              onClick={onRemove}
              className="text-[12px] text-[var(--color-overdue)] hover:underline underline-offset-2"
            >
              确认删除
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            >
              取消
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-[12px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)] transition-colors"
          >
            删除
          </button>
        )}
      </div>
    </div>
  )
}

// ISO → 'M月D日 HH:mm' in factory-local time.
function dateLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
