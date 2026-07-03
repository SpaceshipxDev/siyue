'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  ACTIVITY_DEFAULT_STAGES,
  OUTSOURCE_ACTIVITIES,
  daysFromToday,
  formatCny,
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

// 外协 tab, rebuilt as the same ledger the 零件 tab is: one row per component,
// fixed columns, conditional color, zero prose. Tick rows → a single action
// line (做什么 · 厂商 · 回厂 · ¥) → 送出 → the WeChat handoff takes over the
// screen, because sending the vendor their link IS the point of the flow.
//
// A component's 外协 life is readable straight across its row:
//   数 · 单价 · 做什么 · 厂商 · 寄→回 · 状态(在外/已回/—) · 收
// exactly like scanning a stage column on the master board.

export type WaixieComponent = {
  id: string
  name: string
  qty: number
  material?: string
  imageUrl?: string
  blocks: OutsourceBlock[]
}

type RowState =
  | { kind: 'none' }
  | { kind: 'out'; block: OutsourceBlock; member: OutsourceBlock['members'][number] }
  | { kind: 'back'; block: OutsourceBlock; member: OutsourceBlock['members'][number] }

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
  if (!t) return '—'
  return t.replace(/^外发/, '')
}

const th =
  'px-3 py-2 text-left text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--color-ink-3)] whitespace-nowrap'
const td = 'px-3 py-2.5 align-middle whitespace-nowrap'

export function WaixieTable({
  jobId,
  components,
  vendors,
}: {
  jobId: string
  components: WaixieComponent[]
  vendors: Vendor[]
}) {
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
    })
  }

  const copyWeChat = async () => {
    if (!sent) return
    const lines = [
      `【${BRAND.shortName} · 外协】${activityDisplay(sent.activity)} ${sent.totalQty}件 · 要求 ${mdCn(sent.expectedReturn)} 交`,
      ...(sent.portalToken
        ? [
            '点开确认收货、回交期（免登录，链接固定可收藏）：',
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

      {/* Create bar — appears the moment a row is ticked. One line, like
          filling the header of a paper 外协单. */}
      {selected.size > 0 ? (
        <div className="mb-4 rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-surface)] px-4 py-3">
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
              <span className="text-[var(--color-ink-3)]">回厂</span>
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
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg)]">
              <th className={`${th} w-[36px]`}></th>
              <th className={`${th} w-[56px]`}>图</th>
              <th className={th}>零件</th>
              <th className={`${th} text-right`}>数</th>
              <th className={`${th} text-right`}>单价</th>
              <th className={th}>做什么</th>
              <th className={th}>厂商</th>
              <th className={th}>寄 → 回</th>
              <th className={th}>状态</th>
              <th className={`${th} w-[110px]`}>收</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ c, state }) => (
              <WaixieRow
                key={c.id}
                jobId={jobId}
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
      <p className="mt-2 text-[12px] text-[var(--color-ink-3)]">
        勾选零件 → 填一行 → 送出。收件在行末点 收。
      </p>
    </div>
  )
}

function WaixieRow({
  jobId,
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
  jobId: string
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
  const [receiving, setReceiving] = useState(false)
  const [receiveQty, setReceiveQty] = useState('')
  const [busy, start] = useTransition()

  const block = state.kind === 'none' ? undefined : state.block
  const member = state.kind === 'none' ? undefined : state.member
  const out = state.kind === 'out'
  const back = state.kind === 'back'

  const overdueDays = out && block ? -daysFromToday(block.expectedReturn) : 0
  const promise = out ? block?.vendorPromisedDate : undefined
  const promiseLate = !!(promise && block && promise > block.expectedReturn)

  const vendorName = block
    ? (vendors.find((v) => v.id === block.vendorId)?.name ?? block.vendorId)
    : ''

  const remaining = member ? memberRemainingQty(member) : 0

  const commitReceive = () => {
    if (!block || !member) return
    const n = Math.max(1, Math.min(remaining, Math.floor(Number(receiveQty)) || remaining))
    start(async () => {
      await mutate({
        kind: 'setBlockMembersReturnedQty',
        blockId: block.id,
        items: [{ componentId: c.id, qty: memberReturnedQty(member) + n }],
        date: today(),
        jobId,
      })
      setReceiving(false)
      setReceiveQty('')
      showToast(`已收 ${c.name} ×${n}`)
    })
  }

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
        {c.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={proxiedStorageUrl(c.imageUrl)}
            alt=""
            loading="lazy"
            className="h-10 w-10 rounded-[2px] border border-[var(--color-border)] object-cover"
          />
        ) : (
          <span className="inline-block h-10 w-10 rounded-[2px] border border-dashed border-[var(--color-border)]" />
        )}
      </td>
      <td className={`${td} max-w-[220px]`}>
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
          <span className="mono text-[13px]">
            {out && member ? (
              <>
                {memberReturnedQty(member) > 0 ? (
                  <span className="text-[var(--color-warning)]">
                    {memberReturnedQty(member)}/
                  </span>
                ) : null}
                {member.qty}
              </>
            ) : (
              c.qty
            )}
          </span>
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
          <span className="mono text-[13px]">{formatCny(member.unitPriceCny)}</span>
        ) : (
          <span className={dim}>—</span>
        )}
      </td>
      <td className={td}>
        {block ? (
          <span className={`text-[13px] ${back ? 'text-[var(--color-ink-3)]' : ''}`}>
            {activityDisplay(block.activity)}
          </span>
        ) : (
          <span className={dim}>—</span>
        )}
      </td>
      <td className={td}>
        {block ? (
          <span className={`text-[13px] ${back ? 'text-[var(--color-ink-3)]' : ''}`}>
            {vendorName}
          </span>
        ) : (
          <span className={dim}>—</span>
        )}
      </td>
      <td className={td}>
        {block ? (
          <span className={`mono text-[12px] ${back ? 'text-[var(--color-ink-3)]' : 'text-[var(--color-ink-2)]'}`}>
            {mdShort(block.sentDate)} → {mdShort(block.expectedReturn)}
            {promise && promise !== block.expectedReturn ? (
              <span
                className={promiseLate ? 'text-[var(--color-warning)]' : 'text-[var(--color-success)]'}
              >
                {' '}
                诺{mdShort(promise)}
              </span>
            ) : null}
          </span>
        ) : (
          <span className={dim}>—</span>
        )}
      </td>
      <td className={td}>
        {out && block ? (
          overdueDays > 0 ? (
            <span className="text-[13px] font-medium text-[var(--color-overdue)]">
              逾期 {overdueDays} 天
            </span>
          ) : block.vendorShippedAt ? (
            <span className="text-[13px] font-medium text-[var(--color-success)]">
              已发回
            </span>
          ) : (
            <span className="text-[13px] text-[var(--color-warning)]">在外</span>
          )
        ) : back && member ? (
          <span className="text-[13px] text-[var(--color-success)]">
            ✓ 已回 <span className="mono text-[12px]">{mdShort(member.returnedAt)}</span>
          </span>
        ) : (
          <span className={dim}>—</span>
        )}
      </td>
      <td className={td}>
        {out && remaining > 0 ? (
          receiving ? (
            <span className="inline-flex items-center gap-1">
              <input
                value={receiveQty}
                onChange={(e) => setReceiveQty(e.target.value)}
                placeholder={String(remaining)}
                inputMode="numeric"
                autoFocus
                className="mono w-[44px] rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1 py-0.5 text-right text-[13px]"
              />
              <button
                type="button"
                disabled={busy}
                onClick={commitReceive}
                className="rounded-[2px] bg-[var(--color-ink)] px-2 py-1 text-[12px] text-[var(--color-surface)] active:opacity-70"
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
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setReceiveQty(String(remaining))
                setReceiving(true)
              }}
              className="rounded-[2px] border border-[var(--color-border-strong)] px-2.5 py-1 text-[12px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
            >
              收
            </button>
          )
        ) : null}
      </td>
    </tr>
  )
}
