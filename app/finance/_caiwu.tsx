'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { mutate } from '@/lib/mutate'
import type { CaiwuRow, CaiwuSheet } from '@/lib/data'
import { showToast } from '@/app/_toast'

// 财务 — the finance clerk's two spreadsheets, rebuilt with the SAME Excel-cell
// model as 重点 (app/daily/_daily.tsx). This board IS her Excel:
//
//   • Empty rows always wait below the last filled one — start typing and the
//     next blank row is already there.
//   • Every cell is a cell. 工号 autocompletes against live jobs (picking one
//     lights up 客户名称 / 联系人 from the master read); those are then freely
//     editable TEXT — overrides that live on this sheet only and never write
//     back to the job. Everything else is dumb free text. NOTHING is computed —
//     剩余 / 分期 stay inside her 收款记录 / 开票情况 log, exactly as in Excel.
//   • Rows drag to reorder (grab the row number). Right-click: insert / copy /
//     paste / delete. A multi-line clipboard pasted into the first cell becomes
//     rows — paste a whole block straight out of her old .xlsx.
//
// Persistence is invisible: a row saves itself the moment a cell commits
// (blur / Enter); edits patch in place; order saves on drop. No save button.

// Live job fields joined onto a caiwu row, built server-side from the master
// read (commerce-only page, so customer is always present).
export type CaiwuJobLite = {
  id: string
  jobNo: string
  customer: string
  contact: string // job.engineer — 联系人
  isShipped: boolean
}

// Free-text columns whose key maps 1:1 onto a CaiwuRow field and a CaiwuPatch
// field. The 工号 anchor (job link) is handled apart.
const VALUE_KEYS = [
  'customer',
  'contact',
  'date',
  'orderNo',
  'qty',
  'billable',
  'amount',
  'tax',
  'amountIncl',
  'invoiceNo',
  'log',
] as const
type ValueKey = (typeof VALUE_KEYS)[number]
type AnchorKey = 'jobNo'
type ColKey = AnchorKey | ValueKey

type CellKind = 'anchor' | 'override' | 'text' | 'amount' | 'note'

type ColDef = {
  key: ColKey
  header: string
  kind: CellKind
  width?: number
  minWidth?: number
  /** Live-join value for anchor / override cells (undefined ⇒ show the job's). */
  live?: (job?: CaiwuJobLite) => string
  tint?: 'green' | 'yellow'
  placeholder?: string
}

// The two sheets. Column ORDER leads with the 工号 anchor (where you add the
// job), matching the 重点 grid, then follows her sheet's columns.
const SHEETS: Record<CaiwuSheet, { cols: ColDef[]; hint: string }> = {
  weikaipiao: {
    hint: '输入工号自动带出客户 / 联系人 · 全部可直接改文字（只改本表，不动工单） · 开票情况随手记 · 拖行号排序 · 右键插行 / 删除 · 可整块粘贴 Excel',
    cols: [
      { key: 'jobNo', header: '内部流水号', kind: 'anchor', width: 168, live: (j) => j?.jobNo ?? '' },
      { key: 'customer', header: '客户名称', kind: 'override', width: 140, live: (j) => j?.customer ?? '' },
      { key: 'contact', header: '联系人', kind: 'override', width: 120, live: (j) => j?.contact ?? '' },
      { key: 'date', header: '日期', kind: 'text', width: 92 },
      { key: 'qty', header: '下单数量', kind: 'text', width: 88 },
      { key: 'orderNo', header: '订单号/物料号', kind: 'text', minWidth: 240 },
      { key: 'billable', header: '是否收费', kind: 'text', width: 84 },
      { key: 'amount', header: '未开票金额', kind: 'amount', width: 122 },
      { key: 'log', header: '开票情况', kind: 'note', minWidth: 320, tint: 'yellow' },
    ],
  },
  kaipiao: {
    hint: '可关联工号自动带出客户 · 客户名称即对账标题，随手改 · 收款记录随手记，剩余写在里面 · 拖行号排序 · 右键插行 / 删除 · 可整块粘贴 Excel',
    cols: [
      { key: 'jobNo', header: '工号', kind: 'anchor', width: 140, live: (j) => j?.jobNo ?? '' },
      { key: 'customer', header: '客户名称 / 对账', kind: 'override', minWidth: 240, live: (j) => j?.customer ?? '' },
      { key: 'amount', header: '订单金额', kind: 'amount', width: 112 },
      { key: 'date', header: '开票日期', kind: 'text', width: 100 },
      { key: 'tax', header: '税金金额', kind: 'amount', width: 100 },
      { key: 'amountIncl', header: '含税金额', kind: 'amount', width: 112 },
      { key: 'invoiceNo', header: '发票号码', kind: 'text', width: 210 },
      { key: 'log', header: '收款记录', kind: 'note', minWidth: 320, tint: 'green' },
    ],
  },
}

// One grid row. Drafts (persisted=false) are the trailing blank rows.
type Row = {
  id: string
  jobId?: string
  jobNoText: string
  v: Partial<Record<ValueKey, string>>
  position: number
  persisted: boolean
}

type ServerPatch = {
  jobId?: string | null
  jobNoText?: string
  position?: number
} & Partial<Record<ValueKey, string | null>>

function pickValues(it: CaiwuRow): Partial<Record<ValueKey, string>> {
  const v: Partial<Record<ValueKey, string>> = {}
  for (const k of VALUE_KEYS) {
    const val = it[k]
    if (val !== undefined) v[k] = val
  }
  return v
}

function rowHasContent(r: Row): boolean {
  if (r.jobId || r.jobNoText.trim()) return true
  return VALUE_KEYS.some((k) => r.v[k]?.trim())
}

// Fractional slots for inserting `count` rows between two neighbors —
// insert-anywhere without renumbering the whole sheet.
function slotsBetween(
  prev: number | undefined,
  next: number | undefined,
  count: number,
): number[] {
  const out: number[] = []
  if (prev === undefined && next === undefined) {
    for (let i = 1; i <= count; i++) out.push(i)
  } else if (next === undefined) {
    for (let i = 1; i <= count; i++) out.push((prev as number) + i)
  } else if (prev === undefined) {
    for (let i = count; i >= 1; i--) out.push(next - i)
  } else {
    const step = (next - prev) / (count + 1)
    for (let i = 1; i <= count; i++) out.push(prev + step * i)
  }
  return out
}

export function CaiwuSheetGrid({
  sheet,
  items,
  jobById,
  jobIndex,
}: {
  sheet: CaiwuSheet
  items: CaiwuRow[]
  jobById: Record<string, CaiwuJobLite>
  jobIndex: CaiwuJobLite[]
}) {
  const { cols, hint } = SHEETS[sheet]
  const valueCols = useMemo(() => cols.filter((c) => c.kind !== 'anchor'), [cols])

  const seq = useRef(0)
  const newDraft = (position: number): Row => ({
    id: `draft-${++seq.current}`,
    jobNoText: '',
    v: {},
    position,
    persisted: false,
  })

  // The sheet is the truth for this session; server state seeds it, every edit
  // applies locally first and persists in the background (no router.refresh —
  // it would clobber in-flight cells). Switching tabs remounts (key={sheet}).
  const [rows, setRows] = useState<Row[]>(() => {
    const seeded: Row[] = items.map((it) => ({
      id: it.id,
      jobId: it.jobId,
      jobNoText: it.jobNoText,
      v: pickValues(it),
      position: it.position,
      persisted: true,
    }))
    const last = seeded[seeded.length - 1]?.position ?? 0
    seeded.push(newDraft(last + 1))
    return seeded
  })
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  const creating = useRef(new Map<string, Promise<string>>())
  const clipboard = useRef<Omit<Row, 'id' | 'position' | 'persisted'> | null>(null)

  const [menu, setMenu] = useState<{ x: number; y: number; rowId: string } | null>(null)
  const [drag, setDrag] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ rowId: string; edge: 'top' | 'bottom' } | null>(null)

  // Focus registry so Enter walks DOWN a column, Excel-style.
  const cellRefs = useRef(new Map<string, HTMLInputElement | HTMLTextAreaElement>())
  const cellKey = (rowId: string, col: ColKey) => `${rowId}:${col}`
  const registerCell =
    (rowId: string, col: ColKey) => (el: HTMLInputElement | HTMLTextAreaElement | null) => {
      const k = cellKey(rowId, col)
      if (el) cellRefs.current.set(k, el)
      else cellRefs.current.delete(k)
    }
  const focusCell = (rowId: string, col: ColKey) => {
    requestAnimationFrame(() => cellRefs.current.get(cellKey(rowId, col))?.focus())
  }
  const focusDown = (rowId: string, col: ColKey) => {
    const rs = rowsRef.current
    const i = rs.findIndex((r) => r.id === rowId)
    const below = rs[i + 1]
    if (below) focusCell(below.id, col)
  }

  // Single mutation gate: apply locally, keep ≥1 trailing blank row.
  const apply = (mut: (prev: Row[]) => Row[]) => {
    let next = mut(rowsRef.current)
    const last = next[next.length - 1]
    if (!last || last.persisted || rowHasContent(last)) {
      next = [...next, newDraft((last?.position ?? 0) + 1)]
    }
    rowsRef.current = next
    setRows(next)
  }

  // First keystroke in the LAST row → reveal the next blank immediately (before
  // any commit, so apply()'s has-content check can't yet see the typed text).
  const onCellDirty = (rowId: string) => {
    const rs = rowsRef.current
    const last = rs[rs.length - 1]
    if (last?.id === rowId) {
      const next = [...rs, newDraft(last.position + 1)]
      rowsRef.current = next
      setRows(next)
    }
  }

  const toast = (verb: string, e: unknown) =>
    showToast(`${verb}失败 · ${e instanceof Error ? e.message : '网络中断'}`, 'warning')

  const rowToInput = (row: Row) => {
    const input: Record<string, unknown> = {
      sheet,
      jobId: row.jobId,
      jobNoText: row.jobNoText,
      position: row.position,
    }
    for (const k of VALUE_KEYS) input[k] = row.v[k] ?? null
    return input
  }

  // Persist a row's create exactly once; resolves to the real id.
  const ensureCreated = (row: Row): Promise<string> => {
    const inFlight = creating.current.get(row.id)
    if (inFlight) return inFlight
    const p = (async () => {
      const res = await mutate<{ id: string }>({ kind: 'createCaiwu', input: rowToInput(row) })
      const realId = res.data.id
      apply((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, id: realId, persisted: true } : r)),
      )
      return realId
    })()
    creating.current.set(row.id, p)
    p.catch(() => creating.current.delete(row.id)) // allow retry on next commit
    return p
  }

  const persistPatch = (row: Row, patch: ServerPatch) => {
    void (async () => {
      try {
        if (row.persisted) {
          await mutate({ kind: 'updateCaiwu', itemId: row.id, patch })
        } else if (creating.current.has(row.id)) {
          const realId = await creating.current.get(row.id)!
          await mutate({ kind: 'updateCaiwu', itemId: realId, patch })
        } else if (rowHasContent(row)) {
          await ensureCreated(row)
        }
      } catch (e) {
        toast('保存', e)
      }
    })()
  }

  // A value cell committed: merge locally, persist the single changed field.
  const commitValue = (rowId: string, key: ValueKey, value: string | undefined) => {
    let merged: Row | undefined
    apply((prev) =>
      prev.map((r) => (r.id === rowId ? (merged = { ...r, v: { ...r.v, [key]: value } }) : r)),
    )
    if (merged) persistPatch(merged, { [key]: value ?? null })
  }

  // The 工号 anchor committed (link a job, or free-text it).
  const commitAnchor = (rowId: string, jobId: string | undefined, jobNoText: string) => {
    let merged: Row | undefined
    apply((prev) =>
      prev.map((r) => (r.id === rowId ? (merged = { ...r, jobId, jobNoText }) : r)),
    )
    if (merged) persistPatch(merged, { jobId: jobId ?? null, jobNoText })
  }

  const insertRow = (at: number, content?: Omit<Row, 'id' | 'position' | 'persisted'>) => {
    const rs = rowsRef.current
    const prev = rs[at - 1]?.position
    const next = rs[at]?.position
    const [pos] = slotsBetween(prev, next, 1)
    const row: Row = {
      jobNoText: content?.jobNoText ?? '',
      jobId: content?.jobId,
      v: content ? { ...content.v } : {},
      id: `draft-${++seq.current}`,
      position: pos,
      persisted: false,
    }
    apply((p) => [...p.slice(0, at), row, ...p.slice(at)])
    if (rowHasContent(row)) void ensureCreated(row).catch((e) => toast('保存', e))
    else focusCell(row.id, 'jobNo')
  }

  const deleteRow = (rowId: string) => {
    const row = rowsRef.current.find((r) => r.id === rowId)
    if (!row) return
    apply((prev) => prev.filter((r) => r.id !== rowId))
    void (async () => {
      try {
        if (row.persisted) {
          await mutate({ kind: 'deleteCaiwu', itemId: rowId })
        } else if (creating.current.has(rowId)) {
          const realId = await creating.current.get(rowId)!
          await mutate({ kind: 'deleteCaiwu', itemId: realId })
        }
      } catch (e) {
        toast('删除', e)
      }
    })()
  }

  const moveRow = (rowId: string, toIndex: number) => {
    const rs = rowsRef.current
    const from = rs.findIndex((r) => r.id === rowId)
    if (from === -1) return
    const without = rs.filter((r) => r.id !== rowId)
    const idx = from < toIndex ? toIndex - 1 : toIndex
    const prev = without[idx - 1]?.position
    const next = without[idx]?.position
    const [pos] = slotsBetween(prev, next, 1)
    const moved = { ...rs[from], position: pos }
    apply(() => [...without.slice(0, idx), moved, ...without.slice(idx)])
    persistPatch(moved, { position: pos })
  }

  const copyRow = (rowId: string) => {
    const row = rowsRef.current.find((r) => r.id === rowId)
    if (!row) return
    clipboard.current = { jobId: row.jobId, jobNoText: row.jobNoText, v: { ...row.v } }
  }

  // Multi-row paste into the anchor cell — the Excel-migration path. Tab-
  // separated fields map across THIS sheet's columns (anchor, then the rest in
  // display order); each line becomes a row. Anchor text that exactly matches a
  // 工号 links itself.
  const pasteTsvAt = (rowId: string, text: string) => {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.replace(/ /g, ' '))
      .filter((l) => l.trim().length > 0)
    if (lines.length === 0) return
    const rs = rowsRef.current
    const at = rs.findIndex((r) => r.id === rowId)
    if (at === -1) return
    const prev = rs[at - 1]?.position
    const next = rs[at]?.position
    const slots = slotsBetween(prev, next, lines.length)
    const newRows: Row[] = lines.map((line, i) => {
      const f = line.split('\t')
      const anchorText = (f[0] ?? '').trim()
      const match = anchorText
        ? jobIndex.find((j) => j.jobNo.toLowerCase() === anchorText.toLowerCase())
        : undefined
      const v: Partial<Record<ValueKey, string>> = {}
      valueCols.forEach((c, ci) => {
        const cell = f[ci + 1]
        if (cell !== undefined && cell.trim()) v[c.key as ValueKey] = cell.trim()
      })
      return {
        id: `draft-${++seq.current}`,
        jobId: match?.id,
        jobNoText: match?.jobNo ?? anchorText,
        v,
        position: slots[i],
        persisted: false,
      }
    })
    apply((p) => [...p.slice(0, at), ...newRows, ...p.slice(at)])
    for (const r of newRows) {
      if (rowHasContent(r)) void ensureCreated(r).catch((e) => toast('保存', e))
    }
  }

  // Close the context menu on any click / Esc (see _daily.tsx for the 'click'
  // vs 'mousedown' ordering rationale).
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const filledCount = rows.reduce((n, r) => (rowHasContent(r) ? n + 1 : n), 0)

  return (
    <>
      <div className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="sheet w-full text-left text-[13px]">
          <colgroup>
            <col style={{ width: 48 }} />
            {cols.map((c) => (
              <col key={c.key} style={c.minWidth ? { minWidth: c.minWidth } : { width: c.width }} />
            ))}
            <col style={{ width: 44 }} />
          </colgroup>
          <thead>
            <tr className="text-[var(--color-ink-2)]">
              <th className="px-3 py-3 text-center label whitespace-nowrap">#</th>
              {cols.map((c) => (
                <th key={c.key} className="px-4 py-3 label whitespace-nowrap">
                  {c.header}
                </th>
              ))}
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <SheetRow
                key={row.id}
                cols={cols}
                row={row}
                index={i}
                job={row.jobId ? jobById[row.jobId] : undefined}
                jobIndex={jobIndex}
                registerCell={registerCell}
                onDirty={onCellDirty}
                onCommitValue={commitValue}
                onCommitAnchor={commitAnchor}
                onAnchorAdvance={() => focusDown(row.id, 'jobNo')}
                onDownInCol={focusDown}
                onPasteTsv={pasteTsvAt}
                onDelete={() => deleteRow(row.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ x: e.clientX, y: e.clientY, rowId: row.id })
                }}
                dragging={drag === row.id}
                dropEdge={dropAt?.rowId === row.id ? dropAt.edge : null}
                onDragStart={() => setDrag(row.id)}
                onDragEnd={() => {
                  setDrag(null)
                  setDropAt(null)
                }}
                onDragOver={(e) => {
                  if (!drag || drag === row.id) return
                  e.preventDefault()
                  const rect = e.currentTarget.getBoundingClientRect()
                  setDropAt({
                    rowId: row.id,
                    edge: e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom',
                  })
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (!drag || drag === row.id) return
                  const rect = e.currentTarget.getBoundingClientRect()
                  const before = e.clientY < rect.top + rect.height / 2
                  moveRow(drag, before ? i : i + 1)
                  setDrag(null)
                  setDropAt(null)
                }}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span className="label text-[var(--color-ink-3)]">
          <span className="mono mr-1 text-[12px] text-[var(--color-ink-2)]">{filledCount}</span>条
        </span>
        <p className="label text-[var(--color-ink-3)]">{hint}</p>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          canPaste={clipboard.current !== null}
          onPick={(action) => {
            const rs = rowsRef.current
            const at = rs.findIndex((r) => r.id === menu.rowId)
            setMenu(null)
            if (at === -1) return
            if (action === 'insertAbove') insertRow(at)
            else if (action === 'insertBelow') insertRow(at + 1)
            else if (action === 'copy') copyRow(menu.rowId)
            else if (action === 'paste') {
              if (clipboard.current) insertRow(at + 1, { ...clipboard.current })
            } else if (action === 'delete') deleteRow(menu.rowId)
          }}
        />
      )}
    </>
  )
}

type MenuAction = 'insertAbove' | 'insertBelow' | 'copy' | 'paste' | 'delete'

function ContextMenu({
  x,
  y,
  canPaste,
  onPick,
}: {
  x: number
  y: number
  canPaste: boolean
  onPick: (a: MenuAction) => void
}) {
  const items: { key: MenuAction; label: string; disabled?: boolean; danger?: boolean }[] = [
    { key: 'insertAbove', label: '在上方插入行' },
    { key: 'insertBelow', label: '在下方插入行' },
    { key: 'copy', label: '复制行' },
    { key: 'paste', label: '粘贴行', disabled: !canPaste },
    { key: 'delete', label: '删除行', danger: true },
  ]
  return (
    <div
      role="menu"
      className="fixed z-50 min-w-[148px] overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-[0_10px_34px_-12px_rgba(20,19,15,0.28)]"
      style={{ left: x, top: y }}
    >
      {items.map((it, i) => (
        <span key={it.key}>
          {(it.key === 'copy' || it.key === 'delete') && i > 0 && (
            <span className="my-1 block h-px bg-[var(--color-border)]" />
          )}
          <button
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => onPick(it.key)}
            className={`block w-full px-3 py-1.5 text-left text-[13px] transition-colors ${
              it.disabled
                ? 'text-[var(--color-ink-4)] cursor-default'
                : it.danger
                  ? 'text-[var(--color-overdue)] hover:bg-[var(--color-bg)]'
                  : 'text-[var(--color-ink)] hover:bg-[var(--color-bg)]'
            }`}
          >
            {it.label}
          </button>
        </span>
      ))}
    </div>
  )
}

const cellInputCls =
  'block w-full bg-transparent border-0 outline-none rounded-[2px] px-1 -mx-1 py-0.5 transition-[background-color,box-shadow] duration-150 hover:bg-[var(--color-active-bg)] hover:shadow-[inset_0_-1px_0_var(--color-border-strong)] focus:bg-[var(--color-active-bg)] focus:shadow-[inset_0_-1px_0_var(--color-ink)]'

function SheetRow({
  cols,
  row,
  index,
  job,
  jobIndex,
  registerCell,
  onDirty,
  onCommitValue,
  onCommitAnchor,
  onAnchorAdvance,
  onDownInCol,
  onPasteTsv,
  onDelete,
  onContextMenu,
  dragging,
  dropEdge,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  cols: ColDef[]
  row: Row
  index: number
  job?: CaiwuJobLite
  jobIndex: CaiwuJobLite[]
  registerCell: (
    rowId: string,
    col: ColKey,
  ) => (el: HTMLInputElement | HTMLTextAreaElement | null) => void
  onDirty: (rowId: string) => void
  onCommitValue: (rowId: string, key: ValueKey, value: string | undefined) => void
  onCommitAnchor: (rowId: string, jobId: string | undefined, jobNoText: string) => void
  onAnchorAdvance: () => void
  onDownInCol: (rowId: string, col: ColKey) => void
  onPasteTsv: (rowId: string, text: string) => void
  onDelete: () => void
  onContextMenu: (e: React.MouseEvent) => void
  dragging: boolean
  dropEdge: 'top' | 'bottom' | null
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: (e: React.DragEvent<HTMLTableRowElement>) => void
  onDrop: (e: React.DragEvent<HTMLTableRowElement>) => void
}) {
  const shipped = job?.isShipped ?? false
  const dropIndicator =
    dropEdge === 'top'
      ? { boxShadow: 'inset 0 2px 0 var(--color-info)' }
      : dropEdge === 'bottom'
        ? { boxShadow: 'inset 0 -2px 0 var(--color-info)' }
        : undefined

  return (
    <tr
      className={`group/row align-top ${dragging ? 'opacity-40' : ''} ${shipped ? 'opacity-60' : ''}`}
      style={dropIndicator}
      onContextMenu={onContextMenu}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* Row number = drag handle, like Excel's row header. */}
      <td
        className="px-3 py-3 text-center mono text-[12px] text-[var(--color-ink-3)] cursor-grab active:cursor-grabbing select-none hover:bg-black/[0.04] transition-colors"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          onDragStart()
        }}
        onDragEnd={onDragEnd}
        title="拖动排序 · 右键更多操作"
      >
        {String(index + 1).padStart(2, '0')}
      </td>

      {cols.map((col) => {
        if (col.kind === 'anchor') {
          return (
            <AnchorCell
              key={col.key}
              row={row}
              job={job}
              jobIndex={jobIndex}
              inputRef={registerCell(row.id, col.key)}
              onDirty={() => onDirty(row.id)}
              onCommit={(jobId, jobNoText) => onCommitAnchor(row.id, jobId, jobNoText)}
              onAdvance={onAnchorAdvance}
              onPasteTsv={(text) => onPasteTsv(row.id, text)}
            />
          )
        }

        const key = col.key as ValueKey
        const live = col.live?.(job) ?? ''
        const isOverride = col.kind === 'override'
        const shown = isOverride ? (row.v[key] ?? live) : (row.v[key] ?? '')
        const overrideActive = isOverride && row.v[key] !== undefined

        const commit = (draft: string) => {
          if (isOverride) {
            const next =
              draft.trim() === live.trim() || !draft.trim() ? undefined : draft
            onCommitValue(row.id, key, next)
          } else {
            onCommitValue(row.id, key, draft.trim() ? draft : undefined)
          }
        }

        if (col.kind === 'note') {
          return (
            <td key={col.key} className="px-3 py-2 align-top">
              <NoteCell
                value={shown}
                tint={col.tint}
                placeholder={rowHasContent(row) ? '随手记…' : ''}
                inputRef={registerCell(row.id, col.key)}
                onDirty={() => onDirty(row.id)}
                onCommit={commit}
              />
            </td>
          )
        }

        return (
          <td key={col.key} className="px-4 py-2 align-top">
            <Cell
              value={shown}
              isOverride={overrideActive}
              mono={col.kind === 'amount'}
              align={col.kind === 'amount' ? 'right' : undefined}
              placeholder={col.placeholder ?? ''}
              inputRef={registerCell(row.id, col.key)}
              onDirty={() => onDirty(row.id)}
              onCommit={commit}
              onDown={() => onDownInCol(row.id, col.key)}
            />
          </td>
        )
      })}

      <td className="px-2 py-3 text-center align-top">
        {rowHasContent(row) && (
          <button
            type="button"
            onClick={onDelete}
            aria-label="删除行"
            title="删除行（不影响工单本身）"
            className="inline-flex h-5 w-5 items-center justify-center rounded-[2px] text-transparent group-hover/row:text-[var(--color-ink-4)] hover:!text-[var(--color-overdue)] transition-colors"
          >
            ✕
          </button>
        )}
      </td>
    </tr>
  )
}

// 工号 anchor — a combobox over live jobs in every row. Picking links the row
// (客户名称 / 联系人 light up from the master read); free text that exactly
// matches a 工号 links too; anything else stays an unlinked text row. A
// multi-line clipboard routes to the TSV importer instead.
function AnchorCell({
  row,
  job,
  jobIndex,
  inputRef,
  onDirty,
  onCommit,
  onAdvance,
  onPasteTsv,
}: {
  row: Row
  job?: CaiwuJobLite
  jobIndex: CaiwuJobLite[]
  inputRef: (el: HTMLInputElement | null) => void
  onDirty: () => void
  onCommit: (jobId: string | undefined, jobNoText: string) => void
  onAdvance: () => void
  onPasteTsv: (text: string) => void
}) {
  const shown = job?.jobNo ?? row.jobNoText
  const [draft, setDraft] = useState(shown)
  const [focused, setFocused] = useState(false)
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)

  // Re-sync from upstream while idle (same sentinel pattern as _editable).
  const [syncedFrom, setSyncedFrom] = useState(shown)
  if (syncedFrom !== shown && !focused) {
    setSyncedFrom(shown)
    setDraft(shown)
  }

  const matches = useMemo(() => {
    if (!open) return []
    const q = draft.trim().toLowerCase()
    if (!q) return []
    const out: CaiwuJobLite[] = []
    for (const j of jobIndex) {
      if (j.jobNo.toLowerCase().includes(q) || j.customer.toLowerCase().includes(q)) {
        out.push(j)
        if (out.length >= 8) break
      }
    }
    return out
  }, [open, draft, jobIndex])

  const pick = (j: CaiwuJobLite) => {
    setDraft(j.jobNo)
    setOpen(false)
    onCommit(j.id, j.jobNo)
    onAdvance()
  }

  const commitText = (advance: boolean) => {
    const text = draft.trim()
    if (text === shown.trim()) {
      if (advance) onAdvance()
      return
    }
    const exact = jobIndex.find((j) => j.jobNo.toLowerCase() === text.toLowerCase())
    onCommit(exact?.id, exact?.jobNo ?? text)
    if (advance && text) onAdvance()
  }

  return (
    <td className="px-4 py-2 align-top" style={{ overflow: 'visible' }}>
      <div className="relative">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={draft}
            placeholder="+ 工号…"
            onChange={(e) => {
              if (draft === shown) onDirty()
              setDraft(e.target.value)
              setOpen(e.target.value.trim().length > 0)
              setHi(0)
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false)
              setTimeout(() => {
                setOpen(false)
                commitText(false)
              }, 150)
            }}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text')
              if (text.includes('\n') || text.includes('\t')) {
                e.preventDefault()
                setDraft('')
                setOpen(false)
                onPasteTsv(text)
              }
            }}
            onKeyDown={(e) => {
              if (open && matches.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setHi((h) => (h + 1) % matches.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setHi((h) => (h - 1 + matches.length) % matches.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  if (e.key === 'Enter') e.preventDefault()
                  pick(matches[Math.min(hi, matches.length - 1)])
                  return
                }
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                setOpen(false)
                commitText(true)
              } else if (e.key === 'Escape') {
                setDraft(shown)
                setOpen(false)
              }
            }}
            className={`${cellInputCls} mono text-[13px] font-medium ${
              job ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-2)]'
            }`}
            aria-label="工号"
            autoComplete="off"
          />
          {job && (
            <Link
              href={`/jobs/${job.id}`}
              className="shrink-0 mono text-[11px] text-[var(--color-ink-4)] hover:text-[var(--color-ink)] transition-colors"
              title={`打开工单 ${job.jobNo}`}
              tabIndex={-1}
            >
              ↗
            </Link>
          )}
          {job?.isShipped && (
            <span className="row-badge shrink-0" data-tone="neutral" title="该工单已出货">
              已出货
            </span>
          )}
        </div>
        {open && matches.length > 0 && (
          <div
            role="listbox"
            className="absolute left-0 top-[calc(100%+4px)] z-40 min-w-[300px] overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-[0_10px_34px_-12px_rgba(20,19,15,0.28)]"
          >
            {matches.map((j, mi) => (
              <button
                key={j.id}
                type="button"
                role="option"
                aria-selected={mi === hi}
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(j)
                }}
                onMouseEnter={() => setHi(mi)}
                className={`flex w-full items-baseline gap-3 px-3 py-1.5 text-left transition-colors ${
                  mi === hi ? 'bg-[var(--color-bg)]' : ''
                }`}
              >
                <span className="mono text-[13px] font-medium text-[var(--color-ink)] whitespace-nowrap">
                  {j.jobNo}
                </span>
                <span className="flex-1 truncate text-[12px] text-[var(--color-ink-3)]">
                  {j.customer}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </td>
  )
}

// Single-line Excel cell: commit on blur / Enter, Enter walks down the column,
// Esc reverts. Override cells (客户名称 / 联系人 over a linked job) get a small
// ink dot so "this is hand-typed, not live" stays visible.
function Cell({
  value,
  isOverride,
  mono,
  align,
  placeholder,
  inputRef,
  onDirty,
  onCommit,
  onDown,
}: {
  value: string
  isOverride: boolean
  mono?: boolean
  align?: 'right'
  placeholder: string
  inputRef: (el: HTMLInputElement | null) => void
  onDirty: () => void
  onCommit: (v: string) => void
  onDown: () => void
}) {
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  const [syncedFrom, setSyncedFrom] = useState(value)
  if (syncedFrom !== value && !focused) {
    setSyncedFrom(value)
    setDraft(value)
  }
  const commit = () => {
    if (draft !== value) onCommit(draft)
  }
  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => {
          if (draft === value) onDirty()
          setDraft(e.target.value)
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          commit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
            onDown()
          } else if (e.key === 'Escape') {
            setDraft(value)
          }
        }}
        className={`${cellInputCls} text-[13px] text-[var(--color-ink-2)] ${
          mono ? 'mono tabular-nums' : ''
        } ${align === 'right' ? 'text-right' : ''}`}
        autoComplete="off"
      />
      {isOverride && (
        <span
          aria-hidden="true"
          title="手填内容 · 只在本表生效"
          className="pointer-events-none absolute -left-2.5 top-1/2 h-1 w-1 -translate-y-1/2 rounded-[1px] bg-[var(--color-ink-4)]"
        />
      )}
    </div>
  )
}

// The running money log (收款记录 / 开票情况) — a multi-line textarea that grows
// with its content and carries a faint tint so the column reads as "the log".
// Commits on blur; Enter inserts a newline (she writes paragraphs). Esc reverts.
function NoteCell({
  value,
  tint,
  placeholder,
  inputRef,
  onDirty,
  onCommit,
}: {
  value: string
  tint?: 'green' | 'yellow'
  placeholder: string
  inputRef: (el: HTMLTextAreaElement | null) => void
  onDirty: () => void
  onCommit: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  const [syncedFrom, setSyncedFrom] = useState(value)
  if (syncedFrom !== value && !focused) {
    setSyncedFrom(value)
    setDraft(value)
  }
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const grow = () => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }
  useEffect(grow, [draft])

  const commit = () => {
    if (draft !== value) onCommit(draft)
  }
  const bg =
    tint === 'green'
      ? 'rgba(46,160,67,0.06)'
      : tint === 'yellow'
        ? 'rgba(214,167,18,0.09)'
        : undefined

  return (
    <textarea
      ref={(el) => {
        ref.current = el
        inputRef(el)
      }}
      rows={1}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => {
        if (draft === value) onDirty()
        setDraft(e.target.value)
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        commit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setDraft(value)
      }}
      style={{ backgroundColor: bg }}
      className="block w-full resize-none overflow-y-auto rounded-[2px] border-0 px-1.5 py-1 -mx-0.5 text-[12.5px] leading-[1.5] text-[var(--color-ink-2)] outline-none transition-[box-shadow] duration-150 focus:shadow-[inset_0_0_0_1px_var(--color-border-strong)]"
      autoComplete="off"
    />
  )
}
