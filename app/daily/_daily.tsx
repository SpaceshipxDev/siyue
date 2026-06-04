'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { mutate } from '@/lib/mutate'
import { daysFromToday, dueState } from '@/lib/data'
import type { DailyFocusItem } from '@/lib/data'
import { showToast } from '@/app/_toast'

// 重点 — the boss's "these must be done on this day" list, the one he used to
// keep in Excel and blast over WeChat. This board IS that Excel sheet:
//
//   • The grid always shows empty rows below the last filled one — start
//     typing in a row and the next blank row is already waiting underneath.
//   • Every cell is a cell. 单号 autocompletes against live jobs (picking one
//     fills 产品/交期 from the MES); 产品 and 交期 are then freely editable
//     TEXT — overrides that live on this board only and never write back to
//     the job. 反馈 is plain text.
//   • Rows drag to reorder (grab the row number, like Excel's row header).
//   • Right-click a row: 在上方/下方插入行 · 复制行 · 粘贴行 · 删除行.
//   • Paste straight FROM Excel: a multi-line/tab clipboard dropped into a
//     单号 cell becomes rows (单号 ⇥ 产品 ⇥ 交期 ⇥ 反馈).
//
// Persistence is invisible: a row saves itself the moment a cell commits
// (blur/Enter), edits patch in place, ordering saves as you drop. No save
// button anywhere — Excel doesn't have one either.

// Live job fields joined onto a focus row. Built server-side from the master
// read (post-scrub, so 工程 head never sees customer names here either).
export type FocusJobLite = {
  id: string
  jobNo: string
  customer: string
  product: string
  /** effectiveDueDate — return-adjusted, same as the master grid. */
  dueDate: string
  secondaryDueDate?: string
  hasOpenOutsource: boolean
  needsOutsource: boolean
  isShipped: boolean
}

// One grid row. Drafts (persisted=false) are the trailing blank rows — they
// exist only in the browser until a cell commits content, at which point the
// row creates itself server-side and swaps its temp id for the real one.
type Row = {
  id: string
  jobId?: string
  jobNoText: string
  productText?: string
  dueText?: string
  feedback?: string
  position: number
  persisted: boolean
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// Day arithmetic on the ISO string via local-time Date — no UTC shift.
function addDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map((s) => parseInt(s, 10))
  const dt = new Date(y, m - 1, d + delta)
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

function formatDayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map((s) => parseInt(s, 10))
  const w = WEEKDAY[new Date(y, m - 1, d).getDay()]
  return `${m}月${d}日 ${w}`
}

function dayHref(iso: string, todayStr: string): string {
  return iso === todayStr ? '/daily' : `/daily?day=${iso}`
}

function rowHasContent(r: Row): boolean {
  return Boolean(
    r.jobNoText.trim() ||
      r.productText?.trim() ||
      r.dueText?.trim() ||
      r.feedback?.trim(),
  )
}

// Fractional slots for inserting `count` rows between two neighbors —
// Excel-style insert-anywhere without renumbering the whole sheet.
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

type CellCol = 'jobNo' | 'product' | 'due' | 'feedback'

export function DailyFocusBoard({
  items,
  jobById,
  jobIndex,
  day,
  todayStr,
  showCustomer,
}: {
  items: DailyFocusItem[]
  /** Live join data for every job referenced by `items`. */
  jobById: Record<string, FocusJobLite>
  /** 在产 jobs for the 工号 autocomplete, master-sheet order. */
  jobIndex: FocusJobLite[]
  day: string
  todayStr: string
  showCustomer: boolean
}) {
  const seq = useRef(0)
  const newDraft = (position: number): Row => ({
    id: `draft-${++seq.current}`,
    jobNoText: '',
    position,
    persisted: false,
  })

  // The sheet is the truth for this session (Excel semantics: what you see is
  // your sheet). Server state seeds it; every edit applies locally first and
  // persists in the background. No router.refresh() — it would clobber
  // in-flight cells. A reload (or day flip — the board is keyed by day)
  // re-reads the server.
  const [rows, setRows] = useState<Row[]>(() => {
    const seeded: Row[] = items.map((it) => ({
      id: it.id,
      jobId: it.jobId,
      jobNoText: it.jobNoText,
      productText: it.productText,
      dueText: it.dueText,
      feedback: it.feedback,
      position: it.position,
      persisted: true,
    }))
    const last = seeded[seeded.length - 1]?.position ?? 0
    seeded.push(newDraft(last + 1))
    return seeded
  })
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  // In-flight creations: draft id → promise of the real id. Edits/deletes/
  // moves that race a slow create chain themselves behind it.
  const creating = useRef(new Map<string, Promise<string>>())
  // Local row clipboard (复制行 / 粘贴行).
  const clipboard = useRef<Omit<Row, 'id' | 'position' | 'persisted'> | null>(
    null,
  )

  const [menu, setMenu] = useState<{ x: number; y: number; rowId: string } | null>(
    null,
  )
  const [drag, setDrag] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ rowId: string; edge: 'top' | 'bottom' } | null>(
    null,
  )

  // Focus registry so Enter can walk DOWN a column like Excel.
  const cellRefs = useRef(new Map<string, HTMLInputElement>())
  const cellKey = (rowId: string, col: CellCol) => `${rowId}:${col}`
  const registerCell = (rowId: string, col: CellCol) => (el: HTMLInputElement | null) => {
    const k = cellKey(rowId, col)
    if (el) cellRefs.current.set(k, el)
    else cellRefs.current.delete(k)
  }
  const focusCell = (rowId: string, col: CellCol) => {
    requestAnimationFrame(() => cellRefs.current.get(cellKey(rowId, col))?.focus())
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

  // "Typing in a row → the next is already visible." Fired on the first
  // keystroke in ANY cell of the LAST row — before any commit, so the typed
  // content isn't in `rows` yet and apply()'s has-content check can't see it.
  // Append the next blank unconditionally.
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
    showToast(
      `${verb}失败 · ${e instanceof Error ? e.message : '网络中断'}`,
      'warning',
    )

  // Persist a row's create exactly once; resolves to the real id.
  const ensureCreated = (row: Row): Promise<string> => {
    const inFlight = creating.current.get(row.id)
    if (inFlight) return inFlight
    const p = (async () => {
      const res = await mutate<{ id: string }>({
        kind: 'createDailyFocus',
        input: {
          day,
          jobId: row.jobId,
          jobNoText: row.jobNoText,
          productText: row.productText,
          dueText: row.dueText,
          feedback: row.feedback,
          position: row.position,
        },
      })
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

  type ServerPatch = {
    jobId?: string | null
    jobNoText?: string
    productText?: string | null
    dueText?: string | null
    feedback?: string | null
    position?: number
  }

  const persistPatch = (row: Row, patch: ServerPatch) => {
    void (async () => {
      try {
        if (row.persisted) {
          await mutate({ kind: 'updateDailyFocus', itemId: row.id, patch })
        } else if (creating.current.has(row.id)) {
          const realId = await creating.current.get(row.id)!
          await mutate({ kind: 'updateDailyFocus', itemId: realId, patch })
        } else if (rowHasContent(row)) {
          await ensureCreated(row)
        }
        // Contentless unpersisted row: nothing to save yet.
      } catch (e) {
        toast('保存', e)
      }
    })()
  }

  // One cell committed (blur/Enter): merge locally, persist in background.
  const commitCell = (rowId: string, local: Partial<Row>, patch: ServerPatch) => {
    let merged: Row | undefined
    apply((prev) =>
      prev.map((r) => (r.id === rowId ? (merged = { ...r, ...local }) : r)),
    )
    if (merged) persistPatch(merged, patch)
  }

  const insertRow = (
    at: number, // index the new row should occupy
    content?: Omit<Row, 'id' | 'position' | 'persisted'>,
  ) => {
    const rs = rowsRef.current
    const prev = rs[at - 1]?.position
    const next = rs[at]?.position
    const [pos] = slotsBetween(prev, next, 1)
    const row: Row = { ...(content ?? { jobNoText: '' }), id: `draft-${++seq.current}`, position: pos, persisted: false }
    apply((p) => [...p.slice(0, at), row, ...p.slice(at)])
    if (rowHasContent(row)) {
      void ensureCreated(row).catch((e) => toast('保存', e))
    } else {
      focusCell(row.id, 'jobNo')
    }
  }

  const deleteRow = (rowId: string) => {
    const row = rowsRef.current.find((r) => r.id === rowId)
    if (!row) return
    apply((prev) => prev.filter((r) => r.id !== rowId))
    void (async () => {
      try {
        if (row.persisted) {
          await mutate({ kind: 'deleteDailyFocus', itemId: rowId })
        } else if (creating.current.has(rowId)) {
          const realId = await creating.current.get(rowId)!
          await mutate({ kind: 'deleteDailyFocus', itemId: realId })
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
    const job = row.jobId ? jobById[row.jobId] : undefined
    clipboard.current = {
      jobId: row.jobId,
      jobNoText: row.jobNoText,
      productText: row.productText,
      dueText: row.dueText,
      feedback: row.feedback,
    }
    // Mirror to the system clipboard as TSV so the row pastes back into real
    // Excel too. Best-effort — the in-app 粘贴行 uses the local ref.
    const tsv = [
      job?.jobNo ?? row.jobNoText,
      row.productText ?? job?.product ?? '',
      row.dueText ?? job?.dueDate ?? '',
      row.feedback ?? '',
    ].join('\t')
    void navigator.clipboard?.writeText(tsv).catch(() => undefined)
  }

  // Multi-row paste into a 单号 cell — the Excel-migration path. Each line:
  // 单号 ⇥ 产品 ⇥ 交期 ⇥ 反馈. Lines whose 单号 exactly matches a live job
  // link themselves (and inherit live cells unless the paste overrides them).
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
    // Paste replaces the target row's slot and flows downward, pushing the
    // target row below the pasted block (Excel "insert copied cells" feel).
    const next = rs[at]?.position
    const slots = slotsBetween(prev, next, lines.length)
    const newRows: Row[] = lines.map((line, i) => {
      const f = line.split('\t').map((s) => s.trim())
      const jobNoText = f[0] ?? ''
      const match = jobIndex.find(
        (j) => j.jobNo.toLowerCase() === jobNoText.toLowerCase(),
      )
      return {
        id: `draft-${++seq.current}`,
        jobId: match?.id,
        jobNoText: match?.jobNo ?? jobNoText,
        productText: f[1] || undefined,
        dueText: f[2] || undefined,
        feedback: f[3] || undefined,
        position: slots[i],
        persisted: false,
      }
    })
    apply((p) => [...p.slice(0, at), ...newRows, ...p.slice(at)])
    for (const r of newRows) {
      if (rowHasContent(r)) void ensureCreated(r).catch((e) => toast('保存', e))
    }
  }

  // Enter walks down the column, Excel-style. The trailing blank row always
  // exists, so "down" from the last filled row lands somewhere typeable.
  const focusDown = (rowId: string, col: CellCol) => {
    const rs = rowsRef.current
    const i = rs.findIndex((r) => r.id === rowId)
    const below = rs[i + 1]
    if (below) focusCell(below.id, col)
  }

  // Close the context menu on any click / Esc. Deliberately 'click', not
  // 'mousedown': React hydrates on `document`, so a same-target mousedown
  // listener here still runs after a menu item's stopPropagation and would
  // unmount the menu before its click ever fires. With 'click', the item's
  // onClick (React, attached first) runs, then this closes — right order.
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

  const isToday = day === todayStr
  const filledCount = rows.reduce((n, r) => (rowHasContent(r) ? n + 1 : n), 0)

  return (
    <>
      {/* Day nav — ‹ 6月4日 周四 › with a quiet "回到今天" when displaced.
          Links (not state) so the day is in the URL: refresh-stable and
          shareable into the WeChat group, same thesis as ?stage. */}
      <div className="mb-6 flex flex-wrap items-baseline gap-x-5 gap-y-2">
        <span className="inline-flex items-baseline gap-3">
          <Link
            href={dayHref(addDays(day, -1), todayStr)}
            aria-label="前一天"
            className="mono text-[15px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
          >
            ‹
          </Link>
          <span className="text-[20px] font-semibold tracking-tight text-[var(--color-ink)]">
            {formatDayLabel(day)}
          </span>
          <Link
            href={dayHref(addDays(day, 1), todayStr)}
            aria-label="后一天"
            className="mono text-[15px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
          >
            ›
          </Link>
        </span>
        {isToday ? (
          <span className="label text-[var(--color-ink-3)]">今天</span>
        ) : (
          <Link
            href="/daily"
            className="label text-[var(--color-ink)] hover:underline underline-offset-4 decoration-[var(--color-ink-3)]"
          >
            回到今天 ↺
          </Link>
        )}
        <span className="ml-auto label text-[var(--color-ink-3)]">
          <span className="mono mr-1 text-[12px] text-[var(--color-ink-2)]">
            {filledCount}
          </span>
          个重点
        </span>
      </div>

      <div className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="sheet w-full text-left text-[13px]">
          <colgroup>
            <col style={{ width: 48 }} />
            <col style={{ width: 190 }} />
            <col style={{ width: 230 }} />
            <col style={{ width: 130 }} />
            <col style={{ width: 80 }} />
            <col style={{ minWidth: 260 }} />
            <col style={{ width: 44 }} />
          </colgroup>
          <thead>
            <tr className="text-[var(--color-ink-2)]">
              <th className="px-3 py-3 text-center label whitespace-nowrap">#</th>
              <th className="px-4 py-3 label whitespace-nowrap">单号</th>
              <th className="px-4 py-3 label whitespace-nowrap">产品</th>
              <th className="px-4 py-3 label whitespace-nowrap">交期</th>
              <th className="px-4 py-3 label whitespace-nowrap">外协</th>
              <th className="px-4 py-3 label whitespace-nowrap">反馈</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <SheetRow
                key={row.id}
                row={row}
                index={i}
                job={row.jobId ? jobById[row.jobId] : undefined}
                jobIndex={jobIndex}
                showCustomer={showCustomer}
                registerCell={registerCell}
                onDirty={onCellDirty}
                onCommitCell={commitCell}
                onAdvance={focusCell}
                onDown={focusDown}
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
                  const edge =
                    e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom'
                  setDropAt({ rowId: row.id, edge })
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

      <p className="label mt-4 text-[var(--color-ink-3)]">
        输入工号自动带出产品 / 交期 · 产品交期可直接改文字（只改本表，不动工单） ·
        拖行号排序 · 右键插行 / 复制 / 粘贴 / 删除 · 可整块粘贴 Excel 行
      </p>

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
  row,
  index,
  job,
  jobIndex,
  showCustomer,
  registerCell,
  onDirty,
  onCommitCell,
  onAdvance,
  onDown,
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
  row: Row
  index: number
  job?: FocusJobLite
  jobIndex: FocusJobLite[]
  showCustomer: boolean
  registerCell: (rowId: string, col: CellCol) => (el: HTMLInputElement | null) => void
  onDirty: (rowId: string) => void
  onCommitCell: (
    rowId: string,
    local: Partial<Row>,
    patch: Record<string, unknown>,
  ) => void
  onAdvance: (rowId: string, col: CellCol) => void
  onDown: (rowId: string, col: CellCol) => void
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
  // Live-join display values; an override (productText/dueText) wins.
  const productShown = row.productText ?? job?.product ?? ''
  const dueShown = row.dueText ?? job?.dueDate ?? ''

  const dropIndicator =
    dropEdge === 'top'
      ? { boxShadow: 'inset 0 2px 0 var(--color-info)' }
      : dropEdge === 'bottom'
        ? { boxShadow: 'inset 0 -2px 0 var(--color-info)' }
        : undefined

  return (
    <tr
      className={`group/row align-middle ${dragging ? 'opacity-40' : ''} ${
        shipped ? 'opacity-60' : ''
      }`}
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

      <JobNoCell
        row={row}
        job={job}
        jobIndex={jobIndex}
        showCustomer={showCustomer}
        inputRef={registerCell(row.id, 'jobNo')}
        onDirty={() => onDirty(row.id)}
        onCommit={(local, patch) => onCommitCell(row.id, local, patch)}
        onAdvance={() => onAdvance(row.id, 'feedback')}
        onPasteTsv={(text) => onPasteTsv(row.id, text)}
      />

      {/* 产品 — Excel cell: linked rows show the live product until typed
          over; the override lives on this board only. */}
      <td className="px-4 py-2">
        <TextCell
          value={productShown}
          isOverride={row.productText !== undefined}
          placeholder=""
          inputRef={registerCell(row.id, 'product')}
          onDirty={() => onDirty(row.id)}
          onCommit={(v) => {
            // Typing back the exact live value (or clearing) drops the
            // override and the cell goes live again.
            const next = v.trim() === (job?.product ?? '').trim() || !v.trim() ? undefined : v
            onCommitCell(
              row.id,
              { productText: next },
              { productText: next ?? null },
            )
          }}
          onDown={() => onDown(row.id, 'product')}
        />
      </td>

      {/* 交期 — Excel cell, free text. Tone applies only when it parses as a
          date; arbitrary notes ("月底前", "等客户") render plain. */}
      <td className="px-4 py-2">
        <DueTextCell
          value={dueShown}
          inputRef={registerCell(row.id, 'due')}
          onDirty={() => onDirty(row.id)}
          onCommit={(v) => {
            const next = v.trim() === (job?.dueDate ?? '').trim() || !v.trim() ? undefined : v
            onCommitCell(row.id, { dueText: next }, { dueText: next ?? null })
          }}
          onDown={() => onDown(row.id, 'due')}
        />
      </td>

      {/* 外协 — live MES state, the one column that stays read-only. */}
      <td className="px-4 py-3">
        {job?.hasOpenOutsource ? (
          <span className="row-badge" data-tone="info" title="有零件正在外协">
            外协
          </span>
        ) : job?.needsOutsource ? (
          <span
            className="row-badge"
            data-tone="warning"
            title="工程已标记需外协，待商务安排"
          >
            待外协
          </span>
        ) : (
          <span className="text-[var(--color-ink-4)]">{job ? '—' : ''}</span>
        )}
      </td>

      <td className="px-3 py-2">
        <TextCell
          value={row.feedback ?? ''}
          isOverride={false}
          placeholder={rowHasContent(row) ? '反馈…' : ''}
          inputRef={registerCell(row.id, 'feedback')}
          onDirty={() => onDirty(row.id)}
          onCommit={(v) =>
            onCommitCell(
              row.id,
              { feedback: v.trim() || undefined },
              { feedback: v.trim() || null },
            )
          }
          onDown={() => onDown(row.id, 'feedback')}
        />
      </td>

      <td className="px-2 py-3 text-center">
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

// 单号 cell — a combobox over live jobs in every row. Picking links the row
// (产品/交期 light up from the MES); free text that exactly matches a 工号
// links too; anything else stays an unlinked text row. Multi-line clipboard
// content routes to the TSV importer instead.
function JobNoCell({
  row,
  job,
  jobIndex,
  showCustomer,
  inputRef,
  onDirty,
  onCommit,
  onAdvance,
  onPasteTsv,
}: {
  row: Row
  job?: FocusJobLite
  jobIndex: FocusJobLite[]
  showCustomer: boolean
  inputRef: (el: HTMLInputElement | null) => void
  onDirty: () => void
  onCommit: (local: Partial<Row>, patch: Record<string, unknown>) => void
  onAdvance: () => void
  onPasteTsv: (text: string) => void
}) {
  const shown = job?.jobNo ?? row.jobNoText
  const [draft, setDraft] = useState(shown)
  const [focused, setFocused] = useState(false)
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const localRef = useRef<HTMLInputElement>(null)

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
    const out: FocusJobLite[] = []
    for (const j of jobIndex) {
      if (
        j.jobNo.toLowerCase().includes(q) ||
        (showCustomer && j.customer.toLowerCase().includes(q)) ||
        j.product.toLowerCase().includes(q)
      ) {
        out.push(j)
        if (out.length >= 8) break
      }
    }
    return out
  }, [open, draft, jobIndex, showCustomer])

  const pick = (j: FocusJobLite) => {
    setDraft(j.jobNo)
    setOpen(false)
    onCommit(
      { jobId: j.id, jobNoText: j.jobNo },
      { jobId: j.id, jobNoText: j.jobNo },
    )
    onAdvance()
  }

  const commitText = (advance: boolean) => {
    const text = draft.trim()
    if (text === shown.trim()) {
      if (advance) onAdvance()
      return
    }
    // Exact 工号 match links silently — typing the full number IS picking it.
    const exact = jobIndex.find((j) => j.jobNo.toLowerCase() === text.toLowerCase())
    onCommit(
      { jobId: exact?.id, jobNoText: exact?.jobNo ?? text },
      { jobId: exact?.id ?? null, jobNoText: exact?.jobNo ?? text },
    )
    if (advance && text) onAdvance()
  }

  return (
    <td className="px-4 py-2" style={{ overflow: 'visible' }}>
      <div className="relative">
        <div className="flex items-center gap-2">
          <input
            ref={(el) => {
              localRef.current = el
              inputRef(el)
            }}
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
              // Delay so a dropdown mousedown lands before the menu unmounts.
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
                if (e.key === 'Enter') {
                  e.preventDefault()
                  pick(matches[Math.min(hi, matches.length - 1)])
                  return
                }
                if (e.key === 'Tab') {
                  // Tab takes the highlighted match; the browser's focus move
                  // continues to the next cell on its own.
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
            aria-label="单号"
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
                  {showCustomer && j.customer
                    ? `${j.customer} · ${j.product}`
                    : j.product}
                </span>
                <span className="mono text-[11px] text-[var(--color-ink-4)] whitespace-nowrap">
                  {j.dueDate.slice(5)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </td>
  )
}

// Plain Excel text cell: commit on blur/Enter, Enter walks down the column,
// Esc reverts. Overridden cells get a small ink dot so "this is hand-typed,
// not live" stays visible.
function TextCell({
  value,
  isOverride,
  placeholder,
  inputRef,
  onDirty,
  onCommit,
  onDown,
}: {
  value: string
  isOverride: boolean
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
        className={`${cellInputCls} text-[13px] text-[var(--color-ink-2)]`}
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

// 交期 cell — TextCell plus due-state tone + the 逾期/今日 sub-label, applied
// only while the text parses as YYYY-MM-DD. Free-text deadlines stay plain.
function DueTextCell({
  value,
  inputRef,
  onDirty,
  onCommit,
  onDown,
}: {
  value: string
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
  const isDate = ISO_DATE.test(draft.trim())
  const ds = isDate ? dueState(draft.trim()) : undefined
  const tone =
    ds === 'overdue'
      ? 'text-[var(--color-overdue)]'
      : ds === 'today' || ds === 'soon'
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--color-ink)]'
  const sub = isDate
    ? ds === 'overdue'
      ? `逾期 ${Math.abs(daysFromToday(draft.trim()))} 天`
      : ds === 'today'
        ? '今日'
        : `${daysFromToday(draft.trim())} 天后`
    : null
  return (
    <div className="flex flex-col leading-tight">
      <input
        ref={inputRef}
        type="text"
        value={draft}
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
        className={`${cellInputCls} mono text-[13px] ${tone}`}
        autoComplete="off"
      />
      {sub && !focused && (
        <span className="label mt-0.5 px-0 whitespace-nowrap">{sub}</span>
      )}
    </div>
  )
}
