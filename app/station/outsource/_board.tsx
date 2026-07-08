'use client'

import { useMemo, useState } from 'react'
import {
  blockActivityLabel,
  blockClosedAt,
  daysFromToday,
  formatCny,
  isBlockClosed,
  vendorById,
  type OpenBlockRow,
  type Vendor,
} from '@/lib/data'
import { Pill } from '@/app/_ui'
import { BlockRow, VendorAddressEditor } from '@/app/_routing'
import { VendorShareButton } from '@/app/_vendor_share'
import { Highlight, SearchInput } from '@/app/_search'

// Everything a single outsource block can be found by, flattened to one
// lowercased string. Mirrors the fields the floor actually quotes when they
// ask "where's X" — 计划单号 / 供应商 first, then the 外协单号, the activity
// (外发氧化 …), and every part on the shipment by 名称 / 料号 / 材料.
function rowHaystack(r: OpenBlockRow, vendors: Vendor[]): string {
  const v = vendorById(r.block.vendorId, vendors)
  const parts: string[] = [
    r.jobNo,
    r.customer,
    r.product,
    v?.name ?? r.block.vendorId,
    v?.notes ?? '',
    r.block.docNo ?? '',
    blockActivityLabel(r.block),
    // 工序 — so "喷漆" / "操机" as a search token narrows to blocks
    // covering that stage, not just ones whose activity mentions it.
    ...r.block.stages,
    r.block.notes ?? '',
  ]
  for (const m of r.block.members) {
    parts.push(m.name)
    if (m.partNo) parts.push(m.partNo)
    if (m.material) parts.push(m.material)
  }
  return parts.join(' ').toLowerCase()
}

export function OutsourceBoard({
  open,
  archived,
  vendors,
}: {
  open: OpenBlockRow[]
  archived: OpenBlockRow[]
  vendors: Vendor[]
}) {
  const [q, setQ] = useState('')

  const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const searching = tokens.length > 0

  // One haystack per block, built once. Filtering is AND across whitespace-
  // separated tokens, so "致远 氧化" narrows to that vendor's oxidation blocks.
  const haystacks = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of [...open, ...archived]) m.set(r.block.id, rowHaystack(r, vendors))
    return m
  }, [open, archived, vendors])

  const { openF, archivedF } = useMemo(() => {
    if (tokens.length === 0) return { openF: open, archivedF: archived }
    const keep = (r: OpenBlockRow) => {
      const hay = haystacks.get(r.block.id) ?? ''
      return tokens.every((t) => hay.includes(t))
    }
    return { openF: open.filter(keep), archivedF: archived.filter(keep) }
    // tokens is derived from q; key the memo on the raw query string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, archived, haystacks, q])

  const matchCount = openF.length + archivedF.length

  return (
    <main className="w-full px-4 md:px-10 py-6 md:py-10 flex-1">
      <div className="mb-8">
        <p className="label mb-1">外协台</p>
        <h2 className="text-[28px] font-semibold tracking-tight text-[var(--color-ink)]">
          在外零件
        </h2>
        <p className="mt-1 text-[13px] text-[var(--color-ink-2)]">
          按供应商分组 · 按预计回厂排序 · 点 [已回厂] 收件 · 已回的归档保留
        </p>
        <div className="mt-5 flex items-center gap-4">
          <SearchInput q={q} setQ={setQ} placeholder="计划单号 · 供应商 · 零件…" />
          <p className="label tabular-nums">
            {searching
              ? `${matchCount} 块匹配`
              : `${open.length} 在外 · ${archived.length} 已归档`}
          </p>
        </div>
      </div>

      {searching && matchCount === 0 ? (
        <div className="rounded-[2px] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] py-16 text-center">
          <p className="label mb-2">无匹配</p>
          <p className="text-[13px] text-[var(--color-ink-3)]">
            没有外协匹配 “{q.trim()}” — 试试计划单号、供应商名称，或料号
          </p>
        </div>
      ) : (
        <>
          {!searching || openF.length > 0 ? (
            <Section
              title="在外"
              rows={openF}
              vendors={vendors}
              sortBy="expectedReturn"
              q={q}
              empty="暂无在外零件 — 从工单明细页 · 新增外协 送出"
            />
          ) : null}

          {archivedF.length > 0 ? (
            <div className="mt-10 opacity-80">
              <Section
                title="已归档"
                rows={archivedF}
                vendors={vendors}
                sortBy="closedAt"
                q={q}
                empty="无归档"
              />
            </div>
          ) : null}
        </>
      )}
    </main>
  )
}

// Soft cap on how many block rows mount per page. BlockRow is a heavy
// stateful client component, so with hundreds of blocks we never want them
// all in the DOM at once. We pack *whole* vendor groups into a page until
// adding the next group would exceed this — a group is never split across
// pages, so every vendor header's 件数 / 金额 always matches the rows under
// it. A single vendor larger than the cap gets a page to itself.
const PAGE_ROWS = 40

type VendorGroupData = {
  vendorId: string
  vendor?: Vendor
  rows: OpenBlockRow[]
  total: number
  overdue: number
}

function Section({
  title,
  rows,
  vendors,
  sortBy,
  empty,
  q,
}: {
  title: string
  rows: OpenBlockRow[]
  vendors: Vendor[]
  sortBy: 'expectedReturn' | 'closedAt'
  empty: string
  q: string
}) {
  const [page, setPage] = useState(1)
  // A new query is a new result set — always land on the first page. Reset
  // during render by tracking the previous query (React's recommended pattern
  // over a setState-in-effect, which triggers a cascading re-render).
  const [prevQ, setPrevQ] = useState(q)
  if (q !== prevQ) {
    setPrevQ(q)
    setPage(1)
  }

  const groupList = useMemo(() => buildGroups(rows, vendors, sortBy), [rows, vendors, sortBy])

  // Pack whole groups into pages of up to PAGE_ROWS rows.
  const pages = useMemo(() => {
    const out: VendorGroupData[][] = []
    let cur: VendorGroupData[] = []
    let curRows = 0
    for (const g of groupList) {
      if (cur.length > 0 && curRows + g.rows.length > PAGE_ROWS) {
        out.push(cur)
        cur = []
        curRows = 0
      }
      cur.push(g)
      curRows += g.rows.length
    }
    if (cur.length > 0) out.push(cur)
    return out
  }, [groupList])

  if (rows.length === 0) {
    return (
      <div className="rounded-[2px] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] py-12 text-center">
        <p className="label mb-2">{title}</p>
        <p className="text-[13px] text-[var(--color-ink-3)]">{empty}</p>
      </div>
    )
  }

  const totalPages = Math.max(1, pages.length)
  const safePage = Math.min(page, totalPages)
  const pageGroups = pages[safePage - 1] ?? []
  const total = rows.reduce((s, r) => s + (r.block.amountCny ?? 0), 0)

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <p className="label">{title}</p>
        <p className="label tabular-nums">
          {rows.length} 块 · 合计 {formatCny(total)}
        </p>
      </div>
      <div className="space-y-8">
        {pageGroups.map((g) => (
          <VendorGroup key={g.vendorId} group={g} vendors={vendors} q={q} />
        ))}
      </div>
      {totalPages > 1 ? (
        <Pager page={safePage} totalPages={totalPages} onChange={setPage} />
      ) : null}
    </section>
  )
}

function buildGroups(
  rows: OpenBlockRow[],
  vendors: Vendor[],
  sortBy: 'expectedReturn' | 'closedAt',
): VendorGroupData[] {
  const groups = new Map<string, { vendor?: Vendor; rows: OpenBlockRow[] }>()
  for (const r of rows) {
    const key = r.block.vendorId
    let g = groups.get(key)
    if (!g) {
      g = { vendor: vendorById(key, vendors), rows: [] }
      groups.set(key, g)
    }
    g.rows.push(r)
  }
  for (const g of groups.values()) {
    g.rows.sort((a, b) => {
      const aDate =
        sortBy === 'expectedReturn'
          ? a.block.expectedReturn
          : blockClosedAt(a.block) ?? ''
      const bDate =
        sortBy === 'expectedReturn'
          ? b.block.expectedReturn
          : blockClosedAt(b.block) ?? ''
      return sortBy === 'closedAt'
        ? bDate.localeCompare(aDate) // newest archived first
        : aDate.localeCompare(bDate)
    })
  }
  return Array.from(groups.entries())
    .map(([id, g]) => ({
      vendorId: id,
      vendor: g.vendor,
      rows: g.rows,
      total: g.rows.reduce((s, r) => s + (r.block.amountCny ?? 0), 0),
      overdue: g.rows.filter(
        (r) =>
          !isBlockClosed(r.block) && daysFromToday(r.block.expectedReturn) < 0,
      ).length,
    }))
    .sort(
      (a, b) =>
        b.overdue - a.overdue ||
        (a.vendor?.name.localeCompare(b.vendor?.name ?? '') ?? 0),
    )
}

function Pager({
  page,
  totalPages,
  onChange,
}: {
  page: number
  totalPages: number
  onChange: (p: number) => void
}) {
  const btn =
    'text-[12px] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] disabled:opacity-30 disabled:cursor-default transition-colors'
  return (
    <div className="mt-6 flex items-center justify-end gap-4">
      <button
        type="button"
        className={btn}
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        ← 上一页
      </button>
      <span className="label tabular-nums">
        第 {page} / {totalPages} 页
      </span>
      <button
        type="button"
        className={btn}
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
      >
        下一页 →
      </button>
    </div>
  )
}

function VendorGroup({
  group,
  vendors,
  q,
}: {
  group: {
    vendorId: string
    vendor?: Vendor
    rows: OpenBlockRow[]
    total: number
    overdue: number
  }
  vendors: Vendor[]
  q: string
}) {
  // Open blocks this vendor hasn't been told about on WeChat yet — the
  // growth loop's weak link, surfaced as a header count so the operator
  // knows to work down the 待发 cells in the rows below.
  const pendingWechat = group.rows.filter(
    (r) => !isBlockClosed(r.block) && !r.block.wechatSentAt && !r.block.vendorSeenAt,
  ).length
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between border-b border-[var(--color-border)] pb-2">
        <div className="flex items-baseline gap-4 flex-wrap">
          <h3 className="text-[16px] font-medium tracking-tight text-[var(--color-ink)]">
            <Highlight text={group.vendor?.name ?? group.vendorId} q={q} />
          </h3>
          {group.vendor?.notes ? (
            <span className="text-[12px] text-[var(--color-ink-3)]">
              {group.vendor.notes}
            </span>
          ) : null}
          {group.vendor ? <VendorAddressEditor vendor={group.vendor} /> : null}
          {group.vendor ? (
            <VendorShareButton
              vendor={group.vendor}
              openBlocks={group.rows
                .filter((r) => !isBlockClosed(r.block))
                .map((r) => r.block)}
            />
          ) : null}
        </div>
        <div className="flex items-baseline gap-4">
          {group.overdue > 0 ? (
            <Pill tone="overdue" label="逾期" value={group.overdue} />
          ) : null}
          {pendingWechat > 0 ? (
            <span
              title={`${pendingWechat} 单还没微信告诉厂商 — 点行里的 待发`}
              className="inline-flex items-baseline gap-1.5 rounded-[2px] border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-2.5 py-[3px] text-[10px] uppercase tracking-[0.14em] text-[var(--color-warning)]"
            >
              <span>待发微信</span>
              <span className="mono text-[12px] font-medium tracking-normal">
                {pendingWechat}
              </span>
            </span>
          ) : null}
          <Pill tone="info" label="件数" value={group.rows.length} />
          <Pill tone="info" label="金额" value={formatCny(group.total)} />
        </div>
      </div>
      <div className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2">
        {group.rows.map((r) => (
          <BlockRow
            key={r.block.id}
            jobId={r.jobId}
            jobNo={r.jobNo}
            customer={`${r.customer} · ${r.product}`}
            block={r.block}
            vendor={group.vendor}
            vendors={vendors}
            threadStrip
          />
        ))}
      </div>
    </section>
  )
}
