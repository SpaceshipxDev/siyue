'use client'

import { Fragment, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { formatCny } from '@/lib/data'
import { TOOL_STATE_LABEL, toolState, toolValue, type ToolIssue } from '@/lib/tool-shared'

// 人事 · 工具 —— 工具领用登记 (于海伟 2026-10-23)。
//
//   上面一行记一笔: 谁、哪天、领了什么、几件。工具从采购过的东西里挑, 单价
//   带的是最近一次的采购价 (采购里没有的照样能手填)。
//   下面按人一摞: 累计领了多少、还有几件没还、值多少钱; 点开看每一笔。
//   人要走了点「离职归还确认」: 还回来的勾上, 没勾的按单价扣款, 扣在这个月
//   的工资里 (工资条上「工具扣款」那一行)。平时还一件就点那一件的「归还」。

/** 采购过的东西 —— 名称 + 最近一次的采购单价。 */
export type ToolCatalogItem = { name: string; priceCny: number; date?: string }

type Filter = 'out' | 'all'

const inp =
  'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'

function num(s: string): number | undefined {
  const t = s.trim().replace(/[¥,，元\s]/g, '')
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

export function ToolBoard({
  issues,
  roster,
  catalog,
  todayStr,
}: {
  issues: ToolIssue[]
  roster: string[]
  catalog: ToolCatalogItem[]
  todayStr: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()

  const [name, setName] = useState('')
  const [date, setDate] = useState(todayStr)
  const [tool, setTool] = useState('')
  const [qty, setQty] = useState('1')
  const [price, setPrice] = useState('')
  const [priceFrom, setPriceFrom] = useState<string | null>(null) // 采购价是哪天的
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const [filter, setFilter] = useState<Filter>('out')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [leaving, setLeaving] = useState<string | null>(null)

  const priceOf = useMemo(() => new Map(catalog.map((c) => [c.name, c])), [catalog])

  function pickTool(v: string) {
    setTool(v)
    const hit = priceOf.get(v.trim())
    if (hit) {
      setPrice(String(hit.priceCny))
      setPriceFrom(hit.date ?? '')
    } else setPriceFrom(null)
  }

  function add() {
    const n = num(qty)
    const p = price.trim() ? num(price) : undefined
    if (!name.trim()) return setError('先填领用人')
    if (!tool.trim()) return setError('先填工具名称')
    if (!n || n <= 0) return setError('件数要填一个正数')
    if (price.trim() && (p === undefined || p < 0)) return setError('单价要填数字')
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'addToolIssue',
          input: { name: name.trim(), date, tool: tool.trim(), qty: n, priceCny: p, note: note.trim() },
        })
        setTool('')
        setQty('1')
        setPrice('')
        setPriceFrom(null)
        setNote('')
        showToast('记下了', 'success')
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '记不上')
      }
    })
  }

  // 按人一摞 —— 有没还的排前面, 再按最近领用。
  const people = useMemo(() => {
    const by = new Map<string, ToolIssue[]>()
    for (const t of issues) by.set(t.name, [...(by.get(t.name) ?? []), t])
    return [...by.entries()]
      .map(([n, list]) => {
        const out = list.filter((t) => toolState(t) === 'out')
        return {
          name: n,
          list,
          count: list.length,
          qty: list.reduce((s, t) => s + t.qty, 0),
          outQty: out.reduce((s, t) => s + t.qty, 0),
          outValue: Math.round(out.reduce((s, t) => s + (toolValue(t) ?? 0), 0) * 100) / 100,
          outCount: out.length,
          last: list[0]?.date ?? '',
        }
      })
      .sort((a, b) => Number(b.outCount > 0) - Number(a.outCount > 0) || b.last.localeCompare(a.last))
  }, [issues])
  const needle = q.trim()
  const shown = people.filter(
    (p) => (filter === 'all' || p.outCount > 0) && (!needle || p.name.includes(needle)),
  )
  const outPeople = people.filter((p) => p.outCount > 0).length

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 md:px-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <Suggest
            value={name}
            onChange={setName}
            options={roster.map((n) => ({ value: n }))}
            placeholder="领用人"
            className="w-[120px]"
          />
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={`mono ${inp} w-[150px]`}
          />
          <Suggest
            value={tool}
            onChange={pickTool}
            options={catalog.map((c) => ({ value: c.name, hint: formatCny(c.priceCny) }))}
            placeholder="工具 · 从采购过的里挑"
            className="min-w-[180px] flex-1"
          />
          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            inputMode="decimal"
            placeholder="件数"
            className={`mono ${inp} w-[64px] text-right`}
          />
          <label className="flex flex-col">
            <input
              value={price}
              onChange={(e) => {
                setPrice(e.target.value)
                setPriceFrom(null)
              }}
              inputMode="decimal"
              placeholder="采购单价"
              className={`mono ${inp} w-[104px] text-right`}
            />
          </label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="备注"
            className={`${inp} w-[120px]`}
          />
          <button
            type="button"
            onClick={add}
            disabled={pending}
            className="h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
          >
            记下
          </button>
        </div>
        {(error || priceFrom !== null) && (
          <p className="mt-2 text-[12px]">
            {error ? (
              <span className="text-[var(--color-overdue)]">{error}</span>
            ) : (
              <span className="text-[var(--color-ink-3)]">
                单价按采购价{priceFrom ? `（${priceFrom} 那一笔）` : ''}
              </span>
            )}
          </p>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-baseline gap-4">
        {(
          [
            ['out', `未归还${outPeople > 0 ? ` ${outPeople} 人` : ''}`],
            ['all', '全部'],
          ] as [Filter, string][]
        ).map(([f, label]) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`text-[13.5px] tracking-tight transition-colors ${
              filter === f
                ? 'font-semibold text-[var(--color-ink)]'
                : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
            }`}
          >
            {label}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="找人"
          className={`${inp} ml-auto h-8 w-[140px] bg-[var(--color-surface)]`}
        />
      </div>

      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="hidden grid-cols-[minmax(0,1fr)_96px_96px_112px_120px] items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid">
          <span className="label">领用人</span>
          <span className="label text-right">累计领用</span>
          <span className="label text-right">未归还</span>
          <span className="label text-right">未还价值</span>
          <span />
        </div>
        {shown.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {issues.length === 0 ? '还没有工具领用记录 —— 上面记一笔就开始了' : '没有符合的'}
          </p>
        ) : (
          shown.map((p) => (
            <Fragment key={p.name}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => setOpen(open === p.name ? null : p.name)}
                onKeyDown={(e) => e.key === 'Enter' && setOpen(open === p.name ? null : p.name)}
                className={`grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_96px_96px_112px_120px] md:px-5 ${
                  open === p.name ? 'bg-[#faf8f2]' : 'hover:bg-[#faf8f2]'
                }`}
              >
                <span className="min-w-0 truncate text-[14px] font-medium tracking-tight text-[var(--color-ink)]">
                  {p.name}
                  <span className="ml-2 text-[12px] font-normal text-[var(--color-ink-3)]">
                    {p.count} 次 · 最近 {p.last}
                  </span>
                </span>
                <span className="mono hidden text-right text-[13px] text-[var(--color-ink-2)] md:block">
                  {p.qty} 件
                </span>
                <span
                  className={`mono text-right text-[13px] ${
                    p.outQty > 0 ? 'font-medium text-[var(--color-overdue)]' : 'text-[var(--color-ink-4)]'
                  }`}
                >
                  {p.outQty > 0 ? `${p.outQty} 件` : '都还了'}
                </span>
                <span className="mono hidden text-right text-[13px] text-[var(--color-ink)] md:block">
                  {p.outValue > 0 ? formatCny(p.outValue) : '—'}
                </span>
                <span className="hidden text-right md:block">
                  {p.outCount > 0 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpen(p.name)
                        setLeaving(p.name)
                      }}
                      className="text-[12.5px] font-medium text-[var(--color-ink-2)] underline underline-offset-2 hover:text-[var(--color-ink)]"
                    >
                      离职归还确认
                    </button>
                  )}
                </span>
              </div>
              {open === p.name && (
                <PersonDetail
                  list={p.list}
                  leaving={leaving === p.name}
                  onLeave={() => setLeaving(p.name)}
                  onDone={() => setLeaving(null)}
                  month={todayStr.slice(0, 7)}
                />
              )}
            </Fragment>
          ))
        )}
      </div>

      <p className="mt-4 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
        工具从采购过的东西里挑，单价自动带最近一次的采购价。人要离职时点「离职归还确认」：还回来的勾上，没勾的按单价扣款，扣在这个月的工资里（工资条上「工具扣款」那一行）。
      </p>
    </div>
  )
}

function PersonDetail({
  list,
  leaving,
  onLeave,
  onDone,
  month,
}: {
  list: ToolIssue[]
  leaving: boolean
  onLeave: () => void
  onDone: () => void
  month: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const out = list.filter((t) => toolState(t) === 'out')
  // 离职确认: 勾上 = 还回来了; 没勾 = 扣款 (单价没有的这里补)。
  const [back, setBack] = useState<Set<string>>(() => new Set())
  const [prices, setPrices] = useState<Record<string, string>>({})

  function run(items: { id: string; action: 'return' | 'deduct' | 'reopen'; priceCny?: number }[], ok: string, after?: () => void) {
    setError(null)
    start(async () => {
      try {
        await mutate({ kind: 'settleToolIssues', items })
        showToast(ok, 'success')
        after?.()
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '办不了')
      }
    })
  }

  function remove(id: string) {
    if (!confirm('删掉这一笔领用记录？')) return
    setError(null)
    start(async () => {
      try {
        await mutate({ kind: 'deleteToolIssue', id })
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '删不了')
      }
    })
  }

  const deductRows = out.filter((t) => !back.has(t.id))
  const priceFor = (t: ToolIssue) => (prices[t.id] !== undefined ? num(prices[t.id]) : t.priceCny)
  const deductTotal =
    Math.round(deductRows.reduce((s, t) => s + (priceFor(t) ?? 0) * t.qty, 0) * 100) / 100
  const missing = deductRows.filter((t) => priceFor(t) === undefined).length

  return (
    <div className="border-b border-[var(--color-border)] bg-[#faf8f2] px-4 py-3 last:border-b-0 md:px-5">
      {leaving && out.length > 0 ? (
        <div>
          <p className="mb-2 text-[12.5px] text-[var(--color-ink-2)]">
            离职归还确认 —— 还回来的勾上；没勾的按单价扣款，扣在 {Number(month.slice(5))} 月工资里。
          </p>
          {out.map((t) => {
            const on = back.has(t.id)
            return (
              <label
                key={t.id}
                className="grid cursor-pointer grid-cols-[20px_88px_minmax(0,1fr)_56px_112px_96px] items-center gap-2 border-b border-[var(--color-border)] py-1.5 text-[12.5px]"
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    setBack((cur) => {
                      const next = new Set(cur)
                      if (next.has(t.id)) next.delete(t.id)
                      else next.add(t.id)
                      return next
                    })
                  }
                  className="h-4 w-4 accent-[var(--color-ink)]"
                />
                <span className="mono text-[var(--color-ink-3)]">{t.date}</span>
                <span className="truncate text-[var(--color-ink)]">{t.tool}</span>
                <span className="mono text-right">{t.qty} 件</span>
                {on ? (
                  <span className="text-right text-[var(--color-success)]">已归还</span>
                ) : (
                  <input
                    value={prices[t.id] ?? (t.priceCny !== undefined ? String(t.priceCny) : '')}
                    onChange={(e) => setPrices((cur) => ({ ...cur, [t.id]: e.target.value }))}
                    inputMode="decimal"
                    placeholder="补单价"
                    className={`mono h-7 rounded-[2px] border px-2 text-right text-[12.5px] outline-none ${
                      priceFor(t) === undefined
                        ? 'border-[var(--color-overdue)] placeholder:text-[var(--color-overdue)]'
                        : 'border-[var(--color-border)]'
                    } bg-[var(--color-surface)]`}
                  />
                )}
                <span className="mono text-right text-[var(--color-overdue)]">
                  {on ? '' : priceFor(t) !== undefined ? `扣 ${formatCny((priceFor(t) ?? 0) * t.qty)}` : ''}
                </span>
              </label>
            )
          })}
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <span className="text-[12.5px] text-[var(--color-ink-2)]">
              归还 {back.size} 笔 · 扣款 {deductRows.length} 笔{' '}
              <b className="mono font-medium text-[var(--color-overdue)]">{formatCny(deductTotal)}</b>
            </span>
            <button
              type="button"
              disabled={pending || missing > 0}
              onClick={() =>
                run(
                  out.map((t) =>
                    back.has(t.id)
                      ? { id: t.id, action: 'return' as const }
                      : { id: t.id, action: 'deduct' as const, priceCny: priceFor(t) },
                  ),
                  deductRows.length > 0 ? `已确认，扣款记进 ${Number(month.slice(5))} 月工资` : '已确认，都还了',
                  onDone,
                )
              }
              className="h-9 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-40"
            >
              确认
            </button>
            <button type="button" onClick={onDone} className="text-[12.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]">
              取消
            </button>
            {missing > 0 && (
              <span className="text-[12px] text-[var(--color-overdue)]">还有 {missing} 笔没单价，补上才能扣</span>
            )}
          </div>
        </div>
      ) : (
        <div>
          {list.map((t) => {
            const st = toolState(t)
            const v = toolValue(t)
            return (
              <div
                key={t.id}
                className="grid grid-cols-[88px_minmax(0,1fr)_56px_96px_minmax(0,140px)_auto] items-baseline gap-2 border-b border-[var(--color-border)] py-1.5 text-[12.5px] last:border-b-0"
              >
                <span className="mono text-[var(--color-ink-3)]">{t.date}</span>
                <span className="min-w-0 truncate text-[var(--color-ink)]" title={t.note}>
                  {t.tool}
                  {t.note && <span className="ml-1.5 text-[var(--color-ink-4)]">{t.note}</span>}
                </span>
                <span className="mono text-right">{t.qty} 件</span>
                <span className="mono text-right text-[var(--color-ink-2)]">{v !== undefined ? formatCny(v) : '—'}</span>
                <span
                  className={`text-right ${
                    st === 'out'
                      ? 'text-[var(--color-overdue)]'
                      : st === 'returned'
                        ? 'text-[var(--color-success)]'
                        : 'text-[var(--color-warning)]'
                  }`}
                >
                  {st === 'returned'
                    ? `已归还 ${t.returnedAt?.slice(5)}`
                    : st === 'deducted'
                      ? `已扣 ${formatCny(t.deductCny ?? 0)} · ${Number(t.deductMonth?.slice(5))} 月工资`
                      : TOOL_STATE_LABEL[st]}
                </span>
                <span className="flex justify-end gap-3 text-[12px]">
                  {st === 'out' ? (
                    <>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => run([{ id: t.id, action: 'return' }], '已归还')}
                        className="text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
                      >
                        归还
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => remove(t.id)}
                        className="text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                      >
                        删
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run([{ id: t.id, action: 'reopen' }], '已撤回，回到未归还')}
                      className="text-[var(--color-ink-4)] hover:text-[var(--color-ink)]"
                    >
                      撤回
                    </button>
                  )}
                </span>
              </div>
            )
          })}
          {out.length > 0 && (
            <button
              type="button"
              onClick={onLeave}
              className="mt-2.5 text-[12.5px] font-medium text-[var(--color-ink-2)] underline underline-offset-2 hover:text-[var(--color-ink)]"
            >
              离职归还确认
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>}
    </div>
  )
}

// 带提示的输入框 —— 打字时下面列出对得上的几项, 点一下填进去; 列表里没有的照
// 样能打。不用浏览器自带的下拉 (datalist), 那个跟拼音输入法打架。
function Suggest({
  value,
  onChange,
  options,
  placeholder,
  className = '',
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; hint?: string }[]
  placeholder: string
  className?: string
}) {
  const [focus, setFocus] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  const q = value.trim()
  const hits = useMemo(
    () => (q ? options.filter((o) => o.value.includes(q) && o.value !== q) : options).slice(0, 10),
    [options, q],
  )
  return (
    <span className={`relative ${className}`}>
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        placeholder={placeholder}
        className={`${inp} w-full`}
      />
      {focus && hits.length > 0 && (
        <span className="absolute left-0 top-full z-30 mt-1 flex max-h-[260px] w-full min-w-[200px] flex-col overflow-y-auto rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] py-1 shadow-[0_6px_20px_rgba(0,0,0,0.12)]">
          {hits.map((o) => (
            <button
              key={o.value}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                onChange(o.value)
                ref.current?.blur()
              }}
              className="flex items-baseline justify-between gap-3 px-2.5 py-1.5 text-left text-[12.5px] text-[var(--color-ink-2)] hover:bg-[#f5f3ed] hover:text-[var(--color-ink)]"
            >
              <span className="truncate">{o.value}</span>
              {o.hint && <span className="mono shrink-0 text-[11.5px] text-[var(--color-ink-4)]">{o.hint}</span>}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}
