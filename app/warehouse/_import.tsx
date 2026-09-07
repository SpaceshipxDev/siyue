'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { withBase } from '@/lib/base-path'
import { mutate } from '@/lib/mutate'
import type { StockMove, StockMoveKind } from '@/lib/warehouse'

/*
 * 原始台账导入 — 把一份已经存在的账一次搬进来。
 *
 * 仓库这一页只认一种东西: 一笔出入库。所以导入也只做一件事 —— 从那张 Excel
 * 里认出一笔一笔的出入库, 记进同一张表。没有"导入的记录"这一类, 导进来的和
 * 当场记的长得一模一样, 库存照旧是它们加出来的。
 *
 * 它认这几列, 表头叫什么都行 (日期/时间, 物料/品名/名称, 规格/型号, 进出/
 * 收发, 数量, 备注/用途/供应商); 也认厂里最常见的那种两列台账 —— 入库数量
 * 一列、出库数量一列。找不到表头就按 导出 的顺序读: 日期 · 物料 · 规格 ·
 * 进出 · 数量 · 备注, 也就是说 导出的表改一改能原样导回来。
 *
 * 认完先摆在人面前: 多少条能进、多少条看不懂 (为什么)、多少条跟已有的记录
 * 一模一样。一份台账最容易出的事故是导两遍, 所以重复的那些默认不进。
 */

type Sheet = { name: string; aoa: string[][] }

export type Draft = {
  date: string
  name: string
  spec: string
  kind: StockMoveKind
  qty: number
  note: string
}

type Skip = { where: string; why: string }

type Parsed = {
  rows: Draft[]
  skips: Skip[]
  dupes: number
  /** 这份表里没有"进出"这一列 — 方向要人点一下。 */
  needsKind: boolean
}

// ── 认列 ────────────────────────────────────────────────────────────────
// 顺序就是优先级: "入库日期" 先被日期认走, "入库数量" 先被入库那一列认走。
const HEADERS: [keyof ColMap, RegExp][] = [
  ['date', /日期|时间/],
  ['inQty', /^(入库|进货|进料|收入|收料)/],
  ['outQty', /^(出库|发出|发料|领用|领料|支出)/],
  ['qty', /数量|重量|件数|数目|台数|个数/],
  ['kind', /进出|收发|出入|方向|类型|类别|摘要/],
  ['spec', /规格|型号|材质|尺寸/],
  ['name', /物料|品名|名称|材料|货品|商品|品种/],
  ['note', /备注|说明|用途|去向|供应商|领用人|经手|工单|批号/],
]

type ColMap = {
  date?: number
  name?: number
  spec?: number
  kind?: number
  qty?: number
  inQty?: number
  outQty?: number
  note?: number
}

// 没有表头的表, 按 导出 的列序读。
const POSITIONAL: (keyof ColMap)[] = ['date', 'name', 'spec', 'kind', 'qty', 'note']

// 合计那几行永远不是一笔出入库。
const FOOTER_RE =
  /^(入库|出库|本月|上月|本年|当月|本页|累计|总)?(合计|总计|小计|总额|总数|结存|承前|承上|以下空白|说明)/

function mapHeader(row: string[]): { cols: ColMap; hits: number } {
  const cols: ColMap = {}
  let hits = 0
  for (let c = 0; c < row.length; c++) {
    const cell = (row[c] ?? '').replace(/\s/g, '')
    if (!cell) continue
    for (const [key, re] of HEADERS) {
      if (cols[key] !== undefined) continue
      if (re.test(cell)) {
        cols[key] = c
        hits++
        break
      }
    }
  }
  return { cols, hits }
}

function ymd(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// Excel 里的日期有时是一个序号 (1899-12-30 起的天数)。
function fromSerial(n: number): string | null {
  if (!Number.isFinite(n) || n < 20000 || n > 80000) return null
  const ms = Date.UTC(1899, 11, 30) + Math.round(n) * 86400000
  return new Date(ms).toISOString().slice(0, 10)
}

function parseDay(raw: string, fallbackYear: string): string | null {
  const s = raw.trim()
  if (!s) return null
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(s)
  if (m) return ymd(+m[1], +m[2], +m[3])
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (m) return ymd(+m[1], +m[2], +m[3])
  // xlsx 常把日期渲染成 m/d/yy — 月在前。
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s)
  if (m) return ymd(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1], +m[2])
  m = /^(\d{1,2})[-/.月](\d{1,2})日?$/.exec(s)
  if (m) return ymd(+fallbackYear, +m[1], +m[2])
  if (/^\d{4,5}(\.\d+)?$/.test(s)) return fromSerial(Number(s))
  const t = Date.parse(s)
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10)
  return null
}

function num(raw: string): number {
  const s = raw.replace(/[,，\s]/g, '')
  if (!s) return 0
  const n = Number(s)
  if (Number.isFinite(n)) return n
  // "12个" / "3.5kg" — 带单位的数, 取前面那个数。
  const m = /^-?\d+(\.\d+)?/.exec(s)
  return m ? Number(m[0]) : 0
}

function cellAt(row: string[], c: number | undefined): string {
  return c === undefined ? '' : (row[c] ?? '').trim()
}

/**
 * 一张表 → 一批出入库记录。
 * fallbackKind: 表里没有"进出"这一列时, 整份表算进还是算出。
 */
function parseSheet(
  sheet: Sheet,
  fallbackKind: StockMoveKind,
  fallbackYear: string,
): Parsed {
  const aoa = sheet.aoa
  // 表头 — 前十行里认得最多的那一行。
  let headerRow = -1
  let best = { cols: {} as ColMap, hits: 0 }
  for (let r = 0; r < Math.min(aoa.length, 10); r++) {
    const got = mapHeader(aoa[r] ?? [])
    if (got.hits >= 2 && got.hits > best.hits) {
      best = got
      headerRow = r
    }
  }
  const cols: ColMap = headerRow >= 0 ? best.cols : {}
  if (headerRow < 0) POSITIONAL.forEach((k, i) => (cols[k] = i))

  const rows: Draft[] = []
  const skips: Skip[] = []
  // 有几行是从表里真读出方向的 — 一行都没有, 就得让人点一下整份算进还是算出。
  let directed = 0
  const where = (r: number) =>
    `${sheet.name ? `${sheet.name} · ` : ''}第 ${r + 1} 行`
  let carriedDay = ''

  for (let r = headerRow + 1; r < aoa.length; r++) {
    const row = aoa[r] ?? []
    if (!row.some((c) => (c ?? '').trim())) continue // 空行, 不用提

    const name = cellAt(row, cols.name)
    // 合计那一行有时写在日期那一列, 有时写在名称那一列 — 看这一行的第一个字。
    const firstCell = (row.find((c) => (c ?? '').trim()) ?? '').trim()
    if (
      FOOTER_RE.test(name.replace(/\s/g, '')) ||
      FOOTER_RE.test(firstCell.replace(/\s/g, ''))
    )
      continue

    // 日期 — 空的就沿用上一行 (老台账一天只在第一行写一次日期)。
    const dayCell = cellAt(row, cols.date)
    const day = dayCell ? parseDay(dayCell, fallbackYear) : carriedDay
    if (day) carriedDay = day

    const note = cellAt(row, cols.note)
    const spec = cellAt(row, cols.spec)

    const push = (kind: StockMoveKind, qty: number) => {
      if (!name) return skips.push({ where: where(r), why: '没有物料名称' })
      if (!day)
        return skips.push({
          where: where(r),
          why: dayCell ? `日期看不懂 · ${dayCell}` : '没有日期',
        })
      if (!(qty > 0)) return skips.push({ where: where(r), why: '数量不是大于 0 的数' })
      rows.push({ date: day, name, spec, kind, qty: Math.round(qty * 100) / 100, note })
    }

    // 入库一列、出库一列的台账 — 哪一边有数就是哪个方向, 两边都有就是两笔。
    if (cols.inQty !== undefined || cols.outQty !== undefined) {
      const i = num(cellAt(row, cols.inQty))
      const o = num(cellAt(row, cols.outQty))
      if (i > 0) push('in', i)
      if (o > 0) push('out', o)
      if (!(i > 0) && !(o > 0) && (name || dayCell))
        skips.push({ where: where(r), why: '入库出库两列都是空的' })
      continue
    }

    const qty = num(cellAt(row, cols.qty))
    const kindCell = cellAt(row, cols.kind)
    let kind = fallbackKind
    if (/出|发|领|销|退回|退料/.test(kindCell)) {
      kind = 'out'
      directed++
    } else if (/入|进|收|退货|归还/.test(kindCell)) {
      kind = 'in'
      directed++
    }
    push(kind, qty)
  }

  return {
    rows,
    skips,
    dupes: 0,
    needsKind:
      cols.inQty === undefined && cols.outQty === undefined && directed === 0,
  }
}

function tsvToSheet(text: string): Sheet {
  const lines = text.replace(/\r/g, '').split('\n')
  return {
    name: '',
    aoa: lines.map((l) => l.split('\t').map((c) => c.trim())),
  }
}

function keyOf(d: { date: string; name: string; spec: string; kind: string; qty: number; note: string }) {
  return `${d.date}|${d.name}|${d.spec}|${d.kind}|${d.qty}|${d.note}`
}

// ── 表单 ────────────────────────────────────────────────────────────────

export function ImportPanel({
  existing,
  todayStr,
  onClose,
  onDone,
}: {
  /** 已有的出入库记录 — 只拿来认重复, 免得一份台账导两遍。 */
  existing: StockMove[]
  todayStr: string
  onClose: () => void
  /** 导完了: 把表跳到刚导进去那一批的月份。 */
  onDone: (month: string, count: number) => void
}) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [text, setText] = useState('')
  const [fallbackKind, setFallbackKind] = useState<StockMoveKind>('in')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const fileRef = useRef<HTMLInputElement>(null)

  const existingKeys = useMemo(
    () => new Set(existing.map((r) => keyOf(r))),
    [existing],
  )

  const parsed = useMemo<Parsed | null>(() => {
    const src =
      sheets ?? (text.trim() ? [tsvToSheet(text)] : null)
    if (!src) return null
    const rows: Draft[] = []
    const skips: Skip[] = []
    let needsKind = false
    for (const s of src) {
      const p = parseSheet(s, fallbackKind, todayStr.slice(0, 4))
      rows.push(...p.rows)
      skips.push(...p.skips)
      if (p.rows.length > 0 && p.needsKind) needsKind = true
    }
    // 跟已有记录一模一样的 — 十有八九是同一份台账导第二遍。
    const seen = new Set(existingKeys)
    const fresh: Draft[] = []
    let dupes = 0
    for (const d of rows) {
      const k = keyOf(d)
      if (seen.has(k)) {
        dupes++
        continue
      }
      seen.add(k)
      fresh.push(d)
    }
    return { rows: fresh, skips, dupes, needsKind }
  }, [sheets, text, fallbackKind, todayStr, existingKeys])

  // Esc 关掉 — 跟别处的浮层一个手感。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function takeFile(file: File) {
    setError(null)
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch(withBase('/api/warehouse/parse'), {
        method: 'POST',
        body: fd,
      })
      const d = (await r.json()) as
        | { ok: true; fileName: string; sheets: Sheet[] }
        | { ok: false; error: string }
      if (!d.ok) throw new Error(d.error)
      setSheets(d.sheets)
      setFileName(d.fileName)
      setText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '这个文件读不了')
    } finally {
      setBusy(false)
    }
  }

  function reset() {
    setSheets(null)
    setFileName('')
    setText('')
    setError(null)
  }

  function commit() {
    if (!parsed || parsed.rows.length === 0) return
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'importStockMoves',
          inputs: parsed.rows.map((d) => ({
            date: d.date,
            name: d.name,
            spec: d.spec,
            moveKind: d.kind,
            qty: d.qty,
            note: d.note,
          })),
        })
        const last = parsed.rows.reduce(
          (m, d) => (d.date > m ? d.date : m),
          parsed.rows[0].date,
        )
        onDone(last.slice(5, 7), parsed.rows.length)
      } catch (e) {
        setError(e instanceof Error ? e.message : '导不进去')
      }
    })
  }

  const preview = parsed?.rows.slice(0, 8) ?? []

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const f = e.dataTransfer.files?.[0]
        if (f) takeFile(f)
      }}
      className="mb-5 rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-4 md:px-5"
    >
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[13.5px] font-semibold tracking-tight text-[var(--color-ink)]">
          导入原始台账
        </p>
        <button
          type="button"
          onClick={onClose}
          className="text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
        >
          关掉
        </button>
      </div>

      {sheets ? (
        <div className="mb-3 flex items-center gap-3">
          <p className="text-[13px] text-[var(--color-ink)]">{fileName}</p>
          <button
            type="button"
            onClick={reset}
            className="text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            换一份
          </button>
        </div>
      ) : (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            autoFocus
            placeholder="在 Excel 里选中整张表，复制，在这里粘贴 —— 或者把 .xlsx 拖进来"
            className="w-full resize-y rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="rounded-[2px] border border-[var(--color-border)] px-3.5 py-2 text-[13px] font-medium text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)] disabled:opacity-50"
            >
              {busy ? '读文件…' : '选个文件'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) takeFile(f)
                e.target.value = ''
              }}
            />
            <p className="text-[12px] text-[var(--color-ink-3)]">
              认这几列：日期 · 物料名称 · 规格 / 型号 · 进出 · 数量 · 备注；
              入库出库分两列的老台账也认。没有表头就按这个顺序读。
            </p>
          </div>
        </>
      )}

      {parsed && (
        <div className="mt-4">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <p className="text-[13px] text-[var(--color-ink)]">
              <span className="text-[20px] font-semibold tabular-nums">
                {parsed.rows.length}
              </span>{' '}
              条可以导入
            </p>
            {parsed.dupes > 0 && (
              <p className="text-[12.5px] text-[var(--color-ink-3)]">
                {parsed.dupes} 条跟已有记录一模一样，不重复导
              </p>
            )}
            {parsed.skips.length > 0 && (
              <p className="text-[12.5px] text-[var(--color-overdue)]">
                {parsed.skips.length} 条读不出来
              </p>
            )}
          </div>

          {/* 表里分不清进出时才出现 — 整份表算进还是算出, 点一下。 */}
          {parsed.needsKind && (
            <div className="mb-3 flex items-center gap-2.5">
              <span className="text-[12.5px] text-[var(--color-ink-2)]">
                这份表看不出进还是出，整份算：
              </span>
              <div className="inline-flex h-8 overflow-hidden rounded-[2px] border border-[var(--color-border)]">
                {(['in', 'out'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setFallbackKind(k)}
                    className={`px-3.5 text-[12.5px] font-medium transition-colors ${
                      fallbackKind === k
                        ? k === 'in'
                          ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
                          : 'bg-[var(--color-overdue)] text-white'
                        : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
                    }`}
                  >
                    {k === 'in' ? '入库' : '出库'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {preview.length > 0 && (
            <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)]">
              <div className="grid grid-cols-[76px_minmax(0,1.1fr)_minmax(0,0.9fr)_44px_72px_minmax(0,1fr)] items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-3 py-1.5">
                <span className="label">日期</span>
                <span className="label">物料名称</span>
                <span className="label">规格 / 型号</span>
                <span className="label">进出</span>
                <span className="label text-right">数量</span>
                <span className="label">备注</span>
              </div>
              {preview.map((d, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[76px_minmax(0,1.1fr)_minmax(0,0.9fr)_44px_72px_minmax(0,1fr)] items-start gap-3 border-b border-[var(--color-border)] px-3 py-1.5 last:border-b-0"
                >
                  <span className="mono text-[12px] tabular-nums text-[var(--color-ink-2)]">
                    {d.date}
                  </span>
                  <span className="break-words text-[12.5px] font-medium text-[var(--color-ink)]">
                    {d.name}
                  </span>
                  <span className="break-words text-[12px] text-[var(--color-ink-2)]">
                    {d.spec || '—'}
                  </span>
                  <span
                    className={`text-[12px] font-medium ${
                      d.kind === 'in'
                        ? 'text-[var(--color-ink)]'
                        : 'text-[var(--color-overdue)]'
                    }`}
                  >
                    {d.kind === 'in' ? '入库' : '出库'}
                  </span>
                  <span className="mono text-right text-[12px] tabular-nums text-[var(--color-ink)]">
                    {d.qty}
                  </span>
                  <span className="break-words text-[12px] text-[var(--color-ink-3)]">
                    {d.note || '—'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {parsed.rows.length > preview.length && (
            <p className="mt-2 text-[12px] text-[var(--color-ink-3)]">
              还有 {parsed.rows.length - preview.length} 条，都是一样的读法。
            </p>
          )}

          {parsed.skips.length > 0 && (
            <div className="mt-3 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
              {parsed.skips.slice(0, 5).map((s, i) => (
                <p key={i} className="text-[12px] text-[var(--color-ink-3)]">
                  {s.where} · {s.why}
                </p>
              ))}
              {parsed.skips.length > 5 && (
                <p className="text-[12px] text-[var(--color-ink-4)]">
                  还有 {parsed.skips.length - 5} 条同样读不出来，这些不会进来。
                </p>
              )}
            </div>
          )}

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={commit}
              disabled={pending || parsed.rows.length === 0}
              className="h-9 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-40"
            >
              {pending ? '导入中…' : `导入 ${parsed.rows.length} 条`}
            </button>
            <p className="text-[12px] text-[var(--color-ink-3)]">
              导进来的和当场记的一样，记错了回表里改或删。
            </p>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>
      )}
    </div>
  )
}
