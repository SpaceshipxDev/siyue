import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import {
  blockClosedAt,
  daysFromToday,
  formatCny,
  isBlockClosed,
  type OutsourceBlock,
} from '@/lib/data'
import { today } from '@/lib/today'
import {
  getVendorByPortalToken,
  getVendorPortalBlocks,
  stampVendorBlocksSeen,
} from '@/lib/db'
import { BRAND } from '@/lib/brand'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { portalAck, portalDelayReason, portalPromise, portalShipped } from './_actions'
import { DEMO_COOKIE, DEMO_TOKEN, demoBlocks, demoVendor } from './_demo'

// 外协厂商门户 — the vendor's ledger. One row per 单, and every row carries
// the same three answer cells, master-board style:
//
//   零件 | 交期 | 收 | 报期 | 发
//
// Green ✓ = answered (with its date underneath, like the factory's own stage
// grid). Black = the next thing to tap. Tap the 零件 cell to open the row:
// full part list with photos, 备注, the date chips, and the rare corrections.
// Server-rendered, plain <form> POSTs and plain links — no JS required, so it
// works in any WeChat webview.

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>
}): Promise<Metadata> {
  const { token } = await params
  const vendor =
    token === DEMO_TOKEN ? demoVendor() : await getVendorByPortalToken(token)
  return {
    title: vendor ? `${vendor.name} · 外协单` : '外协单 · 思跃',
    description: '外协协作 — 确认收货 · 交期回复 · 对账',
  }
}

// '2026-07-08' → '7月8日' (+周三 with weekday).
function mdCn(ymd?: string, withWeekday = false): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return ymd ?? ''
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  const base = `${m}月${d}日`
  if (!withWeekday) return base
  const wd = '日一二三四五六'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${base}周${wd}`
}

// '2026-07-08' → '07-08' — the master board's compact cell date.
function mdCell(ymd?: string): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return ''
  return ymd.slice(5, 10)
}

// ISO timestamp → Shanghai-local 'MM-DD'.
function tsCell(iso?: string): string {
  if (!iso) return ''
  return new Date(iso)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
    .slice(5)
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

// The row's identity is its first part — vendors think in parts, never in
// our internal stage ranges (全程 / 手工→打磨 must never leak here).
function rowTitle(block: OutsourceBlock): string {
  const first = block.members[0]?.name?.trim()
  if (first) return first
  return block.activity?.trim().replace(/^外发/, '') || '外协件'
}

export default async function VendorPortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ p?: string }>
}) {
  const { token } = await params
  const { p: openId } = await searchParams
  const isDemo = token === DEMO_TOKEN
  const vendor = isDemo ? demoVendor() : await getVendorByPortalToken(token)
  if (!vendor) return <InvalidLink />

  let blocks: OutsourceBlock[]
  if (isDemo) {
    // Demo taps really answer — state lives in a cookie so the demo behaves
    // exactly like the live thing without touching a single row.
    const jar = await cookies()
    blocks = applyDemoCookie(demoBlocks(), jar.get(DEMO_COOKIE)?.value)
  } else {
    blocks = await getVendorPortalBlocks(vendor.id)
  }

  const open = blocks
    .filter((b) => !isBlockClosed(b))
    .sort((a, b) => a.expectedReturn.localeCompare(b.expectedReturn))
  const closed = blocks
    .filter((b) => isBlockClosed(b))
    .sort((a, b) => (blockClosedAt(b) ?? '').localeCompare(blockClosedAt(a) ?? ''))

  if (!isDemo) {
    try {
      await stampVendorBlocksSeen(
        vendor.id,
        open.map((b) => b.id),
      )
    } catch {
      /* pre-migration DB */
    }
  }

  const t = today()
  const thisMonth = t.slice(0, 7)
  const lastMonth = addDays(`${thisMonth}-01`, -1).slice(0, 7)
  const monthSum = (ym: string) => {
    const rows = blocks.filter((b) => (b.sentDate ?? '').startsWith(ym))
    return {
      count: rows.length,
      amount: rows.reduce((s, b) => s + (b.amountCny ?? 0), 0),
    }
  }
  const cur = monthSum(thisMonth)
  const prev = monthSum(lastMonth)
  const overdueCount = open.filter((b) => daysFromToday(b.expectedReturn) < 0).length

  return (
    <main className="mx-auto w-full max-w-[560px] px-3 pb-16 pt-6">
      <p className="px-1 text-[12px] tracking-[0.14em] text-[var(--color-ink-3)]">
        {BRAND.shortName} · 外协
      </p>
      <h1 className="mt-1 px-1 text-[26px] font-semibold tracking-tight">
        {vendor.name}
      </h1>
      <p className="mt-1 px-1 text-[13px] text-[var(--color-ink-2)]">
        在制 <b className="mono">{open.length}</b>
        {overdueCount > 0 ? (
          <span className="text-[var(--color-overdue)]">
            {' '}
            · 逾期 <b className="mono">{overdueCount}</b>
          </span>
        ) : null}
        {' · '}本月 <b className="mono">{formatCny(cur.amount)}</b>
      </p>

      {/* The ledger. */}
      <div className="mt-4 overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="grid grid-cols-[minmax(0,1fr)_58px_44px_54px_44px] items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5">
          <span className={hdr}>零件</span>
          <span className={`${hdr} text-center`}>交期</span>
          <span className={`${hdr} text-center`}>收</span>
          <span className={`${hdr} text-center`}>报期</span>
          <span className={`${hdr} text-center`}>发</span>
        </div>
        {open.length === 0 ? (
          <p className="py-10 text-center text-[14px] text-[var(--color-ink-3)]">
            当前没有在制的外协单
          </p>
        ) : (
          open.map((b) => (
            <Row key={b.id} block={b} token={token} expanded={openId === b.id} />
          ))
        )}
      </div>

      {/* 对账 — the vendor's own reason to keep this link. */}
      <section className="mt-8 px-1">
        <p className="text-[12px] tracking-[0.14em] text-[var(--color-ink-3)]">对账</p>
        <div className="mt-2 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="flex items-baseline justify-between border-b border-[var(--color-border)] px-4 py-3">
            <span className="text-[14px]">本月 ({Number(thisMonth.slice(5))}月)</span>
            <span className="text-[14px]">
              <span className="text-[var(--color-ink-3)]">{cur.count} 单 · </span>
              <b className="mono">{formatCny(cur.amount)}</b>
            </span>
          </div>
          <div className="flex items-baseline justify-between px-4 py-3">
            <span className="text-[14px]">上月 ({Number(lastMonth.slice(5))}月)</span>
            <span className="text-[14px]">
              <span className="text-[var(--color-ink-3)]">{prev.count} 单 · </span>
              <b className="mono">{formatCny(prev.amount)}</b>
            </span>
          </div>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
          金额为外协单登记价，以双方最终对账为准。
        </p>
      </section>

      {closed.length > 0 ? (
        <details className="mt-8 px-1">
          <summary className="cursor-pointer select-none text-[14px] text-[var(--color-ink-2)]">
            已完成 {closed.length} 单
          </summary>
          <div className="mt-2 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4">
            {closed.slice(0, 40).map((b) => (
              <div
                key={b.id}
                className="flex items-baseline justify-between gap-3 border-b border-[var(--color-border)] py-2.5 last:border-b-0"
              >
                <span className="min-w-0 truncate text-[13px]">
                  {rowTitle(b)}
                  {b.members.length > 1 ? (
                    <span className="text-[var(--color-ink-3)]"> 等{b.members.length}件</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-[13px] text-[var(--color-ink-3)]">
                  {b.amountCny != null ? `${formatCny(b.amountCny)} · ` : ''}
                  回厂 {mdCn(blockClosedAt(b))}
                </span>
              </div>
            ))}
            {closed.length > 40 ? (
              <p className="py-2.5 text-[12px] text-[var(--color-ink-3)]">
                更早的 {closed.length - 40} 单不再显示
              </p>
            ) : null}
          </div>
        </details>
      ) : null}

      <footer className="mt-12 border-t border-[var(--color-border)] px-1 pt-4">
        <p className="text-[12px] text-[var(--color-ink-3)]">{BRAND.softwareCredit}</p>
        <p className="mt-1 text-[12px] text-[var(--color-ink-3)]">
          自己的厂也想这样接单、跟单？访问 {BRAND.domain}
        </p>
      </footer>
    </main>
  )
}

const hdr =
  'text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-ink-3)]'

function InvalidLink() {
  return (
    <main className="mx-auto w-full max-w-[560px] px-4 pt-20 text-center">
      <p className="text-[16px] font-medium">链接无效</p>
      <p className="mt-2 text-[14px] text-[var(--color-ink-3)]">
        请联系发单人重新发送外协链接
      </p>
    </main>
  )
}

// One 单 = one ledger line + its three answer cells. Tap the 零件 cell to
// open the detail drawer (photos, 备注, chips, corrections).
function Row({
  block,
  token,
  expanded,
}: {
  block: OutsourceBlock
  token: string
  expanded: boolean
}) {
  const daysLeft = daysFromToday(block.expectedReturn)
  const overdue = daysLeft < 0
  const dueSoon = !overdue && daysLeft <= 2
  const acked = Boolean(block.vendorAckAt)
  const shipped = Boolean(block.vendorShippedAt)
  const promised = block.vendorPromisedDate
  const promisedLate = promised != null && promised > block.expectedReturn
  const totalQty = block.members.reduce((s, m) => s + m.qty, 0)
  const first = block.members[0]
  const rowHref = expanded
    ? `/w/${token}#b-${block.id}`
    : `/w/${token}?p=${block.id}#b-${block.id}`

  const dueTone = overdue
    ? 'text-[var(--color-overdue)]'
    : dueSoon
      ? 'text-[var(--color-warning)]'
      : 'text-[var(--color-ink)]'

  return (
    <div
      id={`b-${block.id}`}
      className={`scroll-mt-4 border-b border-[var(--color-border)] last:border-b-0 ${
        overdue ? 'border-l-[3px] border-l-[var(--color-overdue)]' : ''
      }`}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_58px_44px_54px_44px] items-center gap-1 px-2 py-2">
        {/* 零件 — identity + the way into the drawer. */}
        <a href={rowHref} className="flex min-w-0 items-center gap-2">
          {first?.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={portalImgSrc(first.imageUrl, token)}
              alt=""
              loading="lazy"
              className="h-10 w-10 shrink-0 rounded-[2px] border border-[var(--color-border)] object-cover"
            />
          ) : (
            <span className="h-10 w-10 shrink-0 rounded-[2px] border border-dashed border-[var(--color-border)]" />
          )}
          <span className="min-w-0">
            <span className="block truncate text-[14px] font-medium leading-tight">
              {rowTitle(block)}
              {block.members.length > 1 ? (
                <span className="font-normal text-[var(--color-ink-3)]">
                  {' '}
                  等{block.members.length}件
                </span>
              ) : null}
            </span>
            <span className="mono block text-[11px] text-[var(--color-ink-3)]">
              {totalQty > 0 ? `×${totalQty}` : ''}
              {block.amountCny != null ? `  ${formatCny(block.amountCny)}` : ''}
            </span>
          </span>
        </a>

        {/* 交期 — the factory's required date. */}
        <span className="text-center leading-tight">
          <span className={`mono block text-[14px] font-semibold ${dueTone}`}>
            {mdCell(block.expectedReturn)}
          </span>
          <span
            className={`block text-[10px] ${overdue ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink-3)]'}`}
          >
            {overdue ? `已过${-daysLeft}天` : daysLeft === 0 ? '今天' : `剩${daysLeft}天`}
          </span>
        </span>

        {/* 收 */}
        {acked ? (
          <DoneCell date={tsCell(block.vendorAckAt)} />
        ) : (
          <form action={portalAck} className="contents">
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="blockId" value={block.id} />
            <button type="submit" className={askCell}>
              收
            </button>
          </form>
        )}

        {/* 报期 */}
        {promised ? (
          <a
            href={rowHref}
            className={`flex min-h-[44px] flex-col items-center justify-center rounded-[2px] leading-tight ${
              promisedLate
                ? 'bg-[var(--color-warning-soft)] text-[var(--color-warning)]'
                : 'bg-[var(--color-success-soft)] text-[var(--color-success)]'
            }`}
          >
            <span className="mono text-[13px] font-semibold">{mdCell(promised)}</span>
            <span className="text-[10px]">{promisedLate ? '晚交' : '按期'}</span>
          </a>
        ) : (
          <a href={rowHref} className={acked && !shipped ? askCell : idleCell}>
            报期
          </a>
        )}

        {/* 发 */}
        {shipped ? (
          <DoneCell date={tsCell(block.vendorShippedAt)} />
        ) : acked ? (
          <form action={portalShipped} className="contents">
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="blockId" value={block.id} />
            <button type="submit" className={promised ? askCell : idleCell}>
              发
            </button>
          </form>
        ) : (
          <span className={`${idleCell} opacity-50`}>发</span>
        )}
      </div>

      {expanded ? (
        <div className="border-t border-dashed border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-3">
          {/* Full part list, with photos. */}
          <ul className="flex flex-col gap-1.5">
            {block.members.map((m) => (
              <li key={m.componentId} className="flex items-center gap-2.5">
                {m.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={portalImgSrc(m.imageUrl, token)}
                    alt=""
                    loading="lazy"
                    className="h-12 w-12 shrink-0 rounded-[2px] border border-[var(--color-border)] object-cover"
                  />
                ) : (
                  <span className="h-12 w-12 shrink-0 rounded-[2px] border border-dashed border-[var(--color-border)]" />
                )}
                <p className="min-w-0 flex-1 truncate text-[14px]">
                  {m.name} <span className="mono text-[var(--color-ink-2)]">×{m.qty}</span>
                  {m.material ? (
                    <span className="ml-2 text-[12px] text-[var(--color-ink-3)]">
                      {m.material}
                    </span>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
          {block.notes ? (
            <p className="mt-2 text-[13px] leading-snug text-[var(--color-ink-2)]">
              {block.notes}
            </p>
          ) : null}

          {/* 交期 chips — the row's main question, answered in one tap. */}
          {!shipped ? (
            <div className="mt-3">
              <p className="text-[13px] font-medium">
                {promised ? '改交期：' : overdue ? '几号能交？' : '交期没问题吧？'}
              </p>
              <PromiseChips block={block} token={token} />
            </div>
          ) : null}

          {/* Late promise → one-tap reason. */}
          {promised && promisedLate && !shipped ? (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <span className="text-[12px] text-[var(--color-ink-3)]">原因:</span>
              {['材料未到', '排队中', '图纸问题', '其他'].map((r) => (
                <form key={r} action={portalDelayReason} className="contents">
                  <input type="hidden" name="token" value={token} />
                  <input type="hidden" name="blockId" value={block.id} />
                  <input type="hidden" name="reason" value={r} />
                  <button
                    type="submit"
                    className={`min-h-[34px] rounded-[2px] border px-2.5 text-[13px] active:opacity-70 ${
                      block.vendorDelayReason === r
                        ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-surface)]'
                        : 'border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-ink-2)]'
                    }`}
                  >
                    {r}
                  </button>
                </form>
              ))}
            </div>
          ) : null}

          {/* Rare corrections + close. */}
          <div className="mt-3 flex items-center gap-4">
            {acked ? (
              <form action={portalAck} className="contents">
                <input type="hidden" name="token" value={token} />
                <input type="hidden" name="blockId" value={block.id} />
                <input type="hidden" name="on" value="0" />
                <button type="submit" className={undoLink}>
                  撤销收到
                </button>
              </form>
            ) : null}
            {shipped ? (
              <form action={portalShipped} className="contents">
                <input type="hidden" name="token" value={token} />
                <input type="hidden" name="blockId" value={block.id} />
                <input type="hidden" name="on" value="0" />
                <button type="submit" className={undoLink}>
                  撤销发货
                </button>
              </form>
            ) : null}
            <a href={`/w/${token}#b-${block.id}`} className="ml-auto text-[13px] text-[var(--color-ink-2)]">
              收起 ▴
            </a>
          </div>
        </div>
      ) : null}
    </div>
  )
}

const askCell =
  'flex min-h-[44px] w-full items-center justify-center rounded-[2px] bg-[var(--color-ink)] text-[14px] font-medium text-[var(--color-surface)] active:opacity-70'
const idleCell =
  'flex min-h-[44px] w-full items-center justify-center rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] text-[13px] text-[var(--color-ink-3)] active:opacity-70'
const undoLink =
  'text-[12px] text-[var(--color-ink-3)] underline underline-offset-4'

function DoneCell({ date }: { date: string }) {
  return (
    <span className="flex min-h-[44px] flex-col items-center justify-center rounded-[2px] bg-[var(--color-success-soft)] leading-tight text-[var(--color-success)]">
      <span className="text-[14px]">✓</span>
      {date ? <span className="mono text-[10px]">{date}</span> : null}
    </span>
  )
}

// Three one-tap dates + the system date wheel. Overdue asks from today.
function PromiseChips({ block, token }: { block: OutsourceBlock; token: string }) {
  const t = today()
  const overdue = block.expectedReturn < t
  const base = overdue ? t : block.expectedReturn
  const chips: Array<{ date: string; label: string }> = overdue
    ? [
        { date: base, label: `今天 ${mdCn(base)}` },
        { date: addDays(base, 1), label: `明天 ${mdCn(addDays(base, 1))}` },
        { date: addDays(base, 2), label: `后天 ${mdCn(addDays(base, 2))}` },
      ]
    : [
        { date: base, label: `按期 ${mdCn(base)}` },
        { date: addDays(base, 1), label: mdCn(addDays(base, 1)) },
        { date: addDays(base, 2), label: mdCn(addDays(base, 2)) },
      ]
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {chips.map((c) => (
        <form key={c.date} action={portalPromise} className="contents">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="blockId" value={block.id} />
          <input type="hidden" name="expected" value={block.expectedReturn} />
          <input type="hidden" name="date" value={c.date} />
          <button
            type="submit"
            className="min-h-[44px] flex-1 basis-[26%] whitespace-nowrap rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[14px] active:opacity-70"
          >
            {c.label}
          </button>
        </form>
      ))}
      <details className="min-w-0 flex-1 basis-[18%]">
        <summary className="flex min-h-[44px] cursor-pointer select-none list-none items-center justify-center whitespace-nowrap rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[14px]">
          选日期
        </summary>
        <DatePickForm
          token={token}
          blockId={block.id}
          expected={block.expectedReturn}
          defaultDate={overdue ? addDays(t, 1) : block.expectedReturn}
        />
      </details>
    </div>
  )
}

// Native date input on purpose: in a phone webview it opens the system wheel.
// Commit is the explicit 确定 button, never the input itself.
function DatePickForm({
  token,
  blockId,
  expected,
  defaultDate,
}: {
  token: string
  blockId: string
  expected: string
  defaultDate: string
}) {
  return (
    <form
      action={portalPromise}
      className="mt-2 flex items-center gap-2 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] p-2"
    >
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="blockId" value={blockId} />
      <input type="hidden" name="expected" value={expected} />
      <input
        type="date"
        name="date"
        defaultValue={defaultDate}
        required
        className="min-h-[40px] flex-1 rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[15px]"
      />
      <button
        type="submit"
        className="min-h-[40px] shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[14px] text-[var(--color-surface)] active:opacity-70"
      >
        确定
      </button>
    </form>
  )
}

// Demo cookie → block-state overlay. Format: {[blockId]: {a?,p?,r?,s?}}.
function applyDemoCookie(blocks: OutsourceBlock[], raw?: string): OutsourceBlock[] {
  if (!raw) return blocks
  let state: Record<string, { a?: string; p?: string; r?: string; s?: string }>
  try {
    state = JSON.parse(decodeURIComponent(raw))
  } catch {
    return blocks
  }
  return blocks.map((b) => {
    const s = state[b.id]
    if (!s) return b
    return {
      ...b,
      vendorAckAt: s.a ?? b.vendorAckAt,
      vendorPromisedDate: s.p ?? b.vendorPromisedDate,
      vendorDelayReason: s.r ?? b.vendorDelayReason,
      vendorShippedAt: s.s ?? b.vendorShippedAt,
      ...(s.a === '' ? { vendorAckAt: undefined } : {}),
      ...(s.p === '' ? { vendorPromisedDate: undefined, vendorDelayReason: undefined } : {}),
      ...(s.s === '' ? { vendorShippedAt: undefined } : {}),
    }
  })
}

// Member images live behind the session-gated /api/img proxy; the portal has
// no session, so it streams them through its own token-gated route instead.
function portalImgSrc(imageUrl: string, token: string): string {
  const proxied = proxiedStorageUrl(imageUrl)
  if (proxied.startsWith('/api/img/')) {
    return `/w/${token}/img/${proxied.slice('/api/img/'.length)}`
  }
  return proxied
}
