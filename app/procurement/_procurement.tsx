'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import {
  dueState,
  daysFromToday,
  formatCny,
  procurementTotalCny,
  PROCUREMENT_CATEGORIES,
} from '@/lib/data'
import type {
  DueState,
  Procurement,
  ProcurementProduct,
} from '@/lib/data'

// 采购 board. One calm ordered queue: what's on the way (sorted so the soonest
// and the overdue float to the top — the question the floor actually asks),
// then what's already landed, dimmed and out of the way.
//
// New here vs. the first cut: every purchase is a 物料 you PICK, not a name you
// retype. The 物料库 (catalog) remembers the 淘宝/1688 链接, the shop and the
// going price; 新建采购 opens straight onto a search-or-create picker. The
// ledger row stays bare — dot, 品名 (clickable to its 链接), 数量×单价, 预计到货,
// 采购人. No arrows, no timeline soup.

type Mode = { kind: 'new' } | { kind: 'edit'; row: Procurement } | null

export function ProcurementBoard({
  procurements,
  products,
  currentUser,
  today,
}: {
  procurements: Procurement[]
  products: ProcurementProduct[]
  currentUser: string
  today: string
}) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [mode, setMode] = useState<Mode>(null)

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

  const [showArrived, setShowArrived] = useState(false)

  const stats = useMemo(() => {
    const open = procurements.filter((p) => p.status === 'ordered')
    let overdue = 0
    let soon = 0
    let openValue = 0
    for (const p of open) {
      if (p.expectedDate) {
        const st = dueState(p.expectedDate, today)
        if (st === 'overdue') overdue++
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
          <Stat label="一周内到货" value={stats.soon} tone="info" />
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
              placeholder="搜索 · 品名 / 供应商 / 采购人"
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
                <span className="label">已到货 · {arrived.length}</span>
              </button>
              {showArrived && (
                <Section
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
          products={products}
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
  rows,
  today,
  empty,
  onEdit,
}: {
  rows: Procurement[]
  today: string
  empty: string
  onEdit: (row: Procurement) => void
}) {
  return (
    <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
      {/* Column header — desktop only; on mobile each row is self-labeling. */}
      <div className="hidden grid-cols-[14px_minmax(0,1fr)_120px_150px_84px] items-center gap-4 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid">
        <span />
        <span className="label">品名 · 供应商</span>
        <span className="label text-right">数量 · 单价</span>
        <span className="label">预计到货</span>
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
      className={`group grid grid-cols-1 gap-3 border-b border-[var(--color-border)] px-5 py-4 last:border-b-0 md:grid-cols-[14px_minmax(0,1fr)_120px_150px_84px] md:items-center md:gap-4 ${
        arrived ? 'bg-[var(--color-bg)]/40' : 'hover:bg-[#faf8f2]'
      }`}
    >
      {/* Status dot — the single calm urgency signal at the start of the row. */}
      <div className="hidden md:flex md:justify-center">
        <StatusDot arrived={arrived} state={st} />
      </div>

      {/* 品名 (clickable to its 链接) + supplier */}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <StatusDot arrived={arrived} state={st} className="md:hidden" />
          <ItemName item={p.item} link={p.link} dim={arrived} />
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

      {/* 数量 × 单价 → 金额 */}
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

      {/* 预计到货 — plain date + urgency, no arrows */}
      <div className="flex items-baseline justify-between md:block">
        <span className="label md:hidden">预计到货</span>
        <Due p={p} arrived={arrived} state={st} today={today} />
      </div>

      {/* 采购人 + actions */}
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

// 品名 — a link if the purchase carries one (淘宝/1688), plain text otherwise.
// The small glyph is the only affordance; the whole name is the hit target.
function ItemName({
  item,
  link,
  dim,
}: {
  item: string
  link?: string
  dim: boolean
}) {
  const cls = `truncate text-[14px] font-medium tracking-tight ${
    dim ? 'text-[var(--color-ink-2)]' : 'text-[var(--color-ink)]'
  }`
  if (link && isHttp(link)) {
    return (
      <a
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        className={`group/link inline-flex min-w-0 items-center gap-1 hover:underline ${cls}`}
        title={item}
      >
        <span className="truncate">{item}</span>
        <LinkGlyph />
      </a>
    )
  }
  return (
    <span className={cls} title={item}>
      {item}
    </span>
  )
}

function Due({
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

  const dateTone =
    state === 'overdue'
      ? 'text-[var(--color-overdue)]'
      : state === 'today' || state === 'soon'
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--color-ink)]'
  const labelTone =
    state === 'overdue'
      ? 'text-[var(--color-overdue)]'
      : state === 'today' || state === 'soon'
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--color-ink-3)]'

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
      <span className={`mono text-[13px] ${dateTone}`}>
        {p.expectedDate ?? '—'}
      </span>
      <span className={`label mt-0.5 ${labelTone}`}>{sub}</span>
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
        买什么、从哪家、什么时候到 —— 选个物料记一笔，大家都看得见
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

// ===========================================================================
// New / edit modal — product-first.
//
// Three faces of one modal:
//   'pick'   — search the 物料库 or jump to 新建物料 (the default for a new buy)
//   'create' — the 物料 form (name + 链接 + shop + price + spec)
//   'form'   — the purchase itself: a picked 物料 up top, then 数量 / 日期 / 备注
// ===========================================================================

type Selected = {
  productId?: string
  name: string
  category?: string
  supplier: string
  link: string
}

type Face = 'pick' | 'create' | 'form'

function ProcurementModal({
  initial,
  products,
  buyer,
  today,
  onDone,
  onCancel,
}: {
  initial: Procurement | null
  products: ProcurementProduct[]
  buyer: string
  today: string
  onDone: () => void
  onCancel: () => void
}) {
  const router = useRouter()
  // Locally tracked so a 新建物料 / edit shows up in the picker immediately,
  // before the page-level router.refresh() catches up.
  const [catalog, setCatalog] = useState<ProcurementProduct[]>(products)

  const [selected, setSelected] = useState<Selected | null>(() =>
    initial
      ? {
          productId: initial.productId,
          name: initial.item,
          supplier: initial.supplier ?? '',
          link: initial.link ?? '',
        }
      : null,
  )
  const [face, setFace] = useState<Face>(initial ? 'form' : 'pick')
  // Pre-fill the 新建物料 form's name when the picker search came up dry.
  const [createSeedName, setCreateSeedName] = useState('')
  // The 物料 being edited (vs. created) when the 'create' face is showing.
  const [editing, setEditing] = useState<ProcurementProduct | null>(null)

  // Per-purchase fields (not the catalog).
  const [qty, setQty] = useState(initial?.qty != null ? String(initial.qty) : '')
  const [unitPrice, setUnitPrice] = useState(
    initial?.unitPriceCny != null ? String(initial.unitPriceCny) : '',
  )
  const [orderDate, setOrderDate] = useState(initial?.orderDate ?? today)
  const [expectedDate, setExpectedDate] = useState(initial?.expectedDate ?? '')
  const [notes, setNotes] = useState(initial?.notes ?? '')

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

  function pickProduct(p: ProcurementProduct) {
    setSelected({
      productId: p.id,
      name: p.name,
      category: p.category,
      supplier: p.supplier ?? '',
      link: p.link ?? '',
    })
    // Default this purchase's 单价 to the 物料's going price; the buyer can
    // still override (the row snapshots whatever they confirm).
    if (typeof p.unitPriceCny === 'number' && !unitPrice) {
      setUnitPrice(String(p.unitPriceCny))
    }
    setError(null)
    setFace('form')
  }

  const qtyNum = parseNum(qty)
  const priceNum = parseNum(unitPrice)
  const liveTotal = procurementTotalCny({ qty: qtyNum, unitPriceCny: priceNum })

  function submit() {
    if (!selected || !selected.name.trim()) {
      setError('请先选择或新建一个物料')
      setFace('pick')
      return
    }
    if (!isDate(orderDate)) {
      setError('采购日期格式应为 YYYY-MM-DD')
      return
    }
    if (expectedDate && !isDate(expectedDate)) {
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
              item: selected.name.trim(),
              supplier: selected.supplier.trim() || null,
              link: selected.link.trim() || null,
              qty: qtyNum ?? null,
              unitPriceCny: priceNum ?? null,
              orderDate: orderDate.trim(),
              expectedDate: expectedDate.trim() || null,
              notes: notes.trim() || null,
            },
          })
        } else {
          await mutate({
            kind: 'createProcurement',
            input: {
              item: selected.name.trim(),
              productId: selected.productId || undefined,
              supplier: selected.supplier.trim() || undefined,
              link: selected.link.trim() || undefined,
              qty: qtyNum,
              unitPriceCny: priceNum,
              orderDate: orderDate.trim(),
              expectedDate: expectedDate.trim() || undefined,
              notes: notes.trim() || undefined,
            },
          })
        }
        onDone()
      } catch (e) {
        setError(e instanceof Error ? e.message : '保存失败')
      }
    })
  }

  const titleByFace =
    face === 'pick' ? '选择物料' : face === 'create' ? '新建物料' : initial ? '编辑采购' : '新建采购'

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
            {titleByFace}
          </h2>
          <span className="label text-[var(--color-ink-3)]">采购人 · {buyer}</span>
        </div>

        {face === 'pick' && (
          <ProductPicker
            catalog={catalog}
            onPick={pickProduct}
            onCreateNew={(seed) => {
              setCreateSeedName(seed)
              setFace('create')
            }}
            onEdit={(p) => {
              setCreateSeedName('')
              setEditing(p)
              setFace('create')
            }}
          />
        )}

        {face === 'create' && (
          <ProductForm
            seedName={createSeedName}
            editing={editing}
            onSaved={(p) => {
              setCatalog((c) => {
                const without = c.filter((x) => x.id !== p.id)
                return [p, ...without]
              })
              setEditing(null)
              router.refresh()
              // A freshly created 物料 selects straight into the purchase;
              // an edit just returns to the picker.
              if (editing) setFace('pick')
              else pickProduct(p)
            }}
            onDeleted={(id) => {
              setCatalog((c) => c.filter((x) => x.id !== id))
              setEditing(null)
              router.refresh()
              setFace('pick')
            }}
            onCancel={() => {
              setEditing(null)
              setFace('pick')
            }}
          />
        )}

        {face === 'form' && selected && (
          <>
            <div className="px-5 py-5">
              {/* Picked 物料 card */}
              <SelectedCard
                selected={selected}
                onChange={() => setFace('pick')}
              />

              <div className="mt-4 grid grid-cols-2 gap-4">
                <Field label="数量">
                  <Input
                    value={qty}
                    onChange={setQty}
                    placeholder="0"
                    mono
                    inputMode="decimal"
                    autoFocus
                  />
                </Field>
                <Field label="单价 ¥">
                  <Input
                    value={unitPrice}
                    onChange={setUnitPrice}
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
                    value={orderDate}
                    onChange={setOrderDate}
                    placeholder="YYYY-MM-DD"
                    mono
                  />
                </Field>
                <Field label="预计到货">
                  <Input
                    value={expectedDate}
                    onChange={setExpectedDate}
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
                      setExpectedDate(
                        addDays(
                          isDate(orderDate) ? orderDate : today,
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
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="本次用途 / 数量说明 · 可留空"
                    rows={2}
                    className="w-full resize-none rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
                  />
                </Field>
              </div>

              {error && (
                <p className="mt-4 text-[12px] text-[var(--color-overdue)]">
                  {error}
                </p>
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
          </>
        )}
      </div>
    </div>
  )
}

// ===========================================================================

function SelectedCard({
  selected,
  onChange,
}: {
  selected: Selected
  onChange: () => void
}) {
  return (
    <div className="rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {selected.category && <CategoryChip category={selected.category} />}
            <span className="truncate text-[14px] font-medium tracking-tight text-[var(--color-ink)]">
              {selected.name}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-[var(--color-ink-3)]">
            <span>{selected.supplier || '供应商未填'}</span>
            {selected.link && isHttp(selected.link) && (
              <a
                href={selected.link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[var(--color-info)] hover:underline"
              >
                链接 <LinkGlyph />
              </a>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onChange}
          className="shrink-0 rounded-[2px] border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
        >
          更换
        </button>
      </div>
    </div>
  )
}

function ProductPicker({
  catalog,
  onPick,
  onCreateNew,
  onEdit,
}: {
  catalog: ProcurementProduct[]
  onPick: (p: ProcurementProduct) => void
  onCreateNew: (seed: string) => void
  onEdit: (p: ProcurementProduct) => void
}) {
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()
  const results = useMemo(() => {
    if (!query) return catalog
    return catalog.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        (p.supplier ?? '').toLowerCase().includes(query) ||
        (p.category ?? '').toLowerCase().includes(query) ||
        (p.notes ?? '').toLowerCase().includes(query),
    )
  }, [catalog, query])

  return (
    <div className="px-5 py-5">
      <div className="relative">
        <SearchIcon />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索物料 · 品名 / 类别 / 供应商"
          autoFocus
          className="h-10 w-full rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] pl-8 pr-3 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
        />
      </div>

      <div className="mt-3 max-h-[320px] overflow-y-auto rounded-[2px] border border-[var(--color-border)]">
        {results.length === 0 ? (
          <p className="px-4 py-8 text-center text-[12px] text-[var(--color-ink-4)]">
            {catalog.length === 0
              ? '物料库还是空的 —— 新建第一个常用物料'
              : '没有匹配的物料'}
          </p>
        ) : (
          results.map((p) => (
            <div
              key={p.id}
              className="group/item flex items-center gap-3 border-b border-[var(--color-border)] last:border-b-0 hover:bg-[#faf8f2]"
            >
              <button
                type="button"
                onClick={() => onPick(p)}
                className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {p.category && <CategoryChip category={p.category} />}
                    <span className="truncate text-[13px] font-medium text-[var(--color-ink)]">
                      {p.name}
                    </span>
                    {p.link && isHttp(p.link) && (
                      <span className="text-[var(--color-info)]">
                        <LinkGlyph />
                      </span>
                    )}
                  </div>
                  <span className="mt-0.5 block truncate text-[11px] text-[var(--color-ink-3)]">
                    {p.supplier || '供应商未填'}
                  </span>
                </div>
                <span className="mono shrink-0 text-[12px] text-[var(--color-ink-2)]">
                  {typeof p.unitPriceCny === 'number'
                    ? formatCny(p.unitPriceCny)
                    : '—'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onEdit(p)}
                className="shrink-0 rounded-[2px] py-0.5 pr-4 pl-1.5 text-[11px] text-[var(--color-ink-4)] opacity-0 hover:text-[var(--color-ink)] group-hover/item:opacity-100"
              >
                编辑
              </button>
            </div>
          ))
        )}
      </div>

      <button
        type="button"
        onClick={() => onCreateNew(q.trim())}
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-3 py-2.5 text-[13px] font-medium text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
      >
        <Plus />
        {q.trim() ? `新建物料「${q.trim()}」` : '新建物料'}
      </button>
    </div>
  )
}

function ProductForm({
  seedName,
  editing,
  onSaved,
  onDeleted,
  onCancel,
}: {
  seedName: string
  editing: ProcurementProduct | null
  onSaved: (p: ProcurementProduct) => void
  onDeleted: (id: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(editing?.name ?? seedName)
  const [category, setCategory] = useState(editing?.category ?? '')
  const [supplier, setSupplier] = useState(editing?.supplier ?? '')
  const [link, setLink] = useState(editing?.link ?? '')
  const [price, setPrice] = useState(
    editing?.unitPriceCny != null ? String(editing.unitPriceCny) : '',
  )
  const [notes, setNotes] = useState(editing?.notes ?? '')
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  function save() {
    if (!name.trim()) {
      setError('请填写品名')
      return
    }
    if (link.trim() && !isHttp(link.trim())) {
      setError('链接需以 http(s):// 开头')
      return
    }
    setError(null)
    const priceNum = parseNum(price)
    start(async () => {
      try {
        if (editing) {
          await mutate({
            kind: 'updateProcurementProduct',
            productId: editing.id,
            patch: {
              name: name.trim(),
              category: category.trim() || null,
              supplier: supplier.trim() || null,
              link: link.trim() || null,
              unitPriceCny: priceNum ?? null,
              notes: notes.trim() || null,
            },
          })
          onSaved({
            ...editing,
            name: name.trim(),
            category: category.trim() || undefined,
            supplier: supplier.trim() || undefined,
            link: link.trim() || undefined,
            unitPriceCny: priceNum,
            notes: notes.trim() || undefined,
          })
        } else {
          const res = await mutate<{ product: ProcurementProduct }>({
            kind: 'createProcurementProduct',
            input: {
              name: name.trim(),
              category: category.trim() || undefined,
              supplier: supplier.trim() || undefined,
              link: link.trim() || undefined,
              unitPriceCny: priceNum,
              notes: notes.trim() || undefined,
            },
          })
          onSaved(res.data.product)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : '保存失败')
      }
    })
  }

  function del() {
    if (!editing) return
    start(async () => {
      try {
        await mutate({
          kind: 'deleteProcurementProduct',
          productId: editing.id,
        })
        onDeleted(editing.id)
      } catch (e) {
        setError(e instanceof Error ? e.message : '删除失败')
      }
    })
  }

  return (
    <>
      <div className="px-5 py-5">
        <Field label="品名" required>
          <Input
            value={name}
            onChange={setName}
            placeholder="如 6mm 四刃硬质合金立铣刀"
            autoFocus
          />
        </Field>

        <div className="mt-4">
          <p className="label mb-1.5">类别</p>
          <div className="flex flex-wrap gap-1.5">
            {PROCUREMENT_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory((cur) => (cur === c ? '' : c))}
                className={`rounded-[2px] border px-2.5 py-1 text-[12px] ${
                  category === c
                    ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-surface)]'
                    : 'border-[var(--color-border)] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <Field label="链接 · 淘宝 / 1688 / 京东">
            <Input
              value={link}
              onChange={setLink}
              placeholder="https://item.taobao.com/…"
            />
          </Field>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4">
          <Field label="默认供应商 / 店铺">
            <Input
              value={supplier}
              onChange={setSupplier}
              placeholder="店铺名 · 可留空"
            />
          </Field>
          <Field label="参考单价 ¥">
            <Input
              value={price}
              onChange={setPrice}
              placeholder="0"
              mono
              inputMode="decimal"
            />
          </Field>
        </div>

        <div className="mt-4">
          <Field label="规格 / 型号">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="材质 / 尺寸 / 型号 · 可留空"
              rows={2}
              className="w-full resize-none rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
            />
          </Field>
        </div>

        {error && (
          <p className="mt-4 text-[12px] text-[var(--color-overdue)]">{error}</p>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] px-5 py-3.5">
        <div>
          {editing &&
            (confirmingDelete ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={del}
                  disabled={pending}
                  className="text-[12px] font-medium text-[var(--color-overdue)] hover:underline disabled:opacity-50"
                >
                  确认删除
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="text-[12px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
              >
                删除物料
              </button>
            ))}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="text-[13px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            返回
          </button>
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="rounded-[2px] bg-[var(--color-ink)] px-4 py-1.5 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
          >
            {pending ? '保存中…' : editing ? '保存物料' : '新建并选用'}
          </button>
        </div>
      </div>
    </>
  )
}

function CategoryChip({ category }: { category: string }) {
  return (
    <span className="shrink-0 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] leading-none text-[var(--color-ink-3)]">
      {category}
    </span>
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

function isHttp(s: string): boolean {
  return /^https?:\/\//i.test(s.trim())
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

function LinkGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M4.5 2.5 H9.5 V7.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 2.5 L4 8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M8 9.5 H2.5 V4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Plus() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M6 2.5 V9.5 M2.5 6 H9.5"
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
