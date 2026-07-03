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
import { portalDelayReason, portalPromise, portalShipped } from './_actions'
import { DEMO_COOKIE, DEMO_TOKEN, demoBlocks, demoVendor } from './_demo'

// 外协厂商门户 — a stack of cards, one per 单, each asking exactly ONE
// question:
//
//   没回交期的 →  "能按期吗？/ 几号能交？"  + 三个日期一按就答
//   回了交期的 →  一个大按钮「货已发出」
//   已发货的   →  一行收据，等厂里收件
//
// Answer them top to bottom and the page goes quiet — that's the whole app.
// Server-rendered, plain <form> POSTs and plain links — no JS required, so it
// works in any WeChat webview. The vendor's own payoff lives at the bottom:
// 已完成 history + 对账 totals.

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
    description: '外协协作 — 回交期 · 报发货 · 对账',
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
          <span className="font-medium text-[var(--color-overdue)]">
            {' '}
            · <b className="mono">{needAnswer.length}</b> 单等你回交期 ↓
          </span>
        ) : open.length > 0 ? (
          <span className="text-[var(--color-success)]"> · 交期都已回 ✓</span>
        ) : null}
      </p>

      {open.length === 0 ? (
        <div className="mt-5 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] py-10 text-center">
          <p className="text-[15px] text-[var(--color-ink-2)]">当前没有在制的外协单</p>
        </div>
      ) : null}

      {/* ① 回交期 — one tap answers the only question that matters. */}
      {needAnswer.length > 0 ? (
        <section className="mt-6">
          <SectionLabel>请回交期 · {needAnswer.length} 单</SectionLabel>
          <div className="mt-2 flex flex-col gap-3">
            {needAnswer.map((b) => (
              <QuestionCard key={b.id} block={b} token={token} />
            ))}
          </div>
        </section>
      ) : null}

      {/* ② 生产中 — promised; the one button left is 货已发出. */}
      {promised.length > 0 ? (
        <section className="mt-7">
          <SectionLabel>生产中 · {promised.length} 单</SectionLabel>
          <div className="mt-2 flex flex-col gap-3">
            {promised.map((b) => (
              <PromisedCard key={b.id} block={b} token={token} />
            ))}
          </div>
        </section>
      ) : null}

      {/* ③ 已发货 — receipts until the factory checks them in. */}
      {shipped.length > 0 ? (
        <section className="mt-7">
          <SectionLabel>已发货 · 等厂里收件</SectionLabel>
          <div className="mt-2 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
            {shipped.map((b) => (
              <ShippedLine key={b.id} block={b} token={token} />
            ))}
          </div>
        </section>
      ) : null}

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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-1 text-[12px] font-medium tracking-[0.14em] text-[var(--color-ink-3)]">
      {children}
    </p>
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

// ===== Shared card top: the goods, exactly as packed. =====

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

function CardTop({ block, token }: { block: OutsourceBlock; token: string }) {
  const act = activityCn(block)
  const shown = block.members.slice(0, 5)
  const more = block.members.length - shown.length
  return (
    <div className="p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {shown.map((m) => (
            <div key={m.componentId} className="flex min-w-0 items-center gap-2.5">
              <PartImg src={m.imageUrl} token={token} />
              <p className="min-w-0 truncate text-[15px] font-medium leading-tight">
                {m.name} <span className="mono font-normal text-[var(--color-ink-2)]">×{m.qty}</span>
                {m.material ? (
                  <span className="ml-1.5 text-[12px] font-normal text-[var(--color-ink-3)]">
                    {m.material}
                  </span>
                ) : null}
              </p>
            </div>
          ))}
          {more > 0 ? (
            <p className="pl-[46px] text-[12px] text-[var(--color-ink-3)]">
              还有 {more} 件…
            </p>
          ) : null}
        </div>
        {block.docNo ? (
          <span className="mono shrink-0 text-[10px] text-[var(--color-ink-4)]">
            {block.docNo}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-[12px] text-[var(--color-ink-3)]">
        {act ? `${act} · ` : ''}
        {mdCn(block.sentDate)}寄出
        {block.amountCny != null ? ` · ${formatCny(block.amountCny)}` : ''}
      </p>
      {block.notes ? (
        <p className="mt-1 text-[13px] leading-snug text-[var(--color-ink-2)]">
          “{block.notes}”
        </p>
      ) : null}
    </div>
  )
}

// ===== ① The question card — 几号能交？ =====

const chipClass =
  'flex min-h-[52px] flex-col items-center justify-center rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] leading-tight active:opacity-60'

function QuestionCard({ block, token }: { block: OutsourceBlock; token: string }) {
  const t = today()
  const overdue = block.expectedReturn < t
  const lateDays = overdue ? -daysFromToday(block.expectedReturn) : 0
  const base = overdue ? t : block.expectedReturn
  const chips: Array<{ date: string; label: string }> = overdue
    ? [
        { date: base, label: '今天' },
        { date: addDays(base, 1), label: '明天' },
        { date: addDays(base, 2), label: '后天' },
      ]
    : [
        { date: base, label: '✓ 按期' },
        { date: addDays(base, 1), label: '晚1天' },
        { date: addDays(base, 2), label: '晚2天' },
      ]

  return (
    <div
      id={`b-${block.id}`}
      className={`scroll-mt-4 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] ${
        overdue ? 'border-l-[3px] border-l-[var(--color-overdue)]' : ''
      }`}
    >
      <CardTop block={block} token={token} />
      <div className="border-t border-[var(--color-border)] p-3.5">
        {overdue ? (
          <>
            <p className="text-[14px] font-medium text-[var(--color-overdue)]">
              原定 {mdCn(block.expectedReturn)} 交 · 已超 {lateDays} 天
            </p>
            <p className="mt-0.5 text-[17px] font-semibold">几号能交？</p>
          </>
        ) : (
          <p className="text-[15px]">
            要求 <b className="font-semibold">{mdCn(block.expectedReturn, true)}</b> 交 —{' '}
            <span className="font-semibold">来得及吗？</span>
          </p>
        )}
        <div className="mt-2.5 grid grid-cols-3 gap-1.5">
          {chips.map((c) => (
            <form key={c.date} action={portalPromise} className="contents">
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="blockId" value={block.id} />
              <input type="hidden" name="expected" value={block.expectedReturn} />
              <input type="hidden" name="date" value={c.date} />
              <button type="submit" className={chipClass}>
                <span className="text-[15px] font-medium">{c.label}</span>
                <span className="mono mt-0.5 text-[11px] text-[var(--color-ink-3)]">
                  {mdCn(c.date)}
                </span>
              </button>
            </form>
          ))}
        </div>
        <details className="mt-1.5">
          <summary className="flex min-h-[40px] cursor-pointer select-none list-none items-center justify-center rounded-[2px] border border-[var(--color-border)] text-[14px] text-[var(--color-ink-2)] active:opacity-60">
            其他日期 ▾
          </summary>
          <DatePickForm
            token={token}
            blockId={block.id}
            expected={block.expectedReturn}
            defaultDate={overdue ? addDays(t, 1) : block.expectedReturn}
          />
        </details>
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
    </div>
  )
}

// ===== ② Promised — one big button left: 货已发出. =====

function PromisedCard({ block, token }: { block: OutsourceBlock; token: string }) {
  const t = today()
  const p = block.vendorPromisedDate!
  const late = p > block.expectedReturn
  const lateDays = late
    ? Math.round(
        (Date.UTC(...(p.split('-').map(Number) as [number, number, number])) -
          Date.UTC(
            ...(block.expectedReturn.split('-').map(Number) as [number, number, number]),
          )) /
          86400000,
      )
    : 0
  const promiseOver = p < t
  const promiseOverDays = promiseOver ? -daysFromToday(p) : 0

  return (
    <div
      id={`b-${block.id}`}
      className={`scroll-mt-4 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] ${
        promiseOver ? 'border-l-[3px] border-l-[var(--color-overdue)]' : ''
      }`}
    >
      <CardTop block={block} token={token} />
      <div className="border-t border-[var(--color-border)] p-3.5">
        <p className="text-[14px]">
          {late ? (
            <span className="font-medium text-[var(--color-warning)]">
              已答 {mdCn(p, true)} 交 · 比要求晚{lateDays}天
            </span>
          ) : (
            <span className="font-medium text-[var(--color-success)]">
              已答 {mdCn(p, true)} 交 · 按期 ✓
            </span>
          )}
          {promiseOver ? (
            <span className="ml-2 font-semibold text-[var(--color-overdue)]">
              已过 {promiseOverDays} 天！
            </span>
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

        <details className="mt-2">
          <summary className="w-fit cursor-pointer select-none list-none text-[13px] text-[var(--color-ink-3)] underline underline-offset-4">
            改交期
          </summary>
          <DatePickForm
            token={token}
            blockId={block.id}
            expected={block.expectedReturn}
            defaultDate={p}
          />
        </details>
      </div>
    </div>
  )
}

// ===== ③ Shipped — a receipt line until the factory checks it in. =====

function ShippedLine({ block, token }: { block: OutsourceBlock; token: string }) {
  return (
    <div
      id={`b-${block.id}`}
      className="flex scroll-mt-4 items-center gap-2.5 border-b border-[var(--color-border)] px-3.5 py-3 last:border-b-0"
    >
      <span className="text-[15px] text-[var(--color-success)]">✓</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-medium">
          {rowTitle(block)}
          {block.members.length > 1 ? (
            <span className="font-normal text-[var(--color-ink-3)]">
              {' '}
              等{block.members.length}件
            </span>
          ) : null}
        </p>
        <p className="text-[12px] text-[var(--color-ink-3)]">
          已发货 {tsCn(block.vendorShippedAt)} · 等厂里收件
        </p>
      </div>
      <form action={portalShipped} className="shrink-0">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="blockId" value={block.id} />
        <input type="hidden" name="on" value="0" />
        <button
          type="submit"
          className="text-[12px] text-[var(--color-ink-3)] underline underline-offset-4"
        >
          撤销
        </button>
      </form>
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
  const proxied = proxiedStorageUrl(imageUrl)
  if (proxied.startsWith('/api/img/')) {
    return `/w/${token}/img/${proxied.slice('/api/img/'.length)}`
  }
  return proxied
}
