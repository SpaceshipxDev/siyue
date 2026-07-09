'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import type { Note } from '@/lib/data'

// 笔记 — Apple-Notes-simple: a column of cards, each a freeform note that grows
// as you type and saves on blur. A fresh draft is already open at the top on
// every landing — you arrive, you type, it saves. The draft lives only on this
// screen until real text is committed: nothing typed (or whitespace only)
// means no row is ever created. Per-author (the page already scopes).

type Card = { key: string; note: Note | null } // note null = local draft

export function NotesBoard({ initial }: { initial: Note[] }) {
  const [cards, setCards] = useState<Card[]>(() => [
    { key: 'draft-0', note: null },
    ...initial.map((n) => ({ key: n.id, note: n })),
  ])
  const draftSeq = useRef(1)
  const [, start] = useTransition()

  const addDraft = () => {
    setCards((prev) => [
      { key: `draft-${draftSeq.current++}`, note: null },
      ...prev,
    ])
  }

  // First non-whitespace commit turned the draft into a real row; remember
  // the note so the counter and delete know about it. The card itself never
  // remounts (key is stable), so the caret stays put mid-typing.
  const created = (key: string, note: Note) => {
    setCards((prev) => prev.map((c) => (c.key === key ? { ...c, note } : c)))
  }

  const remove = (key: string) => {
    const id = cards.find((c) => c.key === key)?.note?.id
    setCards((prev) => prev.filter((c) => c.key !== key))
    if (!id) return // unsaved draft — nothing on the server to delete
    start(async () => {
      try {
        await mutate({ kind: 'deleteNote', noteId: id })
      } catch (e) {
        showToast(`删除失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
      }
    })
  }

  const savedCount = cards.filter((c) => c.note).length

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <p className="text-[13px] text-[var(--color-ink-3)] tabular-nums">
          {savedCount} 条笔记
        </p>
        <button
          type="button"
          onClick={addDraft}
          className="rounded-[2px] bg-[var(--color-ink)] px-4 py-1.5 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 transition-opacity"
        >
          新建笔记
        </button>
      </div>

      <div className="flex flex-col gap-4">
        {cards.map((c) => (
          <NoteCard
            key={c.key}
            note={c.note}
            autoFocus={c.note === null}
            onCreated={(note) => created(c.key, note)}
            onRemove={() => remove(c.key)}
          />
        ))}
      </div>
    </div>
  )
}

function NoteCard({
  note,
  autoFocus,
  onCreated,
  onRemove,
}: {
  note: Note | null // null = draft, not yet a row
  autoFocus: boolean
  onCreated: (note: Note) => void
  onRemove: () => void
}) {
  const [body, setBody] = useState(note?.body ?? '')
  const [stamp, setStamp] = useState(note?.updatedAt ?? null)
  // id/saved live in refs, not state: commit reads them synchronously and a
  // create in flight must block a second create without re-rendering.
  const idRef = useRef<string | null>(note?.id ?? null)
  const savedRef = useRef(note?.body ?? '')
  const creating = useRef(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const [, start] = useTransition()
  const [confirming, setConfirming] = useState(false)

  // Grow to fit content (Apple-Notes feel), and focus a fresh draft.
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
    const text = body
    const id = idRef.current
    if (id) {
      if (text === savedRef.current) return
      start(async () => {
        try {
          await mutate({ kind: 'updateNote', noteId: id, body: text })
          savedRef.current = text
          setStamp(new Date().toISOString())
        } catch (e) {
          showToast(`保存失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
        }
      })
      return
    }
    // Draft: nothing typed (or whitespace only) never becomes a row.
    if (!text.trim() || creating.current) return
    creating.current = true
    start(async () => {
      try {
        const res = await mutate<{ id: string }>({ kind: 'createNote', body: text })
        idRef.current = res.data.id
        savedRef.current = text
        const now = new Date().toISOString()
        setStamp(now)
        onCreated({
          id: res.data.id,
          authorId: '',
          body: text,
          createdAt: now,
          updatedAt: now,
        })
      } catch (e) {
        showToast(`保存失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
      } finally {
        creating.current = false
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
          {stamp ? dateLabel(stamp) : '草稿'}
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
