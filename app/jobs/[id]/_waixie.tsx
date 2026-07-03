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
import { BRAND } from '@/lib/brand'
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
} from '@/app/_editable'
import { BlockShareButton } from '@/app/_vendor_share'

// 外协 tab — two ledgers, one sheet.
//
// Top: 外协单. Each dispatch is a group — a header line (单号 · 厂商 · 做什么 ·
// 工序 · 寄/回 · ¥ · 厂商回话 · 微信/⋯) over its part rows, exactly like a
// merged group row in Excel. Every field on the header edits in place; 收
// happens on the part row (or 全收 on the header) and refreshes the page data
// immediately.
//
// Bottom: 送新单. One row per part with a checkbox — tick → fill one line
// (做什么 · 厂商 · 回厂 · ¥) → 送出 → the WeChat handoff banner takes over,
// because sending the vendor their link IS the point of the flow.

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

function mdCn(ymd?: string): string {
  if (!ymd) return ''
  const p = ymd.split('-')
  if (p.length < 3) return ymd
  return `${Number(p[1])}月${Number(p[2])}日`
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

  const copyWeChat = async () => {
    if (!sent) return
    const lines = [
      `【${BRAND.shortName} · 外协】${activityDisplay(sent.activity)} ${sent.totalQty}件 · 要求 ${mdCn(sent.expectedReturn)} 交`,
      ...(sent.portalToken
        ? [
            '点开回交期、报发货（免登录，链接固定可收藏）：',
            `${window.location.origin}/w/${sent.portalToken}`,
          ]
        : []),
    ]
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      showToast('已复制 · 去微信粘贴给厂商')
    } catch {
      showToast('复制失败', 'warning')
    }
  }

  return (
    <div>
      {/* Post-送出 handoff — the loudest thing on the tab, on purpose. */}
      {sent ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-[2px] border border-[var(--color-success)]/30 bg-[var(--color-success-soft)] px-4 py-3">
          <span className="text-[14px] font-medium text-[var(--color-success)]">
            ✓ 外协单已生成 · {sent.vendorName} · {sent.totalQty}件
            {sent.docNo ? <span className="mono ml-2 text-[12px]">{sent.docNo}</span> : null}
          </span>
          <button
            type="button"
            onClick={copyWeChat}
            className="min-h-[38px] rounded-[2px] bg-[var(--color-ink)] px-4 text-[14px] font-medium text-[var(--color-surface)] active:opacity-70"
          >
            复制微信消息 → 发给{sent.vendorName}
          </button>
          <a
            href={`/print/outsource/${sent.blockId}`}
            target="_blank"
            className="text-[13px] text-[var(--color-ink-2)] underline underline-offset-4"
          >
            打印外协单
          </a>
          <button
            type="button"
            onClick={() => setSent(null)}
            className="ml-auto text-[13px] text-[var(--color-ink-3)]"
            aria-label="关闭"
          >
            ×
          </button>
        </div>
      ) : null}

      {/* ===== 外协单 — one group per dispatch. ===== */}
      {blocks.length > 0 ? (
        <div className="mb-8 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[var(--color-border)]">
                <th className={`${th} w-[56px]`}>图</th>
                <th className={th}>零件</th>
                <th className={`${th} w-[60px] text-right`}>数</th>
                <th className={`${th} w-[72px] text-right`}>单价</th>
                <th className={`${thStatus} w-[64px]`}>已读</th>
                <th className={`${thStatus} w-[84px]`} title="厂商回的交期">
                  厂商诺期
                </th>
                <th className={`${thStatus} w-[64px]`}>已发货</th>
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

      {/* ===== 送新单 — tick parts, fill one line, 送出. ===== */}
      <div className="mb-2 flex items-baseline justify-between">
        <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-[var(--color-ink-3)]">
          送新单
        </p>
        <p className="text-[12px] text-[var(--color-ink-4)]">
          勾选零件 → 填一行 → 送出
        </p>
      </div>

      {selected.size > 0 ? (
        <div className="mb-3 rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-surface)] px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-[14px] font-semibold">
              外协 {selected.size} 件 →
            </span>
            <label className="flex items-center gap-1.5 text-[13px]">
              <span className="text-[var(--color-ink-3)]">做什么</span>
              <select
                value={activity}
                onChange={(e) => setActivity(e.target.value as OutsourceActivity)}
                disabled={pending}
                className="min-h-[34px] rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[13px]"
              >
                <option value="">选择…</option>
                {OUTSOURCE_ACTIVITIES.map((a) => (
                  <option key={a} value={a}>
                    {activityDisplay(a)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-[13px]">
              <span className="text-[var(--color-ink-3)]">厂商</span>
              <select
                value={vendorId}
                onChange={(e) => setVendorId(e.target.value)}
                disabled={pending}
                className="min-h-[34px] max-w-[160px] rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[13px]"
              >
                <option value="">选择…</option>
                {vendorsSorted.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
                <option value="__new__">+ 新增厂商…</option>
              </select>
            </label>
            {creatingVendor ? (
              <input
                value={newVendorName}
                onChange={(e) => setNewVendorName(e.target.value)}
                placeholder="厂商名称"
                disabled={pending}
                className="min-h-[34px] w-[140px] rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[13px]"
              />
            ) : null}
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
      ) : null}

      <div className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
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

  const promise = block.vendorPromisedDate
  const promiseLate = !!promise && promise > block.expectedReturn
  const promiseLateDays = promiseLate ? dayDiff(promise!, block.expectedReturn) : 0
  const qtySum = block.members.reduce((s, m) => s + m.qty, 0)
  const returnedSum = block.members.reduce((s, m) => s + memberReturnedQty(m), 0)

  return (
    <tbody className="border-t border-[var(--color-border)]">
      {/* 单 header — metadata on the left (all editable in place), supplier
          status cells on the right, exactly like a master-board row. */}
      <tr className="bg-[var(--color-bg)]">
        <td colSpan={4} className="px-3 py-2">
          <div
            className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${closed ? 'opacity-70' : ''}`}
          >
            {block.docNo ? (
              <span
                className="mono shrink-0 whitespace-nowrap text-[12px] font-medium text-[var(--color-ink-2)]"
                title="外协单号"
              >
                {block.docNo}
              </span>
            ) : null}
            <span className="w-[130px] shrink-0">
              <NameCombobox
                target={{ kind: 'vendor', blockId: block.id, jobId }}
                value={vendor?.name ?? block.vendorId}
                options={vendors.map((v) => ({ id: v.id, name: v.name }))}
                className="text-[13px] font-semibold text-[var(--color-ink)]"
              />
            </span>
            {act ? (
              <span className="shrink-0 whitespace-nowrap text-[13px] text-[var(--color-ink)]">
                {act}
              </span>
            ) : null}
            <span className="flex items-baseline gap-1 text-[12px] text-[var(--color-ink-2)]">
              <span className="text-[var(--color-ink-4)]">工序</span>
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
            <span className="flex items-baseline gap-1 text-[12px]">
              <span className="text-[var(--color-ink-4)]">寄</span>
              <OutsourceBlockDate
                blockId={block.id}
                jobId={jobId}
                field="sentDate"
                value={block.sentDate}
                formatLabel={mdShort}
                hideIcon
                className="mono text-[12px] text-[var(--color-ink-2)]"
              />
            </span>
            <span className="flex items-baseline gap-1 text-[12px]">
              <span className="text-[var(--color-ink-4)]">交期</span>
              <OutsourceBlockDate
                blockId={block.id}
                jobId={jobId}
                field="expectedReturn"
                value={block.expectedReturn}
                formatLabel={mdShort}
                hideIcon
                className={`mono text-[12px] font-medium ${
                  overdueDays > 0 ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink)]'
                }`}
              />
              {!closed && overdueDays > 0 ? (
                <span className="text-[12px] font-medium text-[var(--color-overdue)]">
                  逾期{overdueDays}天
                </span>
              ) : null}
            </span>
            <span className="flex items-baseline gap-0.5 text-[12px]">
              <span className="mono text-[var(--color-ink-4)]">¥</span>
              <OutsourceBlockAmount
                blockId={block.id}
                jobId={jobId}
                value={block.amountCny}
                className="mono text-[12px] text-[var(--color-ink)] [field-sizing:content] min-w-[3ch]"
              />
            </span>
            <span className="ml-auto flex items-center gap-2">
              <BlockShareButton vendor={vendor} block={block} />
              <BlockKebab blockId={block.id} pending={busy} onDelete={del} />
            </span>
          </div>
        </td>

        {/* 已读 — did the vendor even open the link. */}
        <td className={tdStatus}>
          {block.vendorSeenAt ? (
            <CellDone date={tsShort(block.vendorSeenAt)} />
          ) : (
            <CellDim hint="厂商还没点开链接" />
          )}
        </td>

        {/* 厂商诺期 — the date they committed to; amber when later than 交期. */}
        <td
          className={`${tdStatus} ${
            promiseLate && !closed ? 'bg-[var(--color-warning-soft)]' : ''
          }`}
        >
          {promise ? (
            <span
              className={statusInner}
              title={
                promiseLate
                  ? `比要求晚${promiseLateDays}天${block.vendorDelayReason ? ` · ${block.vendorDelayReason}` : ''}`
                  : '厂商诺按期交'
              }
            >
              <span
                className={`mono text-[12px] font-semibold ${
                  promiseLate ? 'text-[var(--color-warning)]' : 'text-[var(--color-success)]'
                }`}
              >
                {mdShort(promise)}
              </span>
              <span
                className={`text-[10px] ${
                  promiseLate ? 'text-[var(--color-warning)]' : 'text-[var(--color-success)]'
                }`}
              >
                {promiseLate
                  ? (block.vendorDelayReason ?? `晚${promiseLateDays}天`)
                  : '按期'}
              </span>
            </span>
          ) : (
            <CellDim hint="厂商还没回交期" />
          )}
        </td>

        {/* 已发货 — vendor says the goods are on the way back. */}
        <td className={tdStatus}>
          {block.vendorShippedAt ? (
            <CellDone date={tsShort(block.vendorShippedAt)} />
          ) : (
            <CellDim hint="厂商还没报发货" />
          )}
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
        <td colSpan={8} className="pb-2.5 pl-[68px] pr-3">
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
      {/* 已读/诺期/发货 are 单-level — parts only carry their own 收 cell. */}
      <td colSpan={3} className={tdStatus} />
      <td className={tdStatus}>
        <span className={`${statusInner} px-1`}>
          {done ? (
            <>
              <span className="text-[15px] font-semibold leading-none text-[var(--color-success)]">
                ✓
              </span>
              <span className="mono text-[10px] text-[var(--color-ink-3)]">
                {mdShort(m.returnedAt)}
              </span>
            </>
          ) : receiving ? (
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
                onClick={() => setReceiving(false)}
                className="px-1 text-[12px] text-[var(--color-ink-3)]"
              >
                ×
              </button>
            </span>
          ) : (
            <>
              <span className="inline-flex items-center gap-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setRQty(String(remaining))
                    setRDate(today())
                    setReceiving(true)
                  }}
                  className="rounded-[2px] border border-[var(--color-border-strong)] px-2.5 py-1 text-[12px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] disabled:opacity-40"
                >
                  收
                </button>
                {armed ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={removeMember}
                    className="text-[11px] font-medium text-[var(--color-overdue)]"
                  >
                    确认撤掉？
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setArmed(true)}
                    title="把这个零件从外协单撤掉"
                    className="px-1 text-[13px] leading-none text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                  >
                    ×
                  </button>
                )}
              </span>
              {returned > 0 ? (
                <span className="mono text-[10px] text-[var(--color-warning)]">
                  已收{returned}/{m.qty}
                </span>
              ) : null}
            </>
          )}
        </span>
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
