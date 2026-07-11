'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { STAGES } from '@/lib/data'
import type { Handover } from '@/lib/data'

type JobIndexEntry = { id: string; jobNo: string; product: string }

// 交接 = one job, handed by one person, to a department and/or a specific
// person, with a note. Read it as a sentence:
//   「小明 交给 财务 小李 · 工号 240511 · 备注…」
// No shift / 移交 / 接班 jargon — the 部门 is a chip you tap and the 谁 is a
// name you pick.
//
// These are the departments a job can land on. Production stations (STAGES)
// plus the cross-floor functions a job gets pushed to (商务 / 采购 / 财务 / 外协).
const DEPARTMENTS = ['商务', ...STAGES, '采购', '财务', '外协'] as const

// Storage (no DB migration): the whole destination — 部门 and/or 谁 — lives in
// the single `receiver` column, encoded as `部门 ␁ 谁` (␁ = U+0001, never typed
// by a human). A plain string with no separator is department-only, so legacy
// records like receiver="财务" still decode correctly. The old `department`
// column (which held the giver's own stage) is left untouched and ignored, so
// it can never be misread as the recipient.
const TARGET_SEP = String.fromCharCode(1) // U+0001 unit separator

function encodeTarget(dept: string, person: string): string | undefined {
  const d = dept.trim()
  const p = person.trim()
  if (!d && !p) return undefined
  return p ? `${d}${TARGET_SEP}${p}` : d
}

function decodeTarget(receiver?: string): { dept: string; person: string } {
  if (!receiver) return { dept: '', person: '' }
  const i = receiver.indexOf(TARGET_SEP)
  if (i === -1) return { dept: receiver, person: '' }
  return { dept: receiver.slice(0, i), person: receiver.slice(i + 1) }
}

export function HandoverBoard({
  handovers,
  jobIndex,
  people,
  currentUser,
  today,
}: {
  handovers: Handover[]
  jobIndex: JobIndexEntry[]
  people: string[]
  currentUser: string
  today: string
}) {
  const router = useRouter()
  const [q, setQ] = useState('')
  // null = list view; 'new' = blank form; a Handover = editing that one.
  const [editing, setEditing] = useState<Handover | 'new' | null>(null)

  const jobByNo = useMemo(() => {
    const m = new Map<string, JobIndexEntry>()
    for (const j of jobIndex) m.set(j.jobNo, j)
    return m
  }, [jobIndex])

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase()
    if (!query) return handovers
    return handovers.filter((h) => {
      if (
        h.giver.toLowerCase().includes(query) ||
        // receiver carries both 部门 and 谁 (separator-encoded); a raw
        // substring match still finds either part.
        (h.receiver ?? '').toLowerCase().includes(query) ||
        h.date.includes(query)
      )
        return true
      return h.items.some(
        (it) =>
          (it.orderNo ?? '').toLowerCase().includes(query) ||
          (it.matter ?? '').toLowerCase().includes(query) ||
          (it.note ?? '').toLowerCase().includes(query),
      )
    })
  }, [handovers, q])

  if (editing !== null) {
    return (
      <HandoverForm
        initial={editing === 'new' ? null : editing}
        jobIndex={jobIndex}
        people={people}
        defaults={{ giver: currentUser, date: today }}
        onDone={() => {
          setEditing(null)
          router.refresh()
        }}
        onCancel={() => setEditing(null)}
      />
    )
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-6 flex items-center gap-4">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索 · 交出人 / 部门 / 工号"
          className="w-full max-w-xs rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
        />
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="ml-auto shrink-0 rounded-[2px] bg-[var(--color-ink)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85"
        >
          新建交接
        </button>
      </div>

      {filtered.length === 0 ? (
        <button
          type="button"
          onClick={() => (q ? undefined : setEditing('new'))}
          className="block w-full rounded-[2px] border border-dashed border-[var(--color-border)] py-20 text-center"
        >
          <p className="text-[13px] text-[var(--color-ink-3)]">
            {q ? '没有匹配的交接' : '还没有交接'}
          </p>
          {!q && (
            <p className="mt-1.5 text-[12px] text-[var(--color-ink-4)]">
              点这里，把一个工号交给一个部门
            </p>
          )}
        </button>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((h) => (
            <HandoverCard
              key={h.id}
              handover={h}
              jobByNo={jobByNo}
              onEdit={() => setEditing(h)}
              onDeleted={() => router.refresh()}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function HandoverCard({
  handover: h,
  jobByNo,
  onEdit,
  onDeleted,
}: {
  handover: Handover
  jobByNo: Map<string, JobIndexEntry>
  onEdit: () => void
  onDeleted: () => void
}) {
  const [pending, start] = useTransition()
  const [confirming, setConfirming] = useState(false)
  const { dept, person } = decodeTarget(h.receiver)

  function del() {
    start(async () => {
      await mutate({ kind: 'deleteHandover', handoverId: h.id })
      onDeleted()
    })
  }

  return (
    <div className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        {/* The sentence: 交出人 交给 部门 谁. Every word spelled out — no arrows.
            部门 is a chip; 谁 is a name. At least one is present. */}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <span className="text-[18px] font-medium text-[var(--color-ink)]">
            {h.giver || '—'}
          </span>
          <span className="text-[13px] text-[var(--color-ink-3)]">交给</span>
          {dept && (
            <span className="rounded-[2px] bg-[var(--color-ink)] px-2.5 py-1 text-[14px] font-medium text-[var(--color-surface)]">
              {dept}
            </span>
          )}
          {person && (
            <span className="text-[16px] font-medium text-[var(--color-ink)]">
              {person}
            </span>
          )}
          {!dept && !person && (
            <span className="rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-2.5 py-1 text-[14px] text-[var(--color-ink-4)]">
              未填
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {confirming ? (
            <>
              <button
                type="button"
                onClick={del}
                disabled={pending}
                className="rounded-[2px] px-2 py-1 text-[12px] font-medium text-[var(--color-overdue)] hover:bg-[var(--color-overdue-soft)] disabled:opacity-50"
              >
                确认删除
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-[2px] px-2 py-1 text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                取消
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onEdit}
                className="rounded-[2px] px-2 py-1 text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                编辑
              </button>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="rounded-[2px] px-2 py-1 text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-overdue)]"
              >
                删除
              </button>
            </>
          )}
        </div>
      </div>

      {/* The job(s) being handed over, each on its own line: 工号 + 备注. */}
      <div className="mt-3 flex flex-col gap-1.5">
        {h.items.length === 0 ? (
          <p className="text-[13px] text-[var(--color-ink-4)]">未填工号</p>
        ) : (
          h.items.map((it) => {
            const linkedId =
              it.jobId ?? (it.orderNo ? jobByNo.get(it.orderNo)?.id : undefined)
            const note = [it.matter, it.note].filter(Boolean).join(' · ')
            return (
              <div key={it.id} className="flex flex-wrap items-baseline gap-x-2.5">
                <span className="text-[12px] text-[var(--color-ink-3)]">工号</span>
                {it.orderNo ? (
                  linkedId ? (
                    <Link
                      href={`/jobs/${linkedId}`}
                      className="mono text-[14px] text-[var(--color-info)] hover:underline"
                    >
                      {it.orderNo}
                    </Link>
                  ) : (
                    <span className="mono text-[14px] text-[var(--color-ink)]">
                      {it.orderNo}
                    </span>
                  )
                ) : (
                  <span className="text-[14px] text-[var(--color-ink-4)]">—</span>
                )}
                {note && (
                  <span className="text-[13px] text-[var(--color-ink-2)]">
                    <span className="text-[var(--color-ink-4)]">备注 </span>
                    {note}
                  </span>
                )}
              </div>
            )
          })
        )}
      </div>

      <p className="mono mt-3 text-[11px] text-[var(--color-ink-4)]">{h.date}</p>
    </div>
  )
}

function HandoverForm({
  initial,
  jobIndex,
  people,
  defaults,
  onDone,
  onCancel,
}: {
  initial: Handover | null
  jobIndex: JobIndexEntry[]
  people: string[]
  defaults: { giver: string; date: string }
  onDone: () => void
  onCancel: () => void
}) {
  // The new model is one job per 交接, so the form edits a single job + note.
  // Legacy multi-item sheets collapse to their first item on edit.
  const first = initial?.items[0]
  const initialTarget = decodeTarget(initial?.receiver)
  const [giver, setGiver] = useState(initial?.giver ?? defaults.giver)
  // receiver(dept) = 部门 chip, person = 谁. Both ride in the receiver column
  // (separator-encoded on save). See storage note above.
  const [receiver, setReceiver] = useState(initialTarget.dept)
  const [person, setPerson] = useState(initialTarget.person)
  const [orderNo, setOrderNo] = useState(first?.orderNo ?? '')
  const [note, setNote] = useState(
    [first?.matter, first?.note].filter(Boolean).join(' · '),
  )
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const jobByNo = useMemo(() => {
    const m = new Map<string, JobIndexEntry>()
    for (const j of jobIndex) m.set(j.jobNo, j)
    return m
  }, [jobIndex])
  const trimmedOrderNo = orderNo.trim()
  const matchedProduct = trimmedOrderNo
    ? jobByNo.get(trimmedOrderNo)?.product
    : undefined

  function submit() {
    if (!giver.trim()) {
      setError('填一下交出人')
      return
    }
    if (!receiver.trim() && !person.trim()) {
      setError('选一个部门，或者填一下交给谁')
      return
    }
    if (!orderNo.trim()) {
      setError('填一下工号')
      return
    }
    setError(null)
    const target = encodeTarget(receiver, person)
    const items = [{ orderNo: orderNo.trim(), note: note.trim() || undefined }]
    start(async () => {
      try {
        if (initial) {
          // On edit, send null (not undefined) when the whole target is
          // cleared so it actually clears instead of keeping the old value.
          await mutate({
            kind: 'updateHandover',
            handoverId: initial.id,
            patch: {
              giver: giver.trim(),
              date: defaults.date,
              receiver: target ?? null,
              items,
            },
          })
        } else {
          await mutate({
            kind: 'createHandover',
            input: {
              giver: giver.trim(),
              date: defaults.date,
              receiver: target,
              items,
            },
          })
        }
        onDone()
      } catch (e) {
        setError(e instanceof Error ? e.message : '保存失败')
      }
    })
  }

  return (
    <div className="max-w-xl">
      <div className="mb-6 flex items-baseline justify-between">
        <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
          {initial ? '编辑交接' : '新建交接'}
        </h2>
        <button
          type="button"
          onClick={onCancel}
          className="text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
        >
          返回
        </button>
      </div>

      <div className="flex flex-col gap-6 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <Field label="交出人" hint="谁交出去的">
          <input
            value={giver}
            onChange={(e) => setGiver(e.target.value)}
            placeholder="姓名"
            className="w-full max-w-xs rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[15px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
          />
        </Field>

        <Field label="工号" hint="交哪个工号">
          <datalist id="handover-jobnos">
            {jobIndex.slice(0, 1000).map((j) => (
              <option key={j.id} value={j.jobNo}>
                {j.product}
              </option>
            ))}
          </datalist>
          <input
            value={orderNo}
            onChange={(e) => setOrderNo(e.target.value)}
            placeholder="工号"
            list="handover-jobnos"
            className="mono w-full max-w-xs rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[15px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
          />
          {matchedProduct && (
            <p className="mt-1.5 text-[12px] text-[var(--color-ink-3)]">
              {matchedProduct}
            </p>
          )}
        </Field>

        <Field label="交给哪个部门" hint="点一下 · 没有就跳过">
          <div className="flex flex-wrap gap-2">
            {DEPARTMENTS.map((d) => {
              const on = receiver === d
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => setReceiver(on ? '' : d)}
                  className={`rounded-[2px] px-3.5 py-2 text-[14px] font-medium transition-colors ${
                    on
                      ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
                      : 'border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-ink)]'
                  }`}
                >
                  {d}
                </button>
              )
            })}
          </div>
        </Field>

        <Field label="交给谁" hint="具体的人 · 没有就跳过">
          <datalist id="handover-people">
            {people.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <input
            value={person}
            onChange={(e) => setPerson(e.target.value)}
            placeholder="姓名"
            list="handover-people"
            className="w-full max-w-xs rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[15px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
          />
        </Field>

        <Field label="备注" hint="选填">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="要交代的事 · 可留空"
            className="w-full rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[15px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
          />
        </Field>

        {error && (
          <p className="text-[13px] text-[var(--color-overdue)]">{error}</p>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="rounded-[2px] bg-[var(--color-ink)] px-5 py-2 text-[14px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
          >
            {pending ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="text-[13px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-[14px] font-medium text-[var(--color-ink)]">
          {label}
        </span>
        {hint && (
          <span className="text-[12px] text-[var(--color-ink-4)]">{hint}</span>
        )}
      </div>
      {children}
    </div>
  )
}
