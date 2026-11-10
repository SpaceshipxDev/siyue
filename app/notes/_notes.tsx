'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { DatePop } from '@/app/_datepop'
import { NOTES_TODO_EVENT } from '@/app/_notes_todo'
import { parseNoteBody, serializeNoteBody } from '@/lib/data'
import type { Note, NoteFields } from '@/lib/data'
import { today } from '@/lib/today'

// 笔记 — 每条是一件事项: 左边一个圈勾完成, 写事项, 下面一行写开展进度,
// 底下是记录日期和需完成日期。没完成的都算「待办」, 顶栏名字旁边跟着显示
// 几项。打开就有一张空白在最上面 —— 来了就写, 离开输入框就存; 什么都没写
// (或者只有空格) 就不会生出一条。只看得到自己的 (页面已经按人过滤)。
//
// 排序只在进页面时排一次: 待办按需完成日期从近到远 (没定日期的在后), 已完成
// 的收在最底下「已完成 N 项」里。这一屏里勾来勾去不挪位置, 免得点着点着跑了。

type Card = { key: string; note: Note | null; doneOnArrival: boolean }

const isOpen = (f: NoteFields) => !f.doneAt && f.text.trim() !== ''

export function NotesBoard({ initial }: { initial: Note[] }) {
  const [cards, setCards] = useState<Card[]>(() => {
    const parsed = initial.map((n) => ({ n, f: parseNoteBody(n.body) }))
    const open = parsed
      .filter((p) => !p.f.doneAt)
      .sort((a, b) => (a.f.due || '9999').localeCompare(b.f.due || '9999'))
    const done = parsed
      .filter((p) => p.f.doneAt)
      .sort((a, b) => b.f.doneAt.localeCompare(a.f.doneAt))
    return [
      { key: 'draft-0', note: null, doneOnArrival: false },
      ...[...open, ...done].map((p) => ({
        key: p.n.id,
        note: p.n,
        doneOnArrival: !!p.f.doneAt,
      })),
    ]
  })
  // Live fields per card, only for the counts up top.
  const [fields, setFields] = useState<Record<string, NoteFields>>(() =>
    Object.fromEntries(initial.map((n) => [n.id, parseNoteBody(n.body)])),
  )
  const [showDone, setShowDone] = useState(false)
  const draftSeq = useRef(1)
  const [, start] = useTransition()

  const addDraft = () => {
    setCards((prev) => [
      { key: `draft-${draftSeq.current++}`, note: null, doneOnArrival: false },
      ...prev,
    ])
  }

  // First non-whitespace commit turned the draft into a real row; remember
  // the note so delete knows about it. The card itself never remounts (key is
  // stable), so the caret stays put mid-typing.
  const created = (key: string, note: Note) => {
    setCards((prev) => prev.map((c) => (c.key === key ? { ...c, note } : c)))
  }

  const remove = (key: string) => {
    const id = cards.find((c) => c.key === key)?.note?.id
    setCards((prev) => prev.filter((c) => c.key !== key))
    setFields((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    if (!id) return // unsaved draft — nothing on the server to delete
    start(async () => {
      try {
        await mutate({ kind: 'deleteNote', noteId: id })
        window.dispatchEvent(new Event(NOTES_TODO_EVENT))
      } catch (e) {
        showToast(`删除失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
      }
    })
  }

  const t = today()
  const live = Object.values(fields).filter(isOpen)
  const openCount = live.length
  const overdueCount = live.filter((f) => f.due && f.due < t).length
  const active = cards.filter((c) => !c.doneOnArrival)
  const done = cards.filter((c) => c.doneOnArrival)

  const render = (c: Card) => (
    <NoteCard
      key={c.key}
      note={c.note}
      autoFocus={c.note === null}
      onCreated={(note) => created(c.key, note)}
      onRemove={() => remove(c.key)}
      onFields={(f) => setFields((prev) => ({ ...prev, [c.key]: f }))}
    />
  )

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <p className="text-[13px] text-[var(--color-ink-3)] tabular-nums">
          {openCount} 项待办
          {overdueCount > 0 && (
            <span className="text-[var(--color-overdue)]"> · {overdueCount} 项逾期</span>
          )}
        </p>
        <button
          type="button"
          onClick={addDraft}
          className="rounded-[2px] bg-[var(--color-ink)] px-4 py-1.5 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 transition-opacity"
        >
          新建笔记
        </button>
      </div>

      <div className="flex flex-col gap-4">{active.map(render)}</div>

      {done.length > 0 && (
        <div className="mt-10">
          <button
            type="button"
            onClick={() => setShowDone((v) => !v)}
            className="text-[13px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] tabular-nums"
          >
            已完成 {done.length} 项 {showDone ? '▴' : '▾'}
          </button>
          {showDone && <div className="mt-4 flex flex-col gap-4">{done.map(render)}</div>}
        </div>
      )}
    </div>
  )
}

function NoteCard({
  note,
  autoFocus,
  onCreated,
  onRemove,
  onFields,
}: {
  note: Note | null // null = draft, not yet a row
  autoFocus: boolean
  onCreated: (note: Note) => void
  onRemove: () => void
  onFields: (f: NoteFields) => void
}) {
  const [f, setF] = useState<NoteFields>(() => parseNoteBody(note?.body ?? ''))
  const [createdAt, setCreatedAt] = useState(note?.createdAt ?? null)
  // id / saved / latest live in refs, not state: commit reads them
  // synchronously, and a save in flight must queue (not drop) the next one.
  const idRef = useRef<string | null>(note?.id ?? null)
  const savedRef = useRef(note?.body ?? '')
  const latest = useRef(f)
  const busy = useRef(false)
  const again = useRef(false)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const progRef = useRef<HTMLTextAreaElement>(null)
  const [, start] = useTransition()
  const [confirming, setConfirming] = useState(false)

  // Grow to fit content (Apple-Notes feel), and focus a fresh draft.
  const autosize = (el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }
  useEffect(() => {
    autosize(textRef.current)
    autosize(progRef.current)
    if (autoFocus) textRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const commit = () => {
    if (busy.current) {
      again.current = true
      return
    }
    const next = latest.current
    const body = serializeNoteBody(next)
    const id = idRef.current
    // Saved already — or a draft with no 事项 yet, which never becomes a row.
    if (id ? body === savedRef.current : !next.text.trim()) return
    busy.current = true
    start(async () => {
      try {
        if (id) {
          await mutate({ kind: 'updateNote', noteId: id, body })
        } else {
          const res = await mutate<{ id: string }>({ kind: 'createNote', body })
          idRef.current = res.data.id
          const now = new Date().toISOString()
          setCreatedAt(now)
          onCreated({ id: res.data.id, authorId: '', body, createdAt: now, updatedAt: now })
        }
        savedRef.current = body
        window.dispatchEvent(new Event(NOTES_TODO_EVENT))
      } catch (e) {
        showToast(`保存失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')
      } finally {
        busy.current = false
        if (again.current) {
          again.current = false
          commit()
        }
      }
    })
  }

  // save=true for one-tap changes (勾完成, 选日期); typing saves on blur.
  const edit = (patch: Partial<NoteFields>, save = false) => {
    const next = { ...latest.current, ...patch }
    latest.current = next
    setF(next)
    onFields(next)
    if (save) commit()
  }

  const done = !!f.doneAt
  const canTick = f.text.trim() !== ''
  const t = today()

  return (
    <div className="flex gap-3 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-colors focus-within:border-[var(--color-border-strong)]">
      <button
        type="button"
        disabled={!canTick}
        onClick={() => edit({ doneAt: done ? '' : t }, true)}
        title={done ? '改回没完成' : '完成'}
        aria-label={done ? '改回没完成' : '完成'}
        className={`mt-[3px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-40 ${
          done
            ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-surface)]'
            : 'border-[var(--color-ink-4)] hover:border-[var(--color-ink)]'
        }`}
      >
        {done && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <path d="M2 5.2 4.1 7.3 8 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <textarea
          ref={textRef}
          value={f.text}
          onChange={(e) => {
            edit({ text: e.target.value })
            autosize(e.target)
          }}
          onBlur={commit}
          rows={1}
          placeholder="事项…"
          spellCheck={false}
          className={`block w-full resize-none overflow-hidden bg-transparent text-[14px] leading-relaxed outline-none placeholder:text-[var(--color-ink-4)] ${
            done ? 'text-[var(--color-ink-3)]' : 'text-[var(--color-ink)]'
          }`}
        />
        <textarea
          ref={progRef}
          value={f.progress}
          onChange={(e) => {
            edit({ progress: e.target.value })
            autosize(e.target)
          }}
          onBlur={commit}
          rows={1}
          placeholder="开展进度…"
          spellCheck={false}
          className="mt-1 block w-full resize-none overflow-hidden bg-transparent text-[13px] leading-relaxed text-[var(--color-ink-2)] outline-none placeholder:text-[var(--color-ink-4)]"
        />

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="mono text-[11px] text-[var(--color-ink-4)]">
            {createdAt ? `记于 ${dayLabel(shDay(createdAt))}` : '草稿'}
          </span>
          <span className="flex items-center gap-1 text-[11px] text-[var(--color-ink-4)]">
            需完成
            <DatePop
              value={f.due}
              onChange={(d) => edit({ due: d }, true)}
              placeholder="定日期"
              formatLabel={dayLabel}
              hideIcon
              clearable
              triggerClass="text-[11px]"
              tone={!done && f.due && f.due < t ? 'text-[var(--color-overdue)]' : undefined}
            />
          </span>
          <span className="mono text-[11px]">
            {done ? (
              <span className="text-[var(--color-success)]">{dayLabel(f.doneAt)} 完成</span>
            ) : (
              f.due && <DueHint due={f.due} today={t} />
            )}
          </span>

          <span className="ml-auto">
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
          </span>
        </div>
      </div>
    </div>
  )
}

function DueHint({ due, today: t }: { due: string; today: string }) {
  const days = Math.round((Date.parse(due) - Date.parse(t)) / 86_400_000)
  if (days < 0) return <span className="text-[var(--color-overdue)]">逾期 {-days} 天</span>
  if (days === 0) return <span className="text-[var(--color-warning)]">今天到期</span>
  return <span className="text-[var(--color-ink-3)]">还剩 {days} 天</span>
}

// ISO instant → its factory-local day, 'YYYY-MM-DD'.
function shDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
}

// 'YYYY-MM-DD' → 'M月D日' (年份不是今年才带上).
function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  if (!y || !m || !d) return ''
  const label = `${m}月${d}日`
  return String(y) === today().slice(0, 4) ? label : `${y}年${label}`
}
