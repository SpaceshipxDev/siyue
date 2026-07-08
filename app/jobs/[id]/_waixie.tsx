'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  ACTIVITY_DEFAULT_STAGES,
  OUTSOURCE_ACTIVITIES,
  blockClosedAt,
  daysFromToday,
  isBlockClosed,
  isMemberFullyReturned,
  memberRemainingQty,
  memberReturnedQty,
  type OutsourceActivity,
  type OutsourceBlock,
  type Vendor,
} from '@/lib/data'
import { mutate } from '@/lib/mutate'
import { today } from '@/lib/today'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { withBase } from '@/lib/base-path'
import { DatePop } from '@/app/_datepop'
import { showToast } from '@/app/_toast'
import { AddMembersRow, BlockKebab, BlockStagesEditor } from '@/app/_routing'
import {
  BlockMemberQty,
  BlockMemberUnitPrice,
  NameCombobox,
  OutsourceBlockAmount,
  OutsourceBlockDate,
  OutsourceBlockNotes,
  OutsourceBlockText,
} from '@/app/_editable'
import { BlockThreadStrip, SharePanel } from '@/app/_vendor_share'
import { SearchSelect } from '@/app/_search_select'

// 外协 tab — one ledger.
//
// Top: 送新单 — a draft block. At rest it's a single quiet ＋ row; opened it
// takes the exact shape of the block it will become (a create-bar header over
// the pick table). 送出 → the SharePanel modal takes over, because sending the
// vendor their link IS the point of the flow.
//
// Below: 外协单. Each dispatch is a group — a header line (厂商 · 做什么 · 单号 ·
// 工序 · 寄/交期 · ¥) with the whole vendor thread as one BlockThreadStrip,
// over its part rows, exactly like a merged group row in Excel. Every field on
// the header edits in place; 收 happens on the part row (state text at rest,
// panel on click) or 全收 on the header, refreshing the page immediately.

export type WaixieComponent = {
  id: string
  name: string
  qty: number
  material?: string
  imageUrl?: string
  blocks: OutsourceBlock[]
}

type Member = OutsourceBlock['members'][number]

type RowState =
  | { kind: 'none' }
  | { kind: 'out'; block: OutsourceBlock; member: Member }
  | { kind: 'back'; block: OutsourceBlock; member: Member }

function rowState(c: WaixieComponent): RowState {
  // Newest open membership wins; otherwise newest returned one; otherwise
  // the part has never been outsourced.
  let out: RowState | null = null
  let back: RowState | null = null
  for (const b of [...c.blocks].sort((a, z) => z.sentDate.localeCompare(a.sentDate))) {
    const m = b.members.find((x) => x.componentId === c.id)
    if (!m) continue
    if (!isMemberFullyReturned(m)) {
      if (!out) out = { kind: 'out', block: b, member: m }
    } else if (!back) {
      back = { kind: 'back', block: b, member: m }
    }
  }
  return out ?? back ?? { kind: 'none' }
}

function mdShort(ymd?: string): string {
  if (!ymd) return ''
  const p = ymd.split('-')
  if (p.length < 3) return ymd
  return `${p[1]}-${p[2]}`
}

function activityDisplay(a?: string): string {
  const t = a?.trim()
  if (!t) return ''
  return t.replace(/^外发/, '')
}

// ISO timestamp → Shanghai-local 'MM-DD' (vendor_seen/shipped are timestamps).
function tsShort(iso?: string): string {
  if (!iso) return ''
  return new Date(iso)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
    .slice(5)
}

// Whole days between two YYYY-MM-DD dates (a − b).
function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000)
}

const th =
  'px-3 py-2 text-left text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--color-ink-3)] whitespace-nowrap'
const td = 'px-3 py-2.5 align-middle whitespace-nowrap'
// Supplier-status columns — same grid grammar as the master board's stage
// strip: bordered cells, ✓+date when answered, colored bg when off-track.
const thStatus =
  'px-2 py-2 text-center text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--color-ink-3)] whitespace-nowrap border-l border-[var(--color-border)]'
const tdStatus = 'p-0 border-l border-[var(--color-border)] align-middle'

// Column label for the 外协单 header cells — the master board's Excel grammar:
// a tiny tracked label over each editable value.
const hcellLabel =
  'block text-[9px] tracking-[0.12em] text-[var(--color-ink-4)] leading-[12px]'
const statusInner =
  'flex min-h-[48px] h-full w-full flex-col items-center justify-center gap-0.5 leading-none'

function CellDone({ date }: { date?: string }) {
  return (
    <span className={statusInner}>
      <span className="text-[15px] font-semibold leading-none text-[var(--color-success)]">
        ✓
      </span>
      {date ? (
        <span className="mono text-[10px] text-[var(--color-ink-3)]">{date}</span>
      ) : null}
    </span>
  )
}

function CellDim({ hint }: { hint?: string }) {
  return (
    <span className={statusInner} title={hint}>
      <span className="mono text-[13px] text-[var(--color-ink-4)]">—</span>
    </span>
  )
}

function PartImg({ src, size = 'h-10 w-10' }: { src?: string; size?: string }) {
  if (!src)
    return (
      <span
        className={`inline-block ${size} rounded-[2px] border border-dashed border-[var(--color-border)]`}
      />
    )
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={proxiedStorageUrl(src)}
      alt=""
      loading="lazy"
      className={`${size} rounded-[2px] border border-[var(--color-border)] object-cover`}
    />
  )
}

export function WaixieTable({
  jobId,
  components,
  vendors,
}: {
  jobId: string
  components: WaixieComponent[]
  vendors: Vendor[]
}) {
  const router = useRouter()
  const [drafting, setDrafting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [qtys, setQtys] = useState<Record<string, string>>({})
  const [prices, setPrices] = useState<Record<string, string>>({})
  const [pending, start] = useTransition()

  // Create-bar fields.
  const [activity, setActivity] = useState<OutsourceActivity | ''>('')
  const [vendorId, setVendorId] = useState('')
  const [newVendorName, setNewVendorName] = useState('')
  const [expectedReturn, setExpectedReturn] = useState('')
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [overlap, setOverlap] = useState<string | null>(null)
  // The WeChat handoff banner after a successful 送出.
  const [sent, setSent] = useState<{
    blockId: string
    docNo?: string
    vendorName: string
    portalToken?: string
    activity: string
    totalQty: number
    expectedReturn: string
  } | null>(null)

  // One entry per 外协单, open ones first (nearest 回厂 on top), closed ones
  // after (newest return on top) — the same order a paper stack would sit in.
  const blocks = useMemo(() => {
    const seen = new Set<string>()
    const list: OutsourceBlock[] = []
    for (const c of components) {
      for (const b of c.blocks) {
        if (seen.has(b.id)) continue
        seen.add(b.id)
        list.push(b)
      }
    }
    return list.sort((a, z) => {
      const ac = isBlockClosed(a)
      const zc = isBlockClosed(z)
      if (ac !== zc) return ac ? 1 : -1
      if (!ac) return a.expectedReturn.localeCompare(z.expectedReturn)
      return (blockClosedAt(z) ?? '').localeCompare(blockClosedAt(a) ?? '')
    })
  }, [components])

  const byId = useMemo(
    () => new Map(components.map((c) => [c.id, c])),
    [components],
  )
  const rows = useMemo(
    () => components.map((c) => ({ c, state: rowState(c) })),
    [components],
  )
  const vendorsSorted = useMemo(
    () => [...vendors].sort((a, b) => a.name.localeCompare(b.name, 'zh')),
    [vendors],
  )

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const clearBar = () => {
    setDrafting(false)
    setSelected(new Set())
    setQtys({})
    setPrices({})
    setActivity('')
    setAmount('')
    setOverlap(null)
    setError(null)
  }

  const creatingVendor = vendorId === '__new__'
  const canSend =
    selected.size > 0 &&
    !!activity &&
    (creatingVendor ? newVendorName.trim().length > 0 : !!vendorId) &&
    !!expectedReturn

  const submit = (force = false) => {
    if (!canSend || pending) return
    setError(null)
    if (!force) setOverlap(null)
    start(async () => {
      let useVendorId = vendorId
      let vendorName = vendorsSorted.find((v) => v.id === vendorId)?.name ?? ''
      let portalToken = vendorsSorted.find((v) => v.id === vendorId)?.portalToken
      if (creatingVendor) {
        const r = await mutate<{ vendor: { id: string; name: string } | undefined }>({
          kind: 'createVendor',
          name: newVendorName.trim(),
        })
        if (!r.data.vendor) {
          setError('外协厂创建失败')
          return
        }
        useVendorId = r.data.vendor.id
        vendorName = r.data.vendor.name
        portalToken = undefined
      }
      const componentIds = [...selected]
      const unitPricesCny: Record<string, number> = {}
      const qtysByComponent: Record<string, number> = {}
      let totalQty = 0
      for (const cid of componentIds) {
        const c = components.find((x) => x.id === cid)
        const full = c?.qty ?? 0
        const rawQ = qtys[cid]?.trim() ?? ''
        const n = rawQ === '' ? full : Math.max(1, Math.floor(Number(rawQ)) || full)
        totalQty += n
        if (n !== full) qtysByComponent[cid] = n
        const rawP = prices[cid]?.trim() ?? ''
        if (rawP !== '') {
          const p = Number(rawP)
          if (Number.isFinite(p) && p >= 0) unitPricesCny[cid] = p
        }
      }
      const amountTrim = amount.trim()
      const r = await mutate<{
        result:
          | { ok: true; id: string; docNo?: string }
          | { ok: false; reason: 'overlap'; conflicts: Array<{ name: string; stages: string[] }> }
          | { ok: false; reason: string }
          | undefined
      }>({
        kind: 'createOutsourceBlock',
        jobId,
        componentIds,
        input: {
          vendorId: useVendorId,
          activity,
          stages: ACTIVITY_DEFAULT_STAGES[activity as OutsourceActivity] ?? ['操机'],
          amountCny: amountTrim === '' ? null : Number(amountTrim),
          sentDate: today(),
          expectedReturn,
          unitPricesCny,
          qtysByComponent,
          force,
        },
      })
      const result = r.data.result
      if (!result || !result.ok) {
        if (result && result.reason === 'overlap' && 'conflicts' in result) {
          setOverlap(
            result.conflicts.map((x) => x.name).join('、') +
              ' 仍有未回的外协 — 确认要再次送出？',
          )
          return
        }
        setError('创建失败 · 请刷新后重试')
        return
      }
      setSent({
        blockId: result.id,
        docNo: result.docNo,
        vendorName,
        portalToken,
        activity,
        totalQty,
        expectedReturn,
      })
      clearBar()
      router.refresh()
    })
  }

  return (
    <div>
      {/* Post-送出 handoff — the WeChat share panel, the point of the flow. */}
      {sent ? (
        <SharePanel
          vendorName={sent.vendorName}
          token={sent.portalToken}
          activityLabel={activityDisplay(sent.activity)}
          totalQty={sent.totalQty}
          expectedReturn={sent.expectedReturn}
          docNo={sent.docNo}
          blockId={sent.blockId}
          jobId={jobId}
          printHref={withBase(`/print/outsource/${sent.blockId}`)}
          onClose={() => setSent(null)}
        />
      ) : null}

      {/* ===== 送新单 — a draft block at the top of the same ledger. Collapsed
          it's one quiet ＋ row; opened it takes the shape of the block it will
          become: a create-bar header over the pick table. ===== */}
      {drafting ? (
        <div className="mb-8 rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-surface)]">
          {/* Draft header — same shape as a real 单 header. */}
          <div className="border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="text-[14px] font-semibold">
                外协 {selected.size} 件 →
              </span>
              <label className="flex items-center gap-1.5 text-[13px]">
                <span className="text-[var(--color-ink-3)]">做什么</span>
                <SearchSelect
                  options={OUTSOURCE_ACTIVITIES.map((a) => ({
                    id: a,
                    label: activityDisplay(a),
                  }))}
                  value={activity}
                  onChange={(id) => setActivity(id as OutsourceActivity)}
                  placeholder="选择…"
                  searchPlaceholder="搜索工序…"
                  disabled={pending}
                  triggerClass="w-[120px]"
                />
              </label>
              <label className="flex items-center gap-1.5 text-[13px]">
                <span className="text-[var(--color-ink-3)]">厂商</span>
                <SearchSelect
                  options={vendorsSorted.map((v) => ({ id: v.id, label: v.name }))}
                  value={creatingVendor ? '' : vendorId}
                  onChange={(id) => {
                    setVendorId(id)
                    setNewVendorName('')
                  }}
                  placeholder="选择…"
                  searchPlaceholder={`搜索 ${vendorsSorted.length} 家厂商…`}
                  createLabel="新增厂商"
                  onCreate={(name) => {
                    setVendorId('__new__')
                    setNewVendorName(name)
                  }}
                  disabled={pending}
                  triggerClass="w-[160px]"
                  triggerLabel={
                    creatingVendor && newVendorName
                      ? `${newVendorName} · 新`
                      : undefined
                  }
                />
              </label>
              <label className="flex items-center gap-1.5 text-[13px]">
                <span className="text-[var(--color-ink-3)]">交期</span>
                <DatePop
                  value={expectedReturn}
                  onChange={setExpectedReturn}
                  formatLabel={(iso) => mdShort(iso)}
                  placeholder="选日期"
                  disabled={pending}
                />
              </label>
              <label className="flex items-center gap-1 text-[13px]">
                <span className="text-[var(--color-ink-3)]">总价¥</span>
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="可留空"
                  inputMode="decimal"
                  disabled={pending}
                  className="mono min-h-[34px] w-[80px] rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-right text-[13px]"
                />
              </label>
              <button
                type="button"
                disabled={!canSend || pending}
                onClick={() => submit(false)}
                className="min-h-[38px] rounded-[2px] bg-[var(--color-ink)] px-5 text-[14px] font-medium text-[var(--color-surface)] active:opacity-70 disabled:opacity-30"
              >
                送出 ➤
              </button>
              <button
                type="button"
                onClick={clearBar}
                disabled={pending}
                className="text-[13px] text-[var(--color-ink-3)]"
              >
                取消
              </button>
            </div>
            {overlap ? (
              <div className="mt-2 flex flex-wrap items-center gap-3 text-[13px] text-[var(--color-warning)]">
                <span>{overlap}</span>
                <button
                  type="button"
                  onClick={() => submit(true)}
                  disabled={pending}
                  className="rounded-[2px] border border-[var(--color-warning)] px-3 py-1 text-[13px] active:opacity-70"
                >
                  仍要送出
                </button>
              </div>
            ) : null}
            {error ? (
              <p className="mt-2 text-[13px] text-[var(--color-overdue)]">{error}</p>
            ) : null}
          </div>

          {/* Draft body — the pick table. */}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-[var(--color-border)]">
                  <th className={`${th} w-[36px]`}></th>
                  <th className={`${th} w-[56px]`}>图</th>
                  <th className={th}>零件</th>
                  <th className={`${th} text-right`}>数</th>
                  <th className={`${th} text-right`}>单价</th>
                  <th className={th}>外协状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ c, state }) => (
                  <PickRow
                    key={c.id}
                    c={c}
                    state={state}
                    vendors={vendors}
                    ticked={selected.has(c.id)}
                    onTick={() => toggle(c.id)}
                    qty={qtys[c.id] ?? ''}
                    setQty={(v) => setQtys((p) => ({ ...p, [c.id]: v }))}
                    price={prices[c.id] ?? ''}
                    setPrice={(v) => setPrices((p) => ({ ...p, [c.id]: v }))}
                    pending={pending}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setDrafting(true)}
          className="mb-8 flex w-full items-center rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-left text-[13px] text-[var(--color-ink-2)] transition-colors hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
        >
          <span className="mr-2 text-[15px] leading-none">＋</span>送新单
        </button>
      )}

      {/* ===== 外协单 — one group per dispatch. ===== */}
      {blocks.length > 0 ? (
        <div className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[var(--color-border)]">
                <th className={`${th} w-[56px]`}>图</th>
                <th className={th}>零件</th>
                <th className={`${th} w-[60px] text-right`}>数</th>
                <th className={`${th} w-[72px] text-right`}>单价</th>
                <th className={`${thStatus} w-[288px] pr-3 text-right`}>外协进度</th>
                <th className={`${thStatus} w-[104px]`}>收</th>
              </tr>
            </thead>
            {blocks.map((b) => (
              <BlockGroup
                key={b.id}
                jobId={jobId}
                block={b}
                vendors={vendors}
                byId={byId}
                components={components}
                onChanged={() => router.refresh()}
              />
            ))}
          </table>
        </div>
      ) : null}
    </div>
  )
}

// ===== One 外协单 group: header line + its part rows + 备注. =====

function BlockGroup({
  jobId,
  block,
  vendors,
  byId,
  components,
  onChanged,
}: {
  jobId: string
  block: OutsourceBlock
  vendors: Vendor[]
  byId: Map<string, WaixieComponent>
  components: WaixieComponent[]
  onChanged: () => void
}) {
  const [busy, start] = useTransition()
  const closed = isBlockClosed(block)
  const vendor = vendors.find((v) => v.id === block.vendorId)
  const overdueDays = closed ? 0 : -daysFromToday(block.expectedReturn)
  const pendingMembers = block.members.filter((m) => !isMemberFullyReturned(m))
  // Full "外发打印" here, not the stripped "打印" — a bare verb in the header
  // line reads like a button.
  const act = block.activity?.trim() ?? ''

  const receiveAll = () => {
    if (pendingMembers.length === 0) return
    start(async () => {
      await mutate({
        kind: 'setBlockMembersReturnedQty',
        blockId: block.id,
        items: pendingMembers.map((m) => ({ componentId: m.componentId, qty: m.qty })),
        date: today(),
        jobId,
      })
      showToast('已全部收回')
      onChanged()
    })
  }

  const del = () => {
    start(async () => {
      await mutate({ kind: 'deleteOutsourceBlock', blockId: block.id, jobId })
      onChanged()
    })
  }

  const addOptions = components
    .filter((c) => !block.members.some((m) => m.componentId === c.id))
    .map((c) => ({ id: c.id, name: c.name, qty: c.qty }))

  const qtySum = block.members.reduce((s, m) => s + m.qty, 0)
  const returnedSum = block.members.reduce((s, m) => s + memberReturnedQty(m), 0)

  return (
    <tbody className="border-t border-[var(--color-border)]">
      {/* 单 header — metadata on the left (all editable in place), supplier
          status cells on the right, exactly like a master-board row. */}
      <tr className="bg-[var(--color-bg)]">
        <td colSpan={4} className="px-3 py-2">
          {/* The 外协单 in master-board grammar: labeled columns, one value per
              cell, every cell editable in place. Same fields as before — now
              they read like a spreadsheet row instead of a run-on line. */}
          <div
            className={`flex items-start justify-between gap-3 ${closed ? 'opacity-70' : ''}`}
          >
            <div className="flex min-w-0 flex-wrap items-start gap-x-6 gap-y-1.5">
              <span className="block">
                <span className={hcellLabel}>厂商</span>
                <NameCombobox
                  target={{ kind: 'vendor', blockId: block.id, jobId }}
                  value={vendor?.name ?? block.vendorId}
                  options={vendors.map((v) => ({ id: v.id, name: v.name }))}
                  className="text-[14px] font-semibold text-[var(--color-ink)]"
                />
              </span>
              <span className="block">
                <span className={hcellLabel}>做什么</span>
                <OutsourceBlockText
                  blockId={block.id}
                  jobId={jobId}
                  field="activity"
                  value={act || undefined}
                  className="block text-[13px] leading-[20px] text-[var(--color-ink)]"
                />
              </span>
              <span className="block">
                <span className={hcellLabel}>工序</span>
                <span className="block text-[13px] leading-[20px]">
                  <BlockStagesEditor
                    blockId={block.id}
                    jobId={jobId}
                    stages={block.stages}
                    activity={block.activity}
                    vendors={vendors}
                    disabled={busy}
                    onSaved={onChanged}
                  />
                </span>
              </span>
              <span className="block">
                <span className={hcellLabel}>寄出</span>
                <OutsourceBlockDate
                  blockId={block.id}
                  jobId={jobId}
                  field="sentDate"
                  value={block.sentDate}
                  formatLabel={mdShort}
                  hideIcon
                  className="mono block text-[13px] leading-[20px] text-[var(--color-ink)]"
                />
              </span>
              <span className="block">
                <span className={hcellLabel}>交期</span>
                <span className="flex items-baseline gap-1.5">
                  <OutsourceBlockDate
                    blockId={block.id}
                    jobId={jobId}
                    field="expectedReturn"
                    value={block.expectedReturn}
                    formatLabel={mdShort}
                    hideIcon
                    className={`mono block text-[13px] font-medium leading-[20px] ${
                      !closed && overdueDays > 0
                        ? 'text-[var(--color-overdue)]'
                        : 'text-[var(--color-ink)]'
                    }`}
                  />
                  {!closed && overdueDays > 0 ? (
                    <span className="text-[11px] font-medium text-[var(--color-overdue)]">
                      逾期{overdueDays}天
                    </span>
                  ) : null}
                </span>
              </span>
              <span className="block">
                <span className={hcellLabel}>金额</span>
                <span className="flex items-baseline gap-0.5 text-[13px] leading-[20px]">
                  <span className="mono text-[var(--color-ink-3)]">¥</span>
                  <OutsourceBlockAmount
                    blockId={block.id}
                    jobId={jobId}
                    value={block.amountCny}
                    className="mono text-[13px] text-[var(--color-ink)] [field-sizing:content] min-w-[3ch]"
                  />
                </span>
              </span>
              {block.docNo ? (
                <span className="block" title="外协单号">
                  <span className={hcellLabel}>单号</span>
                  <span className="mono block whitespace-nowrap text-[11px] leading-[20px] text-[var(--color-ink-3)]">
                    {block.docNo}
                  </span>
                </span>
              ) : null}
            </div>
            <span className="flex shrink-0 items-center gap-2">
              <BlockKebab blockId={block.id} pending={busy} onDelete={del} />
            </span>
          </div>
        </td>

        {/* 外协进度 — the whole vendor thread in one strip (寄出→微信→已读→
            诺期→发货→收), right-aligned. The amber 微信 cell is the growth
            loop's tappable weak link. */}
        <td className="border-l border-[var(--color-border)] px-2 py-2 text-right align-middle">
          <BlockThreadStrip block={block} vendor={vendor} jobId={jobId} />
        </td>

        {/* 收 — the factory's own cell; 全收 acts right here. */}
        <td className={tdStatus}>
          {closed ? (
            <CellDone date={mdShort(blockClosedAt(block))} />
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={receiveAll}
              title="全部零件今天收回"
              className={`${statusInner} transition-colors hover:bg-[var(--color-success-soft)] disabled:opacity-40`}
            >
              <span className="text-[12px] font-medium text-[var(--color-success)]">
                全收
              </span>
              <span className="mono text-[10px] text-[var(--color-ink-3)]">
                {returnedSum}/{qtySum}
              </span>
            </button>
          )}
        </td>
      </tr>

      {block.members.map((m) => (
        <MemberRow
          key={m.componentId}
          jobId={jobId}
          block={block}
          m={m}
          comp={byId.get(m.componentId)}
          onChanged={onChanged}
        />
      ))}

      {/* 备注 + 加零件 — one quiet line under the parts. */}
      <tr>
        <td colSpan={6} className="pb-2.5 pl-[68px] pr-3">
          <div className="flex items-start gap-4">
            <OutsourceBlockNotes
              blockId={block.id}
              jobId={jobId}
              value={block.notes}
              className="min-w-[200px] flex-1 text-[12px] text-[var(--color-ink-2)]"
            />
            {!closed ? (
              <AddMembersRow
                blockId={block.id}
                jobId={jobId}
                stages={block.stages}
                componentOptions={addOptions}
                vendors={vendors}
                onAdded={onChanged}
              />
            ) : null}
          </div>
        </td>
      </tr>
    </tbody>
  )
}

// One part on a 外协单 — 图 · 零件 · 数(可改) · 单价(可改) · 收.
function MemberRow({
  jobId,
  block,
  m,
  comp,
  onChanged,
}: {
  jobId: string
  block: OutsourceBlock
  m: Member
  comp?: WaixieComponent
  onChanged: () => void
}) {
  const [receiving, setReceiving] = useState(false)
  const [rQty, setRQty] = useState('')
  const [rDate, setRDate] = useState(today())
  const [armed, setArmed] = useState(false)
  const [busy, start] = useTransition()

  const returned = memberReturnedQty(m)
  const remaining = memberRemainingQty(m)
  const done = isMemberFullyReturned(m)

  const commitReceive = () => {
    const n = Math.max(1, Math.min(remaining, Math.floor(Number(rQty)) || remaining))
    start(async () => {
      await mutate({
        kind: 'setBlockMembersReturnedQty',
        blockId: block.id,
        items: [{ componentId: m.componentId, qty: returned + n }],
        date: rDate,
        jobId,
      })
      setReceiving(false)
      setRQty('')
      showToast(`已收 ${m.name} ×${n}`)
      onChanged()
    })
  }

  const removeMember = () => {
    setArmed(false)
    start(async () => {
      await mutate({
        kind: 'removeOutsourceBlockMember',
        blockId: block.id,
        componentId: m.componentId,
        jobId,
      })
      onChanged()
    })
  }

  return (
    <tr className="border-t border-[var(--color-border)]">
      <td className={td}>
        <PartImg src={m.imageUrl ?? comp?.imageUrl} />
      </td>
      <td className={`${td} max-w-[240px]`}>
        <p className="truncate text-[14px] font-medium">{m.name}</p>
        {(m.material ?? comp?.material) ? (
          <p className="truncate text-[11px] text-[var(--color-ink-3)]">
            {m.material ?? comp?.material}
          </p>
        ) : null}
      </td>
      <td className={`${td} text-right`}>
        {done ? (
          <span className="mono text-[13px] text-[var(--color-ink-2)]">{m.qty}</span>
        ) : (
          <BlockMemberQty
            blockId={block.id}
            componentId={m.componentId}
            jobId={jobId}
            value={m.qty}
            className="mono w-[52px] text-right text-[13px]"
          />
        )}
      </td>
      <td className={`${td} text-right`}>
        <BlockMemberUnitPrice
          blockId={block.id}
          componentId={m.componentId}
          jobId={jobId}
          value={m.unitPriceCny}
          className="mono w-[60px] text-right text-[13px]"
        />
      </td>
      {/* 外协进度 strip is 单-level — parts only carry their own 收 cell. */}
      <td className={tdStatus} />
      <td className={tdStatus}>
        {done ? (
          <span className={`${statusInner} px-1`}>
            <span className="text-[15px] font-semibold leading-none text-[var(--color-success)]">
              ✓
            </span>
            <span className="mono text-[10px] text-[var(--color-ink-3)]">
              {mdShort(m.returnedAt)}
            </span>
          </span>
        ) : receiving ? (
          // Opened panel — the ONLY place buttons live. Receive qty/date, then
          // the 撤掉此零件 action tucked below so the resting row stays clean.
          <span className={`${statusInner} gap-1.5 px-1`}>
            <span className="inline-flex items-center gap-1.5">
              <input
                value={rQty}
                onChange={(e) => setRQty(e.target.value)}
                placeholder={String(remaining)}
                inputMode="numeric"
                autoFocus
                className="mono w-[44px] rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1 py-0.5 text-right text-[13px]"
              />
              <DatePop
                value={rDate}
                onChange={(v) => v && setRDate(v)}
                formatLabel={mdShort}
                disabled={busy}
              />
              <button
                type="button"
                disabled={busy}
                onClick={commitReceive}
                className="rounded-[2px] bg-[var(--color-ink)] px-2.5 py-1 text-[12px] text-[var(--color-surface)] active:opacity-70"
              >
                ✓
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setReceiving(false)
                  setArmed(false)
                }}
                className="px-1 text-[12px] text-[var(--color-ink-3)]"
              >
                ×
              </button>
            </span>
            {armed ? (
              <button
                type="button"
                disabled={busy}
                onClick={removeMember}
                className="text-[11px] font-medium text-[var(--color-overdue)]"
              >
                确认撤掉此零件？
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => setArmed(true)}
                title="把这个零件从外协单撤掉"
                className="text-[11px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
              >
                撤掉此零件
              </button>
            )}
          </span>
        ) : (
          // At rest — state text only, no buttons. Click to open the panel.
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setRQty(String(remaining))
              setRDate(today())
              setArmed(false)
              setReceiving(true)
            }}
            className={`${statusInner} px-1 transition-colors hover:bg-[var(--color-success-soft)] disabled:opacity-40`}
          >
            {returned > 0 ? (
              <span className="mono text-[12px] font-medium text-[var(--color-warning)]">
                已收 {returned}/{m.qty}
              </span>
            ) : (
              <span className="mono text-[13px] text-[var(--color-ink-4)]">—</span>
            )}
          </button>
        )}
      </td>
    </tr>
  )
}

// ===== 送新单 picker row — the part's whole 外协 history in one glance. =====

function PickRow({
  c,
  state,
  vendors,
  ticked,
  onTick,
  qty,
  setQty,
  price,
  setPrice,
  pending,
}: {
  c: WaixieComponent
  state: RowState
  vendors: Vendor[]
  ticked: boolean
  onTick: () => void
  qty: string
  setQty: (v: string) => void
  price: string
  setPrice: (v: string) => void
  pending: boolean
}) {
  const block = state.kind === 'none' ? undefined : state.block
  const member = state.kind === 'none' ? undefined : state.member
  const out = state.kind === 'out'
  const back = state.kind === 'back'
  const overdueDays = out && block ? -daysFromToday(block.expectedReturn) : 0
  const vendorName = block
    ? (vendors.find((v) => v.id === block.vendorId)?.name ?? block.vendorId)
    : ''
  const dim = 'text-[var(--color-ink-4)]'

  return (
    <tr
      className={`border-b border-[var(--color-border)] last:border-b-0 ${
        ticked ? 'bg-[color-mix(in_srgb,var(--color-ink)_4%,transparent)]' : ''
      }`}
    >
      <td className={`${td} text-center`}>
        <input
          type="checkbox"
          checked={ticked}
          onChange={onTick}
          disabled={pending}
          className="h-[15px] w-[15px] accent-[var(--color-ink)]"
        />
      </td>
      <td className={td}>
        <PartImg src={c.imageUrl} />
      </td>
      <td className={`${td} max-w-[240px]`}>
        <p className="truncate text-[14px] font-medium">{c.name}</p>
        {c.material ? (
          <p className="truncate text-[11px] text-[var(--color-ink-3)]">{c.material}</p>
        ) : null}
      </td>
      <td className={`${td} text-right`}>
        {ticked ? (
          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder={String(c.qty)}
            inputMode="numeric"
            className="mono w-[48px] rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1 py-0.5 text-right text-[13px]"
          />
        ) : (
          <span className="mono text-[13px]">{c.qty}</span>
        )}
      </td>
      <td className={`${td} text-right`}>
        {ticked ? (
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="¥"
            inputMode="decimal"
            className="mono w-[56px] rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1 py-0.5 text-right text-[13px]"
          />
        ) : member?.unitPriceCny != null ? (
          <span className="mono text-[13px] text-[var(--color-ink-3)]">
            ¥{member.unitPriceCny}
          </span>
        ) : (
          <span className={dim}>—</span>
        )}
      </td>
      <td className={td}>
        {out && block ? (
          <span className="text-[13px]">
            <span className="font-medium text-[var(--color-warning)]">
              在外 · {vendorName}
            </span>
            {overdueDays > 0 ? (
              <span className="ml-2 font-medium text-[var(--color-overdue)]">
                逾期{overdueDays}天
              </span>
            ) : (
              <span className="mono ml-2 text-[12px] text-[var(--color-ink-3)]">
                交期 {mdShort(block.expectedReturn)}
              </span>
            )}
          </span>
        ) : back && member ? (
          <span className="text-[13px] text-[var(--color-success)]">
            ✓ 已回 <span className="mono text-[12px]">{mdShort(member.returnedAt)}</span>
          </span>
        ) : (
          <span className={dim}>—</span>
        )}
      </td>
    </tr>
  )
}
