'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { formatCny } from '@/lib/data'
import {
  settleOutstanding,
  settlePaid,
  type Payable,
  type Receivable,
} from '@/lib/settle-shared'
import type { DuizhangKind } from '@/lib/duizhang'

// 对账单上面那一条 —— 这张纸认没认下来。客户和外协两边一个样子, 只是说法
// 不同: 客户那边是「审批」落应收单、等回款; 外协这边是「确认」落应付单、等
// 我们付款。
//
// 没认: 管钱的人看到一个按钮, 旁边是这一按下去会落下的那个数。还有没定价的
// 行就按不下去 —— 一个偏小的合计认下来, 差的那部分就再也没人去对了。
// 认过: 一句话说清楚这笔钱现在在哪 —— 单号、金额、已收/已付、余额, 一步到账。
// 认下之后单据又改了, 纸上的合计会和单子对不上 —— 照实说出来, 由人决定要不
// 要作废重来, 而不是悄悄改掉已经认下的数。
//
// 整条 no-print: 发给对方的那张纸上不该印着我们内部认没认。

const COPY = {
  customer: {
    pending: '待审批',
    amount: '应收',
    act: '审批通过，生成应收单',
    acting: '审批中…',
    done: '✓ 已审批',
    paid: '已回款',
    left: '未收',
    by: '审批',
    go: '去应收 →',
    tab: 'receivable',
    who: '审批由于海伟或财务来点',
    unpriced: (n: number) => `还有 ${n} 行没定价，补上单价才能审批`,
    kind: 'approveDuizhang',
    partyKey: 'customer',
  },
  vendor: {
    pending: '待确认',
    amount: '应付',
    act: '确认无误，生成应付单',
    acting: '确认中…',
    done: '✓ 已确认',
    paid: '已付',
    left: '未付',
    by: '确认',
    go: '去应付 →',
    tab: 'payable',
    who: '确认由于海伟或财务来点',
    unpriced: (n: number) => `还有 ${n} 张外协单没定价，补上价钱才能确认`,
    kind: 'confirmVendorDuizhang',
    partyKey: 'vendor',
  },
} as const

export function ApprovalStrip({
  kind,
  party,
  period,
  total,
  lineCount,
  unpricedCount,
  record,
  canApprove,
  canOpenLedger,
}: {
  kind: DuizhangKind
  party: string
  period: string
  total: number
  lineCount: number
  unpricedCount: number
  /** 这一方这个月那张还算数的应收单 / 应付单; 没认就是 null。 */
  record: Receivable | Payable | null
  canApprove: boolean
  /** 能不能进财务的应收/应付 —— 不能就不给那个链接, 免得点过去被弹回来。 */
  canOpenLedger: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const c = COPY[kind]

  const box = 'no-print mt-5 rounded-[2px] border px-4 py-3 md:px-5'

  if (record) {
    const paid = settlePaid(record)
    const left = settleOutstanding(record)
    const drifted =
      Math.abs(total - record.amountCny) > 0.005 || lineCount !== record.lineCount
    return (
      <div className={`${box} border-[var(--color-border)] bg-[var(--color-surface)]`}>
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
          <span className="text-[13px] font-semibold text-[var(--color-success)]">
            {c.done}
          </span>
          <span className="mono text-[13px] text-[var(--color-ink)]">{record.no}</span>
          <span className="text-[13px] text-[var(--color-ink-2)]">
            {c.amount}{' '}
            <b className="mono font-medium text-[var(--color-ink)]">
              {formatCny(record.amountCny)}
            </b>
          </span>
          <span className="text-[13px] text-[var(--color-ink-2)]">
            {c.paid} <b className="mono font-medium text-[var(--color-ink)]">{formatCny(paid)}</b>
          </span>
          <span className="text-[13px] text-[var(--color-ink-2)]">
            {c.left}{' '}
            <b
              className={`mono font-medium ${
                left > 0 ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink-3)]'
              }`}
            >
              {formatCny(left)}
            </b>
          </span>
          <span className="text-[11.5px] text-[var(--color-ink-4)]">
            {record.approvedBy} {c.by}于 {record.approvedAt.slice(0, 10)}
          </span>
          {canOpenLedger && (
            <Link
              href={`/finance?tab=${c.tab}&open=${record.id}`}
              className="ml-auto text-[13px] font-medium text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
            >
              {c.go}
            </Link>
          )}
        </div>
        {drifted && (
          <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-warning)]">
            {c.by}之后这个月的单据有变动——现在合计 {formatCny(total)}，共 {lineCount} 行。
            要按新数走，到{c.amount}里把这张作废，再回来重新{c.by}。
          </p>
        )}
      </div>
    )
  }

  function approve() {
    setError(null)
    start(async () => {
      try {
        await mutate({ kind: c.kind, [c.partyKey]: party, period })
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : `${c.by}不上`)
      }
    })
  }

  const blocked = unpricedCount > 0

  return (
    <div className={`${box} border-dashed border-[var(--color-border-strong)] bg-transparent`}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-[13px] font-medium text-[var(--color-ink-2)]">{c.pending}</span>
        <span className="text-[13px] text-[var(--color-ink-2)]">
          {c.amount} <b className="mono font-medium text-[var(--color-ink)]">{formatCny(total)}</b>
          <span className="ml-2 text-[var(--color-ink-3)]">共 {lineCount} 行</span>
        </span>
        {blocked && (
          <span className="text-[12px] text-[var(--color-overdue)]">{c.unpriced(unpricedCount)}</span>
        )}
        {canApprove ? (
          <button
            type="button"
            onClick={approve}
            disabled={pending || blocked}
            className="ml-auto h-9 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-40"
          >
            {pending ? c.acting : c.act}
          </button>
        ) : (
          <span className="ml-auto text-[12px] text-[var(--color-ink-4)]">{c.who}</span>
        )}
      </div>
      {error && <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>}
    </div>
  )
}
