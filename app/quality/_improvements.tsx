'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { EditableTextArea } from '@/app/_editable'
import type { Improvement } from '@/lib/improvements'

// 改善建议 — 质量模块唯一一张不是记问题的表。
//
// 另外三张回答"哪里坏了、谁的责任、赔了多少"; 这一张回答"怎么才能不再这样"。
// 提报对全厂的账号开着 —— 看得见问题的是站在机床边上的那个人, 让他等一个有
// 权限的人来代录, 就是让这条建议不存在。
//
// 一条建议不是一行数, 是一段话: 建议是什么、改善前什么样、改善后什么样、对
// 效率/质量/成本有什么影响。所以这里不排成八列窄格子 (那样每一列都读不成句),
// 而是一条一块 —— 上面一行是"谁提了什么", 下面四格是前后和影响。每一格都点
// 得开: 还空着的谁都填得上, 填过的要改是工程和商务于海伟那一档。

const MONTHS = [
  '01', '02', '03', '04', '05', '06',
  '07', '08', '09', '10', '11', '12',
]

export function ImprovementsBoard({
  rows,
  todayStr,
  defaultReporter,
  defaultDept,
  depts,
  canEdit,
}: {
  rows: Improvement[]
  todayStr: string
  /** 登录的人 / 他的部门 — 录入行的默认值, 车间共用账号可以改掉。 */
  defaultReporter: string
  defaultDept: string
  /** 已经提过的部门 — 输入时的建议, 免得同一个工段写出三种写法。 */
  depts: string[]
  /**
   * 改已经填下去的东西 / 删一条 — 工程 + 商务于海伟。
   * 提一条、补一个还空着的格, 有账号的人都可以, 不看这个。
   */
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [month, setMonth] = useState(todayStr.slice(5, 7))
  const [q, setQ] = useState('')
  const [armDelete, setArmDelete] = useState<string | null>(null)
  const year = todayStr.slice(0, 4)

  // 提一条
  const [date, setDate] = useState(todayStr)
  const [reporter, setReporter] = useState(defaultReporter)
  const [dept, setDept] = useState(defaultDept)
  const [suggestion, setSuggestion] = useState('')
  const [before, setBefore] = useState('')
  const [after, setAfter] = useState('')
  const [impact, setImpact] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const monthRows = useMemo(() => {
    const ym = `${year}-${month}`
    const needle = q.trim().toLowerCase()
    return rows
      .filter((r) => r.date.slice(0, 7) === ym)
      .filter((r) =>
        !needle
          ? true
          : [
              r.reporter,
              r.dept,
              r.suggestion,
              r.before,
              r.after,
              r.impact,
              r.note,
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(needle),
      )
  }, [rows, year, month, q])

  // 这个月有几个部门提了 — 改善建议这种表, 沉默的部门比条数更说明问题。
  const deptCount = useMemo(
    () => new Set(monthRows.map((r) => r.dept).filter(Boolean)).size,
    [monthRows],
  )

  function add() {
    if (!reporter.trim()) return setError('先填提报人')
    if (!suggestion.trim()) return setError('写一下改善建议')
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'addImprovement',
          input: {
            date,
            reporter: reporter.trim(),
            dept: dept.trim(),
            suggestion: suggestion.trim(),
            before: before.trim(),
            after: after.trim(),
            impact: impact.trim(),
            note: note.trim(),
          },
        })
        setSuggestion('')
        setBefore('')
        setAfter('')
        setImpact('')
        setNote('')
        setDate(todayStr)
        setMonth(date.slice(5, 7))
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '提不上')
      }
    })
  }

  async function patch(id: string, p: Record<string, unknown>) {
    await mutate({ kind: 'updateImprovement', improvementId: id, patch: p })
    router.refresh()
  }

  function remove(id: string) {
    start(async () => {
      try {
        await mutate({ kind: 'deleteImprovement', improvementId: id })
        setArmDelete(null)
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '删不掉', 'warning')
      }
    })
  }

  const inp =
    'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'

  const exportHref = `/quality/export?v=improve&m=${year}-${month}${
    q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''
  }`

  return (
    <div>
      <div className="mb-5 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 md:px-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            type="date"
            value={date}
            max={todayStr}
            onChange={(e) => setDate(e.target.value || todayStr)}
            className={`mono ${inp}`}
          />
          <input
            value={reporter}
            onChange={(e) => setReporter(e.target.value)}
            placeholder="提报人"
            className={`${inp} w-[104px]`}
          />
          <input
            value={dept}
            onChange={(e) => setDept(e.target.value)}
            placeholder="提报部门"
            list="improvement-depts"
            className={`${inp} w-[104px]`}
          />
          <datalist id="improvement-depts">
            {depts.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
          <input
            value={suggestion}
            onChange={(e) => setSuggestion(e.target.value)}
            placeholder="改善建议"
            className={`${inp} min-w-[200px] flex-1`}
          />
          <input
            value={before}
            onChange={(e) => setBefore(e.target.value)}
            placeholder="改善前"
            className={`${inp} min-w-[140px] flex-1`}
          />
          <input
            value={after}
            onChange={(e) => setAfter(e.target.value)}
            placeholder="改善后"
            className={`${inp} min-w-[140px] flex-1`}
          />
          <input
            value={impact}
            onChange={(e) => setImpact(e.target.value)}
            placeholder="对效率·质量·成本的影响"
            className={`${inp} min-w-[180px] flex-1`}
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="备注 · 可空"
            onKeyDown={(e) => e.key === 'Enter' && add()}
            className={`${inp} min-w-[120px] flex-1`}
          />
          <button
            type="button"
            onClick={add}
            disabled={pending}
            className="h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
          >
            提交
          </button>
        </div>
        {error && (
          <p className="mt-2 text-[12px] text-[var(--color-overdue)]">
            {error}
          </p>
        )}
      </div>

      <div className="mb-6 flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <p className="text-[32px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">
            {monthRows.length}
          </p>
          <p className="label mt-2.5">{Number(month)}月改善建议</p>
        </div>
        <div>
          <p className="text-[22px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink-2)]">
            {deptCount}
          </p>
          <p className="label mt-2.5">提报部门</p>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索 · 提报人 / 部门 / 建议"
            className="h-9 w-[210px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
          />
          {canEdit && (
            <Link
              href={exportHref}
              prefetch={false}
              className="rounded-[2px] border border-[var(--color-border)] px-3.5 py-2 text-[13px] font-medium text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)]"
            >
              导出
            </Link>
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {MONTHS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMonth(m)}
            className={`rounded-[2px] border bg-[var(--color-surface)] px-2.5 py-1 text-[12.5px] font-medium ${
              m === month
                ? 'border-[var(--color-ink)] text-[var(--color-ink)] shadow-[inset_0_0_0_1px_var(--color-ink)]'
                : 'border-[var(--color-border)] text-[var(--color-ink-3)] hover:border-[var(--color-border-strong)]'
            }`}
          >
            {Number(m)}月
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        {monthRows.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {q ? '没有匹配的建议' : '这个月还没有人提改善建议'}
          </p>
        ) : (
          monthRows.map((r) => (
            <div
              key={r.id}
              className="border-b border-[var(--color-border)] px-4 py-3.5 last:border-b-0 hover:bg-[#faf8f2] md:px-5"
            >
              <div className="flex items-start gap-3">
                <span className="mono shrink-0 pt-0.5 text-[12.5px] tabular-nums text-[var(--color-ink-3)]">
                  {r.date.slice(5)}
                </span>
                <span className="min-w-0 flex-1">
                  <Cell
                    canEdit={canEdit || !r.suggestion}
                    value={r.suggestion}
                    strong
                    onSave={(v) => patch(r.id, { suggestion: v })}
                  />
                </span>
                <span className="w-[88px] shrink-0">
                  <Cell
                    canEdit={canEdit || !r.reporter}
                    value={r.reporter}
                    onSave={(v) => patch(r.id, { reporter: v })}
                  />
                </span>
                <span className="w-[76px] shrink-0">
                  <Cell
                    canEdit={canEdit || !r.dept}
                    value={r.dept}
                    placeholder="部门"
                    onSave={(v) => patch(r.id, { dept: v })}
                  />
                </span>
                <span className="w-5 shrink-0 pt-0.5 text-right">
                  {canEdit &&
                    (armDelete === r.id ? (
                      <button
                        type="button"
                        onClick={() => remove(r.id)}
                        disabled={pending}
                        className="text-[11.5px] font-medium text-[var(--color-overdue)] hover:underline disabled:opacity-50"
                      >
                        确认
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setArmDelete(r.id)}
                        className="text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                      >
                        删
                      </button>
                    ))}
                </span>
              </div>
              <div className="mt-2 grid gap-x-8 gap-y-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)]">
                <Field
                  label="改善前"
                  canEdit={canEdit || !r.before}
                  value={r.before}
                  onSave={(v) => patch(r.id, { before: v })}
                />
                <Field
                  label="改善后"
                  canEdit={canEdit || !r.after}
                  value={r.after}
                  onSave={(v) => patch(r.id, { after: v })}
                />
                <Field
                  label="效率·质量·成本"
                  canEdit={canEdit || !r.impact}
                  value={r.impact}
                  onSave={(v) => patch(r.id, { impact: v })}
                />
                <Field
                  label="备注"
                  canEdit={canEdit || !r.note}
                  value={r.note}
                  onSave={(v) => patch(r.id, { note: v })}
                />
              </div>
            </div>
          ))
        )}
      </div>

      <p className="mt-4 text-[12px] text-[var(--color-ink-3)]">
        谁都能提——提报人和部门先按登录的人填好了，替别人提就改掉。改善前后和影
        响想好了再回来补，还空着的格谁都填得上；填过的要改，找工程或于海伟。
      </p>
    </div>
  )
}

// 下面那四格 — 小标题 + 内容, 空的显示占位, 点开就能写。
function Field({
  label,
  canEdit,
  value,
  onSave,
}: {
  label: string
  canEdit: boolean
  value: string
  onSave: (v: string) => Promise<void>
}) {
  return (
    <div className="min-w-0">
      <p className="label">{label}</p>
      <div className="mt-0.5">
        <Cell
          canEdit={canEdit}
          value={value}
          placeholder="—"
          onSave={onSave}
        />
      </div>
    </div>
  )
}

function Cell({
  canEdit,
  value,
  onSave,
  strong,
  placeholder = '—',
}: {
  canEdit: boolean
  value?: string
  onSave: (v: string) => Promise<void>
  strong?: boolean
  placeholder?: string
}) {
  const cls = strong
    ? 'text-[13.5px] font-medium tracking-tight text-[var(--color-ink)]'
    : 'text-[12.5px] text-[var(--color-ink-2)]'
  if (!canEdit) {
    return (
      <span className={`block break-words ${cls}`}>{value || placeholder}</span>
    )
  }
  // 会自己长高的多行框 —— 一条建议本来就是一段话, 写多长就显多长。
  return (
    <EditableTextArea
      value={value}
      placeholder={placeholder}
      className={cls}
      onSave={onSave}
    />
  )
}
