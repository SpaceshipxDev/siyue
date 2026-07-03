import type { Metadata } from 'next'
import {
  blockActivityLabel,
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
import {
  portalAck,
  portalDelayReason,
  portalPromise,
  portalShipped,
} from './_actions'
import { DEMO_TOKEN, demoBlocks, demoVendor } from './_demo'

// 外协厂商门户 — the vendor's side of the 外协 loop. One stable link per
// vendor, opened inside WeChat. No login, no install, no typing: everything
// the vendor is asked for is a single tap, and everything they get (part
// photos, quantities, dates, their money) is worth the open on its own.
//
// Design constraints this page lives by:
//   • Renders fully server-side — must work in decade-old WeChat webviews,
//     so all interactions are plain <form> POSTs to server actions.
//   • Big type, big targets, 中文 only. The reader is a 45–60 y.o. shop boss
//     on a phone, in a noisy workshop, with 10 seconds of patience.
//   • Shows nothing about the factory's end customers.

export const dynamic = 'force-dynamic'

// Title carries the vendor's own name so a WeChat 收藏/浮窗 of the link reads
// as "my board", not as generic software.
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

// '2026-07-08' → '7月8日'; with weekday: '7月8日周三'.
function mdCn(ymd?: string, withWeekday = false): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return ymd ?? ''
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  const base = `${m}月${d}日`
  if (!withWeekday) return base
  const wd = '日一二三四五六'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${base}周${wd}`
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
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

  const blocks = isDemo ? demoBlocks() : await getVendorPortalBlocks(vendor.id)
  const open = blocks
    .filter((b) => !isBlockClosed(b))
    .sort((a, b) => a.expectedReturn.localeCompare(b.expectedReturn))
  const closed = blocks
    .filter((b) => isBlockClosed(b))
    .sort((a, b) =>
      (blockClosedAt(b) ?? '').localeCompare(blockClosedAt(a) ?? ''),
    )

  // 已读 stamp — the 外协台 renders this as "已读 M-D". Best-effort: a
  // pre-migration DB just skips it.
  if (!isDemo) {
    try {
      await stampVendorBlocksSeen(
        vendor.id,
        open.map((b) => b.id),
      )
    } catch {
      /* column not there yet */
    }
  }

  const t = today()
  const thisMonth = t.slice(0, 7)
  const lastMonth = addDays(`${thisMonth}-01`, -1).slice(0, 7)
  const monthSum = (ym: string) => {
    const rows = blocks.filter((b) => (b.sentDate ?? '').startsWith(ym))
    const amount = rows.reduce((s, b) => s + (b.amountCny ?? 0), 0)
    return { count: rows.length, amount }
  }
  const cur = monthSum(thisMonth)
  const prev = monthSum(lastMonth)
  const overdueCount = open.filter(
    (b) => daysFromToday(b.expectedReturn) < 0,
  ).length

  return (
    <main className="mx-auto w-full max-w-[560px] px-4 pb-16 pt-6">
      {/* Identity: who is asking, who is being asked. */}
      <p className="text-[12px] tracking-[0.14em] text-[var(--color-ink-3)]">
        {BRAND.shortName} · 外协协作
      </p>
      <h1 className="mt-1 text-[26px] font-semibold tracking-tight">
        {vendor.name}
      </h1>
      <p className="mt-1.5 text-[14px] text-[var(--color-ink-2)]">
        在制 <b className="mono">{open.length}</b> 单
        {overdueCount > 0 ? (
          <>
            {' · '}
            <span className="text-[var(--color-overdue)]">
              逾期 <b className="mono">{overdueCount}</b> 单
            </span>
          </>
        ) : null}
        {' · '}本月 <b className="mono">{cur.count}</b> 单{' '}
        <b className="mono">{formatCny(cur.amount)}</b>
      </p>

      {/* Open blocks, most urgent first. */}
      <div className="mt-6 flex flex-col gap-4">
        {open.length === 0 ? (
          <div className="rounded-[2px] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] py-12 text-center text-[14px] text-[var(--color-ink-3)]">
            当前没有在制的外协单
          </div>
        ) : (
          open.map((b) => <BlockCard key={b.id} block={b} token={token} />)
        )}
      </div>

      {/* 对账 — the vendor's own reason to keep this link. */}
      <section className="mt-10">
        <p className="text-[12px] tracking-[0.14em] text-[var(--color-ink-3)]">
          对账
        </p>
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

      {/* History, collapsed — proof & dispute protection, not daily reading. */}
      {closed.length > 0 ? (
        <details className="mt-8">
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
                  {blockActivityLabel(b)}
                  <span className="text-[var(--color-ink-3)]">
                    {' '}
                    · {b.members.reduce((s, m) => s + m.qty, 0)}件
                  </span>
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

      <footer className="mt-12 border-t border-[var(--color-border)] pt-4">
        <p className="text-[12px] text-[var(--color-ink-3)]">
          {BRAND.softwareCredit}
        </p>
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

// One outsource block, one ledger row — Excel logic, not letter logic. Every
// card carries the SAME three cells: ① 收到 → ② 交期 → ③ 发货. Green cell =
// done, black cell = tap this next, grey cell = later. No status sentences,
// no undo links: tapping a green ①/③ cell un-fills it (fat-finger safe —
// tap again to re-fill), and the date cell re-opens via 改交期 below.
function BlockCard({ block, token }: { block: OutsourceBlock; token: string }) {
  const daysLeft = daysFromToday(block.expectedReturn)
  const overdue = daysLeft < 0
  const dueSoon = !overdue && daysLeft <= 2
  const totalQty = block.members.reduce((s, m) => s + m.qty, 0)
  const acked = Boolean(block.vendorAckAt)
  const shipped = Boolean(block.vendorShippedAt)
  const promised = block.vendorPromisedDate
  const promisedLate = promised != null && promised > block.expectedReturn
  // Which cell is "next"? 1 = 收到, 2 = 交期, 3 = 发货, 4 = all answered.
  const step = !acked ? 1 : shipped ? 4 : !promised ? 2 : 3

  const dueTone = overdue
    ? 'text-[var(--color-overdue)]'
    : dueSoon
      ? 'text-[var(--color-warning)]'
      : 'text-[var(--color-ink)]'

  // Part rows read like spreadsheet lines: 图 · 名称 ×数量 · 材料. Long
  // dispatches fold everything past the third row.
  const inlineMembers = block.members.slice(0, 3)
  const foldedMembers = block.members.slice(3)

  const memberLi = (m: OutsourceBlock['members'][number]) => (
    <li key={m.componentId} className="flex items-center gap-2.5">
      {m.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={portalImgSrc(m.imageUrl, token)}
          alt=""
          loading="lazy"
          className="h-11 w-11 shrink-0 rounded-[2px] border border-[var(--color-border)] object-cover"
        />
      ) : (
        <span className="h-11 w-11 shrink-0 rounded-[2px] border border-dashed border-[var(--color-border)]" />
      )}
      <p className="min-w-0 flex-1 truncate text-[15px] leading-tight">
        {m.name} <span className="mono text-[var(--color-ink-2)]">×{m.qty}</span>
        {m.material ? (
          <span className="ml-2 text-[12px] text-[var(--color-ink-3)]">
            {m.material}
          </span>
        ) : null}
      </p>
    </li>
  )

  return (
    <section
      id={`b-${block.id}`}
      className={`scroll-mt-4 overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] ${
        overdue ? 'border-l-[3px] border-l-[var(--color-overdue)]' : ''
      }`}
    >
      {/* 活 · 件数 · 钱 — one line, no document prose. */}
      <div className="flex items-baseline justify-between gap-3 px-4 pt-3">
        <span className="text-[13px] font-medium tracking-[0.06em] text-[var(--color-ink-2)]">
          {activityShort(block)} · {totalQty}件
        </span>
        <span className="mono shrink-0 text-[15px]">
          {block.amountCny != null ? formatCny(block.amountCny) : (
            <span className="text-[var(--color-ink-3)]">¥待定</span>
          )}
        </span>
      </div>

      <ul className="mt-2 flex flex-col gap-1.5 px-4">
        {inlineMembers.map(memberLi)}
      </ul>
      {foldedMembers.length > 0 ? (
        <details className="px-4">
          <summary className="cursor-pointer select-none py-1.5 text-[13px] text-[var(--color-ink-3)]">
            还有 {foldedMembers.length} 件 ▾
          </summary>
          <ul className="flex flex-col gap-1.5 pb-1">
            {foldedMembers.map(memberLi)}
          </ul>
        </details>
      ) : null}
      {block.notes ? (
        <p className="mt-1.5 px-4 text-[13px] leading-snug text-[var(--color-ink-2)]">
          {block.notes}
        </p>
      ) : null}

      {/* The date, spreadsheet-big. */}
      <p className={`mt-2.5 px-4 text-[20px] font-semibold tracking-tight ${dueTone}`}>
        {mdCn(block.expectedReturn, true)}交
        <span className="ml-2 text-[13px] font-medium">
          {overdue
            ? `已过 ${-daysLeft} 天`
            : daysLeft === 0
              ? '今天'
              : `剩 ${daysLeft} 天`}
        </span>
      </p>

      {/* The three cells. */}
      <div className="mt-2.5 px-2.5 pb-2.5">
        <div className="grid grid-cols-3 gap-1">
          <form action={portalAck} className="contents">
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="blockId" value={block.id} />
            <input type="hidden" name="on" value={acked ? '0' : '1'} />
            <button type="submit" className={cellCls(acked ? 'done' : 'now')}>
              {acked ? '✓ 已收到' : '① 收到'}
            </button>
          </form>

          <div
            className={cellCls(
              promised ? (promisedLate ? 'late' : 'done') : step === 2 ? 'now' : 'idle',
            )}
          >
            {promised
              ? `✓ ${mdCn(promised)}交`
              : step === 2
                ? '② 几号交?'
                : '② 交期'}
          </div>

          <form action={portalShipped} className="contents">
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="blockId" value={block.id} />
            <input type="hidden" name="on" value={shipped ? '0' : '1'} />
            <button
              type="submit"
              className={cellCls(shipped ? 'done' : step === 3 ? 'now' : 'idle')}
            >
              {shipped ? '✓ 已发出' : '③ 发货'}
            </button>
          </form>
        </div>

        {/* 交期 input — visible exactly when the black cell asks for it. */}
        {step === 2 ? <PromiseChips block={block} token={token} /> : null}

        {/* Late promise → one-tap reason. */}
        {promised && promisedLate && !shipped ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span className="px-1 text-[12px] text-[var(--color-ink-3)]">
              原因:
            </span>
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
                      : 'border-[var(--color-border-strong)] text-[var(--color-ink-2)]'
                  }`}
                >
                  {r}
                </button>
              </form>
            ))}
          </div>
        ) : null}

        {/* Rare correction path, kept tiny. */}
        {promised && !shipped ? (
          <details className="mt-1">
            <summary className="cursor-pointer select-none px-1 py-1 text-[12px] text-[var(--color-ink-3)] underline underline-offset-4">
              改交期
            </summary>
            <PromiseChips block={block} token={token} />
          </details>
        ) : null}
      </div>
    </section>
  )
}

type CellState = 'done' | 'late' | 'now' | 'idle'
function cellCls(state: CellState): string {
  const base =
    'flex min-h-[50px] w-full items-center justify-center rounded-[2px] px-1 text-[15px] font-medium active:opacity-70'
  const tones: Record<CellState, string> = {
    done: 'border border-[var(--color-success)]/25 bg-[var(--color-success-soft)] text-[var(--color-success)]',
    late: 'border border-[var(--color-warning)]/25 bg-[var(--color-warning-soft)] text-[var(--color-warning)]',
    now: 'bg-[var(--color-ink)] text-[var(--color-surface)]',
    idle: 'border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-ink-3)]',
  }
  return `${base} ${tones[state]}`
}

// 外发氧化 → 氧化: the verb the vendor thinks in, without our 外发 prefix.
function activityShort(block: OutsourceBlock): string {
  return blockActivityLabel(block).replace(/^外发/, '')
}

// The 交期 answer row: three one-tap dates + the system date wheel. Overdue
// asks from today (今天/明天/后天); on-track offers 按期 first.
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
            className="min-h-[44px] flex-1 basis-[22%] whitespace-nowrap rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[14px] active:opacity-70"
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

// Native date input on purpose: inside a phone webview it opens the system
// wheel — the one date control every vendor already knows. Commit is the
// explicit 确定 button, never the input itself.
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

// Member images live behind the session-gated /api/img proxy; the portal has
// no session, so it streams them through its own token-gated route instead.
function portalImgSrc(imageUrl: string, token: string): string {
  const proxied = proxiedStorageUrl(imageUrl)
  if (proxied.startsWith('/api/img/')) {
    return `/w/${token}/img/${proxied.slice('/api/img/'.length)}`
  }
  return proxied
}
