'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { EditableText } from '@/app/_editable'
import { SearchSelect } from '@/app/_search_select'
import { formatCny } from '@/lib/data'
import {
  matchesSalaryChange,
  salaryDelta,
  salaryPct,
  type SalaryChange,
} from '@/lib/payroll'

// 调薪 — 谁, 什么时候, 从多少到多少, 为什么, 谁改的.
//
// Nothing on this page is typed into existence: every line was filed by
// somebody changing a 月薪 on the 工资表, so the record and the pay can't
// disagree. What IS typed here is the 原因 — asked for after the fact, because
// stopping to explain yourself mid-keystroke is how a log stops getting kept.
//
// One line per move, newest first. 涨 reads green, 降 red, 移出名册 grey —
// three colours are the whole vocabulary, and the year's totals sit on top so
// "今年给谁涨了多少" is answered before you scroll.

export function RaiseLedger({
  changes,
  people,
  year,
  today,
}: {
  changes: SalaryChange[]
  /** 可以调薪的人 + 他现在的月薪 — 选了人就把原月薪带出来。 */
  people: { name: string; monthlyCny: number }[]
  /** 'YYYY' — the year the totals summarise. */
  year: string
  today: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [q, setQ] = useState('')
  const [armDelete, setArmDelete] = useState<string | null>(null)

  // 记一笔
  const [name, setName] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [reason, setReason] = useState('')
  const [date, setDate] = useState(today)
  const [error, setError] = useState<string | null>(null)

  const fromN = parseMoney(from)
  const toN = parseMoney(to)
  const delta = fromN !== null && toN !== null ? toN - fromN : null

  // Picking somebody fills in what they're on now — the 原月薪 is a fact the
  // system already holds, and retyping a fact is how they stop matching. It
  // stays editable so an old raise can be entered after the fact.
  function pick(n: string) {
    setName(n)
    const p = people.find((x) => x.name === n)
    setFrom(p && p.monthlyCny > 0 ? String(p.monthlyCny) : '')
    setError(null)
  }

  function file() {
    if (!name.trim()) return setError('先选一个人')
    if (fromN === null) return setError('填一下原月薪')
    if (toN === null) return setError('填一下调后月薪')
    if (fromN === toN) return setError('调前调后一样')
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'addSalaryChange',
          name: name.trim(),
          fromCny: fromN,
          toCny: toN,
          date,
          reason: reason.trim() || undefined,
        })
        setName('')
        setFrom('')
        setTo('')
        setReason('')
        setDate(today)
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '记不上')
      }
    })
  }

  const rows = useMemo(
    () => changes.filter((c) => matchesSalaryChange(c, q)),
    [changes, q],
  )

  // 今年 — how many moves, and what they add to the monthly wage bill. The
  // sum is what payroll costs MORE (or less) every month from now on, which
  // is the number the decision was actually made against.
  const stats = useMemo(() => {
    const ofYear = changes.filter((c) => c.date.startsWith(year))
    let delta = 0
    for (const c of ofYear) {
      // 移出名册 isn't a raise decision — it's somebody leaving the payroll,
      // and folding it in would read as "we cut ¥6000 of wages".
      if (c.toCny > 0) delta += salaryDelta(c)
    }
    const up = ofYear.filter((c) => c.toCny > 0 && salaryDelta(c) > 0).length
    return { count: ofYear.length, up, delta }
  }, [changes, year])

  async function save(body: Record<string, unknown> & { kind: string }) {
    await mutate(body)
    router.refresh()
  }

  function remove(id: string) {
    start(async () => {
      await mutate({ kind: 'deleteSalaryChange', changeId: id })
      setArmDelete(null)
      router.refresh()
    })
  }

  return (
    <div>
      <div className="mb-8 grid grid-cols-2 gap-x-8 gap-y-10 lg:grid-cols-3">
        <Stat label={`${year}年调薪`} value={`${stats.count} 次`} sub={`其中涨薪 ${stats.up} 次`} />
        <Stat
          label="月工资增减"
          value={`${stats.delta > 0 ? '+' : stats.delta < 0 ? '−' : ''}${formatCny(Math.abs(stats.delta))}`}
          sub="今年调完后每月多发/少发"
          tone={stats.delta > 0 ? 'up' : stats.delta < 0 ? 'down' : undefined}
        />
        <Stat label="全部记录" value={`${changes.length} 条`} sub="工资表改一次月薪自动记一条" />
      </div>

      {/* 记一笔 — 选人, 原月薪自动带出, 填调后多少和为什么。 */}
      <div className="mb-4 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 md:px-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="w-[150px]">
            <SearchSelect
              options={people.map((p) => ({ id: p.name, label: p.name }))}
              value={name}
              onChange={pick}
              placeholder="谁"
              searchPlaceholder="选人或直接输入姓名…"
              createLabel="员工"
              onCreate={pick}
              triggerLabel={
                name && !people.some((p) => p.name === name) ? name : undefined
              }
              triggerClass="w-full"
            />
          </div>

          <span className="text-[12.5px] text-[var(--color-ink-3)]">原</span>
          <input
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="原月薪"
            inputMode="decimal"
            onKeyDown={(e) => e.key === 'Enter' && file()}
            className="mono h-9 w-[92px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-right text-[12.5px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
          />
          <span className="text-[13px] text-[var(--color-ink-4)]">→</span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="调后月薪"
            inputMode="decimal"
            onKeyDown={(e) => e.key === 'Enter' && file()}
            className="mono h-9 w-[92px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-right text-[12.5px] font-semibold text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
          />
          <span
            className={`mono min-w-[60px] shrink-0 text-[12.5px] font-semibold tabular-nums ${
              delta === null || delta === 0
                ? 'text-[var(--color-ink-4)]'
                : delta > 0
                  ? 'text-[var(--color-success)]'
                  : 'text-[var(--color-overdue)]'
            }`}
          >
            {delta === null || delta === 0
              ? ''
              : `${delta > 0 ? '+' : '−'}${formatCny(Math.abs(delta))}`}
          </span>

          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="原因 · 为什么调"
            onKeyDown={(e) => e.key === 'Enter' && file()}
            className="h-9 min-w-[160px] flex-1 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
          />

          {/* 调薪当天 — 记下就生效, 所以没有未来的日子可填。 */}
          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value || today)}
            className="mono h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[12.5px] text-[var(--color-ink)] outline-none focus:border-[var(--color-border-strong)]"
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
        {error ? (
          <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>
        ) : (
          <p className="mt-2 text-[12px] text-[var(--color-ink-4)]">
            记下的同时，工资表上这个人的月薪就改成调后的数了。
          </p>
        )}
      </div>

      <div className="mb-4">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索 · 姓名 / 部门 / 原因"
          className="h-9 w-full max-w-[280px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
        />
      </div>

      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="hidden grid-cols-[92px_minmax(0,1fr)_84px_160px_96px_minmax(0,1.3fr)_80px_36px] items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid">
          <span className="label">日期</span>
          <span className="label">姓名</span>
          <span className="label">部门</span>
          <span className="label text-right">调整</span>
          <span className="label text-right">幅度</span>
          <span className="label">原因</span>
          <span className="label text-right">操作人</span>
          <span />
        </div>

        {rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-[13px] text-[var(--color-ink-3)]">
            {q
              ? '没有匹配的记录'
              : '还没有调薪 — 在工资表上改一个人的月薪，这里就会有一条'}
          </p>
        ) : (
          rows.map((c) => {
            const d = salaryDelta(c)
            const pct = salaryPct(c)
            const out = c.toCny === 0
            return (
              <div
                key={c.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-[var(--color-border)] px-4 py-3 last:border-b-0 hover:bg-[#faf8f2] md:grid-cols-[92px_minmax(0,1fr)_84px_160px_96px_minmax(0,1.3fr)_80px_36px] md:px-5 md:py-2.5"
              >
                <span className="mono hidden text-[12.5px] text-[var(--color-ink-2)] tabular-nums md:block">
                  {c.date.slice(5)}
                </span>
                <span className="truncate text-[14px] font-medium tracking-tight text-[var(--color-ink)]">
                  {c.name}
                  <span className="mono ml-2 text-[11.5px] font-normal text-[var(--color-ink-4)] md:hidden">
                    {c.date.slice(5)}
                  </span>
                </span>
                <span className="mono hidden truncate text-[12px] text-[var(--color-ink-3)] md:block">
                  {c.dept}
                </span>
                <span className="mono text-right text-[12.5px] tabular-nums text-[var(--color-ink-2)]">
                  {formatCny(c.fromCny)}
                  <span className="mx-1 text-[var(--color-ink-4)]">→</span>
                  <span
                    className={
                      out ? 'text-[var(--color-ink-4)]' : 'font-semibold text-[var(--color-ink)]'
                    }
                  >
                    {out ? '移出名册' : formatCny(c.toCny)}
                  </span>
                </span>
                <span
                  className={`mono hidden text-right text-[12.5px] font-semibold tabular-nums md:block ${
                    out
                      ? 'text-[var(--color-ink-4)]'
                      : d > 0
                        ? 'text-[var(--color-success)]'
                        : 'text-[var(--color-overdue)]'
                  }`}
                >
                  {out
                    ? '·'
                    : `${d > 0 ? '+' : '−'}${formatCny(Math.abs(d))}${
                        pct === null ? '' : ` ${Math.abs(pct).toFixed(0)}%`
                      }`}
                </span>
                <div className="hidden md:block">
                  <EditableText
                    value={c.reason}
                    placeholder="补一句原因…"
                    className="text-[12.5px]"
                    onSave={(next) =>
                      save({
                        kind: 'setSalaryChangeReason',
                        changeId: c.id,
                        reason: next,
                      })
                    }
                  />
                </div>
                <span className="hidden truncate text-right text-[12px] text-[var(--color-ink-3)] md:block">
                  {c.by}
                </span>
                <span className="hidden text-right md:block">
                  {armDelete === c.id ? (
                    <button
                      type="button"
                      onClick={() => remove(c.id)}
                      disabled={pending}
                      className="text-[11.5px] font-medium text-[var(--color-overdue)] hover:underline disabled:opacity-50"
                    >
                      确认
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setArmDelete(c.id)}
                      className="text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                    >
                      删
                    </button>
                  )}
                </span>
              </div>
            )
          })
        )}
      </div>

      <p className="mt-4 text-[12px] text-[var(--color-ink-3)]">
        两头都通：在这里记一笔会改工资表的月薪；直接在工资表上改月薪，这里也会
        自动落一条（原因空着，回头点着补一句）。
      </p>
    </div>
  )
}

// 6000 / ¥6,000 / 6000元 都当 6000。空的算没填。
function parseMoney(raw: string): number | null {
  const t = raw.trim().replace(/[¥,，元\s]/g, '')
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 && n <= 200000 ? n : null
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub: string
  tone?: 'up' | 'down'
}) {
  return (
    <div>
      <p
        className={`text-[32px] md:text-[36px] font-semibold tracking-tight tabular-nums leading-none ${
          tone === 'up'
            ? 'text-[var(--color-success)]'
            : tone === 'down'
              ? 'text-[var(--color-overdue)]'
              : 'text-[var(--color-ink)]'
        }`}
      >
        {value}
      </p>
      <p className="label mt-3">{label}</p>
      <p className="mt-1 text-[12px] tabular-nums text-[var(--color-ink-3)]">
        {sub}
      </p>
    </div>
  )
}
