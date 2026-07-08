'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  blockActivityLabel,
  blockClosedAt,
  isBlockClosed,
  memberReturnedQty,
  type OutsourceBlock,
  type Vendor,
} from '@/lib/data'
import { BRAND } from '@/lib/brand'
import { showToast } from './_toast'
import { withBase } from '@/lib/base-path'
import { mutate } from '@/lib/mutate'

// The vendor thread, made visible. A 外协单 has a lifecycle exactly like a
// part has stages: 寄出 → 微信 → 已读 → 诺期 → 发货 → 收. BlockThreadStrip
// renders those six cells in the /x tick idiom — ✓ + date when done, faint ·
// when not — and the one step the factory keeps skipping (telling the vendor
// on WeChat) is an amber, TAPPABLE cell until it's done. Nobody needs to know
// the portal feature exists: the ledger shows an unfinished cell, and
// unfinished cells demand finishing.

function mdCn(ymd?: string): string {
  if (!ymd) return ''
  const p = ymd.split('-')
  if (p.length < 3) return ymd
  return `${Number(p[1])}月${Number(p[2])}日`
}

function mdShort(iso?: string): string {
  if (!iso) return ''
  const d = iso.slice(0, 10).split('-')
  if (d.length < 3) return iso
  return `${d[1]}-${d[2]}`
}

function portalUrl(token: string): string {
  return `${window.location.origin}${withBase(`/w/${token}`)}`
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // http / older webview fallback
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

// One message shape everywhere: what · how many · when due, then the standing
// portal link on its own line so WeChat auto-links it.
export function composeBlockMessage(args: {
  activityLabel: string
  totalQty: number
  expectedReturn?: string
  token: string
}): string {
  return [
    `【${BRAND.shortName} · 外协】${args.activityLabel} ${args.totalQty}件${args.expectedReturn ? ` · 要求${mdCn(args.expectedReturn)}交` : ''}`,
    `点开确认收货、回交期（免登录，链接固定可收藏）：`,
    portalUrl(args.token),
  ].join('\n')
}

// Copy + stamp, together always. The stamp is what turns the amber 微信 cell
// green everywhere, so any copy path that forgets it would leave the ledger
// lying — keep them fused in one helper.
async function copyAndStamp(args: {
  message: string
  blockId: string
  jobId?: string
}): Promise<boolean> {
  const ok = await copyText(args.message)
  showToast(ok ? '已复制，去微信粘贴给厂商' : '复制失败', ok ? 'success' : 'warning')
  if (ok) {
    try {
      await mutate({ kind: 'setBlockWechatSent', blockId: args.blockId, jobId: args.jobId })
    } catch {
      // stamp is best-effort; the copy itself already succeeded
    }
  }
  return ok
}

// ── The thread strip ──────────────────────────────────────────────────────

const CELL = 'w-11 shrink-0 text-center'
const CELL_LABEL =
  'block text-[9px] tracking-[0.12em] text-[var(--color-ink-4)]'
const CELL_DATE = 'block font-mono text-[9px] text-[var(--color-ink-3)]'

function StripCell({
  label,
  title,
  children,
  date,
}: {
  label: string
  title?: string
  children: React.ReactNode
  date?: string
}) {
  return (
    <span className={CELL} title={title}>
      <span className={CELL_LABEL}>{label}</span>
      <span className="block text-[13px] leading-[16px]">{children}</span>
      <span className={CELL_DATE}>{date ? mdShort(date) : ' '}</span>
    </span>
  )
}

const TICK = <span className="font-semibold text-[var(--color-success)]">✓</span>
const DOT = <span className="text-[var(--color-ink-4)]">·</span>

// blockId+jobId let the 微信 cell copy-and-stamp in place. Pass vendor with a
// portalToken or the 微信 cell degrades to a quiet dot.
export function BlockThreadStrip({
  block,
  vendor,
  jobId,
}: {
  block: OutsourceBlock
  vendor?: Vendor
  jobId?: string
}) {
  const router = useRouter()
  const [justSent, setJustSent] = useState(false)
  const token = vendor?.portalToken
  const closed = isBlockClosed(block)
  const closedAt = blockClosedAt(block)
  const qtySum = block.members.reduce((s, m) => s + m.qty, 0)
  const returnedSum = block.members.reduce((s, m) => s + memberReturnedQty(m), 0)
  const wechatDone = justSent || Boolean(block.wechatSentAt) || Boolean(block.vendorSeenAt)
  const promised = block.vendorPromisedDate
  const promiseLate = promised != null && promised > block.expectedReturn

  const sendWeChat = async () => {
    if (!token) return
    const ok = await copyAndStamp({
      message: composeBlockMessage({
        activityLabel: blockActivityLabel(block),
        totalQty: qtySum,
        expectedReturn: block.expectedReturn,
        token,
      }),
      blockId: block.id,
      jobId,
    })
    if (ok) {
      setJustSent(true)
      router.refresh()
    }
  }

  return (
    <span className="inline-flex items-start">
      <StripCell label="寄出" title={`寄出 ${block.sentDate}`} date={block.sentDate}>
        {TICK}
      </StripCell>

      {/* 微信 — the growth loop's weak link, so it's the loud cell. */}
      {wechatDone ? (
        <StripCell
          label="微信"
          title={block.wechatSentAt ? `微信已发 ${mdShort(block.wechatSentAt)} · 再点可重发` : '厂商已打开过链接'}
          date={block.wechatSentAt}
        >
          {token ? (
            <button
              type="button"
              onClick={sendWeChat}
              className="font-semibold text-[var(--color-success)]"
            >
              ✓
            </button>
          ) : (
            TICK
          )}
        </StripCell>
      ) : token ? (
        <span className={CELL} title="还没微信告诉厂商 — 点一下复制消息（含厂商专属链接）">
          <span className={CELL_LABEL}>微信</span>
          <button
            type="button"
            onClick={sendWeChat}
            className="mx-auto block rounded-[2px] border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-1 text-[10px] font-medium leading-[16px] text-[var(--color-warning)]"
          >
            待发
          </button>
          <span className={CELL_DATE}>{' '}</span>
        </span>
      ) : (
        <StripCell label="微信" title="厂商还没有专属链接">
          {DOT}
        </StripCell>
      )}

      <StripCell
        label="已读"
        title={block.vendorSeenAt ? `厂商已读 ${mdShort(block.vendorSeenAt)}` : '厂商还没点开链接'}
        date={block.vendorSeenAt}
      >
        {block.vendorSeenAt ? TICK : DOT}
      </StripCell>

      <StripCell
        label="诺期"
        title={
          promised
            ? promiseLate
              ? `厂商诺 ${mdCn(promised)} · 比要求晚${block.vendorDelayReason ? ` · ${block.vendorDelayReason}` : ''}`
              : `厂商诺 ${mdCn(promised)} · 按期`
            : '厂商还没回交期'
        }
      >
        {promised ? (
          <span
            className={`font-mono text-[10px] font-medium ${promiseLate ? 'text-[var(--color-warning)]' : 'text-[var(--color-success)]'}`}
          >
            {mdShort(promised)}
          </span>
        ) : (
          DOT
        )}
      </StripCell>

      <StripCell
        label="发货"
        title={block.vendorShippedAt ? `厂商已发货 ${mdShort(block.vendorShippedAt)}` : '厂商还没报发货'}
        date={block.vendorShippedAt}
      >
        {block.vendorShippedAt ? TICK : DOT}
      </StripCell>

      <StripCell
        label="收"
        title={
          closed
            ? `全部收回 ${closedAt ? mdShort(closedAt) : ''}`
            : returnedSum > 0
              ? `已收 ${returnedSum}/${qtySum}`
              : '还没收件'
        }
        date={closed ? closedAt : undefined}
      >
        {closed ? (
          TICK
        ) : returnedSum > 0 ? (
          <span className="font-mono text-[10px] text-[var(--color-ink-2)]">
            {returnedSum}/{qtySum}
          </span>
        ) : (
          DOT
        )}
      </StripCell>
    </span>
  )
}

// ── Post-送出 handoff panel ───────────────────────────────────────────────

// Shown the moment a 外协单 is created. The old dismissible banner made
// "tell the vendor" optional and invisible; this panel makes it THE next
// step. One big button; copying stamps wechat_sent_at and the amber cell
// downstream never appears.
export function SharePanel({
  vendorName,
  token,
  activityLabel,
  totalQty,
  expectedReturn,
  docNo,
  blockId,
  jobId,
  printHref,
  onClose,
}: {
  vendorName: string
  token?: string
  activityLabel: string
  totalQty: number
  expectedReturn?: string
  docNo?: string
  blockId: string
  jobId?: string
  printHref: string
  onClose: () => void
}) {
  const router = useRouter()
  const [copied, setCopied] = useState(false)
  const message = token
    ? composeBlockMessage({ activityLabel, totalQty, expectedReturn, token })
    : ''

  const doCopy = async () => {
    if (!token) return
    const ok = await copyAndStamp({ message, blockId, jobId })
    if (ok) {
      setCopied(true)
      router.refresh()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,19,15,0.32)] p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[440px] rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between">
          <span className="text-[12px] tracking-[0.14em] text-[var(--color-ink-3)]">
            外协单已生成
          </span>
          {docNo ? (
            <span className="font-mono text-[10px] text-[var(--color-ink-4)]">{docNo}</span>
          ) : null}
        </div>
        <h3 className="mt-1 text-[17px] font-semibold tracking-tight text-[var(--color-ink)]">
          下一步 · 微信告诉{vendorName}
        </h3>

        {token ? (
          <>
            <div className="mt-3 whitespace-pre-line rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[13px] leading-[1.6] text-[var(--color-ink-2)]">
              {message}
            </div>
            {copied ? (
              <button
                type="button"
                onClick={onClose}
                className="mt-3 flex min-h-[48px] w-full items-center justify-center rounded-[2px] border border-[var(--color-success)] bg-[var(--color-success-soft)] text-[15px] font-medium text-[var(--color-success)]"
              >
                ✓ 已复制 — 去微信粘贴给{vendorName}
              </button>
            ) : (
              <button
                type="button"
                onClick={doCopy}
                className="mt-3 flex min-h-[48px] w-full items-center justify-center rounded-[2px] bg-[var(--color-ink)] text-[15px] font-medium text-[var(--color-surface)] active:opacity-70"
              >
                复制微信消息 → 发给{vendorName}
              </button>
            )}
          </>
        ) : (
          <p className="mt-3 text-[13px] text-[var(--color-ink-2)]">
            厂商专属链接生成中 — 刷新后可在外协单行发微信。可先打印外协单。
          </p>
        )}

        <div className="mt-3 flex items-center justify-between text-[13px]">
          <a
            href={printHref}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--color-ink-2)] underline decoration-[var(--color-ink-4)] underline-offset-2 hover:text-[var(--color-ink)]"
          >
            打印外协单（含厂商二维码）
          </a>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            {copied ? '完成' : '暂不发'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Legacy/aggregate share buttons ────────────────────────────────────────

const shareBtnClass =
  'shrink-0 rounded-[2px] border border-[var(--color-border-strong)] px-2 py-[3px] text-[11px] tracking-wider text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] transition-colors'

// Per-block message button (kept for surfaces that don't render the strip).
export function BlockShareButton({
  vendor,
  block,
  jobId,
}: {
  vendor?: Vendor
  block: OutsourceBlock
  jobId?: string
}) {
  const token = vendor?.portalToken
  if (!token) return null
  const send = () => {
    const totalQty = block.members.reduce((s, m) => s + m.qty, 0)
    void copyAndStamp({
      message: composeBlockMessage({
        activityLabel: blockActivityLabel(block),
        totalQty,
        expectedReturn: block.expectedReturn,
        token,
      }),
      blockId: block.id,
      jobId,
    })
  }
  return (
    <button
      type="button"
      className={shareBtnClass}
      title="复制微信消息（含厂商专属链接）"
      onClick={send}
    >
      微信
    </button>
  )
}

// Per-vendor message — from the 外协台 group header: the standing "your
// board" message with the current open count and nearest due date. Copying
// stamps every open block of this vendor: the vendor-level message notifies
// about all of them at once.
export function VendorShareButton({
  vendor,
  openBlocks,
}: {
  vendor: Vendor
  openBlocks: OutsourceBlock[]
}) {
  const router = useRouter()
  const token = vendor.portalToken
  if (!token) return null
  const compose = () => {
    const nearest = openBlocks
      .map((b) => b.expectedReturn)
      .sort()[0]
    const head =
      openBlocks.length > 0
        ? `${vendor.name}您好，您现有 ${openBlocks.length} 单在制${nearest ? `，最近交期${mdCn(nearest)}` : ''}`
        : `${vendor.name}您好，这是您的外协对单链接`
    return [
      `【${BRAND.shortName} · 外协】${head}`,
      `点开确认收货、回交期、月底对账（免登录，链接固定可收藏）：`,
      portalUrl(token),
    ].join('\n')
  }
  const send = async () => {
    const ok = await copyText(compose())
    showToast(ok ? '已复制，去微信粘贴给厂商' : '复制失败', ok ? 'success' : 'warning')
    if (!ok) return
    const unsent = openBlocks.filter((b) => !b.wechatSentAt)
    await Promise.all(
      unsent.map((b) =>
        mutate({ kind: 'setBlockWechatSent', blockId: b.id }).catch(() => undefined),
      ),
    )
    if (unsent.length > 0) router.refresh()
  }
  return (
    <button
      type="button"
      className={shareBtnClass}
      title="复制微信消息（含厂商专属链接）"
      onClick={send}
    >
      复制微信消息
    </button>
  )
}

// Vendor-reported state, one chip, most-advanced-wins:
// 已发货 > 承诺交期 > 已确认收货 > 已读. Rendered on surfaces too narrow for
// the full strip.
export function VendorStateChip({ block }: { block: OutsourceBlock }) {
  if (block.vendorShippedAt) {
    return (
      <span className="text-[12px] font-medium text-[var(--color-success)]">
        厂商已发货 · 待收件
      </span>
    )
  }
  if (block.vendorPromisedDate) {
    const late = block.vendorPromisedDate > block.expectedReturn
    if (late) {
      return (
        <span className="text-[12px] font-medium text-[var(--color-warning)]">
          厂商诺 {mdCn(block.vendorPromisedDate)}
          {block.vendorDelayReason ? ` · ${block.vendorDelayReason}` : ''}
        </span>
      )
    }
    return (
      <span className="text-[12px] text-[var(--color-success)]">
        厂商诺按期
      </span>
    )
  }
  if (block.vendorAckAt) {
    return (
      <span className="text-[12px] text-[var(--color-ink-2)]">厂商已确认收货</span>
    )
  }
  if (block.vendorSeenAt) {
    return <span className="text-[12px] text-[var(--color-ink-3)]">厂商已读</span>
  }
  return null
}
