import { Fragment } from 'react'
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
import { withBase } from '@/lib/base-path'
import { portalDelayReason, portalPromise, portalShipped } from './_actions'
import { DEMO_COOKIE, DEMO_TOKEN, demoBlocks, demoVendor } from './_demo'

// 外协厂商门户 — the vendor's OWN ledger, one row per 单. Opening the link
// shows every concurrent 单 as one calm line: "these are my jobs for the
// factory." Nothing auto-expands, nothing shouts. The ONLY color on the
// resting page is a red date on rows whose date has passed.
//
// Tap a row → a visibly nested panel (washed background) with the 零件 list
// (clearly subordinate to the 单) and exactly one act: a date field + one
// confirm button. No 今天/明天/晚1天 chips — the vendor just sets the date.
//
// Server-rendered, plain <form> POSTs and plain links — no JS required, so
// it works in any WeChat webview. The vendor's own payoff lives at the
// bottom: 已完成 history + 对账 totals.

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>
}): Promise<Metadata> {
  const { token } = await params
  const vendor =
    token === DEMO_TOKEN ? demoVendor() : await getVendorByPortalToken(token)
  const title = vendor ? `${vendor.name} · 外协单` : '外协单 · 思跃'
  return {
    title,
    description: '外协协作 — 回交期 · 报发货 · 对账',
    openGraph: {
      title: vendor ? `${vendor.name} · 外协单` : '外协单',
      description: '回交期 · 报发货 · 对账 — 免登录',
    },
  }
}

// '2026-07-08' → '7月8日' (+周三 with weekday).
function mdCn(ymd?: string, withWeekday = false): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return ymd ?? ''
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  const base = `${m}月${d}日`
  if (!withWeekday) return base
  const wd = '日一二三四五六'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${base} 周${wd}`
}

// ISO timestamp → Shanghai-local '7月2日'.
function tsCn(iso?: string): string {
  if (!iso) return ''
  return mdCn(new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }))
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

// A 单's identity is its first part — vendors think in parts, never in our
// internal stage ranges (全程 / 手工→打磨 must never leak here).
function rowTitle(block: OutsourceBlock): string {
  const first = block.members[0]?.name?.trim()
  if (first) return first
  return block.activity?.trim().replace(/^外发/, '') || '外协件'
}

function activityCn(block: OutsourceBlock): string {
  return block.activity?.trim().replace(/^外发/, '') ?? ''
}

// needAnswer → still waiting on a 交期; promised → date given, not shipped;
// shipped → on its way back. Drives the row's state cell + expanded guts.
type RowKind = 'needAnswer' | 'promised' | 'shipped'
function rowKind(block: OutsourceBlock): RowKind {
  if (block.vendorShippedAt) return 'shipped'
  if (block.vendorPromisedDate) return 'promised'
  return 'needAnswer'
}

export default async function VendorPortalPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
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

  const open = blocks.filter((b) => !isBlockClosed(b))
  const closed = blocks
    .filter((b) => isBlockClosed(b))
    .sort((a, b) => (blockClosedAt(b) ?? '').localeCompare(blockClosedAt(a) ?? ''))

  // The three piles, in the order the vendor should deal with them.
  const shipped = open
    .filter((b) => b.vendorShippedAt)
    .sort((a, b) => (b.vendorShippedAt ?? '').localeCompare(a.vendorShippedAt ?? ''))
  const promised = open
    .filter((b) => !b.vendorShippedAt && b.vendorPromisedDate)
    .sort((a, b) => (a.vendorPromisedDate ?? '').localeCompare(b.vendorPromisedDate ?? ''))
  const needAnswer = open
    .filter((b) => !b.vendorShippedAt && !b.vendorPromisedDate)
    .sort((a, b) => a.expectedReturn.localeCompare(b.expectedReturn))

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

  // One ledger, ordered: 请回交期 → 生产中 → 已发货. Each cluster gets a slim
  // in-ledger separator. Every row is born collapsed — the vendor clicks
  // into a 单 to act on it.
  const clusters: Array<{ label: string; rows: OutsourceBlock[] }> = []
  if (needAnswer.length > 0)
    clusters.push({ label: `请回交期 · ${needAnswer.length}`, rows: needAnswer })
  if (promised.length > 0)
    clusters.push({ label: `生产中 · ${promised.length}`, rows: promised })
  if (shipped.length > 0)
    clusters.push({ label: '已发货 · 等厂里收件', rows: shipped })

  return (
    <main className="mx-auto w-full max-w-[560px] px-3 pb-16 pt-5">
      <div className="flex items-baseline justify-between px-1">
        <p className="text-[12px] tracking-[0.14em] text-[var(--color-ink-3)]">
          {BRAND.shortName} · 外协
        </p>
        <p className="text-[12px] text-[var(--color-ink-3)]">今天 {mdCn(t, true)}</p>
      </div>
      <h1 className="mt-1 px-1 text-[26px] font-semibold tracking-tight">
        {vendor.name}
      </h1>
      <p className="mt-1 px-1 text-[14px] text-[var(--color-ink-2)]">
        在制 <b className="mono">{open.length}</b> 单
        {needAnswer.length > 0 ? (
          <span>
            {' '}
            · <b className="mono">{needAnswer.length}</b> 单待回交期
          </span>
        ) : open.length > 0 ? (
          <span> · 交期都已回 ✓</span>
        ) : null}
      </p>

      {open.length === 0 ? (
        <div className="mt-5 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] py-10 text-center">
          <p className="text-[15px] text-[var(--color-ink-2)]">当前没有在制的外协单</p>
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
          {clusters.map((cl) => (
            <Fragment key={cl.label}>
              <p className="border-b border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[11px] font-medium tracking-[0.12em] text-[var(--color-ink-3)]">
                {cl.label}
              </p>
              {cl.rows.map((b) => (
                <LedgerRow key={b.id} block={b} token={token} />
              ))}
            </Fragment>
          ))}
        </div>
      )}

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

// ===== One ledger row — same cells every row, color = state. =====

function LedgerRow({ block, token }: { block: OutsourceBlock; token: string }) {
  const kind = rowKind(block)

  const totalQty = block.members.reduce((s, m) => s + m.qty, 0)
  const subParts = [
    activityCn(block),
    `${totalQty}件`,
    block.amountCny != null ? formatCny(block.amountCny) : '',
  ].filter(Boolean)

  return (
    <details
      id={`b-${block.id}`}
      className="scroll-mt-4 border-b border-[var(--color-border)] last:border-b-0"
    >
      <summary className="flex min-h-[56px] cursor-pointer list-none items-center gap-3 px-3 py-2 active:opacity-60 [&::-webkit-details-marker]:hidden">
        <PartImg src={block.members[0]?.imageUrl} token={token} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium leading-tight">
            {rowTitle(block)}
            {block.members.length > 1 ? (
              <span className="font-normal text-[var(--color-ink-3)]">
                {' '}
                等{block.members.length}件
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 truncate text-[12px] text-[var(--color-ink-3)]">
            {subParts.join(' · ')}
          </p>
        </div>
        <StateCell block={block} kind={kind} />
      </summary>

      {/* Expanded = the 单's own panel. The bg wash nests it visibly under
          its row so it never blends into the neighbouring jobs. */}
      <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)]">
        {kind === 'needAnswer' ? (
          <NeedAnswerGuts block={block} token={token} />
        ) : kind === 'promised' ? (
          <PromisedGuts block={block} token={token} />
        ) : (
          <ShippedGuts block={block} token={token} />
        )}
      </div>
    </details>
  )
}

// The one glanceable cell on the right: just the date. Red = that date has
// passed and needs the vendor's attention. No prose, no second line.
function StateCell({ block, kind }: { block: OutsourceBlock; kind: RowKind }) {
  const t = today()

  if (kind === 'shipped') {
    return (
      <p className="shrink-0 text-[13px] text-[var(--color-success)]">✓ 已发货</p>
    )
  }

  if (kind === 'promised') {
    const p = block.vendorPromisedDate!
    const promiseOver = p < t
    return (
      <p
        className={`shrink-0 text-[13px] ${
          promiseOver
            ? 'font-medium text-[var(--color-overdue)]'
            : 'text-[var(--color-ink-2)]'
        }`}
      >
        诺 {mdCn(p)}
      </p>
    )
  }

  // needAnswer — the required date, red once it's behind us.
  const overdue = block.expectedReturn < t
  return (
    <p
      className={`shrink-0 text-[13px] ${
        overdue
          ? 'font-medium text-[var(--color-overdue)]'
          : 'text-[var(--color-ink-2)]'
      }`}
    >
      交 {mdCn(block.expectedReturn)}
    </p>
  )
}

// ===== Expanded row bodies — the goods + exactly the action left. =====

// The 单's contents, clearly SUBORDINATE to the row: a labeled, inset white
// box with smaller part lines. The job is the row; these are its parts —
// the hierarchy must be readable at a glance.
function Members({ block, token }: { block: OutsourceBlock; token: string }) {
  const act = activityCn(block)
  const shown = block.members.slice(0, 8)
  const more = block.members.length - shown.length
  return (
    <div className="px-3.5 pt-3">
      {block.members.length > 0 ? (
        <>
      <p className="text-[11px] tracking-[0.12em] text-[var(--color-ink-3)]">
        零件 · {block.members.length}件
      </p>
      <div className="mt-1.5 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5">
        {shown.map((m) => (
          <div
            key={m.componentId}
            className="flex min-w-0 items-center gap-2 border-b border-[var(--color-border)] py-1.5 last:border-b-0"
          >
            <PartImgSm src={m.imageUrl} token={token} />
            <p className="min-w-0 flex-1 truncate text-[13px] leading-tight">
              {m.name}
              {m.material ? (
                <span className="ml-1.5 text-[11px] text-[var(--color-ink-3)]">
                  {m.material}
                </span>
              ) : null}
            </p>
            <span className="mono shrink-0 text-[12px] text-[var(--color-ink-2)]">
              ×{m.qty}
            </span>
          </div>
        ))}
        {more > 0 ? (
          <p className="py-1.5 text-[12px] text-[var(--color-ink-3)]">还有 {more} 件…</p>
        ) : null}
      </div>
        </>
      ) : null}
      <p className="mt-2 text-[12px] text-[var(--color-ink-3)]">
        {act ? `${act} · ` : ''}
        {mdCn(block.sentDate)}寄出
        {block.amountCny != null ? ` · ${formatCny(block.amountCny)}` : ''}
        {block.docNo ? ` · ${block.docNo}` : ''}
      </p>
      {block.notes ? (
        <p className="mt-1 text-[13px] leading-snug text-[var(--color-ink-2)]">
          “{block.notes}”
        </p>
      ) : null}
    </div>
  )
}

function PartImg({ src, token }: { src?: string; token: string }) {
  if (!src)
    return (
      <span className="h-9 w-9 shrink-0 rounded-[2px] border border-dashed border-[var(--color-border)]" />
    )
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={portalImgSrc(src, token)}
      alt=""
      loading="lazy"
      className="h-9 w-9 shrink-0 rounded-[2px] border border-[var(--color-border)] object-cover"
    />
  )
}

// Smaller thumb for the nested 零件 list — parts render lighter than the 单.
function PartImgSm({ src, token }: { src?: string; token: string }) {
  if (!src)
    return (
      <span className="h-7 w-7 shrink-0 rounded-[2px] border border-dashed border-[var(--color-border)]" />
    )
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={portalImgSrc(src, token)}
      alt=""
      loading="lazy"
      className="h-7 w-7 shrink-0 rounded-[2px] border border-[var(--color-border)] object-cover"
    />
  )
}

// ① needAnswer — one act: set the date you can deliver, confirm. No relative
// chips, no second control. The required date sits above as plain fact.
function NeedAnswerGuts({ block, token }: { block: OutsourceBlock; token: string }) {
  const t = today()
  const overdue = block.expectedReturn < t
  const lateDays = overdue ? -daysFromToday(block.expectedReturn) : 0

  return (
    <>
      <Members block={block} token={token} />
      <div className="p-3.5">
        <p className="text-[13px] text-[var(--color-ink-2)]">
          要求 {mdCn(block.expectedReturn, true)} 交
          {overdue ? (
            <span className="text-[var(--color-overdue)]"> · 已超 {lateDays} 天</span>
          ) : null}
        </p>
        <p className="mt-1.5 text-[15px] font-semibold">几号能交？</p>
        <DatePickForm
          token={token}
          blockId={block.id}
          expected={block.expectedReturn}
          defaultDate={overdue ? t : block.expectedReturn}
        />
        <form action={portalShipped} className="mt-3 text-center">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="blockId" value={block.id} />
          <button
            type="submit"
            className="text-[13px] text-[var(--color-ink-3)] underline underline-offset-4"
          >
            货已经发出了？点此报发货
          </button>
        </form>
      </div>
    </>
  )
}

// ② promised — one big button left: 货已发出. The promised date shows as a
// date field so changing it is the same gesture as setting it was.
function PromisedGuts({ block, token }: { block: OutsourceBlock; token: string }) {
  const t = today()
  const p = block.vendorPromisedDate!
  const late = p > block.expectedReturn
  const promiseOver = p < t
  const promiseOverDays = promiseOver ? -daysFromToday(p) : 0

  return (
    <>
      <Members block={block} token={token} />
      <div className="p-3.5">
        <p className="text-[13px] text-[var(--color-ink-2)]">
          要求 {mdCn(block.expectedReturn)} 交 · 已答 {mdCn(p, true)} 交
          {promiseOver ? (
            <span className="text-[var(--color-overdue)]"> · 已过 {promiseOverDays} 天</span>
          ) : null}
        </p>

        {late && !block.vendorShippedAt ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] text-[var(--color-ink-3)]">晚交原因？</span>
            {['材料未到', '排队中', '图纸问题', '其他'].map((r) => (
              <form key={r} action={portalDelayReason} className="contents">
                <input type="hidden" name="token" value={token} />
                <input type="hidden" name="blockId" value={block.id} />
                <input type="hidden" name="reason" value={r} />
                <button
                  type="submit"
                  className={`min-h-[36px] rounded-[2px] border px-3 text-[13px] active:opacity-60 ${
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

        <form action={portalShipped} className="mt-3">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="blockId" value={block.id} />
          <button
            type="submit"
            className="flex min-h-[48px] w-full items-center justify-center rounded-[2px] bg-[var(--color-ink)] text-[16px] font-medium text-[var(--color-surface)] active:opacity-70"
          >
            货已发出 ✓
          </button>
        </form>

        <p className="mt-3 text-[12px] text-[var(--color-ink-3)]">改交期</p>
        <DatePickForm
          token={token}
          blockId={block.id}
          expected={block.expectedReturn}
          defaultDate={p}
        />
      </div>
    </>
  )
}

// ③ shipped — a receipt until the factory checks it in. 撤销 undoes a tap.
function ShippedGuts({ block, token }: { block: OutsourceBlock; token: string }) {
  return (
    <>
      <Members block={block} token={token} />
      <div className="flex items-center justify-between p-3.5">
        <p className="text-[13px] text-[var(--color-ink-2)]">
          已发货 {tsCn(block.vendorShippedAt)} · 等厂里收件
        </p>
        <form action={portalShipped} className="shrink-0">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="blockId" value={block.id} />
          <input type="hidden" name="on" value="0" />
          <button
            type="submit"
            className="min-h-[40px] px-2 text-[13px] text-[var(--color-ink-3)] underline underline-offset-4 active:opacity-60"
          >
            撤销
          </button>
        </form>
      </div>
    </>
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
    <form action={portalPromise} className="mt-2 flex items-center gap-2">
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
        这天能交 ✓
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
  // proxiedStorageUrl now returns a basePath-prefixed /api/img path
  // (withBase). Compare against the same prefixed form so we still
  // recognise proxied images and re-route them through the token-gated
  // portal proxy, itself under basePath.
  const proxied = proxiedStorageUrl(imageUrl)
  const apiImg = withBase('/api/img/')
  if (proxied.startsWith(apiImg)) {
    return withBase(`/w/${token}/img/${proxied.slice(apiImg.length)}`)
  }
  return proxied
}
