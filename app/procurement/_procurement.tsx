'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import {
  dueState,
  daysFromToday,
  formatCny,
  procurementTotalCny,
} from '@/lib/data'
import type { DueState, Procurement } from '@/lib/data'

// 采购 board. One calm ordered queue: what's on the way (sorted so the soonest
// and the overdue float to the top — that's the question the floor actually
// asks), then what's already landed, dimmed and out of the way. The list is
// the product; the form is a quiet modal that never steals the data's space.

type Mode = { kind: 'new' } | { kind: 'edit'; row: Procurement } | null

export function ProcurementBoard({
  procurements,
  currentUser,
  today,
}: {
  procurements: Procurement[]
  currentUser: string
  today: string
}) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [mode, setMode] = useState<Mode>(null)
  const [showArrived, setShowArrived] = useState(false)

  const query = q.trim().toLowerCase()
  const matches = (p: Procurement) =>
    !query ||
    p.item.toLowerCase().includes(query) ||
    (p.supplier ?? '').toLowerCase().includes(query) ||
    p.buyer.toLowerCase().includes(query) ||
    (p.notes ?? '').toLowerCase().includes(query)

  // In-transit, soonest-expected first. A null 预计到货 has no deadline, so it
  // sinks below every dated row rather than masquerading as urgent.
  const inTransit = useMemo(() => {
    return procurements
      .filter((p) => p.status === 'ordered' && matches(p))
      .sort((a, b) => {
        const ae = a.expectedDate ?? '9999-99-99'
        const be = b.expectedDate ?? '9999-99-99'
        if (ae !== be) return ae < be ? -1 : 1
        return a.orderDate < b.orderDate ? -1 : a.orderDate > b.orderDate ? 1 : 0
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [procurements, query])

  const arrived = useMemo(() => {
    return procurements
      .filter((p) => p.status === 'arrived' && matches(p))
      .sort((a, b) => {
        const ad = a.arrivedDate ?? a.orderDate
        const bd = b.arrivedDate ?? b.orderDate
        return ad < bd ? 1 : ad > bd ? -1 : 0
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [procurements, query])

  const stats = useMemo(() => {
    const open = procurements.filter((p) => p.status === 'ordered')
    let overdue = 0
    let soon = 0
    let openValue = 0
    for (const p of open) {
      if (p.expectedDate) {
        const st = dueState(p.expectedDate, today)
        if (st === 'overdue') overdue++
        else if (st === 'today' || st === 'soon') soon++
        else if (daysFromToday(p.expectedDate, today) <= 7) soon++
      }
      const t = procurementTotalCny(p)
      if (typeof t === 'number') openValue += t
    }
    return { openCount: open.length, overdue, soon, openValue }
  }, [procurements, today])

  function onDone() {
    setMode(null)
    router.refresh()
  }

  const empty = procurements.length === 0

  return (
    <div className="mx-auto max-w-5xl">
      {/* Stats — the one-glance read on the queue's health. */}
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-stretch gap-2.5">
          <Stat label="采购中" value={stats.openCount} tone="neutral" />
          <Stat label="即将到货 · 7天" value={stats.soon} tone="info" />
          <Stat label="逾期" value={stats.overdue} tone="overdue" />
          <Stat
            label="在途金额"
            value={stats.openValue > 0 ? formatCny(stats.openValue) : '—'}
            tone="neutral"
          />
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <SearchIcon />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索 · 采购项 / 供应商 / 采购人"
              className="h-9 w-[220px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] pl-8 pr-3 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)] md:w-[260px]"
            />
          </div>
          <button
            type="button"
            onClick={() => setMode({ kind: 'new' })}
            className="h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85"
          >
            新建采购
          </button>
        </div>
      </div>

      {empty ? (
        <EmptyState onNew={() => setMode({ kind: 'new' })} />
      ) : (
        <>
          <Section
            title="在途"
            count={inTransit.length}
            rows={inTransit}
            today={today}
            empty={query ? '没有匹配的在途采购' : '当前没有在途采购'}
            onEdit={(row) => setMode({ kind: 'edit', row })}
          />

          {arrived.length > 0 && (
            <div className="mt-9">
              <button
                type="button"
                onClick={() => setShowArrived((v) => !v)}
                className="mb-3 flex items-center gap-2 text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                <Chevron open={showArrived} />
                <span className="label">
                  已到货 · {arrived.length}
                </span>
              </button>
              {showArrived && (
                <Section
                  title=""
                  count={arrived.length}
                  rows={arrived}
                  today={today}
                  empty=""
                  onEdit={(row) => setMode({ kind: 'edit', row })}
                />
              )}
            </div>
          )}
        </>
      )}

      {mode && (
        <ProcurementModal
          initial={mode.kind === 'edit' ? mode.row : null}
          buyer={currentUser}
          today={today}
          onDone={onDone}
          onCancel={() => setMode(null)}
        />
      )}
    </div>
  )
}

function Section({
  title,
  count,
  rows,
  today,
  empty,
  onEdit,
}: {
  title: string
  count: number
  rows: Procurement[]
  today: string
  empty: string
  onEdit: (row: Procurement) => void
}) {
  return (
    <div>
      {title && (
        <div className="mb-3 flex items-baseline gap-2">
          <span className="label text-[var(--color-ink)]">{title}</span>
          <span className="mono text-[11px] text-[var(--color-ink-3)]">
            {count}
          </span>
        </div>
      )}
      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        {/* Column header — desktop only; on mobile each row is self-labeling. */}
        <div className="hidden grid-cols-[14px_minmax(0,1fr)_120px_180px_84px] items-center gap-4 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid">
          <span />
          <span className="label">采购项 · 供应商</span>
          <span className="label text-right">数量 · 单价</span>
          <span className="label">采购 → 预计到货</span>
          <span className="label text-right">采购人</span>
        </div>
        {rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-[13px] text-[var(--color-ink-3)]">
            {empty}
          </p>
        ) : (
          rows.map((p) => (
            <Row key={p.id} p={p} today={today} onEdit={() => onEdit(p)} />
          ))
        )}
      </div>
    </div>
  )
}

function Row({
  p,
  today,
  onEdit,
}: {
  p: Procurement
  today: string
  onEdit: () => void
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const total = procurementTotalCny(p)
  const arrived = p.status === 'arrived'
  const st: DueState | null =
    !arrived && p.expectedDate ? dueState(p.expectedDate, today) : null

  function toggleArrived() {
    start(async () => {
      await mutate({
        kind: 'updateProcurement',
        procurementId: p.id,
        patch: { status: arrived ? 'ordered' : 'arrived' },
      })
      router.refresh()
    })
  }

  function del() {
    start(async () => {
      await mutate({ kind: 'deleteProcurement', procurementId: p.id })
      router.refresh()
    })
  }

  return (
    <div
      className={`group grid grid-cols-1 gap-3 border-b border-[var(--color-border)] px-5 py-4 last:border-b-0 md:grid-cols-[14px_minmax(0,1fr)_120px_180px_84px] md:items-center md:gap-4 ${
        arrived ? 'bg-[var(--color-bg)]/40' : 'hover:bg-[#faf8f2]'
      }`}
    >
      {/* Status dot — the single calm urgency signal at the start of the row. */}
      <div className="hidden md:flex md:justify-center">
        <StatusDot arrived={arrived} state={st} />
      </div>

      {/* Item + supplier */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <StatusDot arrived={arrived} state={st} className="md:hidden" />
          <span
            className={`truncate text-[14px] font-medium tracking-tight ${
              arrived
                ? 'text-[var(--color-ink-2)]'
                : 'text-[var(--color-ink)]'
            }`}
            title={p.item}
          >
            {p.item}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] text-[var(--color-ink-3)]">
          <span>{p.supplier || '供应商未填'}</span>
          {p.notes && (
            <span className="truncate text-[var(--color-ink-4)]" title={p.notes}>
              · {p.notes}
            </span>
          )}
        </div>
      </div>

      {/* Qty × unit price → total */}
      <div className="flex items-baseline justify-between md:flex-col md:items-end md:justify-center md:gap-0.5">
        <span className="label md:hidden">数量 · 单价</span>
        <div className="flex flex-col items-end leading-tight">
          <span className="mono text-[13px] text-[var(--color-ink)]">
            {typeof total === 'number' ? formatCny(total) : '—'}
          </span>
          <span className="mono text-[10px] text-[var(--color-ink-3)]">
            {fmtQty(p.qty)}
            {typeof p.unitPriceCny === 'number'
              ? ` × ${formatCny(p.unitPriceCny)}`
              : ''}
          </span>
        </div>
      </div>

      {/* Timeline: ordered → expected (or arrived) */}
      <div className="flex items-baseline justify-between md:block">
        <span className="label md:hidden">采购 → 到货</span>
        <Timeline p={p} arrived={arrived} state={st} today={today} />
      </div>

      {/* Buyer + actions */}
      <div className="flex items-center justify-between md:flex-col md:items-end md:gap-1.5">
        <span className="text-[12px] text-[var(--color-ink-2)] md:text-right">
          {p.buyer || '—'}
        </span>
        <div className="flex items-center gap-1">
          {confirmingDelete ? (
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
                onClick={() => setConfirmingDelete(false)}
                className="rounded-[2px] px-2 py-1 text-[11px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                取消
              </button>
            </>
          ) : (
            <div className="flex items-center gap-1 md:opacity-0 md:transition-opacity md:group-hover:opacity-100">
              <button
                type="button"
                onClick={toggleArrived}
                disabled={pending}
                className={`rounded-[2px] px-2 py-1 text-[11px] font-medium disabled:opacity-50 ${
                  arrived
                    ? 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
                    : 'text-[var(--color-success)] hover:bg-[var(--color-success-soft)]'
                }`}
              >
                {arrived ? '撤销到货' : '到货'}
              </button>
              <button
                type="button"
                onClick={onEdit}
                className="rounded-[2px] px-2 py-1 text-[11px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                编辑
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="rounded-[2px] px-2 py-1 text-[11px] text-[var(--color-ink-3)] hover:text-[var(--color-overdue)]"
              >
                删除
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Timeline({
  p,
  arrived,
  state,
  today,
}: {
  p: Procurement
  arrived: boolean
  state: DueState | null
  today: string
}) {
  if (arrived) {
    return (
      <div className="flex items-center gap-1.5 leading-tight">
        <span className="text-[12px] leading-none text-[var(--color-success)]">
          ✓
        </span>
        <span className="mono text-[12px] text-[var(--color-ink-2)]">
          {p.arrivedDate ?? '已到货'}
        </span>
        <span className="label text-[var(--color-ink-4)]">到货</span>
      </div>
    )
  }

  const tone =
    state === 'overdue'
      ? 'text-[var(--color-overdue)]'
      : state === 'today' || state === 'soon'
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--color-ink)]'

  let sub = '未定到货'
  if (p.expectedDate) {
    const d = daysFromToday(p.expectedDate, today)
    sub =
      state === 'overdue'
        ? `逾期 ${Math.abs(d)} 天`
        : state === 'today'
          ? '今日到货'
          : `${d} 天后`
  }

  return (
    <div className="flex flex-col leading-tight">
      <div className="flex items-center gap-1.5">
        <span className="mono text-[11px] text-[var(--color-ink-3)]">
          {p.orderDate}
        </span>
        <span className="text-[var(--color-ink-4)]">→</span>
        <span className={`mono text-[13px] ${tone}`}>
          {p.expectedDate ?? '—'}
        </span>
      </div>
      <span
        className={`label mt-0.5 ${
          state === 'overdue'
            ? 'text-[var(--color-overdue)]'
            : state === 'today' || state === 'soon'
              ? 'text-[var(--color-warning)]'
              : 'text-[var(--color-ink-3)]'
        }`}
      >
        {sub}
      </span>
    </div>
  )
}

function StatusDot({
  arrived,
  state,
  className = '',
}: {
  arrived: boolean
  state: DueState | null
  className?: string
}) {
  const color = arrived
    ? 'var(--color-success)'
    : state === 'overdue'
      ? 'var(--color-overdue)'
      : state === 'today' || state === 'soon'
        ? 'var(--color-warning)'
        : 'var(--color-info)'
  return (
    <span
      className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${className}`}
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number | string
  tone: 'neutral' | 'info' | 'overdue'
}) {
  const ring =
    tone === 'overdue'
      ? 'border-[var(--color-overdue)]/25'
      : tone === 'info'
        ? 'border-[var(--color-border-strong)]'
        : 'border-[var(--color-border)]'
  const valueColor =
    tone === 'overdue'
      ? 'text-[var(--color-overdue)]'
      : 'text-[var(--color-ink)]'
  return (
    <div
      className={`flex min-w-[88px] flex-col gap-0.5 rounded-[2px] border ${ring} bg-[var(--color-surface)] px-3 py-2`}
    >
      <span className="label text-[var(--color-ink-3)]">{label}</span>
      <span className={`mono text-[18px] font-medium leading-none ${valueColor}`}>
        {value}
      </span>
    </div>
  )
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="rounded-[2px] border border-dashed border-[var(--color-border)] py-24 text-center">
      <p className="text-[14px] text-[var(--color-ink-2)]">还没有采购记录</p>
      <p className="mt-1.5 text-[12px] text-[var(--color-ink-4)]">
        需要买什么零件、找哪家供应商、什么时候到 —— 记一笔，大家都看得见
      </p>
      <button
        type="button"
        onClick={onNew}
        className="mt-5 rounded-[2px] bg-[var(--color-ink)] px-4 py-2 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85"
      >
        新建第一笔采购
      </button>
    </div>
  )
}

// === New / edit modal ===

type Draft = {
  item: string
  supplier: string
  qty: string
  unitPrice: string
  orderDate: string
  expectedDate: string
  notes: string
}

function ProcurementModal({
  initial,
  buyer,
  today,
  onDone,
  onCancel,
}: {
  initial: Procurement | null
  buyer: string
  today: string
  onDone: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<Draft>(() => ({
    item: initial?.item ?? '',
    supplier: initial?.supplier ?? '',
    qty: initial?.qty != null ? String(initial.qty) : '',
    unitPrice: initial?.unitPriceCny != null ? String(initial.unitPriceCny) : '',
    orderDate: initial?.orderDate ?? today,
    expectedDate: initial?.expectedDate ?? '',
    notes: initial?.notes ?? '',
  }))
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Esc closes; lock body scroll while open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onCancel])

  function set<K extends keyof Draft>(k: K, v: Draft[K]) {
    setDraft((d) => ({ ...d, [k]: v }))
  }

  const qtyNum = parseNum(draft.qty)
  const priceNum = parseNum(draft.unitPrice)
  const liveTotal = procurementTotalCny({
    qty: qtyNum,
    unitPriceCny: priceNum,
  })

  function submit() {
    if (!draft.item.trim()) {
      setError('请填写采购项')
      return
    }
    if (!isDate(draft.orderDate)) {
      setError('采购日期格式应为 YYYY-MM-DD')
      return
    }
    if (draft.expectedDate && !isDate(draft.expectedDate)) {
      setError('预计到货格式应为 YYYY-MM-DD')
      return
    }
    setError(null)

    start(async () => {
      try {
        if (initial) {
          await mutate({
            kind: 'updateProcurement',
            procurementId: initial.id,
            patch: {
              item: draft.item.trim(),
              supplier: draft.supplier.trim() || null,
              qty: qtyNum ?? null,
              unitPriceCny: priceNum ?? null,
              orderDate: draft.orderDate.trim(),
              expectedDate: draft.expectedDate.trim() || null,
              notes: draft.notes.trim() || null,
            },
          })
        } else {
          await mutate({
            kind: 'createProcurement',
            input: {
              item: draft.item.trim(),
              supplier: draft.supplier.trim() || undefined,
              qty: qtyNum,
              unitPriceCny: priceNum,
              orderDate: draft.orderDate.trim(),
              expectedDate: draft.expectedDate.trim() || undefined,
              notes: draft.notes.trim() || undefined,
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
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 py-10 md:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="w-full max-w-[480px] rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-xl">
        <div className="flex items-baseline justify-between border-b border-[var(--color-border)] px-5 py-3.5">
          <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
            {initial ? '编辑采购' : '新建采购'}
          </h2>
          <span className="label text-[var(--color-ink-3)]">采购人 · {buyer}</span>
        </div>

        <div className="px-5 py-5">
          <Field label="采购项" required>
            <Input
              value={draft.item}
              onChange={(v) => set('item', v)}
              placeholder="所需零件 / 物料"
              autoFocus
            />
          </Field>

          <div className="mt-4">
            <Field label="供应商">
              <Input
                value={draft.supplier}
                onChange={(v) => set('supplier', v)}
                placeholder="从哪家买 · 可留空"
              />
            </Field>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-4">
            <Field label="数量">
              <Input
                value={draft.qty}
                onChange={(v) => set('qty', v)}
                placeholder="0"
                mono
                inputMode="decimal"
              />
            </Field>
            <Field label="单价 ¥">
              <Input
                value={draft.unitPrice}
                onChange={(v) => set('unitPrice', v)}
                placeholder="0"
                mono
                inputMode="decimal"
              />
            </Field>
          </div>

          <div className="mt-2 flex justify-end">
            <span className="label text-[var(--color-ink-3)]">
              合计{' '}
              <span className="mono text-[12px] text-[var(--color-ink)]">
                {typeof liveTotal === 'number' ? formatCny(liveTotal) : '—'}
              </span>
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-4">
            <Field label="采购日期" required>
              <Input
                value={draft.orderDate}
                onChange={(v) => set('orderDate', v)}
                placeholder="YYYY-MM-DD"
                mono
              />
            </Field>
            <Field label="预计到货">
              <Input
                value={draft.expectedDate}
                onChange={(v) => set('expectedDate', v)}
                placeholder="YYYY-MM-DD"
                mono
              />
            </Field>
          </div>

          {/* Quick presets for 预计到货 — intuition over typing dates. */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {[
              { label: '+3天', days: 3 },
              { label: '+1周', days: 7 },
              { label: '+2周', days: 14 },
              { label: '+1月', days: 30 },
            ].map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() =>
                  set(
                    'expectedDate',
                    addDays(
                      isDate(draft.orderDate) ? draft.orderDate : today,
                      preset.days,
                    ),
                  )
                }
                className="rounded-[2px] border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="mt-4">
            <Field label="备注">
              <textarea
                value={draft.notes}
                onChange={(e) => set('notes', e.target.value)}
                placeholder="规格 / 型号 / 用途 · 可留空"
                rows={2}
                className="w-full resize-none rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
              />
            </Field>
          </div>

          {error && (
            <p className="mt-4 text-[12px] text-[var(--color-overdue)]">{error}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-[var(--color-border)] px-5 py-3.5">
          <button
            type="button"
            onClick={onCancel}
            className="text-[13px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="rounded-[2px] bg-[var(--color-ink)] px-4 py-1.5 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
          >
            {pending ? '保存中…' : initial ? '保存' : '新建采购'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="label mb-1.5">
        {label}
        {required && <span className="text-[var(--color-overdue)]"> ·</span>}
      </p>
      {children}
    </div>
  )
}

function Input({
  value,
  onChange,
  placeholder,
  mono,
  autoFocus,
  inputMode,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
  autoFocus?: boolean
  inputMode?: 'text' | 'decimal'
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      inputMode={inputMode}
      className={`w-full rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)] ${
        mono ? 'mono' : ''
      }`}
    />
  )
}

// === helpers ===

function fmtQty(qty?: number): string {
  if (typeof qty !== 'number' || !Number.isFinite(qty)) return '数量未填'
  return `${qty} 件`
}

function parseNum(s: string): number | undefined {
  const t = s.trim()
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

function isDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s.trim())
}

// Add N days to a YYYY-MM-DD date, returning YYYY-MM-DD. UTC math so it never
// drifts across a DST boundary (and the factory's Shanghai tz has none anyway).
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000
  const dt = new Date(t)
  const yy = dt.getUTCFullYear()
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-ink-3)]"
    >
      <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.4" />
      <line
        x1="10.5"
        y1="10.5"
        x2="14"
        y2="14"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={`transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path
        d="M4.5 3 L7.5 6 L4.5 9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
