'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { EditableText } from '@/app/_editable'
import { SearchSelect } from '@/app/_search_select'
import { DEPARTMENTS, NO_DEPARTMENT } from '@/lib/payroll'
import type { DormEntry } from '@/lib/dorm'

// 住宿登记 — 谁住哪一间。
//
// 一人一行, 按宿舍号排, 所以同一间的人挨在一起 —— 这张表最常被问的就是"这间
// 住了谁"。四栏全部点着改: 换房间是常事, 改一个格子比删了重登快。
//
// 只读的人 (老板 / 财务 / 于海伟) 看到的是同一张表, 只是没有输入框和删除 —
// 与其做两套界面, 不如让同一张表在没有权限时安静下来。

const DEPT_OPTIONS = [...DEPARTMENTS, NO_DEPARTMENT]

const COLS = 'grid-cols-[minmax(0,1.1fr)_88px_96px_minmax(0,1.4fr)_36px]'

export function DormBoard({
  entries,
  roster,
  deptOf,
  canEdit,
}: {
  entries: DormEntry[]
  /** 人事名册 — 选人不用手打。 */
  roster: string[]
  /** 姓名 → 部门, 选了人自动带出来。 */
  deptOf: Record<string, string>
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [armDelete, setArmDelete] = useState<string | null>(null)

  // 记一行
  const [name, setName] = useState('')
  const [dept, setDept] = useState(NO_DEPARTMENT)
  const [room, setRoom] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const rooms = useMemo(
    () => new Set(entries.map((e) => e.room.trim()).filter(Boolean)).size,
    [entries],
  )

  function pick(n: string) {
    setName(n)
    setDept(deptOf[n] ?? NO_DEPARTMENT)
    setError(null)
  }

  function add() {
    if (!name.trim()) return setError('先选一个人')
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'addDormEntry',
          name: name.trim(),
          dept,
          room: room.trim(),
          note: note.trim() || undefined,
        })
        setName('')
        setDept(NO_DEPARTMENT)
        setRoom('')
        setNote('')
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '记不上')
      }
    })
  }

  async function patch(id: string, p: Record<string, string>) {
    await mutate({ kind: 'updateDormEntry', entryId: id, patch: p })
    router.refresh()
  }

  function remove(id: string) {
    start(async () => {
      try {
        await mutate({ kind: 'deleteDormEntry', entryId: id })
        setArmDelete(null)
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '删不掉', 'warning')
      }
    })
  }

  return (
    <div className="mx-auto max-w-4xl">
      {canEdit && (
        <div className="mb-4 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 md:px-5">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="w-[150px]">
              <SearchSelect
                options={roster.map((n) => ({ id: n, label: n }))}
                value={name}
                onChange={pick}
                placeholder="谁"
                searchPlaceholder="选人或直接输入姓名…"
                createLabel="员工"
                onCreate={pick}
                triggerLabel={
                  name && !roster.includes(name) ? name : undefined
                }
                triggerClass="w-full"
              />
            </div>
            <select
              value={dept}
              onChange={(e) => setDept(e.target.value)}
              className="mono h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[12.5px] text-[var(--color-ink)] outline-none focus:border-[var(--color-border-strong)]"
            >
              {DEPT_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <input
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              placeholder="宿舍号"
              onKeyDown={(e) => e.key === 'Enter' && add()}
              className="mono h-9 w-[110px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[12.5px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
            />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="备注 · 可空"
              onKeyDown={(e) => e.key === 'Enter' && add()}
              className="h-9 min-w-[140px] flex-1 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
            />
            <button
              type="button"
              onClick={add}
              disabled={pending}
              className="h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
            >
              登记
            </button>
          </div>
          {error && (
            <p className="mt-2 text-[12px] text-[var(--color-overdue)]">
              {error}
            </p>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-5 py-2.5">
          <span className="mono text-[13px] font-semibold text-[var(--color-ink)]">
            住宿 {entries.length} 人 · {rooms} 间
          </span>
        </div>

        <div
          className={`hidden ${COLS} items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid`}
        >
          <span className="label">姓名</span>
          <span className="label">部门</span>
          <span className="label">宿舍号</span>
          <span className="label">备注</span>
          <span />
        </div>

        {entries.length === 0 ? (
          <p className="px-5 py-10 text-center text-[13px] text-[var(--color-ink-3)]">
            {canEdit ? '还没有登记住宿的人' : '还没有住宿登记'}
          </p>
        ) : (
          entries.map((e) => (
            <div
              key={e.id}
              className={`grid ${COLS} items-center gap-3 border-b border-[var(--color-border)] px-4 py-2.5 last:border-b-0 md:px-5`}
            >
              {canEdit ? (
                <EditableText
                  value={e.name}
                  className="text-[14px] font-medium tracking-tight text-[var(--color-ink)]"
                  onSave={(v) => patch(e.id, { name: v })}
                />
              ) : (
                <span className="truncate text-[14px] font-medium tracking-tight text-[var(--color-ink)]">
                  {e.name}
                </span>
              )}

              {canEdit ? (
                <select
                  value={DEPT_OPTIONS.includes(e.dept) ? e.dept : NO_DEPARTMENT}
                  onChange={(ev) => {
                    patch(e.id, { dept: ev.target.value }).catch(() =>
                      showToast('改不上', 'warning'),
                    )
                  }}
                  className="mono w-full cursor-pointer appearance-none rounded-[2px] border-0 bg-transparent px-1 -mx-1 py-0.5 text-[12px] text-[var(--color-ink-2)] outline-none transition-colors hover:bg-[var(--color-active-bg)] focus:bg-[var(--color-active-bg)]"
                >
                  {DEPT_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="mono truncate text-[12px] text-[var(--color-ink-2)]">
                  {e.dept || '—'}
                </span>
              )}

              {canEdit ? (
                <EditableText
                  mono
                  value={e.room}
                  placeholder="—"
                  className="text-[12.5px] text-[var(--color-ink)]"
                  onSave={(v) => patch(e.id, { room: v })}
                />
              ) : (
                <span className="mono truncate text-[12.5px] text-[var(--color-ink)]">
                  {e.room || '—'}
                </span>
              )}

              {canEdit ? (
                <EditableText
                  value={e.note}
                  placeholder="备注…"
                  className="text-[12.5px] text-[var(--color-ink-2)]"
                  onSave={(v) => patch(e.id, { note: v })}
                />
              ) : (
                <span className="truncate text-[12.5px] text-[var(--color-ink-2)]">
                  {e.note || '—'}
                </span>
              )}

              <span className="text-right">
                {canEdit &&
                  (armDelete === e.id ? (
                    <button
                      type="button"
                      onClick={() => remove(e.id)}
                      disabled={pending}
                      className="text-[11.5px] font-medium text-[var(--color-overdue)] hover:underline disabled:opacity-50"
                    >
                      确认
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setArmDelete(e.id)}
                      className="text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                    >
                      删
                    </button>
                  ))}
              </span>
            </div>
          ))
        )}
      </div>

      <p className="mt-4 text-[12px] text-[var(--color-ink-3)]">
        {canEdit
          ? '按宿舍号排，同一间的人挨在一起。四栏都能点着改——换房间改一格就行。'
          : '这张表由人事采购登记维护。'}
      </p>
    </div>
  )
}
