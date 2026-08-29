'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { SearchSelect } from '@/app/_search_select'
import { HR_TYPES, hrHasHours } from '@/lib/data'
import type { HrRecord, HrType } from '@/lib/data'

// 人事 — one screen, two halves.
//
// Top: 记一笔. Pick the person, tap what happened, and it's filed against
// today. Nothing else is required — a 迟到 is a fact, not a form — and the
// 说明 line is there for the times it needs one. 当日提交 is the default
// rather than a rule: the 日期 stays editable so yesterday's 旷工 can still
// be entered this morning, and it always books into the month it happened in.
//
// The 谁 picker offers system accounts AND every name 人事 has been told to
// remember — type a name that isn't there, file the record, and that person is
// in the picker from then on. Half the floor shares a station account or has
// no login at all, so the account list was never the shop's roster.
//
// Bottom: 一人一行 for the chosen 月 or 年 — one column per kind, ordered by
// whoever has the most to answer for. The four absence kinds read in hours
// (事假 16h), because hours are what payroll deducts from; 迟到 / 违纪 /
// 重大质量异常 read as a count, because a 迟到 is a 迟到 whether it was five
// minutes or fifty. 请假共 adds 事假 + 病假 + 工伤 into the one number the
// month actually gets settled on. Click a name to read that person's actual
// lines. Nobody with a clean record appears; the table is the exception list.

export function HrBoard({
  records,
  period,
  months,
  roster,
  canDelete,
  today,
}: {
  records: HrRecord[]
  period: string
  months: string[]
  roster: string[]
  canDelete: boolean
  today: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()

  const [name, setName] = useState('')
  const [type, setType] = useState<HrType>('事假')
  const [date, setDate] = useState(today)
  const [hours, setHours] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [openName, setOpenName] = useState<string | null>(null)

  const isYear = period.length === 4
  const year = period.slice(0, 4)

  // The periods worth offering: every month that has something in it, plus
  // the one we're standing in (so a fresh month is reachable before its first
  // record exists).
  const monthOptions = useMemo(() => {
    const s = new Set(months)
    s.add(today.slice(0, 7))
    return [...s].sort().reverse()
  }, [months, today])

  const years = useMemo(() => {
    const s = new Set(monthOptions.map((m) => m.slice(0, 4)))
    return [...s].sort().reverse()
  }, [monthOptions])

  // 一人一行, with the count of each type. Sorted by total desc so whoever
  // needs a conversation is at the top.
  const rows = useMemo(() => {
    const by = new Map<string, HrRecord[]>()
    for (const r of records) {
      const l = by.get(r.name) ?? []
      l.push(r)
      by.set(r.name, l)
    }
    return [...by.entries()]
      .map(([person, list]) => ({
        name: person,
        list,
        cells: HR_TYPES.map((t) => {
          const of = list.filter((r) => r.type === t)
          if (of.length === 0) return ''
          if (!hrHasHours(t)) return String(of.length)
          const h = of.reduce((sum, r) => sum + (r.hours ?? 0), 0)
          // Records filed before 时长 was required carry none — they still
          // have to show that something happened, so they read as a count.
          return h > 0 ? `${trimNum(h)}h` : `${of.length}次`
        }),
        // 累计请假时长 — 事假 + 病假 + 工伤 in one number, which is the one
        // the person is actually asked about at the end of the month.
        leave: list
          .filter((r) => LEAVE.has(r.type))
          .reduce((sum, r) => sum + (r.hours ?? 0), 0),
        total: list.length,
      }))
      .sort((a, b) =>
        a.total !== b.total ? b.total - a.total : a.name < b.name ? -1 : 1,
      )
  }, [records])

  function go(p: string) {
    setOpenName(null)
    router.push(`/hr?p=${encodeURIComponent(p)}`)
  }

  function file() {
    if (!name.trim()) {
      setError('先选一个人')
      return
    }
    // 事假 / 病假 / 工伤 / 旷工 ARE their hours — a 请假 with no length is a
    // line nothing can be added up from, so it isn't accepted at all.
    if (hrHasHours(type) && parseHours(hours) === null) {
      setError(`${type}要填时长 · 半天 4，一天 8`)
      return
    }
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'addHrRecord',
          input: {
            name: name.trim(),
            type,
            date,
            hours: hrHasHours(type)
              ? (parseHours(hours) ?? undefined)
              : undefined,
            note: note.trim() || undefined,
          },
        })
        setNote('')
        setName('')
        setHours('')
        setDate(today)
        // A record files into the month it happened in — jump there so the
        // person always sees what they just wrote.
        const m = date.slice(0, 7)
        if (!isYear && m !== period) go(m)
        else router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '记不上')
      }
    })
  }

  function remove(r: HrRecord) {
    start(async () => {
      try {
        await mutate({
          kind: 'deleteHrRecord',
          month: r.date.slice(0, 7),
          recordId: r.id,
        })
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '删不掉')
      }
    })
  }

  const chip =
    'rounded-[2px] border px-3 py-1.5 text-[12.5px] font-medium whitespace-nowrap'

  return (
    <div className="mx-auto max-w-4xl">
      {/* 记一笔 — everything on one line, filed with one tap. */}
      <div className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 md:px-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="w-[150px]">
            <SearchSelect
              options={roster.map((n) => ({ id: n, label: n }))}
              value={name}
              onChange={setName}
              placeholder="谁"
              searchPlaceholder="选人或直接输入姓名…"
              createLabel="员工"
              onCreate={setName}
              triggerLabel={name && !roster.includes(name) ? name : undefined}
              triggerClass="w-full"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {HR_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={`${chip} ${
                  type === t
                    ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-surface)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)]'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {hrHasHours(type) && (
            <div className="flex items-center gap-1">
              <input
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                placeholder="时长"
                inputMode="decimal"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') file()
                }}
                className="mono h-9 w-[68px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-center text-[12.5px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
              />
              <span className="text-[12px] text-[var(--color-ink-3)]">
                小时
              </span>
            </div>
          )}

          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value || today)}
            className="mono h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[12.5px] text-[var(--color-ink)] outline-none focus:border-[var(--color-border-strong)]"
          />

          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="一句话 · 可空"
            onKeyDown={(e) => {
              if (e.key === 'Enter') file()
            }}
            className="h-9 min-w-[140px] flex-1 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
          />

          <button
            type="button"
            onClick={file}
            disabled={pending}
            className="h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
          >
            记下
          </button>
        </div>
        {error && (
          <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>
        )}
      </div>

      {/* Period — months, then the years they roll up into. */}
      <div className="mt-4 mb-3 flex flex-wrap items-center gap-1.5">
        {monthOptions.slice(0, 12).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => go(m)}
            className={`${chip} ${
              period === m
                ? 'border-[var(--color-ink)] text-[var(--color-ink)] shadow-[inset_0_0_0_1px_var(--color-ink)]'
                : 'border-[var(--color-border)] text-[var(--color-ink-3)] hover:border-[var(--color-border-strong)]'
            } bg-[var(--color-surface)]`}
          >
            {monthLabel(m)}
          </button>
        ))}
        <span className="mx-1 text-[var(--color-ink-4)]">·</span>
        {years.map((y) => (
          <button
            key={y}
            type="button"
            onClick={() => go(y)}
            className={`${chip} ${
              period === y
                ? 'border-[var(--color-ink)] text-[var(--color-ink)] shadow-[inset_0_0_0_1px_var(--color-ink)]'
                : 'border-[var(--color-border)] text-[var(--color-ink-3)] hover:border-[var(--color-border-strong)]'
            } bg-[var(--color-surface)]`}
          >
            {y} 全年
          </button>
        ))}
      </div>

      {/* 一人一行 */}
      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-5 py-2.5">
          <span className="mono text-[13px] font-semibold text-[var(--color-ink)]">
            {isYear ? `${year} 全年` : monthLabel(period)} · {rows.length} 人 ·{' '}
            {records.length} 条
          </span>
        </div>

        <div className="hidden grid-cols-[minmax(0,1fr)_repeat(7,52px)_58px_46px] items-center gap-2 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid">
          <span className="label">姓名</span>
          {HR_TYPES.map((t) => (
            <span key={t} className="label text-center">
              {t === '重大质量异常' ? '质量' : t}
            </span>
          ))}
          <span className="label text-center text-[var(--color-ink-2)]">
            请假共
          </span>
          <span className="label text-center">笔数</span>
        </div>

        {rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-[13px] text-[var(--color-ink-3)]">
            这段时间没人有记录
          </p>
        ) : (
          rows.map((r) => (
            <div
              key={r.name}
              className="border-b border-[var(--color-border)] last:border-b-0"
            >
              <button
                type="button"
                onClick={() =>
                  setOpenName(openName === r.name ? null : r.name)
                }
                className={`grid w-full grid-cols-[minmax(0,1fr)_46px] items-center gap-2 px-4 py-3 text-left md:grid-cols-[minmax(0,1fr)_repeat(7,52px)_58px_46px] md:px-5 ${
                  openName === r.name ? 'bg-[#faf8f2]' : 'hover:bg-[#faf8f2]'
                }`}
              >
                <span className="truncate text-[14.5px] font-medium tracking-tight text-[var(--color-ink)]">
                  {r.name}
                </span>
                {r.cells.map((c, i) => (
                  <span
                    key={HR_TYPES[i]}
                    className={`mono hidden text-center text-[12.5px] md:block ${
                      !c
                        ? 'text-[var(--color-ink-4)]'
                        : HEAVY.has(HR_TYPES[i])
                          ? 'font-semibold text-[var(--color-overdue)]'
                          : 'text-[var(--color-ink)]'
                    }`}
                  >
                    {c || '·'}
                  </span>
                ))}
                <span
                  className={`mono hidden text-center text-[12.5px] font-semibold md:block ${
                    r.leave > 0
                      ? 'text-[var(--color-ink)]'
                      : 'text-[var(--color-ink-4)]'
                  }`}
                >
                  {r.leave > 0 ? `${trimNum(r.leave)}h` : '·'}
                </span>
                <span className="mono text-right text-[12.5px] font-semibold text-[var(--color-ink)] md:text-center">
                  {r.total}
                </span>
              </button>

              {openName === r.name && (
                <div className="border-t border-[var(--color-border)] bg-[#faf8f2] px-4 py-2 md:px-5">
                  {r.list.map((rec) => (
                    <div
                      key={rec.id}
                      className="flex items-baseline gap-3 border-b border-[var(--color-border)] py-2 last:border-b-0"
                    >
                      <span className="mono shrink-0 text-[12.5px] text-[var(--color-ink-2)]">
                        {rec.date.slice(5)}
                      </span>
                      <span
                        className={`shrink-0 text-[12.5px] font-medium ${
                          HEAVY.has(rec.type)
                            ? 'text-[var(--color-overdue)]'
                            : 'text-[var(--color-ink)]'
                        }`}
                      >
                        {rec.type}
                      </span>
                      {rec.hours ? (
                        <span className="mono shrink-0 text-[12.5px] text-[var(--color-ink-2)]">
                          {trimNum(rec.hours)}h
                        </span>
                      ) : null}
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-ink-2)]">
                        {rec.note}
                      </span>
                      <span className="shrink-0 text-[11.5px] text-[var(--color-ink-4)]">
                        {rec.by}
                      </span>
                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => remove(rec)}
                          disabled={pending}
                          className="shrink-0 text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)] disabled:opacity-50"
                        >
                          删
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// The kinds that read in red — nobody arranged them, and they're what a
// conversation gets started over.
const HEAVY = new Set<HrType>(['旷工', '违纪', '重大质量异常'])

// What 请假共 adds up: the three arranged absences. 旷工 has hours too but is
// not leave — nobody asked for it, and adding it in would flatter the number.
const LEAVE = new Set<HrType>(['事假', '病假', '工伤'])

// 8 not 8.0, 7.5 stays 7.5.
function trimNum(n: number): string {
  return String(Math.round(n * 10) / 10)
}

function parseHours(raw: string): number | null {
  const n = Number(raw.trim())
  return Number.isFinite(n) && n > 0 && n <= 999 ? n : null
}

function monthLabel(m: string): string {
  const [y, mm] = m.split('-')
  return `${y}年${Number(mm)}月`
}
