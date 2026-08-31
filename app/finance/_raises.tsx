'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { EditableText } from '@/app/_editable'
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
  year,
}: {
  changes: SalaryChange[]
  /** 'YYYY' — the year the totals summarise. */
  year: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [q, setQ] = useState('')
  const [armDelete, setArmDelete] = useState<string | null>(null)

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
        这里不用手工记：在工资表上改谁的月薪，就自动落一条。原因可以随时补。
      </p>
    </div>
  )
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
