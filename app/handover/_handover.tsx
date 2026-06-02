'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import type { Handover } from '@/lib/data'

type JobIndexEntry = { id: string; jobNo: string; product: string }

// One editable line of the form. `key` is a stable client id for React only —
// never sent to the server (item ids are minted server-side on replace).
type DraftItem = {
  key: string
  orderNo: string
  matter: string
  owner: string
  note: string
}

let keySeq = 0
function newKey(): string {
  return `k${keySeq++}`
}

function emptyItem(): DraftItem {
  return { key: newKey(), orderNo: '', matter: '', owner: '', note: '' }
}

type Draft = {
  giver: string
  department: string
  date: string
  reason: string
  receiver: string
  items: DraftItem[]
}

export function HandoverBoard({
  handovers,
  jobIndex,
  currentUser,
  department,
  today,
}: {
  handovers: Handover[]
  jobIndex: JobIndexEntry[]
  currentUser: string
  department: string
  today: string
}) {
  const router = useRouter()
  const [q, setQ] = useState('')
  // null = list view; 'new' = blank form; a Handover = editing that sheet.
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
        (h.receiver ?? '').toLowerCase().includes(query) ||
        (h.department ?? '').toLowerCase().includes(query) ||
        (h.reason ?? '').toLowerCase().includes(query) ||
        h.date.includes(query)
      )
        return true
      return h.items.some(
        (it) =>
          (it.orderNo ?? '').toLowerCase().includes(query) ||
          (it.matter ?? '').toLowerCase().includes(query) ||
          (it.owner ?? '').toLowerCase().includes(query) ||
          (it.note ?? '').toLowerCase().includes(query),
      )
    })
  }, [handovers, q])

  if (editing !== null) {
    return (
      <HandoverForm
        initial={editing === 'new' ? null : editing}
        jobIndex={jobIndex}
        defaults={{ giver: currentUser, department, date: today }}
        onDone={() => {
          setEditing(null)
          router.refresh()
        }}
        onCancel={() => setEditing(null)}
      />
    )
  }

  return (
    <div className="max-w-4xl">
      <div className="mb-6 flex items-center gap-4">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索 · 交出人 / 承接人 / 单号 / 事项"
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
        <div className="rounded-[2px] border border-dashed border-[var(--color-border)] py-20 text-center">
          <p className="text-[13px] text-[var(--color-ink-3)]">
            {q ? '没有匹配的交接单' : '尚无交接单'}
          </p>
          {!q && (
            <p className="mt-1.5 text-[11px] text-[var(--color-ink-4)]">
              交班 / 请假 / 休息前，把手头未完的工作交接清楚
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
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

  function del() {
    start(async () => {
      await mutate({ kind: 'deleteHandover', handoverId: h.id })
      onDeleted()
    })
  }

  return (
    <div className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <span className="flex items-baseline gap-1.5">
              <span className="label text-[var(--color-ink-3)]">交班</span>
              <span className="text-[14px] font-medium text-[var(--color-ink)]">
                {h.giver || '—'}
              </span>
            </span>
            <span className="text-[11px] text-[var(--color-ink-4)]">移交</span>
            <span className="flex items-baseline gap-1.5">
              <span className="label text-[var(--color-ink-3)]">接班</span>
              <span
                className={`text-[14px] font-medium ${
                  h.receiver
                    ? 'text-[var(--color-ink)]'
                    : 'text-[var(--color-ink-4)]'
                }`}
              >
                {h.receiver || '待承接'}
              </span>
            </span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-ink-3)]">
            <span className="mono">{h.date}</span>
            {h.department && <span>· {h.department}</span>}
            {h.reason && (
              <span className="text-[var(--color-ink-2)]">· {h.reason}</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {confirming ? (
            <>
              <button
                type="button"
                onClick={del}
                disabled={pending}
                className="rounded-[2px] px-2 py-1 text-[11px] font-medium text-[var(--color-overdue)] hover:bg-[var(--color-overdue-soft)] disabled:opacity-50"
              >
                确认删除
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-[2px] px-2 py-1 text-[11px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                取消
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onEdit}
                className="rounded-[2px] px-2 py-1 text-[11px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                编辑
              </button>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="rounded-[2px] px-2 py-1 text-[11px] text-[var(--color-ink-3)] hover:text-[var(--color-overdue)]"
              >
                删除
              </button>
            </>
          )}
        </div>
      </div>

      {h.items.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-[var(--color-ink-4)]">无事项</p>
      ) : (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.12em] text-[var(--color-ink-3)]">
              <th className="px-4 py-1.5 font-medium">单号</th>
              <th className="px-4 py-1.5 font-medium">相关事宜</th>
              <th className="w-24 px-4 py-1.5 font-medium">责任人</th>
              <th className="px-4 py-1.5 font-medium">备注</th>
            </tr>
          </thead>
          <tbody>
            {h.items.map((it) => {
              const linkedId =
                it.jobId ?? (it.orderNo ? jobByNo.get(it.orderNo)?.id : undefined)
              return (
                <tr
                  key={it.id}
                  className="border-t border-[var(--color-border)] align-top"
                >
                  <td className="px-4 py-2">
                    {it.orderNo ? (
                      linkedId ? (
                        <Link
                          href={`/jobs/${linkedId}`}
                          className="mono text-[12px] text-[var(--color-info)] hover:underline"
                        >
                          {it.orderNo}
                        </Link>
                      ) : (
                        <span className="mono text-[12px] text-[var(--color-ink-2)]">
                          {it.orderNo}
                        </span>
                      )
                    ) : (
                      <span className="text-[var(--color-ink-4)]">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-[var(--color-ink)]">
                    {it.matter || <span className="text-[var(--color-ink-4)]">—</span>}
                  </td>
                  <td className="px-4 py-2 text-[var(--color-ink-2)]">
                    {it.owner || <span className="text-[var(--color-ink-4)]">—</span>}
                  </td>
                  <td className="px-4 py-2 text-[var(--color-ink-2)]">
                    {it.note || <span className="text-[var(--color-ink-4)]">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

function HandoverForm({
  initial,
  jobIndex,
  defaults,
  onDone,
  onCancel,
}: {
  initial: Handover | null
  jobIndex: JobIndexEntry[]
  defaults: { giver: string; department: string; date: string }
  onDone: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<Draft>(() => {
    if (initial) {
      return {
        giver: initial.giver,
        department: initial.department ?? '',
        date: initial.date,
        reason: initial.reason ?? '',
        receiver: initial.receiver ?? '',
        items: [
          ...initial.items.map((it) => ({
            key: newKey(),
            orderNo: it.orderNo ?? '',
            matter: it.matter ?? '',
            owner: it.owner ?? '',
            note: it.note ?? '',
          })),
          emptyItem(),
        ],
      }
    }
    return {
      giver: defaults.giver,
      department: defaults.department,
      date: defaults.date,
      reason: '',
      receiver: '',
      items: [emptyItem()],
    }
  })
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof Draft>(k: K, v: Draft[K]) {
    setDraft((d) => ({ ...d, [k]: v }))
  }

  function setItem(key: string, field: keyof DraftItem, value: string) {
    setDraft((d) => {
      const items = d.items.map((it) =>
        it.key === key ? { ...it, [field]: value } : it,
      )
      // Auto-append a fresh trailing row when the last row gets any content,
      // so the form always has an empty slot to type into.
      const last = items[items.length - 1]
      if (last && (last.orderNo || last.matter || last.owner || last.note)) {
        items.push(emptyItem())
      }
      return { ...d, items }
    })
  }

  function removeItem(key: string) {
    setDraft((d) => {
      const items = d.items.filter((it) => it.key !== key)
      return { ...d, items: items.length ? items : [emptyItem()] }
    })
  }

  function submit() {
    if (!draft.giver.trim()) {
      setError('请填写交出人')
      return
    }
    if (!draft.date.trim()) {
      setError('请填写日期')
      return
    }
    setError(null)
    const items = draft.items
      .map((it) => ({
        orderNo: it.orderNo.trim() || undefined,
        matter: it.matter.trim() || undefined,
        owner: it.owner.trim() || undefined,
        note: it.note.trim() || undefined,
      }))
      .filter((it) => it.orderNo || it.matter || it.owner || it.note)
    const input = {
      giver: draft.giver.trim(),
      department: draft.department.trim() || undefined,
      date: draft.date.trim(),
      reason: draft.reason.trim() || undefined,
      receiver: draft.receiver.trim() || undefined,
      items,
    }
    start(async () => {
      try {
        if (initial) {
          await mutate({
            kind: 'updateHandover',
            handoverId: initial.id,
            patch: input,
          })
        } else {
          await mutate({ kind: 'createHandover', input })
        }
        onDone()
      } catch (e) {
        setError(e instanceof Error ? e.message : '保存失败')
      }
    })
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-6 flex items-baseline justify-between">
        <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
          {initial ? '编辑交接单' : '新建交接单'}
        </h2>
        <button
          type="button"
          onClick={onCancel}
          className="text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
        >
          返回
        </button>
      </div>

      <div className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="交出人">
            <TextInput
              value={draft.giver}
              onChange={(v) => set('giver', v)}
              placeholder="姓名"
            />
          </Field>
          <Field label="部门">
            <TextInput
              value={draft.department}
              onChange={(v) => set('department', v)}
              placeholder="工段 / 部门"
            />
          </Field>
          <Field label="日期">
            <TextInput
              value={draft.date}
              onChange={(v) => set('date', v)}
              placeholder="YYYY-MM-DD"
              mono
            />
          </Field>
          <Field label="交出原因">
            <TextInput
              value={draft.reason}
              onChange={(v) => set('reason', v)}
              placeholder="如 · 明日休息"
            />
          </Field>
          <Field label="承接人">
            <TextInput
              value={draft.receiver}
              onChange={(v) => set('receiver', v)}
              placeholder="代班人 · 可留空"
            />
          </Field>
        </div>

        <div className="mt-6">
          <p className="label mb-2">交接事项</p>
          <datalist id="handover-jobnos">
            {jobIndex.slice(0, 1000).map((j) => (
              <option key={j.id} value={j.jobNo}>
                {j.product}
              </option>
            ))}
          </datalist>
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.12em] text-[var(--color-ink-3)]">
                <th className="w-44 pb-1.5 font-medium">单号</th>
                <th className="pb-1.5 font-medium">相关事宜</th>
                <th className="w-24 pb-1.5 font-medium">责任人</th>
                <th className="pb-1.5 font-medium">备注</th>
                <th className="w-8 pb-1.5" />
              </tr>
            </thead>
            <tbody>
              {draft.items.map((it) => (
                <tr key={it.key} className="align-top">
                  <td className="py-1 pr-2">
                    <CellInput
                      value={it.orderNo}
                      onChange={(v) => setItem(it.key, 'orderNo', v)}
                      placeholder="工号"
                      list="handover-jobnos"
                      mono
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <CellInput
                      value={it.matter}
                      onChange={(v) => setItem(it.key, 'matter', v)}
                      placeholder="未完事项 / 注意点"
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <CellInput
                      value={it.owner}
                      onChange={(v) => setItem(it.key, 'owner', v)}
                      placeholder="负责人"
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <CellInput
                      value={it.note}
                      onChange={(v) => setItem(it.key, 'note', v)}
                      placeholder="备注"
                    />
                  </td>
                  <td className="py-1 text-center">
                    {draft.items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeItem(it.key)}
                        className="text-[15px] leading-none text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                        aria-label="删除此行"
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {error && (
          <p className="mt-4 text-[12px] text-[var(--color-overdue)]">{error}</p>
        )}

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="rounded-[2px] bg-[var(--color-ink)] px-4 py-1.5 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
          >
            {pending ? '保存中…' : '保存交接单'}
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
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="label mb-1.5">{label}</p>
      {children}
    </div>
  )
}

function TextInput({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)] ${
        mono ? 'mono' : ''
      }`}
    />
  )
}

function CellInput({
  value,
  onChange,
  placeholder,
  list,
  mono,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  list?: string
  mono?: boolean
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      list={list}
      className={`w-full rounded-[2px] border border-transparent bg-[var(--color-bg)] px-2 py-1.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)] ${
        mono ? 'mono' : ''
      }`}
    />
  )
}
