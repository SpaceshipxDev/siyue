'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { EditableText } from '@/app/_editable'
import { usePersistentState } from '@/app/_persist'
import { formatCny } from '@/lib/data'
import {
  emptyLine,
  quoteLine,
  quoteTotals,
  type QuoteLine,
  type QuoteRates,
} from '@/lib/quote'

// 报价 — 上面是模板, 下面是这一次要报的几行。
//
// 模板那一块平时收着: 费率是设一次用半年的东西, 天天摊在眼前只会挡路。收起
// 来时它是一句话 —— 机时费 ¥60/时 · 毛利 30% —— 那是报价时唯一需要确认的两
// 个数, 其余点开再看。
//
// 报价行留在浏览器里 (sessionStorage), 刷新不丢、关掉就算。报的是还没接的
// 单, 同一个零件一天可能按三个数量各报一次, 存到服务器只会越积越乱。
//
// 每一行右边直接给出单价和小计, 点开还能看到这个价是怎么摊出来的 —— 客户问
// "为什么这么贵", 答案就在那四个数里。

export function QuoteBoard({ rates }: { rates: QuoteRates }) {
  const router = useRouter()
  const [openRates, setOpenRates] = useState(false)
  const [openLine, setOpenLine] = useState<string | null>(null)
  const [lines, setLines] = usePersistentState<QuoteLine[]>('quote:lines', [])

  const totals = useMemo(() => quoteTotals(lines, rates), [lines, rates])

  async function saveRate(body: Record<string, unknown> & { kind: string }) {
    await mutate(body)
    router.refresh()
  }

  function patchLine(id: string, p: Partial<QuoteLine>) {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...p } : l)))
  }

  function addLine() {
    setLines((prev) => [
      ...prev,
      emptyLine(
        `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      ),
    ])
  }

  function removeLine(id: string) {
    setLines((prev) => prev.filter((l) => l.id !== id))
    if (openLine === id) setOpenLine(null)
  }

  const COLS =
    'grid-cols-[minmax(0,1.4fr)_92px_64px_64px_96px_46px_46px_56px_84px_92px_28px]'

  return (
    <div className="mx-auto max-w-6xl">
      {/* 模板 — 收起时是一句话, 点开是全部费率。 */}
      <div className="mb-5 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <button
          type="button"
          onClick={() => setOpenRates(!openRates)}
          className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-left md:px-5"
        >
          <span className="text-[13px] font-medium text-[var(--color-ink)]">
            报价模板
          </span>
          <span className="mono text-[12.5px] text-[var(--color-ink-2)]">
            机时费 ¥{rates.machineRatePerHour}/时 · 毛利 {rates.marginPct}%
          </span>
          <span className="mono text-[12px] text-[var(--color-ink-3)]">
            · 材料 {rates.materials.length} 种 · 表面处理{' '}
            {rates.surfaces.length} 种 · 喷涂 ¥{rates.paintPerPiece} · 丝印 ¥
            {rates.screenPerPiece}
          </span>
          <span className="ml-auto text-[11.5px] text-[var(--color-ink-4)]">
            {openRates ? '收起' : '改费率'}
          </span>
        </button>

        {openRates && (
          <div className="border-t border-[var(--color-border)] px-4 py-4 md:px-5">
            <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-3 text-[12.5px] text-[var(--color-ink-3)]">
              <Scalar
                label="机时费"
                unit="元/小时"
                value={rates.machineRatePerHour}
                onSave={(v) =>
                  saveRate({
                    kind: 'setQuoteScalar',
                    key: 'machineRatePerHour',
                    value: v,
                  })
                }
              />
              <Scalar
                label="毛利率"
                unit="%"
                value={rates.marginPct}
                onSave={(v) =>
                  saveRate({ kind: 'setQuoteScalar', key: 'marginPct', value: v })
                }
              />
              <Scalar
                label="喷涂"
                unit="元/件"
                value={rates.paintPerPiece}
                onSave={(v) =>
                  saveRate({
                    kind: 'setQuoteScalar',
                    key: 'paintPerPiece',
                    value: v,
                  })
                }
              />
              <Scalar
                label="丝印"
                unit="元/件"
                value={rates.screenPerPiece}
                onSave={(v) =>
                  saveRate({
                    kind: 'setQuoteScalar',
                    key: 'screenPerPiece',
                    value: v,
                  })
                }
              />
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <RateList
                title="材料"
                unit="元/kg"
                list="materials"
                items={rates.materials}
                onSave={saveRate}
              />
              <RateList
                title="表面处理"
                unit="元/件"
                list="surfaces"
                items={rates.surfaces}
                onSave={saveRate}
              />
            </div>
          </div>
        )}
      </div>

      {/* 合计 */}
      <div className="mb-5 flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <p className="text-[32px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">
            {formatCny(totals.totalCny)}
          </p>
          <p className="label mt-2.5">报价合计</p>
          <p className="mt-1 text-[12px] tabular-nums text-[var(--color-ink-3)]">
            {lines.length} 项 · {totals.pieces} 件
          </p>
        </div>
        <div>
          <p className="text-[18px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink-2)]">
            {formatCny(totals.costCny)}
          </p>
          <p className="label mt-2.5">成本</p>
        </div>
        <div>
          <p className="text-[18px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-success)]">
            {formatCny(totals.profitCny)}
          </p>
          <p className="label mt-2.5">毛利</p>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          {lines.length > 0 && (
            <button
              type="button"
              onClick={() => {
                if (confirm('清空这次报价的所有行？')) setLines([])
              }}
              className="rounded-[2px] border border-[var(--color-border)] px-3.5 py-2 text-[13px] text-[var(--color-ink-3)] hover:border-[var(--color-overdue)] hover:text-[var(--color-overdue)]"
            >
              清空
            </button>
          )}
          <button
            type="button"
            onClick={addLine}
            className="rounded-[2px] bg-[var(--color-ink)] px-4 py-2 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85"
          >
            ＋ 加一行
          </button>
        </div>
      </div>

      {/* 报价行 */}
      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div
          className={`hidden ${COLS} items-center gap-2 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid`}
        >
          <span className="label">零件</span>
          <span className="label">材料</span>
          <span className="label text-right">单重kg</span>
          <span className="label text-right">工时分</span>
          <span className="label">表面处理</span>
          <span className="label text-center">喷涂</span>
          <span className="label text-center">丝印</span>
          <span className="label text-right">数量</span>
          <span className="label text-right">单价</span>
          <span className="label text-right">小计</span>
          <span />
        </div>

        {lines.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            点「＋ 加一行」开始报价 — 填什么料、多重、加工多久，勾一下后道
          </p>
        ) : (
          lines.map((l) => {
            const b = quoteLine(l, rates)
            return (
              <div
                key={l.id}
                className="border-b border-[var(--color-border)] last:border-b-0"
              >
                <div
                  className={`grid ${COLS} items-center gap-2 px-4 py-2 md:px-5`}
                >
                  <EditableText
                    value={l.name}
                    placeholder="零件名"
                    className="text-[13.5px] text-[var(--color-ink)]"
                    onSave={async (v) => patchLine(l.id, { name: v })}
                  />
                  <Picker
                    value={l.material}
                    options={rates.materials.map((m) => m.name)}
                    onChange={(v) => patchLine(l.id, { material: v })}
                  />
                  <Num
                    value={l.weightKg}
                    onChange={(v) => patchLine(l.id, { weightKg: v })}
                  />
                  <Num
                    value={l.minutes}
                    onChange={(v) => patchLine(l.id, { minutes: v })}
                  />
                  <Picker
                    value={l.surface}
                    options={rates.surfaces.map((m) => m.name)}
                    onChange={(v) => patchLine(l.id, { surface: v })}
                  />
                  <Tick
                    on={l.paint}
                    onToggle={() => patchLine(l.id, { paint: !l.paint })}
                  />
                  <Tick
                    on={l.screen}
                    onToggle={() => patchLine(l.id, { screen: !l.screen })}
                  />
                  <Num
                    value={l.qty}
                    onChange={(v) => patchLine(l.id, { qty: Math.max(0, v) })}
                  />
                  <button
                    type="button"
                    onClick={() => setOpenLine(openLine === l.id ? null : l.id)}
                    className="mono text-right text-[13px] font-medium tabular-nums text-[var(--color-ink)] hover:underline"
                  >
                    {formatCny(b.unitCny)}
                  </button>
                  <span className="mono text-right text-[13.5px] font-semibold tabular-nums text-[var(--color-ink)]">
                    {formatCny(b.totalCny)}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeLine(l.id)}
                    className="text-right text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                  >
                    删
                  </button>
                </div>

                {/* 这个价怎么来的 — 客户问起来的答案。 */}
                {openLine === l.id && (
                  <div className="border-t border-[var(--color-border)] bg-[#faf8f2] px-5 py-3">
                    <div className="mx-auto max-w-[420px] text-[12.5px]">
                      <Row label="料费" detail={`${l.material || '未选材料'} × ${l.weightKg}kg`} v={b.materialCny} />
                      <Row label="加工费" detail={`${l.minutes} 分 × ¥${rates.machineRatePerHour}/时`} v={b.machiningCny} />
                      {b.surfaceCny > 0 && (
                        <Row label="表面处理" detail={l.surface} v={b.surfaceCny} />
                      )}
                      {b.paintCny > 0 && <Row label="喷涂" detail="" v={b.paintCny} />}
                      {b.screenCny > 0 && <Row label="丝印" detail="" v={b.screenCny} />}
                      <Row label="成本" detail="" v={b.costCny} strong />
                      <Row
                        label="单价"
                        detail={`成本 + 毛利 ${rates.marginPct}%`}
                        v={b.unitCny}
                        strong
                      />
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      <p className="mt-4 text-[12px] text-[var(--color-ink-3)]">
        费率是全厂共用的，改一次以后都按新的算；这几行报价只留在你这台机器上，
        刷新不丢、关掉就没。点单价能看到这个数是怎么摊出来的。
      </p>
    </div>
  )
}

function Row({
  label,
  detail,
  v,
  strong,
}: {
  label: string
  detail: string
  v: number
  strong?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--color-border)] py-1.5 last:border-b-0">
      <span className={strong ? 'font-medium text-[var(--color-ink)]' : 'text-[var(--color-ink-2)]'}>
        {label}
        {detail && (
          <span className="ml-2 text-[12px] text-[var(--color-ink-3)]">
            {detail}
          </span>
        )}
      </span>
      <span
        className={`mono shrink-0 tabular-nums ${
          strong
            ? 'font-semibold text-[var(--color-ink)]'
            : 'text-[var(--color-ink-2)]'
        }`}
      >
        {formatCny(v)}
      </span>
    </div>
  )
}

const CELL =
  'w-full cursor-pointer appearance-none rounded-[2px] border-0 bg-transparent px-1 -mx-1 py-1 text-[12.5px] text-[var(--color-ink)] outline-none transition-colors hover:bg-[var(--color-active-bg)] focus:bg-[var(--color-active-bg)]'

function Picker({
  value,
  options,
  onChange,
}: {
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`mono ${CELL} ${value ? '' : 'text-[var(--color-ink-4)]'}`}
    >
      <option value="">—</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}

function Num({
  value,
  onChange,
}: {
  value: number
  onChange: (v: number) => void
}) {
  return (
    <input
      value={value === 0 ? '' : String(value)}
      onChange={(e) => {
        const t = e.target.value.trim()
        const n = t === '' ? 0 : Number(t)
        if (Number.isFinite(n)) onChange(n)
      }}
      inputMode="decimal"
      placeholder="0"
      className={`mono ${CELL} text-right tabular-nums placeholder:text-[var(--color-ink-4)]`}
    />
  )
}

function Tick({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <span className="flex justify-center">
      <input
        type="checkbox"
        checked={on}
        onChange={onToggle}
        className="h-[15px] w-[15px] accent-[var(--color-ink)]"
      />
    </span>
  )
}

function Scalar({
  label,
  unit,
  value,
  onSave,
}: {
  label: string
  unit: string
  value: number
  onSave: (v: number) => Promise<void>
}) {
  return (
    <span className="inline-flex items-baseline">
      {label}
      <span className="mx-1 inline-block w-[54px]">
        <EditableText
          mono
          align="center"
          value={String(value)}
          className="text-[12.5px] tabular-nums text-[var(--color-ink)]"
          onSave={async (next) => {
            const n = Number(next.trim())
            if (!Number.isFinite(n)) throw new Error('要填数字')
            await onSave(n)
          }}
        />
      </span>
      {unit}
    </span>
  )
}

function RateList({
  title,
  unit,
  list,
  items,
  onSave,
}: {
  title: string
  unit: string
  list: 'materials' | 'surfaces'
  items: { name: string; price: number }[]
  onSave: (body: Record<string, unknown> & { kind: string }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')

  function add() {
    if (!name.trim()) return
    const n = Number(price.trim())
    if (!Number.isFinite(n)) {
      showToast('单价要填数字', 'warning')
      return
    }
    onSave({
      kind: 'setQuoteRateItem',
      list,
      index: -1,
      name: name.trim(),
      price: n,
    })
      .then(() => {
        setName('')
        setPrice('')
      })
      .catch(() => showToast('加不上', 'warning'))
  }

  return (
    <div>
      <p className="label mb-2">
        {title}
        <span className="ml-2 font-normal text-[var(--color-ink-4)]">
          {unit}
        </span>
      </p>
      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)]">
        {items.map((it, i) => (
          <div
            key={`${it.name}-${i}`}
            className="grid grid-cols-[minmax(0,1fr)_72px_28px] items-center gap-2 border-b border-[var(--color-border)] px-3 py-1.5 last:border-b-0"
          >
            <EditableText
              value={it.name}
              className="text-[12.5px] text-[var(--color-ink)]"
              onSave={(v) =>
                onSave({
                  kind: 'setQuoteRateItem',
                  list,
                  index: i,
                  name: v,
                  price: it.price,
                })
              }
            />
            <EditableText
              mono
              align="right"
              value={String(it.price)}
              className="text-[12.5px] tabular-nums"
              onSave={async (v) => {
                const n = Number(v.trim())
                if (!Number.isFinite(n)) throw new Error('单价要填数字')
                await onSave({
                  kind: 'setQuoteRateItem',
                  list,
                  index: i,
                  name: it.name,
                  price: n,
                })
              }}
            />
            <button
              type="button"
              onClick={() =>
                onSave({
                  kind: 'setQuoteRateItem',
                  list,
                  index: i,
                  name: null,
                }).catch(() => showToast('删不掉', 'warning'))
              }
              className="text-right text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
            >
              删
            </button>
          </div>
        ))}
        <div className="grid grid-cols-[minmax(0,1fr)_72px_28px] items-center gap-2 bg-[#faf8f2] px-3 py-1.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="新增…"
            onKeyDown={(e) => e.key === 'Enter' && add()}
            className="w-full bg-transparent text-[12.5px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)]"
          />
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="单价"
            inputMode="decimal"
            onKeyDown={(e) => e.key === 'Enter' && add()}
            className="mono w-full bg-transparent text-right text-[12.5px] tabular-nums text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)]"
          />
          <button
            type="button"
            onClick={add}
            className="text-right text-[11.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            加
          </button>
        </div>
      </div>
    </div>
  )
}
