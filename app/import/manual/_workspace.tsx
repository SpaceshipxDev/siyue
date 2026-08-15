'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { withBase } from '@/lib/base-path'
import { BackButton } from '@/app/_back'
import { DatePop } from '@/app/_datepop'
import { autoMapColumns, detectHeaderRow, IMG_RE, type FieldKey } from './_map'

/*
 * 清单导入 — the no-AI import workspace.
 *
 * The user pastes a copied WPS/Excel range (text only — the OS clipboard does
 * not carry embedded cell pictures across apps) or drops the original .xlsx
 * (embedded 图纸 come along via the same extractor the AI import uses). The
 * sheet renders as a grid; clicking a column head assigns it to a system
 * field (零件名称 / 数量 / …), with common Chinese header names pre-matched
 * automatically. 导入 commits the mapped rows as a normal draft and lands on
 * /import/[id] — the same review + 确认导入 gate the AI path uses, so nothing
 * enters the board without a human confirm either way.
 */

// ---------------------------------------------------------------- model

// Menu + numeric-alignment metadata. Ordered exactly like the board's 零件
// sheet (零件 · 料号 · 加工工艺 · 数量 · 材料 · 表面处理 · … · 备注 · 单价 ·
// 小计) so the mapping menu reads as the same fixed sequence every order
// imports into.
const FIELDS: { key: FieldKey; label: string; numeric?: boolean }[] = [
  { key: 'name', label: '零件名称' },
  { key: 'partNo', label: '料号' },
  { key: 'process', label: '加工工艺' },
  { key: 'qty', label: '数量', numeric: true },
  { key: 'material', label: '材料' },
  { key: 'surfaceTreatment', label: '表面处理' },
  { key: 'notes', label: '备注' },
  { key: 'unitPriceCny', label: '单价', numeric: true },
  { key: 'lineTotalCny', label: '小计', numeric: true },
  { key: 'image', label: '图纸' },
]

const FIELD_LABEL = Object.fromEntries(FIELDS.map((f) => [f.key, f.label])) as Record<
  FieldKey,
  string
>

// 合计-style footer rows never import, whatever sits in their name cell.
const FOOTER_ROW_RE = /^(合计|总计|小计|总价|总金额|备注|说明|以下空白)/

function colLetter(c: number): string {
  let s = ''
  let n = c
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

type MetaDraft = {
  customer: string
  product: string
  jobNo: string
  amount: string
  dueDate: string
  notes: string
}

const META_PATTERNS: [RegExp, keyof MetaDraft][] = [
  [/^(客户|客户名称|客户名|委托单位|委托方|公司名称|甲方|需方)$/, 'customer'],
  [/^(产品|产品名称|项目|项目名称|机种)$/, 'product'],
  [/^(工号|单号|订单号|订单编号|工单号|合同号|合同编号)$/, 'jobNo'],
  [/^(交期|交货期|交货日期|纳期|交货时间)$/, 'dueDate'],
  [/^(总价|总金额|合计金额|含税总价|总计)$/, 'amount'],
]

function ymd(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function parseDayLike(raw: string): string | null {
  const s = raw.trim()
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(s)
  if (m) return ymd(+m[1], +m[2], +m[3])
  // xlsx renders dates as m/d/yy — month first.
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s)
  if (m) return ymd(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1], +m[2])
  m = /^(\d{1,2})[-.月](\d{1,2})日?$/.exec(s)
  if (m) return ymd(new Date().getFullYear(), +m[1], +m[2])
  return null
}

function detectMeta(aoa: string[][], headerRow: number): Partial<MetaDraft> {
  const found: Partial<MetaDraft> = {}
  const take = (key: keyof MetaDraft, raw: string) => {
    const v = raw.trim()
    if (!v || found[key]) return
    if (key === 'dueDate') {
      const day = parseDayLike(v)
      if (day) found.dueDate = day
      return
    }
    found[key] = v
  }
  for (let r = 0; r < headerRow; r++) {
    const row = aoa[r] ?? []
    for (let c = 0; c < row.length; c++) {
      const cell = (row[c] ?? '').trim()
      if (!cell || IMG_RE.test(cell)) continue
      const inline = /^(.+?)[:：](.+)$/.exec(cell)
      for (const [re, key] of META_PATTERNS) {
        if (inline && re.test(inline[1].trim())) {
          take(key, inline[2])
        } else if (re.test(cell)) {
          for (let c2 = c + 1; c2 < row.length; c2++) {
            const v = (row[c2] ?? '').trim()
            if (v) {
              take(key, v)
              break
            }
          }
        }
      }
    }
  }
  return found
}

function parseQty(raw: string): number {
  const m = /(\d+(?:\.\d+)?)/.exec(raw.replace(/,/g, ''))
  if (!m) return 1
  const n = Math.round(parseFloat(m[1]))
  return n >= 1 ? n : 1
}

function parseMoney(raw: string): number | undefined {
  const s = raw.replace(/[^\d.]/g, '')
  if (!s) return undefined
  const n = parseFloat(s)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined
}

// --------------------------------------------------------- clipboard parse

type PastedGrid = { aoa: string[][]; rowImgs: (string | null)[] }

function parsePasted(html: string, text: string): PastedGrid | null {
  let grid: string[][] = []
  let imgs: (string | null)[] = []

  if (html && /<table/i.test(html) && typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const table = doc.querySelector('table')
    if (table) {
      for (const tr of Array.from(table.querySelectorAll('tr'))) {
        const cells = Array.from(tr.querySelectorAll('td,th'))
        if (!cells.length) continue
        grid.push(cells.map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim()))
        // Desktop Excel/WPS put file:/// refs here (unreadable); only web
        // tables carry data-URIs. Harvest them when they exist — free 图纸.
        let img: string | null = null
        for (const td of cells) {
          const src = td.querySelector('img')?.getAttribute('src') ?? ''
          if (src.startsWith('data:image/')) {
            img = src
            break
          }
        }
        imgs.push(img)
      }
    }
  }

  if (!grid.length) {
    const lines = text.replace(/\r/g, '').split('\n')
    grid = lines.map((l) => l.split('\t').map((c) => c.trim()))
    imgs = lines.map(() => null)
  }

  // Drop empty rows, square the matrix, trim empty trailing columns.
  const keptImgs: (string | null)[] = []
  grid = grid.filter((r, i) => {
    const has = r.some((c) => c !== '')
    if (has) keptImgs.push(imgs[i] ?? null)
    return has
  })
  if (!grid.length) return null
  const width = Math.max(...grid.map((r) => r.length))
  grid = grid.map((r) => {
    const out = r.slice()
    while (out.length < width) out.push('')
    return out
  })
  let lastUsed = -1
  for (let c = 0; c < width; c++) if (grid.some((r) => r[c] !== '')) lastUsed = c
  grid = grid.map((r) => r.slice(0, lastUsed + 1))
  if (!grid[0]?.length) return null
  return { aoa: grid, rowImgs: keptImgs }
}

// ---------------------------------------------------------------- component

type SheetData = {
  name: string
  aoa: string[][]
  rowImgs?: (string | null)[]
}

type Loaded = {
  kind: 'file' | 'paste'
  file?: File
  fileName?: string
  sheets: SheetData[]
  images: Record<string, string | null>
}

const emptyMeta: MetaDraft = {
  customer: '',
  product: '',
  jobNo: '',
  amount: '',
  dueDate: '',
  notes: '',
}

export function ManualImportWorkspace() {
  const router = useRouter()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [active, setActive] = useState(0)
  const [headerRow, setHeaderRow] = useState(0)
  const [mapping, setMapping] = useState<(FieldKey | null)[]>([])
  const [excluded, setExcluded] = useState<Set<number>>(new Set())
  const [meta, setMeta] = useState<MetaDraft>(emptyMeta)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ col: number; top: number; left: number } | null>(null)
  const [drag, setDrag] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const sheet = loaded?.sheets[active] ?? null

  const initSheet = useCallback(
    (data: Loaded, sheetIdx: number, base: MetaDraft, fileStem?: string) => {
      const aoa = data.sheets[sheetIdx]?.aoa ?? []
      const hr = detectHeaderRow(aoa)
      setHeaderRow(hr)
      setMapping(autoMapColumns(aoa, hr))
      setExcluded(new Set())
      const detected = detectMeta(aoa, hr)
      setMeta({
        ...base,
        customer: base.customer || detected.customer || '',
        product: base.product || detected.product || '',
        jobNo: base.jobNo || detected.jobNo || fileStem || '',
        amount: base.amount || detected.amount || '',
        dueDate: base.dueDate || detected.dueDate || '',
      })
    },
    [],
  )

  const loadData = useCallback(
    (data: Loaded, fileStem?: string) => {
      // Default to the sheet with the most rows — cover sheets and 说明 tabs
      // are usually near-empty.
      let idx = 0
      for (let i = 1; i < data.sheets.length; i++) {
        if ((data.sheets[i].aoa.length ?? 0) > (data.sheets[idx].aoa.length ?? 0)) idx = i
      }
      setLoaded(data)
      setActive(idx)
      setError(null)
      initSheet(data, idx, emptyMeta, fileStem)
    },
    [initSheet],
  )

  const handleFile = useCallback(
    async (file: File) => {
      if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
        setError('只支持 .xlsx / .xls / .csv 文件')
        return
      }
      setBusy('读取文件中…')
      setError(null)
      try {
        const fd = new FormData()
        fd.append('file', file)
        const r = await fetch(withBase('/api/qingdan/parse'), { method: 'POST', body: fd })
        const d = (await r.json()) as
          | { ok: true; fileName: string; sheets: { name: string; aoa: string[][] }[]; images: Record<string, string | null> }
          | { ok: false; error: string }
        if (!('ok' in d) || !d.ok) {
          setError('error' in d ? `无法读取：${d.error}` : '无法读取文件')
          return
        }
        const sheets = d.sheets.filter((s) => s.aoa.length > 0)
        if (!sheets.length) {
          setError('文件里没有内容')
          return
        }
        loadData(
          { kind: 'file', file, fileName: d.fileName, sheets, images: d.images },
          file.name.replace(/\.[^.]+$/, ''),
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(null)
      }
    },
    [loadData],
  )

  // Paste — the whole point. Active only before data lands; after that the
  // meta inputs own the clipboard and 重新导入 is the way back.
  useEffect(() => {
    if (loaded) return
    const onPaste = (e: ClipboardEvent) => {
      const cd = e.clipboardData
      if (!cd) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      const excel = Array.from(cd.files ?? []).find((f) => /\.(xlsx|xls|csv)$/i.test(f.name))
      if (excel) {
        e.preventDefault()
        void handleFile(excel)
        return
      }
      const parsed = parsePasted(cd.getData('text/html'), cd.getData('text/plain'))
      if (!parsed) return
      e.preventDefault()
      loadData({
        kind: 'paste',
        sheets: [{ name: '粘贴内容', aoa: parsed.aoa, rowImgs: parsed.rowImgs }],
        images: {},
      })
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [loaded, handleFile, loadData])

  const switchSheet = (i: number) => {
    if (!loaded || i === active) return
    setActive(i)
    initSheet(loaded, i, meta)
  }

  const moveHeader = (delta: number) => {
    if (!sheet) return
    const next = Math.min(Math.max(headerRow + delta, 0), Math.max(sheet.aoa.length - 2, 0))
    if (next === headerRow) return
    setHeaderRow(next)
    setMapping(autoMapColumns(sheet.aoa, next))
    setExcluded(new Set())
  }

  const assign = (col: number, field: FieldKey | null) => {
    setMapping((prev) => {
      const next = prev.slice()
      while (next.length <= col) next.push(null)
      if (field) {
        for (let c = 0; c < next.length; c++) if (next[c] === field) next[c] = null
      }
      next[col] = field
      return next
    })
    setMenu(null)
  }

  const colOf = useCallback(
    (field: FieldKey) => mapping.findIndex((m) => m === field),
    [mapping],
  )

  // Row roll-call: which sheet rows become 零件.
  const rows = useMemo(() => {
    if (!sheet) return []
    const nameCol = colOf('name')
    const out: { r: number; name: string; autoSkip: boolean; included: boolean }[] = []
    for (let r = headerRow + 1; r < sheet.aoa.length; r++) {
      const row = sheet.aoa[r] ?? []
      const rawName = nameCol >= 0 ? (row[nameCol] ?? '').trim() : ''
      const name = IMG_RE.test(rawName) ? '' : rawName
      const autoSkip = !name || FOOTER_ROW_RE.test(name)
      out.push({ r, name, autoSkip, included: !autoSkip && !excluded.has(r) })
    }
    return out
  }, [sheet, headerRow, colOf, excluded])

  const included = useMemo(() => rows.filter((x) => x.included), [rows])

  const buildComponents = useCallback(() => {
    if (!sheet) return []
    const col = (f: FieldKey) => colOf(f)
    const text = (row: string[], f: FieldKey): string => {
      const c = col(f)
      if (c < 0) return ''
      const v = (row[c] ?? '').trim()
      return IMG_RE.test(v) ? '' : v
    }
    return included.map(({ r, name }) => {
      const row = sheet.aoa[r] ?? []
      const imgCol = col('image')
      const marker = imgCol >= 0 ? IMG_RE.exec((row[imgCol] ?? '').trim()) : null
      return {
        name,
        qty: parseQty(text(row, 'qty')),
        material: text(row, 'material') || undefined,
        surfaceTreatment: text(row, 'surfaceTreatment') || undefined,
        process: text(row, 'process') || undefined,
        partNo: text(row, 'partNo') || undefined,
        notes: text(row, 'notes') || undefined,
        unitPriceCny: parseMoney(text(row, 'unitPriceCny')),
        lineTotalCny: parseMoney(text(row, 'lineTotalCny')),
        imageRef: marker ? marker[1] : undefined,
        imageDataUri: sheet.rowImgs?.[r] ?? undefined,
      }
    })
  }, [sheet, included, colOf])

  const imgCount = useMemo(
    () => buildComponents().filter((c) => c.imageRef || c.imageDataUri).length,
    [buildComponents],
  )

  const submit = async () => {
    if (!loaded || !sheet) return
    if (colOf('name') < 0) {
      setError('请先点击列头，指定哪一列是「零件名称」')
      return
    }
    if (!meta.jobNo.trim()) {
      setError('请填写工号')
      return
    }
    const components = buildComponents()
    if (!components.length) {
      setError('没有可导入的零件行')
      return
    }
    setBusy('导入中…')
    setError(null)
    try {
      const fd = new FormData()
      fd.append(
        'payload',
        JSON.stringify({
          jobNo: meta.jobNo.trim(),
          customer: meta.customer.trim(),
          product: meta.product.trim(),
          amountCny: parseMoney(meta.amount),
          dueDate: meta.dueDate,
          notes: meta.notes.trim() || undefined,
          components,
        }),
      )
      if (loaded.kind === 'file' && loaded.file) fd.append('file', loaded.file)
      const r = await fetch(withBase('/api/qingdan/commit'), { method: 'POST', body: fd })
      const d = (await r.json()) as { ok: true; jobId: string } | { ok: false; error: string }
      if ('ok' in d && d.ok) {
        router.push(`/import/${d.jobId}`)
        return
      }
      setError('error' in d ? d.error : '导入失败')
      setBusy(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(null)
    }
  }

  // ------------------------------------------------------------ empty state

  if (!loaded) {
    return (
      <main className="mx-auto w-full max-w-[1500px] px-4 md:px-10 py-6 md:py-10 flex-1 flex flex-col">
        <div className="mb-6">
          <BackButton fallback="/" />
        </div>
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDrag(true)
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDrag(false)
            const f = Array.from(e.dataTransfer.files ?? [])[0]
            if (f) void handleFile(f)
          }}
          onClick={() => inputRef.current?.click()}
          className={`flex-1 min-h-[420px] flex flex-col items-center justify-center cursor-pointer rounded-[2px] border border-dashed transition-colors ${
            drag
              ? 'border-[var(--color-ink)] bg-[var(--color-active-bg)]'
              : 'border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-bg)]'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void handleFile(f)
              e.target.value = ''
            }}
          />
          {busy ? (
            <p className="text-[15px] text-[var(--color-ink-2)]">{busy}</p>
          ) : (
            <>
              <p className="text-[22px] font-semibold tracking-tight text-[var(--color-ink)]">
                粘贴表格，或拖入 Excel
              </p>
              <p className="mt-3 text-[13px] text-[var(--color-ink-2)]">
                在 WPS / Excel 里选中清单区域复制，回到这里按 Ctrl+V 粘贴
              </p>
              <p className="mt-1.5 text-[12px] text-[var(--color-ink-3)]">
                粘贴只带文字 · 表格里每行的图纸要一起带入，请上传原始 Excel 文件
              </p>
              <span className="mt-6 px-4 py-2 text-[13px] tracking-wider border border-[var(--color-border-strong)] text-[var(--color-ink-2)] rounded-[2px] hover:text-[var(--color-ink)]">
                选择文件
              </span>
            </>
          )}
          {error ? (
            <p className="mt-4 text-[12px] text-[var(--color-overdue)]">{error}</p>
          ) : null}
        </div>
      </main>
    )
  }

  // ------------------------------------------------------------- workspace

  const aoa = sheet?.aoa ?? []
  const header = aoa[headerRow] ?? []
  const cols = Math.max(header.length, ...aoa.map((r) => r.length), mapping.length)
  const mappedCount = mapping.filter(Boolean).length

  return (
    <main className="mx-auto w-full max-w-[1600px] px-4 md:px-10 py-6 flex-1 flex flex-col">
      <div className="mb-5 flex items-center justify-between gap-4">
        <BackButton fallback="/" />
        <div className="flex items-center gap-3 min-w-0">
          <span className="mono text-[12px] text-[var(--color-ink-2)] truncate max-w-[380px]">
            {loaded.kind === 'file' ? loaded.fileName : `已粘贴 · ${aoa.length} 行`}
          </span>
          <button
            type="button"
            onClick={() => {
              setLoaded(null)
              setMeta(emptyMeta)
              setError(null)
            }}
            className="label text-[var(--color-ink-3)] hover:text-[var(--color-ink)] whitespace-nowrap"
          >
            重新导入
          </button>
        </div>
      </div>

      {/* 工单信息 — job-level fields; everything editable again on the review page. */}
      <div className="mb-5 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
        <div className="grid grid-cols-2 md:grid-cols-12 gap-x-6 gap-y-4">
          <div className="col-span-2 md:col-span-3">
            <p className="label mb-1.5">客户名称</p>
            <input
              value={meta.customer}
              onChange={(e) => setMeta({ ...meta, customer: e.target.value })}
              placeholder="客户"
              className="w-full bg-transparent text-[16px] font-medium tracking-tight text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] border-b border-transparent hover:border-[var(--color-border)] focus:border-[var(--color-ink)] outline-none pb-0.5"
            />
          </div>
          <div className="col-span-1 md:col-span-2">
            <p className="label mb-1.5">产品</p>
            <input
              value={meta.product}
              onChange={(e) => setMeta({ ...meta, product: e.target.value })}
              placeholder="产品"
              className="w-full bg-transparent text-[14px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] border-b border-transparent hover:border-[var(--color-border)] focus:border-[var(--color-ink)] outline-none pb-0.5"
            />
          </div>
          <div className="col-span-1 md:col-span-2">
            <p className="label mb-1.5">工号</p>
            <input
              value={meta.jobNo}
              onChange={(e) => setMeta({ ...meta, jobNo: e.target.value })}
              placeholder="必填"
              className={`w-full bg-transparent mono text-[14px] text-[var(--color-ink)] placeholder:text-[var(--color-overdue)] border-b hover:border-[var(--color-border)] focus:border-[var(--color-ink)] outline-none pb-0.5 ${
                meta.jobNo.trim() ? 'border-transparent' : 'border-[var(--color-overdue)]'
              }`}
            />
          </div>
          <div className="col-span-1 md:col-span-2">
            <p className="label mb-1.5">金额</p>
            <div className="flex items-baseline gap-1">
              <span className="mono text-[13px] text-[var(--color-ink-3)]">¥</span>
              <input
                value={meta.amount}
                onChange={(e) => setMeta({ ...meta, amount: e.target.value })}
                placeholder="—"
                inputMode="decimal"
                className="w-full bg-transparent mono text-[14px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] border-b border-transparent hover:border-[var(--color-border)] focus:border-[var(--color-ink)] outline-none pb-0.5"
              />
            </div>
          </div>
          <div className="col-span-1 md:col-span-3">
            <p className="label mb-1.5">交期</p>
            <DatePop
              value={meta.dueDate}
              onChange={(v) => setMeta({ ...meta, dueDate: v })}
              placeholder="默认今天"
              portal
            />
          </div>
          <div className="col-span-2 md:col-span-12">
            <p className="label mb-1.5">工单备注</p>
            <input
              value={meta.notes}
              onChange={(e) => setMeta({ ...meta, notes: e.target.value })}
              placeholder="添加备注…"
              className="w-full bg-transparent text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] border-b border-transparent hover:border-[var(--color-border)] focus:border-[var(--color-ink)] outline-none pb-0.5"
            />
          </div>
        </div>
      </div>

      <div className="mb-2.5 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          {loaded.sheets.length > 1
            ? loaded.sheets.map((s, i) => (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => switchSheet(i)}
                  className={`px-2.5 py-1 text-[12px] tracking-wider rounded-[2px] transition-colors ${
                    i === active
                      ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
                      : 'text-[var(--color-ink-2)] hover:bg-[var(--color-muted-bg)]'
                  }`}
                >
                  {s.name}
                </button>
              ))
            : null}
          <span className="label text-[var(--color-ink-3)] inline-flex items-center gap-1">
            表头 第 {headerRow + 1} 行
            <button
              type="button"
              onClick={() => moveHeader(-1)}
              disabled={headerRow === 0}
              className="px-1.5 py-0.5 text-[12px] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] disabled:opacity-30"
              aria-label="表头上移一行"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => moveHeader(1)}
              className="px-1.5 py-0.5 text-[12px] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] disabled:opacity-30"
              aria-label="表头下移一行"
            >
              ›
            </button>
          </span>
        </div>
        <p className="label text-[var(--color-ink-3)]">
          点击列头指定对应字段 · 点击行号可跳过该行
        </p>
      </div>

      <div className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] overflow-auto max-h-[62vh]">
        <table className="w-full border-separate border-spacing-0 text-left text-[12px]">
          <thead>
            <tr>
              <th className="sticky top-0 z-10 w-[44px] border-b border-r border-[var(--color-border-strong)] bg-[#f5f3ed] px-2 py-2" />
              {Array.from({ length: cols }, (_, c) => {
                const field = mapping[c] ?? null
                return (
                  // The whole header cell is the mapping control. A mapped
                  // column's head goes solid ink — selected should LOOK
                  // selected from across the room, not via a small chip.
                  <th
                    key={c}
                    className="sticky top-0 z-10 min-w-[92px] border-b border-r border-b-[var(--color-border-strong)] border-r-[var(--color-border)] p-0 align-bottom"
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect()
                        setMenu(
                          menu?.col === c
                            ? null
                            : {
                                col: c,
                                top: rect.bottom + 4,
                                left: Math.min(rect.left, window.innerWidth - 190),
                              },
                        )
                      }}
                      className={`block w-full px-3 py-2 text-left transition-colors ${
                        field
                          ? 'bg-[var(--color-ink)] hover:opacity-90'
                          : 'bg-[#f5f3ed] hover:bg-[var(--color-active-bg)]'
                      }`}
                    >
                      <span
                        className={`flex items-center gap-1.5 whitespace-nowrap text-[12px] tracking-wider ${
                          field
                            ? 'font-medium text-[var(--color-surface)]'
                            : 'text-[var(--color-ink-4)]'
                        }`}
                      >
                        {field ? FIELD_LABEL[field] : '对应…'}
                        <span className={`text-[9px] ${field ? 'opacity-60' : ''}`}>▾</span>
                      </span>
                      <span
                        className={`mt-0.5 block max-w-[180px] truncate text-[11px] font-normal ${
                          field
                            ? 'text-[var(--color-surface)] opacity-55'
                            : 'text-[var(--color-ink-3)]'
                        }`}
                      >
                        {(() => {
                          const raw = (header[c] ?? '').trim()
                          // A floating image anchored on the header row leaves
                          // its marker here — show the column letter, not the
                          // raw <<IMG:…>> token.
                          return !raw || IMG_RE.test(raw) ? colLetter(c) : raw
                        })()}
                      </span>
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ r, autoSkip, included: inc }) => {
              const row = aoa[r] ?? []
              return (
                <tr key={r} className={`group ${inc ? '' : 'opacity-35'}`}>
                  <td className="border-b border-r border-[var(--color-border)] bg-[#f5f3ed] px-2 py-1.5">
                    <button
                      type="button"
                      disabled={autoSkip}
                      onClick={() =>
                        setExcluded((prev) => {
                          const next = new Set(prev)
                          if (next.has(r)) next.delete(r)
                          else next.add(r)
                          return next
                        })
                      }
                      title={autoSkip ? '零件名称为空，自动跳过' : inc ? '点击跳过该行' : '点击恢复该行'}
                      className={`mono text-[11px] w-full text-center ${
                        autoSkip
                          ? 'text-[var(--color-ink-4)] cursor-default'
                          : inc
                            ? 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
                            : 'text-[var(--color-ink-4)] line-through hover:text-[var(--color-ink-2)]'
                      }`}
                    >
                      {r - headerRow}
                    </button>
                  </td>
                  {Array.from({ length: cols }, (_, c) => {
                    const raw = (row[c] ?? '').trim()
                    const marker = IMG_RE.exec(raw)
                    const field = mapping[c] ?? null
                    const numeric = field ? FIELDS.find((f) => f.key === field)?.numeric : false
                    // Column separation + a lit/dim split: mapped columns stay
                    // white (they're what actually imports), unmapped sink to
                    // the page bg — the sheet reads as "these lanes go in".
                    const laneBg = field
                      ? 'bg-[var(--color-surface)] group-hover:bg-[#faf8f2]'
                      : 'bg-[var(--color-bg)]'
                    if (marker || (field === 'image' && sheet?.rowImgs?.[r])) {
                      const uri = marker ? loaded.images[marker[1]] : sheet?.rowImgs?.[r]
                      return (
                        <td key={c} className={`border-b border-r border-[var(--color-border)] px-2 py-1 ${laneBg}`}>
                          {uri ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={uri}
                              alt=""
                              className="h-9 w-9 object-contain rounded-[2px] border border-[var(--color-border)] bg-white"
                            />
                          ) : (
                            <span className="inline-flex h-9 w-9 items-center justify-center rounded-[2px] border border-[var(--color-border)] text-[10px] text-[var(--color-ink-3)]">
                              图
                            </span>
                          )}
                        </td>
                      )
                    }
                    return (
                      <td
                        key={c}
                        title={raw.length > 30 ? raw : undefined}
                        className={`border-b border-r border-[var(--color-border)] px-2 py-1.5 whitespace-nowrap max-w-[240px] overflow-hidden text-ellipsis ${
                          numeric ? 'text-right mono' : ''
                        } ${
                          field ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-4)]'
                        } ${laneBg}`}
                      >
                        {raw}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={cols + 1}
                  className="px-4 py-8 text-center text-[12px] text-[var(--color-ink-3)]"
                >
                  表头下方没有数据行 · 试试用 ‹ › 调整表头行
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="sticky bottom-0 mt-4 -mx-4 md:-mx-10 px-4 md:px-10 py-3 border-t border-[var(--color-border)] bg-[var(--color-bg)] flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-4 min-w-0">
          <span className="text-[13px] text-[var(--color-ink)]">
            <span className="mono font-medium">{included.length}</span> 个零件
            {imgCount > 0 ? (
              <span className="text-[var(--color-ink-2)]">
                {' '}
                · <span className="mono">{imgCount}</span> 张图纸
              </span>
            ) : null}
            <span className="text-[var(--color-ink-3)]">
              {' '}
              · 已对应 {mappedCount} 列
            </span>
          </span>
          {error ? (
            <span className="text-[12px] text-[var(--color-overdue)] truncate">{error}</span>
          ) : (
            <span className="label text-[var(--color-ink-3)] hidden md:inline">
              导入后进入审核页核对 · 确认后才会进入看板
            </span>
          )}
        </div>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={submit}
          className="px-4 py-2 text-[13px] tracking-wider bg-[var(--color-ink)] text-[var(--color-surface)] rounded-[2px] hover:opacity-80 disabled:opacity-50 whitespace-nowrap"
        >
          {busy ?? `导入 ${included.length} 个零件`}
        </button>
      </div>

      {menu
        ? createPortal(
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} />
              <div
                className="fixed z-50 w-[176px] rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-lg py-1"
                style={{ top: menu.top, left: menu.left }}
              >
                {FIELDS.map((f) => {
                  const usedAt = mapping.findIndex((m) => m === f.key)
                  const isHere = usedAt === menu.col
                  return (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => assign(menu.col, isHere ? null : f.key)}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-[12px] transition-colors ${
                        isHere
                          ? 'bg-[var(--color-muted-bg)] text-[var(--color-ink)]'
                          : 'text-[var(--color-ink-2)] hover:bg-[var(--color-bg)] hover:text-[var(--color-ink)]'
                      }`}
                    >
                      <span>{f.label}</span>
                      <span className="mono text-[10px] text-[var(--color-ink-4)]">
                        {isHere ? '✓' : usedAt >= 0 ? colLetter(usedAt) : ''}
                      </span>
                    </button>
                  )
                })}
                <div className="my-1 border-t border-[var(--color-border)]" />
                <button
                  type="button"
                  onClick={() => assign(menu.col, null)}
                  className="w-full px-3 py-1.5 text-left text-[12px] text-[var(--color-ink-3)] hover:bg-[var(--color-bg)] hover:text-[var(--color-ink)]"
                >
                  不导入该列
                </button>
              </div>
            </>,
            document.body,
          )
        : null}
    </main>
  )
}
