'use client'

import { blockActivityLabel, type OutsourceBlock, type Vendor } from '@/lib/data'
import { BRAND } from '@/lib/brand'
import { showToast } from './_toast'

// 复制微信消息 — the whole growth loop hangs on this one button. The 外协员
// already sends the vendor a WeChat message per dispatch; this composes that
// exact message WITH the vendor's portal link, so "notify the vendor" and
// "onboard the vendor" become the same single paste. The link is stable per
// vendor — every message re-delivers it, so the vendor never has to find an
// old message to reach their board.

function mdCn(ymd?: string): string {
  if (!ymd) return ''
  const p = ymd.split('-')
  if (p.length < 3) return ymd
  return `${Number(p[1])}月${Number(p[2])}日`
}

function portalUrl(token: string): string {
  return `${window.location.origin}/w/${token}`
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

async function copyAndToast(text: string) {
  const ok = await copyText(text)
  showToast(ok ? '已复制，去微信粘贴给厂商' : '复制失败', ok ? 'success' : 'warning')
}

const shareBtnClass =
  'shrink-0 rounded-[2px] border border-[var(--color-border-strong)] px-2 py-[3px] text-[11px] tracking-wider text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] transition-colors'

// Per-block message — the moment right after 送出 a new dispatch.
export function BlockShareButton({
  vendor,
  block,
}: {
  vendor?: Vendor
  block: OutsourceBlock
}) {
  const token = vendor?.portalToken
  if (!token) return null
  const compose = () => {
    const totalQty = block.members.reduce((s, m) => s + m.qty, 0)
    return [
      `【${BRAND.shortName} · 外协】${blockActivityLabel(block)} ${totalQty}件 · 要求${mdCn(block.expectedReturn)}交`,
      `点开确认收货、回交期（免登录，链接固定可收藏）：`,
      portalUrl(token),
    ].join('\n')
  }
  return (
    <button
      type="button"
      className={shareBtnClass}
      title="复制微信消息（含厂商专属链接）"
      onClick={() => copyAndToast(compose())}
    >
      微信
    </button>
  )
}

// Per-vendor message — from the 外协台 group header: the standing "your
// board" message with the current open count and nearest due date.
export function VendorShareButton({
  vendor,
  openBlocks,
}: {
  vendor: Vendor
  openBlocks: OutsourceBlock[]
}) {
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
  return (
    <button
      type="button"
      className={shareBtnClass}
      title="复制微信消息（含厂商专属链接）"
      onClick={() => copyAndToast(compose())}
    >
      复制微信消息
    </button>
  )
}

// Vendor-reported state, one chip, most-advanced-wins:
// 已发货 > 承诺交期 > 已确认收货 > 已读. Rendered on the block row so the
// 外协员 stops phoning vendors who have already answered on the portal.
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
