'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  Fragment,
} from 'react'
import { DEFAULT_ROUTE_STAGES, STAGES, type Component, type Stage } from '@/lib/data'
import { mutate } from '@/lib/mutate'
import {
  ComponentLineTotal,
  ComponentNotes,
  ComponentQty,
  ComponentSeqLabel,
  ComponentText,
  ComponentUnitPrice,
} from '@/app/_editable'
import { ComponentImageUploader } from '@/app/_image_uploader'
import { EffectiveStageCell } from '@/app/_stagecell'
import { StageChips } from '@/app/_stagechips'
import { PartDrawingChange } from '@/app/_part_drawing_change'
import { withBase } from '@/lib/base-path'
import { DeletePartButton } from './_part_delete'

// 添加零件 as a sheet gesture, not a button. Every row carries a + on the
// separator line beneath it (left gutter, over the frozen # column so it
// survives horizontal scroll); clicking it inserts a part RIGHT THERE — in
// the DB (positions shift, see insertComponentAfter) and on screen.
//
// The new <tr> is rendered client-side off the 30-byte mutate response, never
// via router.refresh() — the full RSC payload is what the GFW truncates for
// mainland users (the old "click add, wait, F5" experience). A reload folds
// these rows into the server table at exactly the same place.
//
// Rows inserted this visit can themselves be inserted under, so the local
// model is a tree: anchorId → the ids inserted directly beneath it, in order.

// A row added this visit: its id, plus the # the server gave it (a sub-number
// of the row above — 1.1). Absent for a row appended at the tail, which simply
// takes the next number in the sequence.
type Kid = { id: string; label?: string }

type Kids = Record<string, Kid[]>

type Ctx = {
  jobId: string
  // Field-level editing (names, qty, #, 备注) — also decides which COLUMNS the
  // sheet has, so it must stay exactly as it was.
  canEdit: boolean
  // Structural rights, narrower and per-person (lib/auth canCreatePartRow /
  // canDeletePartRow). canDeleteRow does not remove the 删除 column: the button
  // renders for every editor and explains itself when it can't act.
  canAddRow: boolean
  canDeleteRow: boolean
  showMoney: boolean
  totalCols: number
  kids: Kids
  ordinals: Map<string, number>
  insertAfter: (anchorId: string | null, id: string, label?: string) => void
  dropRow: (id: string) => void
}

const PartInsertCtx = createContext<Ctx | null>(null)

// Column count of the 零件进度 table — must track page.tsx's colgroup:
// 9 leading + stage grid + 出货记录/动态 + 备注 + money + 删除.
function countCols(canEdit: boolean, showMoney: boolean): number {
  return 9 + STAGES.length + 2 + (canEdit ? 1 : 0) + (showMoney ? 2 : 0) + (canEdit ? 1 : 0)
}

export function PartInsertProvider({
  jobId,
  serverRows,
  canEdit,
  canAddRow,
  canDeleteRow,
  showMoney,
  children,
}: {
  jobId: string
  // The server-rendered rows in sheet order, each with the ordinal the server
  // printed (# is the part's index in the FULL part list — while a 退货 scopes
  // the sheet, those base numbers have gaps, and they must keep them).
  serverRows: { id: string; base: number }[]
  canEdit: boolean
  canAddRow: boolean
  canDeleteRow: boolean
  showMoney: boolean
  children: React.ReactNode
}) {
  const [kids, setKids] = useState<Kids>({})

  const insertAfter = useCallback(
    (anchorId: string | null, id: string, label?: string) => {
      // anchorId null = the end of the sheet (empty job — nothing to insert
      // under yet). Keyed under '' so the tail strip owns that list.
      const key = anchorId ?? ''
      setKids((prev) => ({
        ...prev,
        [key]: [...(prev[key] ?? []), { id, label }],
      }))
    },
    [],
  )

  // A deleted row's own inserted children are real parts of their own — they
  // survive, re-parented to wherever the deleted row sat.
  const dropRow = useCallback((id: string) => {
    setKids((prev) => {
      const next: Kids = {}
      const orphans = prev[id] ?? []
      for (const [k, list] of Object.entries(prev)) {
        if (k === id) continue
        const i = list.findIndex((kid) => kid.id === id)
        next[k] =
          i < 0 ? list : [...list.slice(0, i), ...orphans, ...list.slice(i + 1)]
      }
      return next
    })
  }, [])

  // # for every row on screen. A server row NEVER moves: inserting above it
  // used to push its number down one, which is precisely what the floor
  // objected to (后壳 read 02 on paper and 03 on screen). The server now freezes
  // those numbers and hands the new row a sub-number of its anchor instead, so
  // here the server bases are simply left alone.
  //
  // The numbers below are the FALLBACK for a row added this visit that has no
  // label of its own (the tail append): it takes the next free number. A
  // sub-numbered row renders its label instead, so its entry is never read —
  // it exists only so a cleared field has something to fall back to.
  const ordinals = useMemo(() => {
    const m = new Map<string, number>()
    let next = 0
    for (const row of serverRows) {
      m.set(row.id, row.base)
      if (row.base > next) next = row.base
    }
    const walk = (id: string) => {
      for (const child of kids[id] ?? []) {
        next += 1
        m.set(child.id, next)
        walk(child.id)
      }
    }
    for (const row of serverRows) walk(row.id)
    walk('') // rows added to an empty sheet, below everything
    return m
  }, [serverRows, kids])

  const value = useMemo<Ctx>(
    () => ({
      jobId,
      canEdit,
      canAddRow,
      canDeleteRow,
      showMoney,
      totalCols: countCols(canEdit, showMoney),
      kids,
      ordinals,
      insertAfter,
      dropRow,
    }),
    [
      jobId,
      canEdit,
      canAddRow,
      canDeleteRow,
      showMoney,
      kids,
      ordinals,
      insertAfter,
      dropRow,
    ],
  )

  return (
    <PartInsertCtx.Provider value={value}>{children}</PartInsertCtx.Provider>
  )
}

// The row's # — server truth, shifted down by however many rows have been
// inserted above it this visit.
//
// Derived is only the DEFAULT. The customer's own drawing set sometimes numbers
// the parts differently than the order they arrived in, so an editor can type
// over the number and that value sticks (parts.seq_label, migration 0088);
// clearing it hands the row back to the sequence. Read-only scopes see plain
// text, exactly as before.
export function PartOrdinal({
  id,
  base,
  label,
}: {
  id: string
  base: number
  label?: string
}) {
  const ctx = useContext(PartInsertCtx)
  const n = ctx?.ordinals.get(id) ?? base
  const derived = String(n).padStart(2, '0')
  if (!ctx?.canEdit) return <>{label ?? derived}</>
  return (
    <ComponentSeqLabel
      jobId={ctx.jobId}
      componentId={id}
      value={label}
      derived={derived}
    />
  )
}

// The + itself. Absolutely positioned so it straddles the row's bottom border
// — the line IS the target, and the row it will appear under is the row you
// are hovering. Lives inside the frozen # cell, which needs
// `overflow: visible` (the .sheet rule clips) and a hover z-bump (the next
// row's frozen cells paint later otherwise).
export function RowInsert({ afterId }: { afterId: string | null }) {
  const ctx = useContext(PartInsertCtx)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!ctx || !ctx.canAddRow) return null

  const add = async () => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const r = await mutate<{ id?: string; seqLabel?: string }>(
        afterId
          ? {
              kind: 'insertComponentAfter',
              jobId: ctx.jobId,
              afterComponentId: afterId,
            }
          : { kind: 'appendComponent', jobId: ctx.jobId },
      )
      const id = 'data' in r ? r.data?.id : undefined
      if (!id) throw new Error('服务器未返回零件 ID')
      // The # the server pinned to this row (1.1 under 01) — painted straight
      // from the response, since this path never refreshes.
      const seqLabel = 'data' in r ? r.data?.seqLabel : undefined
      ctx.insertAfter(afterId, id, seqLabel)
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加失败')
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={add}
        disabled={pending}
        title="在此行下方插入零件"
        aria-label="在此行下方插入零件"
        className="row-insert absolute left-[18px] -bottom-[10px] z-10 inline-flex h-[20px] w-[20px] items-center justify-center rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-ink-3)] transition-colors hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)]"
      >
        <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
          <path
            d="M4.5 0.5 V8.5 M0.5 4.5 H8.5"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="square"
            className={pending ? 'opacity-40' : ''}
          />
        </svg>
      </button>
      {error && (
        <span
          role="alert"
          className="absolute left-[44px] -bottom-[11px] z-10 whitespace-nowrap rounded-[2px] bg-[var(--color-overdue-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-overdue)]"
        >
          {error}
        </span>
      )}
    </>
  )
}

// Rows inserted under `afterId` this visit, each followed by its own
// insertions. Rendered as a sibling of the server <tr> it belongs under.
export function InsertedRows({ afterId }: { afterId: string | null }) {
  const ctx = useContext(PartInsertCtx)
  if (!ctx) return null
  const list = ctx.kids[afterId ?? ''] ?? []
  if (list.length === 0) return null
  return (
    <>
      {list.map((kid) => (
        <Fragment key={kid.id}>
          <NewPartRow componentId={kid.id} seqLabel={kid.label} />
          <InsertedRows afterId={kid.id} />
        </Fragment>
      ))}
    </>
  )
}

// Bottom of the sheet: 12px of room so the last row's + (which straddles the
// final separator line) isn't clipped by the scroll container. On a job with
// no parts at all there is no row to hover, so the strip carries a visible +
// of its own.
export function PartsTailRoom() {
  const ctx = useContext(PartInsertCtx)
  const empty = (ctx?.ordinals.size ?? 0) === 0
  return (
    <>
      <InsertedRows afterId={null} />
      <tr>
        <td
          colSpan={ctx?.totalCols ?? 1}
          className="p-0"
          style={{
            height: empty && ctx?.canAddRow ? 40 : 12,
            borderRight: 'none',
            borderBottom: 'none',
            overflow: 'visible',
          }}
        >
          {empty && ctx?.canAddRow ? (
            <span className="flex items-center pl-3">
              <TailAdd />
            </span>
          ) : null}
        </td>
      </tr>
    </>
  )
}

function TailAdd() {
  const ctx = useContext(PartInsertCtx)!
  const [pending, setPending] = useState(false)
  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true)
        try {
          const r = await mutate<{ id?: string }>({
            kind: 'appendComponent',
            jobId: ctx.jobId,
          })
          const id = 'data' in r ? r.data?.id : undefined
          if (id) ctx.insertAfter(null, id)
        } finally {
          setPending(false)
        }
      }}
      className="inline-flex items-center gap-1.5 text-[12px] tracking-wider text-[var(--color-ink-3)] hover:text-[var(--color-ink)] disabled:opacity-50"
    >
      <span className="inline-flex h-[16px] w-[16px] items-center justify-center rounded-[2px] border border-[var(--color-border-strong)]">
        <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
          <path
            d="M4.5 0.5 V8.5 M0.5 4.5 H8.5"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="square"
          />
        </svg>
      </span>
      添加零件
    </button>
  )
}

// A part created this visit. Same cell-for-cell shape as the server row
// (including the three frozen identifier columns) so nothing shifts when the
// page is next loaded and the row comes back from the DB.
function NewPartRow({
  componentId,
  seqLabel,
}: {
  componentId: string
  seqLabel?: string
}) {
  const ctx = useContext(PartInsertCtx)!
  const { jobId, showMoney, canEdit } = ctx
  // Server truth for a fresh part: DEFAULT_NEW_PART_STAGES (== the default
  // route — opt-in 采购/表处 absent) seeded pending, nothing else set. Held in
  // state so 排工序 on this row re-slashes its own stage grid immediately.
  const [route, setRoute] = useState<Stage[]>(DEFAULT_ROUTE_STAGES)
  const component = useMemo<Component>(
    () => ({
      id: componentId,
      name: '',
      qty: 0,
      stages: Object.fromEntries(
        route.map((s) => [s, { status: 'pending' as const }]),
      ),
    }),
    [componentId, route],
  )

  return (
    <tr className="group align-middle">
      <td
        className="sticky-col px-1 py-3 text-center mono text-[var(--color-ink-3)] text-[12px]"
        style={{ left: 0, overflow: 'visible' }}
      >
        <PartOrdinal id={componentId} base={0} label={seqLabel} />
        <RowInsert afterId={componentId} />
      </td>
      <td className="sticky-col px-3 py-2" style={{ left: 56 }}>
        <ComponentImageUploader
          jobId={jobId}
          componentId={componentId}
          imageUrl={undefined}
          size={56}
        />
      </td>
      <td
        className="sticky-col sticky-col-edge px-3 py-3"
        style={{ left: 134 }}
      >
        <ComponentText
          jobId={jobId}
          componentId={componentId}
          field="name"
          value=""
          placeholder="零件名称"
          className="text-[14px] font-medium text-[var(--color-ink)]"
        />
        {/* Same second line as a server row — a fresh part gets its 检验报告
            and 图纸变更 immediately, and the row doesn't change height the
            next time the page loads. */}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <a
            href={withBase(
              `/jobs/${jobId}/print/inspection/${encodeURIComponent(componentId)}`,
            )}
            target="_blank"
            rel="noopener"
            className="text-[10px] tracking-wider text-[var(--color-ink-4)] hover:text-[var(--color-ink)] transition-colors whitespace-nowrap"
          >
            检验报告 ↗
          </a>
          <PartDrawingChange
            jobId={jobId}
            partId={componentId}
            partName=""
            changes={[]}
            canEdit={canEdit}
          />
        </div>
      </td>
      <td className="px-3 py-3">
        <ComponentText
          jobId={jobId}
          componentId={componentId}
          field="partNo"
          value={undefined}
          placeholder="—"
          className="mono text-[12px] text-[var(--color-ink-2)]"
        />
      </td>
      <td className="px-3 py-3 align-top">
        <ComponentText
          jobId={jobId}
          componentId={componentId}
          field="process"
          value={undefined}
          placeholder="—"
          multiline
          className="text-[12px] text-[var(--color-ink-2)] leading-snug"
        />
      </td>
      <td className="px-3 py-3 align-top">
        <ComponentQty
          jobId={jobId}
          componentId={componentId}
          value={0}
          className="text-[13px] text-[var(--color-ink)]"
        />
      </td>
      <td className="px-3 py-3 align-top">
        <ComponentText
          jobId={jobId}
          componentId={componentId}
          field="material"
          value={undefined}
          placeholder="材料"
          multiline
          className="text-[12px] text-[var(--color-ink-2)] leading-snug"
        />
      </td>
      <td className="px-3 py-3 align-top">
        <ComponentText
          jobId={jobId}
          componentId={componentId}
          field="surfaceTreatment"
          value={undefined}
          placeholder="表面处理"
          multiline
          className="text-[12px] text-[var(--color-ink-2)] leading-snug"
        />
      </td>
      {/* 工序 — a brand-new row routes the default way until someone prunes
          it, and prunes it from right here, same widget as every other row. */}
      <td className="px-3 py-3 align-top">
        <StageChips
          jobId={jobId}
          component={component}
          onRouteChange={setRoute}
        />
      </td>
      {STAGES.map((stage) => (
        <td key={stage} className="p-0 h-[60px]">
          <EffectiveStageCell
            jobId={jobId}
            component={component}
            stage={stage}
            interactive
          />
        </td>
      ))}
      <td className="px-3 py-3 align-top text-[var(--color-ink-4)] mono text-[11px]">
        —
      </td>
      <td className="px-3 py-3 align-top text-[var(--color-ink-4)] mono text-[11px]">
        —
      </td>
      {canEdit && (
        <td className="px-3 py-3 align-top">
          <ComponentNotes
            jobId={jobId}
            componentId={componentId}
            value={undefined}
            placeholder="添加备注…"
            multiline
            className="text-[12px] text-[var(--color-ink-2)] leading-snug"
          />
        </td>
      )}
      {showMoney && (
        <td className="px-3 py-3">
          <ComponentUnitPrice
            jobId={jobId}
            componentId={componentId}
            value={undefined}
            className="text-[13px] text-[var(--color-ink)]"
          />
        </td>
      )}
      {showMoney && (
        <td className="px-3 py-3">
          <ComponentLineTotal
            jobId={jobId}
            componentId={componentId}
            value={undefined}
            className="text-[13px] text-[var(--color-ink)]"
          />
        </td>
      )}
      {canEdit && (
        <td className="px-2 py-3 text-center align-middle">
          <DeletePartButton
            jobId={jobId}
            componentId={componentId}
            componentName=""
            allowed={ctx.canDeleteRow}
            onDeleted={() => ctx.dropRow(componentId)}
          />
        </td>
      )}
    </tr>
  )
}
