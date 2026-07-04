'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { showToast } from '@/app/_toast'
import {
  applyOps,
  dayDiff,
  emptySheet,
  factoryToday,
  isNumeric,
  mdShort,
  parseClipboard,
  parseDayLike,
  planPaste,
  rid,
  rowDone,
  samplePlan,
  type Col,
  type Group,
  type Op,
  type Row,
  type SheetState,
} from './_model'

/*
 * /x — the sheet. One component, two storage modes:
 *
 *   demo — localStorage sandbox. Public, zero-login, zero DB writes. The
 *          TikTok / self-onboarding surface: paste your WPS rows, it works.
 *   live — the factory's real sheet. Ops POST to /api/x, a 3.5s poll pulls
 *          everyone else's taps in. Optimistic local apply + op replay on
 *          poll keeps typing latency at zero.
 *
 * The design contract (ledger, not letter): rows are parts, left columns are
 * whatever the factory pasted, the right strip is the journey. Tap a stage
 * cell → ✓ + date + who (that IS 报工). Click the row number → 重点 star.
 * Everything else is Excel muscle memory: arrows, Enter, type-to-replace,
 * ⌘V anywhere.
 */

type Mode = 'demo' | 'live'

type Sel = { rowId: string; ck: string } | null // ck: 'num' | colId | `s:${stage}`
type EditCell = { rowId: string; colId: string; init: string } | null
type Undo = { text: string; ops: Op[] } | null

const LS_STATE = 'x:demo:v1'
const LS_ME = 'x:me'
const LS_COLLAPSED = 'x:collapsed'

const CSS = `
@keyframes xRowIn { from { opacity: 0; transform: translateY(5px) } to { opacity: 1; transform: none } }
.x-row-in { animation: xRowIn .26s cubic-bezier(.32,.72,.18,1) both }
@keyframes xTickPop { from { transform: scale(.55) } 60% { transform: scale(1.12) } to { transform: scale(1) } }
.x-tick { display:inline-block; animation: xTickPop .18s cubic-bezier(.32,.72,.18,1) }
@keyframes xFadeIn { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
.x-fadein { animation: xFadeIn .4s cubic-bezier(.32,.72,.18,1) both }
`

export function Sheet({ mode, me: bootMe, boot }: { mode: Mode; me: string | null; boot?: SheetState }) {
  const [st, setSt] = useState<SheetState | null>(boot ?? null)
  const [me, setMe] = useState(bootMe ?? '我')
  const [sel, setSel] = useState<Sel>(null)
  const [edit, setEdit] = useState<EditCell>(null)
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [undo, setUndo] = useState<Undo>(null)
  const [stagesOpen, setStagesOpen] = useState(false)
  const [hdrEdit, setHdrEdit] = useState<{ colId: string; init: string } | null>(null)
  const [delGroupArm, setDelGroupArm] = useState<string | null>(null)
  const [flash, setFlash] = useState<Set<string>>(new Set())
  const [uploading, setUploading] = useState<Record<string, string>>({})

  const stRef = useRef(st)
  const selRef = useRef(sel)
  const editRef = useRef(edit)
  const lightboxRef = useRef(lightbox)
  const meRef = useRef(me)
  useEffect(() => { stRef.current = st }, [st])
  useEffect(() => { selRef.current = sel }, [sel])
  useEffect(() => { lightboxRef.current = lightbox }, [lightbox])
  useEffect(() => { meRef.current = me }, [me])

  // editRef must update SYNCHRONOUSLY (not in an effect): with a fast typist,
  // keystroke #2 can arrive before React commits keystroke #1's setEdit — the
  // window key handler would see "not editing" and reset the editor, eating
  // the first character.
  const setEditSync = useCallback((e: EditCell) => {
    editRef.current = e
    setEdit(e)
  }, [])

  const queue = useRef<Op[]>([])
  const flushing = useRef(false)
  const failToasted = useRef(false)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const quotaToasted = useRef(false)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const pickTarget = useRef<string | null>(null)

  // ------------------------------------------------------------------ store
  const persistSoon = useCallback(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      const s = stRef.current
      if (!s) return
      try {
        localStorage.setItem(LS_STATE, JSON.stringify(s))
      } catch {
        if (!quotaToasted.current) {
          quotaToasted.current = true
          showToast('本机存储满了 — 图片太多的话删几张', 'warning')
        }
      }
    }, 250)
  }, [])

  const flush = useCallback(async () => {
    if (mode !== 'live' || flushing.current || queue.current.length === 0) return
    flushing.current = true
    const batch = queue.current.slice(0, 120)
    try {
      const r = await fetch('/api/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops: batch }),
      })
      if (!r.ok) throw new Error(String(r.status))
      const j = (await r.json()) as { version?: number }
      queue.current = queue.current.slice(batch.length)
      failToasted.current = false
      const v = Number(j.version ?? 0)
      setSt((s) => (s && v > s.version ? { ...s, version: v } : s))
    } catch {
      if (!failToasted.current) {
        failToasted.current = true
        showToast('网络不通 — 改动会自动重发', 'warning')
      }
      setTimeout(() => {
        flushing.current = false
        void flush()
      }, 4000)
      return
    }
    flushing.current = false
    if (queue.current.length) void flush()
  }, [mode])

  const dispatch = useCallback(
    (ops: Op[]) => {
      if (!ops.length) return
      setSt((s) => (s ? applyOps(s, ops) : s))
      if (mode === 'live') {
        queue.current.push(...ops)
        void flush()
      } else {
        // stRef updates in an effect after render; persist on the next tick.
        setTimeout(persistSoon, 0)
      }
    },
    [mode, flush, persistSoon],
  )

  // Demo boot: hydrate from localStorage after mount (SSR renders the shell).
  useEffect(() => {
    if (mode !== 'demo') return
    let loaded: SheetState | null = null
    try {
      const raw = localStorage.getItem(LS_STATE)
      if (raw) loaded = JSON.parse(raw) as SheetState
    } catch {}
    setSt(loaded && Array.isArray(loaded.columns) ? { ...emptySheet(), ...loaded } : emptySheet())
    const savedMe = localStorage.getItem(LS_ME)
    if (savedMe) setMe(savedMe)
  }, [mode])

  // Collapsed groups are per-device view state, both modes.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_COLLAPSED)
      if (raw) setCollapsed(new Set(JSON.parse(raw) as string[]))
    } catch {}
  }, [])
  const toggleCollapsed = useCallback((gid: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(gid)) next.delete(gid)
      else next.add(gid)
      try {
        localStorage.setItem(LS_COLLAPSED, JSON.stringify([...next]))
      } catch {}
      return next
    })
  }, [])

  // Live poll — cheap version check every 3.5s + on tab focus. Server state
  // replaces local, with any un-acked local ops replayed on top.
  useEffect(() => {
    if (mode !== 'live') return
    let stopped = false
    const tick = async () => {
      if (stopped || document.hidden) return
      try {
        const v = stRef.current?.version ?? 0
        const r = await fetch(`/api/x?v=${v}`, { cache: 'no-store' })
        if (!r.ok) return
        const j = (await r.json()) as { unchanged?: boolean; state?: SheetState }
        if (j.unchanged || !j.state) return
        const server = j.state
        setSt(() => applyOps(server, queue.current))
      } catch {}
    }
    const iv = setInterval(tick, 3500)
    const onShow = () => void tick()
    window.addEventListener('focus', onShow)
    document.addEventListener('visibilitychange', onShow)
    return () => {
      stopped = true
      clearInterval(iv)
      window.removeEventListener('focus', onShow)
      document.removeEventListener('visibilitychange', onShow)
    }
  }, [mode])

  // ------------------------------------------------------- derived structure
  const imgCol = useMemo(() => st?.columns.find((c) => c.kind === 'img') ?? null, [st])
  const textCols = useMemo(() => st?.columns.filter((c) => c.kind === 'text') ?? [], [st])
  const stages = st?.stages ?? []
  const today = factoryToday()

  const groupsSorted = useMemo(
    () => (st ? [...st.groups].sort((a, b) => a.pos - b.pos) : []),
    [st],
  )
  const rowsByGroup = useMemo(() => {
    const m = new Map<string, Row[]>()
    if (!st) return m
    for (const g of st.groups) m.set(g.id, [])
    for (const r of st.rows) {
      const arr = m.get(r.groupId)
      if (arr) arr.push(r)
    }
    for (const arr of m.values()) arr.sort((a, b) => a.pos - b.pos)
    return m
  }, [st])

  const query = q.trim().toLowerCase()
  const visible = useMemo(() => {
    const out: Array<{ group: Group; rows: Row[]; all: Row[]; hiddenByCollapse: boolean }> = []
    for (const g of groupsSorted) {
      const all = rowsByGroup.get(g.id) ?? []
      if (!query) {
        out.push({ group: g, rows: all, all, hiddenByCollapse: collapsed.has(g.id) })
        continue
      }
      const gMatch = `${g.title} ${g.orderNo} ${g.due}`.toLowerCase().includes(query)
      const rows = gMatch
        ? all
        : all.filter((r) =>
            Object.values(r.cells).some(
              (v) => !v.startsWith('data:') && !v.startsWith('/api/img/') && v.toLowerCase().includes(query),
            ),
          )
      if (gMatch || rows.length) out.push({ group: g, rows, all, hiddenByCollapse: false })
    }
    return out
  }, [groupsSorted, rowsByGroup, query, collapsed])

  // Flat visible row list + column key order — the keyboard nav space.
  const navRef = useRef<{ rows: Row[]; cols: string[] }>({ rows: [], cols: [] })
  navRef.current = {
    rows: visible.flatMap((v) => (v.hiddenByCollapse ? [] : v.rows)),
    cols: [
      'num',
      ...(st?.columns.map((c) => c.id) ?? []),
      ...stages.map((s) => `s:${s}`),
    ],
  }

  // ----------------------------------------------------------------- actions
  const commitCell = useCallback(
    (rowId: string, colId: string, value: string) => {
      const s = stRef.current
      const row = s?.rows.find((r) => r.id === rowId)
      const prev = row?.cells[colId] ?? ''
      const v = value.trim()
      if (v === prev) return
      dispatch([{ type: 'editCell', rowId, colId, value: v }])
    },
    [dispatch],
  )

  const tapStage = useCallback(
    (row: Row, stage: string) => {
      const done = row.stageDone[stage]
      dispatch([
        {
          type: 'setStage',
          rowId: row.id,
          stage,
          done: done ? null : { at: factoryToday(), by: meRef.current || '我' },
        },
      ])
    },
    [dispatch],
  )

  const showUndo = useCallback(
    (text: string, ops: Op[]) => {
      setUndo({ text, ops })
      if (undoTimer.current) clearTimeout(undoTimer.current)
      undoTimer.current = setTimeout(() => setUndo(null), 6000)
    },
    [],
  )

  const deleteRow = useCallback(
    (row: Row) => {
      dispatch([{ type: 'delRow', id: row.id }])
      setSel(null)
      showUndo('已删除 1 行', [{ type: 'addRows', rows: [row] }])
    },
    [dispatch, showUndo],
  )

  const deleteGroup = useCallback(
    (g: Group) => {
      const rows = (stRef.current?.rows ?? []).filter((r) => r.groupId === g.id)
      dispatch([{ type: 'delGroup', id: g.id }])
      setDelGroupArm(null)
      showUndo(`已删除「${g.title || g.orderNo || '未命名'}」`, [
        { type: 'addGroup', group: g },
        { type: 'addRows', rows },
      ])
    },
    [dispatch, showUndo],
  )

  const addRow = useCallback(
    (groupId: string) => {
      const s = stRef.current
      if (!s) return
      const maxPos = s.rows.filter((r) => r.groupId === groupId).reduce((m, r) => Math.max(m, r.pos), 0)
      const row: Row = { id: rid(), groupId, cells: {}, stageDone: {}, flag: false, pos: maxPos + 1 }
      dispatch([{ type: 'addRows', rows: [row] }])
      const firstText = s.columns.find((c) => c.kind === 'text')
      if (firstText) {
        setSel({ rowId: row.id, ck: firstText.id })
        setEditSync({ rowId: row.id, colId: firstText.id, init: '' })
      }
    },
    [dispatch],
  )

  const addGroup = useCallback(() => {
    const s = stRef.current
    if (!s) return
    const maxPos = s.groups.reduce((m, g) => Math.max(m, g.pos), 0)
    const g: Group = { id: rid(), title: '', orderNo: '', due: '', pos: maxPos + 1 }
    dispatch([{ type: 'addGroup', group: g }])
    setFlashIds([g.id])
    setTimeout(() => {
      document.querySelector<HTMLInputElement>(`[data-gtitle="${g.id}"]`)?.focus()
    }, 30)
  }, [dispatch])

  const setFlashIds = (ids: string[]) => {
    setFlash(new Set(ids))
    setTimeout(() => setFlash(new Set()), 900)
  }

  const runPastePlan = useCallback(
    (plan: ReturnType<typeof planPaste>) => {
      dispatch(plan.ops)
      setFlashIds([...plan.rowIds, plan.groupId])
      const s = stRef.current
      const firstText = s?.columns.find((c) => c.kind === 'text')
      if (plan.rowIds.length && firstText) setSel({ rowId: plan.rowIds[0], ck: firstText.id })
      showToast(
        `已添加 ${plan.rowIds.length} 行${plan.liftedNote ? ` · ${plan.liftedNote}` : ''}`,
        'success',
      )
    },
    [dispatch],
  )

  // --------------------------------------------------------------- images
  const setRowImage = useCallback(
    async (rowId: string, file: File) => {
      const s = stRef.current
      const ic = s?.columns.find((c) => c.kind === 'img')
      if (!ic) return
      const scaled = await downscale(file, mode === 'demo' ? 520 : 1400, 0.82)
      if (mode === 'demo') {
        const dataUrl = scaled ? await blobToDataUrl(scaled) : null
        if (!dataUrl) {
          showToast('这张图读不出来', 'warning')
          return
        }
        dispatch([{ type: 'editCell', rowId, colId: ic.id, value: dataUrl }])
        return
      }
      const preview = URL.createObjectURL(scaled ?? file)
      setUploading((u) => ({ ...u, [rowId]: preview }))
      try {
        const fd = new FormData()
        fd.append('file', scaled ? new File([scaled], 'x.jpg', { type: 'image/jpeg' }) : file)
        const r = await fetch('/api/x/upload', { method: 'POST', body: fd })
        const j = (await r.json()) as { ok?: boolean; url?: string; error?: string }
        if (!r.ok || !j.ok || !j.url) throw new Error(j.error || 'upload failed')
        dispatch([{ type: 'editCell', rowId, colId: ic.id, value: j.url }])
      } catch {
        showToast('图片上传失败', 'warning')
      } finally {
        setUploading((u) => {
          const next = { ...u }
          delete next[rowId]
          return next
        })
        URL.revokeObjectURL(preview)
      }
    },
    [dispatch, mode],
  )

  const handleImageFiles = useCallback(
    (files: File[], preferRowId?: string) => {
      const s = stRef.current
      if (!s || !files.length) return
      const ic = s.columns.find((c) => c.kind === 'img')
      if (!ic) return
      const targets: string[] = []
      const startRowId = preferRowId ?? selRef.current?.rowId ?? null
      const startRow = s.rows.find((r) => r.id === startRowId)
      const ops: Op[] = []
      if (startRow) {
        // Fill from the selected row downward: replace its image, then land in
        // following empty slots; overflow appends fresh rows to the group.
        const groupRows = s.rows
          .filter((r) => r.groupId === startRow.groupId)
          .sort((a, b) => a.pos - b.pos)
        const startIdx = groupRows.findIndex((r) => r.id === startRow.id)
        targets.push(startRow.id)
        for (let i = startIdx + 1; i < groupRows.length && targets.length < files.length; i++) {
          if (!groupRows[i].cells[ic.id]) targets.push(groupRows[i].id)
        }
        let maxPos = groupRows.reduce((m, r) => Math.max(m, r.pos), 0)
        const extra: Row[] = []
        while (targets.length < files.length) {
          maxPos += 1
          const row: Row = { id: rid(), groupId: startRow.groupId, cells: {}, stageDone: {}, flag: false, pos: maxPos }
          extra.push(row)
          targets.push(row.id)
        }
        if (extra.length) ops.push({ type: 'addRows', rows: extra })
      } else {
        // No target — the photos ARE the new 单 (boss photographs N parts).
        const gid = rid()
        const maxPos = s.groups.reduce((m, g) => Math.max(m, g.pos), 0)
        ops.push({ type: 'addGroup', group: { id: gid, title: '', orderNo: '', due: '', pos: maxPos + 1 } })
        const rows: Row[] = files.map((_, i) => ({
          id: rid(), groupId: gid, cells: {}, stageDone: {}, flag: false, pos: i + 1,
        }))
        ops.push({ type: 'addRows', rows })
        targets.push(...rows.map((r) => r.id))
      }
      if (ops.length) dispatch(ops)
      setFlashIds(targets)
      files.forEach((f, i) => {
        const t = targets[i]
        if (t) void setRowImage(t, f)
      })
    },
    [dispatch, setRowImage],
  )

  const openPicker = useCallback((rowId: string) => {
    pickTarget.current = rowId
    fileInput.current?.click()
  }, [])

  // ---------------------------------------------------------------- paste
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (editRef.current) return
      const s = stRef.current
      const cd = e.clipboardData
      if (!s || !cd) return

      const files = Array.from(cd.files ?? []).filter((f) => f.type.startsWith('image/'))
      if (files.length) {
        e.preventDefault()
        handleImageFiles(files)
        return
      }

      const html = cd.getData('text/html')
      const text = cd.getData('text/plain')
      if (!html && !text.trim()) return
      const parsed = parseClipboard(html, text)
      if (!parsed) return
      e.preventDefault()

      const cur = selRef.current
      // 1×1 paste into a selected text cell = just set the value.
      if (
        parsed.grid.length === 1 &&
        parsed.grid[0].length === 1 &&
        !parsed.headerLabels &&
        cur &&
        cur.ck !== 'num' &&
        !cur.ck.startsWith('s:')
      ) {
        const col = s.columns.find((c) => c.id === cur.ck)
        if (col?.kind === 'text') {
          commitCell(cur.rowId, col.id, parsed.grid[0][0])
          return
        }
      }
      const curRow = cur ? s.rows.find((r) => r.id === cur.rowId) : undefined
      const plan = planPaste(
        s,
        parsed,
        curRow ? { groupId: curRow.groupId, afterPos: curRow.pos } : null,
      )
      runPastePlan(plan)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [handleImageFiles, runPastePlan, commitCell])

  // -------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (lightboxRef.current) {
        if (e.key === 'Escape') setLightbox(null)
        return
      }
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (editRef.current) return
      const s = stRef.current
      if (!s) return
      const cur = selRef.current
      const { rows, cols } = navRef.current

      if (e.key === 'Escape') {
        setSel(null)
        return
      }
      if (!cur) return
      const ri = rows.findIndex((r) => r.id === cur.rowId)
      const ci = cols.indexOf(cur.ck)
      if (ri < 0 || ci < 0) return
      const row = rows[ri]

      const move = (dr: number, dc: number) => {
        e.preventDefault()
        const nr = Math.min(rows.length - 1, Math.max(0, ri + dr))
        const nc = Math.min(cols.length - 1, Math.max(0, ci + dc))
        const next = { rowId: rows[nr].id, ck: cols[nc] }
        setSel(next)
        requestAnimationFrame(() => {
          document
            .querySelector(`[data-cell="${next.rowId}|${cssEscape(next.ck)}"]`)
            ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        })
      }

      if (e.key === 'ArrowDown') return move(1, 0)
      if (e.key === 'ArrowUp') return move(-1, 0)
      if (e.key === 'ArrowRight') return move(0, 1)
      if (e.key === 'ArrowLeft') return move(0, -1)
      if (e.key === 'Tab') return move(0, e.shiftKey ? -1 : 1)

      if (e.key === 'Enter') {
        e.preventDefault()
        if (cur.ck === 'num') {
          dispatch([{ type: 'setFlag', rowId: row.id, flag: !row.flag }])
          return
        }
        if (cur.ck.startsWith('s:')) {
          tapStage(row, cur.ck.slice(2))
          return
        }
        const col = s.columns.find((c) => c.id === cur.ck)
        if (!col) return
        if (col.kind === 'img') {
          const v = row.cells[col.id]
          if (v) setLightbox(v)
          else openPicker(row.id)
          return
        }
        setEditSync({ rowId: row.id, colId: col.id, init: row.cells[col.id] ?? '' })
        return
      }

      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        if (e.metaKey || e.ctrlKey) {
          deleteRow(row)
          return
        }
        if (cur.ck === 'num') return
        if (cur.ck.startsWith('s:')) {
          if (row.stageDone[cur.ck.slice(2)]) tapStage(row, cur.ck.slice(2))
          return
        }
        const col = s.columns.find((c) => c.id === cur.ck)
        if (col && row.cells[col.id]) commitCell(row.id, col.id, '')
        return
      }

      // Type-to-replace, Excel style.
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const col = s.columns.find((c) => c.id === cur.ck)
        if (col?.kind === 'text') {
          e.preventDefault()
          setEditSync({ rowId: row.id, colId: col.id, init: e.key })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dispatch, tapStage, deleteRow, commitCell, openPicker])

  // ------------------------------------------------------------------ render
  const totalCols = 1 + (st?.columns.length ?? 0) + 1 + stages.length

  if (!st) {
    return (
      <div className="flex h-dvh items-center justify-center text-[12px] text-[var(--color-ink-4)]">
        <style>{CSS}</style>
        载入中…
      </div>
    )
  }

  const isEmpty = st.groups.length === 0
  const minWidth = 44 + 56 + textCols.length * 112 + 30 + stages.length * 58

  return (
    <div className="flex h-dvh flex-col bg-[var(--color-surface)]">
      <style>{CSS}</style>

      {/* ------------------------------------------------ top bar */}
      <header className="relative z-30 flex h-12 shrink-0 items-center gap-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3">
        <span className="select-none font-mono text-[11px] tracking-wide text-[var(--color-ink-3)]">思跃</span>
        <input
          key={`name:${st.name}`}
          defaultValue={st.name}
          onBlur={(e) => {
            const v = e.target.value.trim() || '生产表'
            if (v !== st.name) dispatch([{ type: 'renameSheet', name: v }])
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          className="w-[120px] bg-transparent text-[15px] font-semibold tracking-tight outline-none placeholder:text-[var(--color-ink-4)] sm:w-[170px]"
          placeholder="生产表"
        />
        {mode === 'demo' && (
          <span className="hidden select-none text-[10px] text-[var(--color-ink-4)] md:inline">
            示例模式 · 数据只存这台设备
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索"
            className="h-8 w-24 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[12px] outline-none transition-all placeholder:text-[var(--color-ink-4)] focus:w-40 focus:border-[var(--color-border-strong)] sm:w-32"
          />
          <button
            onClick={() => setStagesOpen((v) => !v)}
            className="h-8 whitespace-nowrap rounded-[2px] border border-[var(--color-border)] px-2.5 text-[11px] text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-ink)]"
          >
            工序
          </button>
          {mode === 'demo' ? (
            <input
              key={`me:${me}`}
              defaultValue={me}
              onBlur={(e) => {
                const v = e.target.value.trim() || '我'
                setMe(v)
                try { localStorage.setItem(LS_ME, v) } catch {}
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              className="h-8 w-16 rounded-[2px] bg-[var(--color-muted-bg)] px-2 text-center text-[12px] font-medium outline-none"
              title="报工署名 — 点✓时记你的名字"
            />
          ) : (
            <span className="flex h-8 items-center rounded-[2px] bg-[var(--color-muted-bg)] px-2.5 text-[12px] font-medium" title="报工署名">
              {me}
            </span>
          )}
          {mode === 'demo' && !isEmpty && (
            <button
              onClick={() => {
                try { localStorage.removeItem(LS_STATE) } catch {}
                setSt(emptySheet())
                setSel(null)
              }}
              className="text-[11px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
            >
              清空
            </button>
          )}
        </div>

        {stagesOpen && (
          <StagesPanel
            stages={stages}
            onClose={() => setStagesOpen(false)}
            onSave={(next) => {
              dispatch([{ type: 'setStages', stages: next }])
              setStagesOpen(false)
            }}
          />
        )}
      </header>

      {/* ------------------------------------------------ body */}
      {isEmpty ? (
        <EmptyState
          mode={mode}
          onSample={() => runPastePlan(samplePlan(st))}
          onBlank={addGroup}
          onDropFiles={(files) => handleImageFiles(files)}
        />
      ) : (
        <div className="flex-1 overflow-auto overscroll-none">
          <table
            className="w-full border-separate border-spacing-0"
            style={{ tableLayout: 'fixed', minWidth }}
          >
            <colgroup>
              <col style={{ width: 44 }} />
              {st.columns.map((c) => (
                <col key={c.id} style={c.kind === 'img' ? { width: 56 } : undefined} />
              ))}
              <col style={{ width: 30 }} />
              {stages.map((s) => (
                <col key={s} style={{ width: 58 }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className={TH} />
                {st.columns.map((c) =>
                  c.kind === 'img' ? (
                    <th key={c.id} className={TH}>{c.label || '图'}</th>
                  ) : (
                    <th key={c.id} className={`${TH} group/th`}>
                      {hdrEdit?.colId === c.id ? (
                        <span className="flex items-center gap-1">
                          <input
                            autoFocus
                            defaultValue={hdrEdit.init}
                            onBlur={(e) => {
                              dispatch([{ type: 'renameColumn', id: c.id, label: e.target.value.trim() }])
                              setHdrEdit(null)
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                              if (e.key === 'Escape') setHdrEdit(null)
                            }}
                            className="w-full min-w-0 rounded-[2px] border border-[var(--color-border-strong)] bg-white px-1 py-0.5 text-[10px] uppercase tracking-[0.12em] outline-none"
                          />
                          <button
                            onMouseDown={(e) => {
                              e.preventDefault()
                              dispatch([{ type: 'delColumn', id: c.id }])
                              setHdrEdit(null)
                              showUndo(`已删除「${c.label || '未命名'}」列`, [{ type: 'addColumns', cols: [c] }])
                            }}
                            className="shrink-0 text-[11px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                            title="删除这一列"
                          >
                            ✕
                          </button>
                        </span>
                      ) : (
                        <button
                          onDoubleClick={() => setHdrEdit({ colId: c.id, init: c.label })}
                          className="block w-full cursor-text truncate text-left uppercase tracking-[0.12em]"
                          title="双击改列名"
                        >
                          {c.label || <span className="text-[var(--color-ink-4)]">列</span>}
                        </button>
                      )}
                    </th>
                  ),
                )}
                <th className={TH}>
                  <button
                    onClick={() => {
                      const col: Col = { id: `c-${rid().slice(0, 8)}`, label: '', kind: 'text' }
                      dispatch([{ type: 'addColumns', cols: [col] }])
                      setHdrEdit({ colId: col.id, init: '' })
                    }}
                    className="block w-full text-center text-[13px] leading-none text-[var(--color-ink-4)] hover:text-[var(--color-ink)]"
                    title="加一列"
                  >
                    ＋
                  </button>
                </th>
                {stages.map((s, i) => (
                  <th
                    key={s}
                    className={`${TH} border-l text-center ${
                      i === 0
                        ? 'border-l-[var(--color-border-strong)]'
                        : 'border-l-[var(--color-border)]'
                    }`}
                  >
                    {s}
                  </th>
                ))}
              </tr>
            </thead>

            {visible.map(({ group, rows, all, hiddenByCollapse }) => (
              <tbody key={group.id}>
                <GroupHeader
                  group={group}
                  all={all}
                  stages={stages}
                  today={today}
                  totalCols={totalCols}
                  collapsed={hiddenByCollapse}
                  flash={flash.has(group.id)}
                  armed={delGroupArm === group.id}
                  onToggle={() => toggleCollapsed(group.id)}
                  onEdit={(patch) => dispatch([{ type: 'editGroup', id: group.id, patch }])}
                  onArm={(v) => setDelGroupArm(v ? group.id : null)}
                  onDelete={() => deleteGroup(group)}
                />
                {!hiddenByCollapse &&
                  rows.map((row) => (
                    <RowTr
                      key={row.id}
                      row={row}
                      index={all.indexOf(row) + 1}
                      cols={st.columns}
                      stages={stages}
                      today={today}
                      sel={sel && sel.rowId === row.id ? sel.ck : null}
                      edit={edit && edit.rowId === row.id ? edit : null}
                      flash={flash.has(row.id)}
                      uploadingUrl={uploading[row.id] ?? null}
                      onSelect={(ck) => { setSel({ rowId: row.id, ck }); setEditSync(null) }}
                      onEditStart={(colId, init) => setEditSync({ rowId: row.id, colId, init })}
                      onEditCommit={(colId, v, moveDown) => {
                        commitCell(row.id, colId, v)
                        setEditSync(null)
                        if (moveDown) {
                          const { rows: navRows } = navRef.current
                          const i = navRows.findIndex((r) => r.id === row.id)
                          const nxt = navRows[i + 1]
                          if (nxt) setSel({ rowId: nxt.id, ck: colId })
                        }
                      }}
                      onEditCancel={() => setEditSync(null)}
                      onTapStage={(stage) => tapStage(row, stage)}
                      onFlag={() => dispatch([{ type: 'setFlag', rowId: row.id, flag: !row.flag }])}
                      onDelete={() => deleteRow(row)}
                      onLightbox={(src) => setLightbox(src)}
                      onPick={() => openPicker(row.id)}
                      onDropFiles={(files) => handleImageFiles(files, row.id)}
                    />
                  ))}
                {!hiddenByCollapse && !query && (
                  <tr>
                    <td colSpan={totalCols} className="border-b border-[var(--color-border)]">
                      <button
                        onClick={() => addRow(group.id)}
                        className="block h-7 w-full pl-11 text-left text-[11px] text-[var(--color-ink-4)] hover:bg-[var(--color-bg)] hover:text-[var(--color-ink-2)]"
                      >
                        ＋ 行
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            ))}
          </table>

          {!query && (
            <div className="px-3 pb-10 pt-2">
              <button
                onClick={addGroup}
                className="h-8 rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-3 text-[12px] text-[var(--color-ink-3)] hover:border-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                ＋ 新单
              </button>
              <p className="mt-4 select-none text-[10px] leading-relaxed text-[var(--color-ink-4)]">
                ⌘V 粘贴追加(选中某行=贴进那一单,没选=另起一单) · 点工序格=报工✓ · 行号=重点★ · 长按行号=删行 · 图片可直接拖到行上
              </p>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------ overlays */}
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          const target = pickTarget.current
          e.target.value = ''
          if (files.length && target) handleImageFiles(files, target)
        }}
      />

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/85 p-4"
          onClick={() => setLightbox(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="" className="max-h-[92vh] max-w-[94vw] rounded-[2px] bg-white object-contain" />
        </div>
      )}

      {undo && (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-3 rounded-[2px] bg-[var(--color-ink)] px-3.5 py-2 text-[12px] text-white shadow-lg">
            <span>{undo.text}</span>
            <button
              onClick={() => {
                dispatch(undo.ops)
                setUndo(null)
              }}
              className="font-semibold underline underline-offset-2 hover:opacity-80"
            >
              撤销
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// header th style
const TH =
  'sticky top-0 z-10 h-8 border-b border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-left text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-ink-3)] whitespace-nowrap'

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------

function GroupHeader({
  group, all, stages, today, totalCols, collapsed, flash, armed,
  onToggle, onEdit, onArm, onDelete,
}: {
  group: Group
  all: Row[]
  stages: string[]
  today: string
  totalCols: number
  collapsed: boolean
  flash: boolean
  armed: boolean
  onToggle: () => void
  onEdit: (patch: Partial<Pick<Group, 'title' | 'orderNo' | 'due'>>) => void
  onArm: (v: boolean) => void
  onDelete: () => void
}) {
  const doneCount = all.filter((r) => rowDone(r, stages)).length
  const allDone = all.length > 0 && doneCount === all.length
  const day = parseDayLike(group.due)
  const overdue = !!day && !allDone && dayDiff(day, today) < 0
  const soon = !!day && !allDone && !overdue && dayDiff(day, today) <= 1

  const commit = (field: 'title' | 'orderNo' | 'due') => (e: React.FocusEvent<HTMLInputElement>) => {
    const v = e.target.value.trim()
    if (v !== group[field]) onEdit({ [field]: v })
  }
  const enterBlurs = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
  }

  return (
    <tr className={flash ? 'x-row-in' : undefined}>
      <td colSpan={totalCols} className="border-b border-[var(--color-border)] bg-[var(--color-bg)] px-1.5">
        <div className="flex h-10 items-center gap-2">
          <button
            onClick={onToggle}
            className={`w-5 shrink-0 text-center text-[10px] text-[var(--color-ink-3)] transition-transform ${collapsed ? '' : 'rotate-90'}`}
            title={collapsed ? '展开' : '收起'}
          >
            ▶
          </button>
          <input
            key={`t:${group.title}`}
            data-gtitle={group.id}
            defaultValue={group.title}
            onBlur={commit('title')}
            onKeyDown={enterBlurs}
            placeholder="客户 / 单名"
            className="w-[110px] shrink-0 bg-transparent text-[13px] font-semibold tracking-tight outline-none placeholder:font-normal placeholder:text-[var(--color-ink-4)] sm:w-[160px]"
          />
          <input
            key={`o:${group.orderNo}`}
            defaultValue={group.orderNo}
            onBlur={commit('orderNo')}
            onKeyDown={enterBlurs}
            placeholder="单号"
            className="w-[90px] shrink-0 bg-transparent font-mono text-[11px] text-[var(--color-ink-3)] outline-none placeholder:text-[var(--color-ink-4)] sm:w-[130px]"
          />
          <span className={`shrink-0 text-[10px] ${overdue ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink-4)]'}`}>
            交期
          </span>
          <input
            key={`d:${group.due}`}
            defaultValue={group.due}
            onBlur={commit('due')}
            onKeyDown={enterBlurs}
            placeholder="—"
            className={`w-[72px] shrink-0 bg-transparent font-mono text-[11.5px] outline-none placeholder:text-[var(--color-ink-4)] ${
              overdue
                ? 'font-semibold text-[var(--color-overdue)]'
                : soon
                  ? 'font-semibold text-[var(--color-warning)]'
                  : 'text-[var(--color-ink-2)]'
            }`}
            title={overdue && day ? `已超 ${-dayDiff(day, today)} 天` : undefined}
          />
          {overdue && day && (
            <span className="shrink-0 text-[10px] font-semibold text-[var(--color-overdue)]">
              超{-dayDiff(day, today)}天
            </span>
          )}
          <span className={`ml-auto shrink-0 font-mono text-[11px] tabular-nums ${allDone ? 'font-semibold text-[var(--color-success)]' : 'text-[var(--color-ink-3)]'}`}>
            {allDone ? '✓ ' : ''}{doneCount}/{all.length}
          </span>
          {armed ? (
            <span className="flex shrink-0 items-center gap-2 text-[11px]">
              <span className="text-[var(--color-ink-2)]">删这一单？</span>
              <button onClick={onDelete} className="font-semibold text-[var(--color-overdue)]">确认</button>
              <button onClick={() => onArm(false)} className="text-[var(--color-ink-3)]">取消</button>
            </span>
          ) : (
            <button
              onClick={() => onArm(true)}
              className="w-6 shrink-0 text-center text-[13px] leading-none text-[var(--color-ink-4)] hover:text-[var(--color-ink)]"
              title="删除整单"
            >
              ⋯
            </button>
          )}
        </div>
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------

function RowTr({
  row, index, cols, stages, today, sel, edit, flash, uploadingUrl,
  onSelect, onEditStart, onEditCommit, onEditCancel, onTapStage, onFlag,
  onDelete, onLightbox, onPick, onDropFiles,
}: {
  row: Row
  index: number
  cols: Col[]
  stages: string[]
  today: string
  sel: string | null
  edit: { colId: string; init: string } | null
  flash: boolean
  uploadingUrl: string | null
  onSelect: (ck: string) => void
  onEditStart: (colId: string, init: string) => void
  onEditCommit: (colId: string, v: string, moveDown: boolean) => void
  onEditCancel: () => void
  onTapStage: (stage: string) => void
  onFlag: () => void
  onDelete: () => void
  onLightbox: (src: string) => void
  onPick: () => void
  onDropFiles: (files: File[]) => void
}) {
  const done = rowDone(row, stages)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const held = useRef(false)

  const startHold = () => {
    held.current = false
    holdTimer.current = setTimeout(() => {
      held.current = true
      onDelete()
    }, 600)
  }
  const endHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current)
  }

  const frontier = stages.find((s) => !row.stageDone[s])

  return (
    <tr
      className={`${done ? 'opacity-55' : ''} ${flash ? 'x-row-in' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith('image/'))
        if (files.length) {
          e.preventDefault()
          onDropFiles(files)
        }
      }}
    >
      {/* row number / 重点 */}
      <td
        data-cell={`${row.id}|num`}
        className="relative cursor-pointer select-none border-b border-[var(--color-border)] text-center"
        onClick={() => {
          if (held.current) return
          onFlag()
        }}
        onMouseDown={startHold}
        onMouseUp={endHold}
        onMouseLeave={endHold}
        onTouchStart={startHold}
        onTouchEnd={endHold}
        onTouchMove={endHold}
        title={row.flag ? '取消重点(长按删行)' : '标重点(长按删行)'}
      >
        {row.flag && <span className="absolute inset-y-0 left-0 w-[3px] bg-[var(--color-warning)]" />}
        {done ? (
          <span className="text-[11px] font-semibold text-[var(--color-success)]">✓</span>
        ) : row.flag ? (
          <span className="text-[12px] text-[var(--color-warning)]">★</span>
        ) : (
          <span className="font-mono text-[10px] text-[var(--color-ink-4)]">{index}</span>
        )}
        {sel === 'num' && <SelRing />}
      </td>

      {/* data columns */}
      {cols.map((c) => {
        if (c.kind === 'img') {
          const src = uploadingUrl ?? row.cells[c.id]
          return (
            <td
              key={c.id}
              data-cell={`${row.id}|${c.id}`}
              className="relative border-b border-[var(--color-border)] p-1"
              onClick={() => {
                if (src && !uploadingUrl) onLightbox(src)
                else if (sel === c.id) onPick()
                else onSelect(c.id)
              }}
              onDoubleClick={() => { if (!src) onPick() }}
            >
              {src ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={src}
                  alt=""
                  className={`h-9 w-12 cursor-zoom-in rounded-[2px] border border-[var(--color-border)] bg-white object-cover ${uploadingUrl ? 'animate-pulse' : ''}`}
                />
              ) : (
                <span className="flex h-9 w-12 items-center justify-center rounded-[2px] text-[13px] text-[var(--color-ink-4)] opacity-0 hover:opacity-100">
                  ＋
                </span>
              )}
              {sel === c.id && <SelRing />}
            </td>
          )
        }
        const v = row.cells[c.id] ?? ''
        const editing = edit?.colId === c.id
        return (
          <td
            key={c.id}
            data-cell={`${row.id}|${c.id}`}
            className="relative h-11 cursor-default border-b border-[var(--color-border)] px-2 text-[13px]"
            // Excel grammar: first click selects, click-again (or dblclick, or
            // just typing) edits. Selection must happen in the click phase —
            // selecting on mousedown re-renders before the click event lands,
            // which made every first click fall straight into edit mode.
            onClick={() => {
              if (editing) return
              if (sel === c.id) onEditStart(c.id, v)
              else onSelect(c.id)
            }}
            onDoubleClick={() => {
              if (!editing) onEditStart(c.id, v)
            }}
          >
            {editing ? (
              <input
                autoFocus
                defaultValue={edit.init}
                // Caret at end, never select-all: in type-to-replace the init
                // char is already "typed", and select-all would make the very
                // next keystroke wipe it.
                onFocus={(e) => {
                  const n = e.target.value.length
                  e.target.setSelectionRange(n, n)
                }}
                onBlur={(e) => onEditCommit(c.id, e.target.value, false)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return
                  if (e.key === 'Enter') onEditCommit(c.id, (e.target as HTMLInputElement).value, true)
                  if (e.key === 'Tab') {
                    e.preventDefault()
                    onEditCommit(c.id, (e.target as HTMLInputElement).value, false)
                  }
                  if (e.key === 'Escape') onEditCancel()
                }}
                className="absolute inset-0 z-[2] h-full w-full border-[1.5px] border-[var(--color-ink)] bg-white px-2 text-[13px] outline-none"
              />
            ) : (
              <CellValue v={v} today={today} rowFinished={done} />
            )}
            {sel === c.id && !editing && <SelRing />}
          </td>
        )
      })}

      {/* +col spacer */}
      <td className="border-b border-[var(--color-border)]" />

      {/* stage strip */}
      {stages.map((s, i) => {
        const d = row.stageDone[s]
        const ck = `s:${s}`
        return (
          <td
            key={s}
            data-cell={`${row.id}|${ck}`}
            className={`relative border-b border-l p-0 ${
              i === 0 ? 'border-l-[var(--color-border-strong)]' : 'border-l-[var(--color-border)]'
            } border-b-[var(--color-border)]`}
          >
            <button
              onClick={() => onTapStage(s)}
              onFocus={(e) => e.target.blur()}
              className={`flex h-11 w-full flex-col items-center justify-center gap-0.5 leading-none ${
                d ? '' : 'hover:bg-[var(--color-success-soft)]'
              }`}
              title={d ? `${s} · ${d.at} · ${d.by} (再点=撤销)` : `点一下=报工 ${s} ✓`}
            >
              {d ? (
                <>
                  <span className="x-tick text-[15px] font-semibold text-[var(--color-success)]">✓</span>
                  <span className="font-mono text-[9px] text-[var(--color-ink-3)]">
                    {mdShort(d.at)} {d.by.slice(0, 2)}
                  </span>
                </>
              ) : frontier === s ? (
                <span className="text-[15px] leading-none text-[var(--color-ink-4)]">·</span>
              ) : null}
            </button>
            {sel === ck && <SelRing />}
          </td>
        )
      })}
    </tr>
  )
}

function SelRing() {
  return (
    <span className="pointer-events-none absolute inset-0 z-[1] border-[1.5px] border-[var(--color-ink)]" />
  )
}

// Value-level smarts: dates color by urgency, numbers right-align, text is text.
function CellValue({ v, today, rowFinished }: { v: string; today: string; rowFinished: boolean }) {
  if (!v) return null
  const day = parseDayLike(v)
  if (day) {
    const diff = dayDiff(day, today)
    const cls =
      !rowFinished && diff < 0
        ? 'font-semibold text-[var(--color-overdue)]'
        : !rowFinished && diff <= 1
          ? 'font-semibold text-[var(--color-warning)]'
          : 'text-[var(--color-ink-2)]'
    return (
      <span className={`block truncate font-mono text-[12px] ${cls}`} title={!rowFinished && diff < 0 ? `${v} · 已超 ${-diff} 天` : v}>
        {mdShort(day)}
      </span>
    )
  }
  if (isNumeric(v)) {
    return <span className="block truncate text-right font-mono text-[12.5px] tabular-nums">{v}</span>
  }
  return <span className="block truncate" title={v}>{v}</span>
}

// ---------------------------------------------------------------------------

function StagesPanel({
  stages, onClose, onSave,
}: {
  stages: string[]
  onClose: () => void
  onSave: (next: string[]) => void
}) {
  const [val, setVal] = useState(stages.join(' '))
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute right-3 top-[52px] z-40 w-[300px] rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-3 shadow-lg">
        <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-ink-3)]">
          工序(空格分隔,按你厂的叫法)
        </div>
        <input
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const next = val.split(/[\s,，、]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20)
              if (next.length) onSave(next)
            }
            if (e.key === 'Escape') onClose()
          }}
          className="mt-2 w-full rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--color-border-strong)]"
        />
        <p className="mt-2 text-[10px] leading-relaxed text-[var(--color-ink-4)]">
          已打的 ✓ 按工序名字记着;改名后旧 ✓ 会对不上,删掉/加新的不受影响。
        </p>
        <div className="mt-2 flex justify-end gap-2">
          <button onClick={onClose} className="h-7 rounded-[2px] px-2.5 text-[11px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]">
            取消
          </button>
          <button
            onClick={() => {
              const next = val.split(/[\s,，、]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20)
              if (next.length) onSave(next)
            }}
            className="h-7 rounded-[2px] bg-[var(--color-ink)] px-3 text-[11px] font-medium text-white hover:opacity-90"
          >
            保存
          </button>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------

function EmptyState({
  mode, onSample, onBlank, onDropFiles,
}: {
  mode: Mode
  onSample: () => void
  onBlank: () => void
  onDropFiles: (files: File[]) => void
}) {
  return (
    <div
      className="flex flex-1 items-center justify-center p-6"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith('image/'))
        if (files.length) {
          e.preventDefault()
          onDropFiles(files)
        }
      }}
    >
      <div className="x-fadein w-full max-w-md text-center">
        <div className="text-[22px] font-semibold tracking-tight">把你的排产表,粘贴进来</div>
        <p className="mx-auto mt-3 max-w-sm text-[13px] leading-relaxed text-[var(--color-ink-2)]">
          在 WPS / Excel 里选中零件那几行,复制,回到这里按
          <Kbd>⌘V</Kbd>或<Kbd>Ctrl+V</Kbd>。
          列名、数量、交期、客户,原样落进表格 — 然后整个厂看的就是同一张表。
        </p>
        <div className="mt-7 flex items-center justify-center gap-3">
          <button
            onClick={onSample}
            className="h-9 rounded-[2px] border border-[var(--color-border-strong)] px-4 text-[13px] font-medium hover:bg-[var(--color-muted-bg)]"
          >
            粘贴示例数据
          </button>
          <button
            onClick={onBlank}
            className="h-9 px-2 text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            或 新建空白一单
          </button>
        </div>
        <p className="mt-9 select-none text-[11px] leading-relaxed text-[var(--color-ink-4)]">
          点工序格 = 报工✓(记名字和日期) · 点行号 = 重点★ · 图片直接拖进来
          {mode === 'demo' ? ' · 示例数据只存这台设备' : ''}
        </p>
      </div>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mx-1 rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-muted-bg)] px-1.5 py-0.5 font-mono text-[11px]">
      {children}
    </kbd>
  )
}

// ---------------------------------------------------------------------------
// image helpers

async function downscale(file: File, maxDim: number, quality: number): Promise<Blob | null> {
  try {
    const url = URL.createObjectURL(file)
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = reject
      el.src = url
    })
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no ctx')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    URL.revokeObjectURL(url)
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality),
    )
  } catch {
    return null
  }
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const fr = new FileReader()
    fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null)
    fr.onerror = () => resolve(null)
    fr.readAsDataURL(blob)
  })
}
