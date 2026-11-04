'use client'

import { Fragment, useCallback, useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { withBase } from '@/lib/base-path'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { formatCny } from '@/lib/data'
import { DatePop } from '@/app/_datepop'
import { usePasteImage } from '@/app/_paste_image'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { shanghaiDay } from '@/lib/today'
import { PhotoViewer } from '@/app/_photo_viewer'
import {
  settleOutstanding,
  settleOverdueDays,
  settlePaid,
  settleStatus,
  type PayablePayment,
  type PaymentProof,
  type PayableRequestRef,
  type SettleManual,
  type SettleStatus,
} from '@/lib/settle-shared'

// 应收 / 应付 — 对账单认下来之后落下的每一张单, 和它名下的每一笔收/付款。
//
// 两条对称的线, 一个页面样子:
//   应收: 对账 → 审批 → 这里 (等客户的钱回来)
//   应付: 对账 · 供应商 → 确认 → 这里 (我们付给外协的钱)
//
// 一张单一行, 看的是"还差多少、拖了几天"; 点开记一笔, 余额自己减掉, 结清了
// 这一行就沉下去。默认只看没结清的 —— 这一页每天打开要回答的就一个问题。
//
// 应付多一样: 付款凭证。传一张回单上来, 机器先把日期、金额、摘要读出来填
// 好, 人看一眼对不对再点「记付款」, 那张回单就挂在这一笔上。

export type SettleKind = 'receivable' | 'payable'

/** 列表上的一张单 —— 应收单和应付单摊平成同一个样子 (party = 客户 / 供应商)。 */
export type SettleRow = {
  id: string
  no: string
  party: string
  period: string
  amountCny: number
  lineCount: number
  totalQty: number
  approvedBy: string
  approvedAt: string
  dueDate: string
  payments: PayablePayment[]
  /** 应付单认的那几张外协单 —— 「看对账单」重印的就是它们。 */
  blockIds?: string[]
  /** 应收单认的那几个单号 (没有 = 整月审的)。 */
  jobNos?: string[]
  /** 财务订单导入落的应收单 (lib/order-import)。 */
  imported?: boolean
  /** 补录的老账 —— 备注 + 凭证, 不挂对账单。 */
  manual?: SettleManual
  /** 付款申请老板批下来落的 (只有应付) —— 清单、凭证、发票在申请上。 */
  request?: PayableRequestRef
  voidedAt?: string
  voidedBy?: string
}

const COPY = {
  receivable: {
    no: '应收单号',
    party: '客户',
    amount: '应收',
    paid: '已回款',
    left: '未收',
    total: '未收合计',
    monthPaid: '月回款',
    filterOpen: '未收清',
    status: {
      open: '未回款',
      partial: '部分回款',
      overdue: '逾期',
      paid: '已收完',
      void: '已作废',
    } as Record<SettleStatus, string>,
    noPay: '还没有回款',
    act: '记回款',
    amountPh: '回款金额',
    notePh: '备注 · 转账 / 承兑…',
    proof: '收款凭证',
    over: '比未收多了',
    by: '审批',
    emptyNone: '还没有应收单 —— 到「对账」里选一个客户，审批通过就会落在这里',
    emptyClear: '钱都收清了',
    sheetKind: '',
    idKey: 'receivableId',
    addKind: 'addReceivablePayment',
    delKind: 'deleteReceivablePayment',
    voidKind: 'voidReceivable',
    foot:
      '每一张都是在「对账」里审批通过的那张对账单——金额是审批那一刻的合计，之后出货单再改也不会跟着变。约定回款日是审批后 30 天，过了就标逾期。系统以前的老账点「补录」手动补一张。',
  },
  payable: {
    no: '应付单号',
    party: '供应商',
    amount: '应付',
    paid: '已付',
    left: '未付',
    total: '未付合计',
    monthPaid: '月付款',
    filterOpen: '未付清',
    status: {
      open: '未付款',
      partial: '部分付款',
      overdue: '逾期',
      paid: '已付清',
      void: '已作废',
    } as Record<SettleStatus, string>,
    noPay: '还没有付款',
    act: '记付款',
    amountPh: '付款金额',
    notePh: '备注 · 哪个账户 / 用途…',
    proof: '付款凭证',
    over: '比未付多了',
    by: '确认',
    emptyNone: '还没有应付单 —— 到「对账 · 供应商」里选一家，确认无误就会落在这里',
    emptyClear: '都付清了',
    sheetKind: 'vendor',
    idKey: 'payableId',
    addKind: 'addPayablePayment',
    delKind: 'deletePayablePayment',
    voidKind: 'voidPayable',
    foot:
      '每一张都是在「对账 · 供应商」里确认过的外协对账单——金额是确认那一刻的合计。约定付款日是确认后 30 天。付款时传一张回单，日期金额会自己填好，那张回单就挂在这笔付款上。系统以前的老账点「补录」手动补一张。',
  },
} as const

const COLS =
  'grid-cols-[minmax(0,1fr)_76px] md:grid-cols-[112px_minmax(0,1fr)_72px_104px_104px_104px_96px]'

// 应收的「全部」不含作废的 —— 作废的单子不算钱, 摆在明细、导出里只会让人以为
// 那几单还挂在应收上 (于海伟 2026-11-04)。要恢复的去「已作废」里找。
type Filter = 'open' | 'all' | 'void'

// 应收单从哪来 —— 对账页审批、财务订单导入、手动补录。合计对不上时先看这个
// (于海伟 2026-11-04: 导入表 458483.1, 应收合计差 1 万多)。
function sourceOf(r: SettleRow): '导入' | '补录' | '对账审批' {
  return r.manual ? '补录' : r.imported ? '导入' : '对账审批'
}

// 应收按审批月份归月 (于海伟 2026-11-04) —— 对账页审批的, 哪天点的审批就算
// 哪个月; 导入的、补录的没有审批这一步, 还按它们自己的月份 (下单月份 / 补录
// 时填的月份)。
function monthOf(r: SettleRow): string {
  if (r.manual || r.imported) return r.period
  return shanghaiDay(r.approvedAt).slice(0, 7) || r.period
}

export function SettleBoard({
  kind,
  rows,
  todayStr,
  canEdit,
  openId,
}: {
  kind: SettleKind
  rows: SettleRow[]
  todayStr: string
  /** 记一笔 / 删一笔 / 作废 —— 管钱那一档 (lib/auth canSettleAccounts)。 */
  canEdit: boolean
  /** 从对账页「去应收/去应付 →」进来时直接摊开的那一张。 */
  openId?: string
}) {
  const c = COPY[kind]
  const [filter, setFilter] = useState<Filter>(() => {
    // 从对账页点过来的那张要是已经结清了, 默认筛选会把它藏掉 —— 那就看全部。
    const target = openId ? rows.find((r) => r.id === openId) : undefined
    if (target?.voidedAt) return 'void'
    return target && settleStatus(target, todayStr) === 'paid' ? 'all' : 'open'
  })
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(openId ?? null)
  const [adding, setAdding] = useState(false)
  const parties = useMemo(
    () => [...new Set(rows.map((r) => r.party).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh')),
    [rows],
  )

  const month = todayStr.slice(0, 7)

  // 审批月份 (应收, 于海伟 2026-11-04) —— 选一个月, 顶上的数、列表、按客户、
  // 导出都只算这个月的应收单。空 = 全部月份。
  const [period, setPeriod] = useState('')
  const periods = useMemo(
    () => [...new Set(rows.filter((r) => !r.voidedAt && monthOf(r)).map(monthOf))].sort().reverse(),
    [rows],
  )
  const scoped = useMemo(() => (period ? rows.filter((r) => monthOf(r) === period) : rows), [rows, period])
  const periodLabel = (p: string) =>
    p.slice(0, 4) === month.slice(0, 4) ? `${Number(p.slice(5))}月` : `${p.slice(0, 4)}年${Number(p.slice(5))}月`

  const stats = useMemo(() => {
    let outstanding = 0
    let overdue = 0
    let paidThisMonth = 0
    let amount = 0
    let paid = 0
    const bySource: Record<string, number> = {}
    for (const r of scoped) {
      if (r.voidedAt) continue
      outstanding += settleOutstanding(r)
      amount += r.amountCny
      bySource[sourceOf(r)] = (bySource[sourceOf(r)] ?? 0) + r.amountCny
      paid += settlePaid(r)
      if (settleStatus(r, todayStr) === 'overdue') overdue += 1
      for (const p of r.payments) {
        if (p.date.slice(0, 7) === todayStr.slice(0, 7)) paidThisMonth += p.amountCny
      }
    }
    const r2 = (n: number) => Math.round(n * 100) / 100
    return {
      outstanding: r2(outstanding),
      overdue,
      paidThisMonth: r2(paidThisMonth),
      amount: r2(amount),
      paid: r2(paid),
      bySource: (['导入', '对账审批', '补录'] as const)
        .filter((k) => bySource[k])
        .map((k) => ({ k, v: r2(bySource[k]) })),
    }
  }, [scoped, todayStr])

  // 应收多一种看法: 按客户 · 按审批月份汇总 (于海伟 2026-11-04)。
  const [view, setView] = useState<'list' | 'party'>('list')

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return scoped.filter((r) => {
      const st = settleStatus(r, todayStr)
      if (filter === 'open' && (st === 'paid' || st === 'void')) return false
      if (kind === 'receivable' && filter === 'all' && st === 'void') return false
      if (filter === 'void' && st !== 'void') return false
      if (!needle) return true
      // 单号也能搜 —— 输一个工单号, 看它挂在哪张应收单上。
      return [r.no, r.party, kind === 'receivable' ? monthOf(r) : r.period, r.request?.no, r.request?.subject, r.request?.category, kind === 'receivable' ? sourceOf(r) : '', ...(r.jobNos ?? [])]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    })
  }, [scoped, filter, q, todayStr, kind])

  return (
    <div>
      {kind === 'receivable' && periods.length > 0 && (
        <div className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <span className="label">审批月份</span>
          {['', ...periods].map((p) => (
            <button
              key={p || 'all'}
              type="button"
              onClick={() => setPeriod(p)}
              className={`text-[13px] tabular-nums transition-colors ${
                period === p
                  ? 'font-semibold text-[var(--color-ink)] underline decoration-[var(--color-ink)] underline-offset-[6px]'
                  : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
              }`}
            >
              {p ? periodLabel(p) : '全部'}
            </button>
          ))}
        </div>
      )}
      <div className="mb-8 flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <p className="text-[32px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-overdue)]">
            {formatCny(stats.outstanding)}
          </p>
          <p className="label mt-2.5">
            {kind === 'receivable' && period ? `${periodLabel(period)}未收` : c.total}
          </p>
        </div>
        {kind === 'receivable' && (
          <>
            <div>
              <p className="text-[22px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">
                {formatCny(stats.amount)}
              </p>
              <p className="label mt-2.5">{period ? `${periodLabel(period)}应收` : '应收合计'}</p>
              {stats.bySource.length > 1 && (
                <p className="mt-1 text-[11.5px] tabular-nums text-[var(--color-ink-3)]">
                  {stats.bySource.map(({ k, v }) => `${k} ${formatCny(v)}`).join(' · ')}
                </p>
              )}
            </div>
            <div>
              <p className="text-[22px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">
                {formatCny(stats.paid)}
              </p>
              <p className="label mt-2.5">{period ? `${periodLabel(period)}已收` : '已收合计'}</p>
            </div>
          </>
        )}
        <div>
          <p
            className={`text-[22px] font-semibold leading-none tracking-tight tabular-nums ${
              stats.overdue > 0 ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink-3)]'
            }`}
          >
            {stats.overdue}
          </p>
          <p className="label mt-2.5">逾期</p>
        </div>
        <div>
          <p className="text-[22px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">
            {formatCny(stats.paidThisMonth)}
          </p>
          <p className="label mt-2.5">
            {Number(month.slice(5))}
            {c.monthPaid}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-4">
          {kind === 'receivable' && (
            <div className="inline-flex overflow-hidden rounded-[2px] border border-[var(--color-border)]">
              {(
                [
                  ['list', '明细'],
                  ['party', '按客户'],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`px-2.5 py-1 text-[12px] transition-colors ${
                    view === v
                      ? 'bg-[var(--color-active-bg)] font-medium text-[var(--color-ink)]'
                      : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-baseline gap-4">
            {(kind === 'receivable' && rows.some((r) => r.voidedAt)
              ? (['open', 'all', 'void'] as Filter[])
              : (['open', 'all'] as Filter[])
            ).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`text-[13.5px] tracking-tight transition-colors ${
                  filter === f
                    ? 'font-semibold text-[var(--color-ink)]'
                    : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
                }`}
              >
                {f === 'open' ? c.filterOpen : f === 'void' ? '已作废' : '全部'}
              </button>
            ))}
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={kind === 'receivable' ? '搜索 · 客户 / 应收单号 / 工单号' : `搜索 · ${c.party} / 单号`}
            className="h-9 w-[180px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
          />
          {kind === 'receivable' && (
            <ReceivableExport rows={shown} todayStr={todayStr} labels={c.status} />
          )}
          {canEdit && !adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              title="系统以前的老账 —— 手动补一张，挂上凭证"
              className="h-9 rounded-[2px] border border-[var(--color-border-strong)] px-3 text-[13px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
            >
              ＋ 补录
            </button>
          )}
        </div>
      </div>

      {adding && (
        <ManualForm
          kind={kind}
          parties={parties}
          todayStr={todayStr}
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            setAdding(false)
            setFilter('all')
            setOpen(id)
          }}
        />
      )}

      {view === 'party' ? (
        <PartyMonths
          rows={scoped}
          q={q}
          openOnly={filter === 'open'}
          onPick={(party, period) => {
            // 点一个月 —— 回到明细, 只看这个客户这个月的那几张。
            setQ(`${party} ${period}`)
            setFilter('all')
            setView('list')
          }}
        />
      ) : (
      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div
          className={`hidden ${COLS} items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid`}
        >
          <span className="label">{c.no}</span>
          <span className="label">{c.party}</span>
          <span className="label">{kind === 'receivable' ? '审批月份' : '期间'}</span>
          <span className="label text-right">{c.amount}</span>
          <span className="label text-right">{c.paid}</span>
          <span className="label text-right">{c.left}</span>
          <span className="label text-right">状态</span>
        </div>

        {shown.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] leading-relaxed text-[var(--color-ink-3)]">
            {q
              ? '没有匹配的单子'
              : rows.length === 0
                ? c.emptyNone
                : filter === 'open'
                  ? c.emptyClear
                  : filter === 'void'
                    ? '没有作废的单子'
                    : c.emptyNone}
          </p>
        ) : (
          shown.map((r) => {
            const paid = settlePaid(r)
            const left = settleOutstanding(r)
            return (
              <Fragment key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpen(open === r.id ? null : r.id)}
                  className={`grid w-full ${COLS} items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 text-left last:border-b-0 md:px-5 ${
                    open === r.id ? 'bg-[#faf8f2]' : 'hover:bg-[#faf8f2]'
                  } ${r.voidedAt ? 'opacity-50' : ''}`}
                >
                  <span className="mono hidden text-[12.5px] text-[var(--color-ink-2)] md:block">
                    {r.no}
                  </span>
                  <span className="min-w-0 truncate text-[14px] font-medium tracking-tight text-[var(--color-ink)]">
                    {r.party}
                    {kind === 'receivable' && r.imported && (
                      <span className="ml-2 text-[11px] font-normal text-[var(--color-ink-4)]">导入</span>
                    )}
                    {r.manual && (
                      <span className="ml-2 text-[11px] font-normal text-[var(--color-ink-4)]">补录</span>
                    )}
                    {r.request && (
                      <span className="ml-2 text-[11.5px] font-normal text-[var(--color-ink-3)]">
                        付款申请 · {r.request.category} · {r.request.subject}
                      </span>
                    )}
                    <span className="mono ml-2 text-[11.5px] font-normal text-[var(--color-ink-4)] md:hidden">
                      {r.no}
                    </span>
                  </span>
                  <span className="mono hidden text-[12.5px] text-[var(--color-ink-2)] md:block">
                    {(kind === 'receivable' ? monthOf(r) : r.period).slice(2).replace('-', '.')}
                  </span>
                  <span className="mono hidden text-right text-[13px] text-[var(--color-ink)] md:block">
                    {formatCny(r.amountCny)}
                  </span>
                  <span className="mono hidden text-right text-[13px] text-[var(--color-ink-2)] md:block">
                    {paid > 0 ? formatCny(paid) : '—'}
                  </span>
                  <span
                    className={`mono hidden text-right text-[13px] font-medium md:block ${
                      left > 0 ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink-4)]'
                    }`}
                  >
                    {left > 0 ? formatCny(left) : '—'}
                  </span>
                  <StatusTag r={r} todayStr={todayStr} labels={c.status} />
                </button>
                {open === r.id && (
                  <Detail kind={kind} r={r} todayStr={todayStr} canEdit={canEdit} />
                )}
              </Fragment>
            )
          })
        )}
      </div>

      )}

      <p className="mt-4 text-[12px] leading-relaxed text-[var(--color-ink-3)]">{c.foot}</p>
    </div>
  )
}

// 导出 (于海伟 2026-11-04) —— 当前筛选、搜索下看到的那几张应收单。两张表:
// 应收单 (一张一行) 和 回款明细 (一笔一行), 金额是数字, 财务能直接求和。
function ReceivableExport({
  rows,
  todayStr,
  labels,
}: {
  rows: SettleRow[]
  todayStr: string
  labels: Record<SettleStatus, string>
}) {
  const [busy, setBusy] = useState(false)
  const disabled = busy || rows.length === 0
  const onExport = async () => {
    if (disabled) return
    setBusy(true)
    try {
      const XLSX = await import('xlsx')
      const statusText = (r: SettleRow) => {
        const st = settleStatus(r, todayStr)
        return st === 'overdue' ? `逾期 ${settleOverdueDays(r, todayStr)} 天` : labels[st]
      }
      const head = ['应收单号', '客户', '期间', '应收', '已回款', '未收', '状态', '约定回款日', '审批人', '审批日期', '单号', '来源', '备注']
      const body = rows.map((r) => [
        r.no,
        r.party,
        r.period,
        r.amountCny,
        settlePaid(r),
        settleOutstanding(r),
        statusText(r),
        r.dueDate,
        r.approvedBy,
        r.approvedAt.slice(0, 10),
        r.jobNos?.join('、') ?? (r.manual ? '' : '整月'),
        sourceOf(r),
        r.manual?.note ?? '',
      ])
      const payHead = ['应收单号', '客户', '回款日期', '金额', '备注', '记录人', '收款凭证']
      const payBody = rows.flatMap((r) =>
        r.voidedAt
          ? []
          : r.payments.map((p) => [
              r.no,
              r.party,
              p.date,
              p.amountCny,
              p.note ?? '',
              p.by ?? '',
              p.proof ? p.proof.filename : '',
            ]),
      )
      const sheet = (h: string[], b: (string | number)[][], widths: number[]) => {
        const ws = XLSX.utils.aoa_to_sheet([h, ...b])
        ws['!cols'] = widths.map((wch) => ({ wch }))
        return ws
      }
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, sheet(head, body, [14, 22, 9, 12, 12, 12, 10, 11, 8, 11, 40, 9, 20]), '应收单')
      XLSX.utils.book_append_sheet(wb, sheet(payHead, payBody, [14, 22, 11, 12, 24, 8, 24]), '回款明细')
      XLSX.writeFile(wb, `应收_${todayStr}.xlsx`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      onClick={onExport}
      disabled={disabled}
      title="导出当前看到的应收单 (含回款明细)"
      className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] transition-colors ${
        disabled ? 'cursor-default text-[var(--color-ink-4)]' : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
      }`}
    >
      {busy ? '导出中…' : '导出 Excel'}
      <span aria-hidden className="text-[14px] leading-none">↓</span>
    </button>
  )
}

// 按客户 · 按审批月份 —— 一个客户一行合计, 下面一个月一行: 应收、已收、未收
// (红字)。作废的不算。只看未收清时, 收完了的月份、客户不列。
function PartyMonths({
  rows,
  q,
  openOnly,
  onPick,
}: {
  rows: SettleRow[]
  q: string
  openOnly: boolean
  onPick: (party: string, period: string) => void
}) {
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    type Sum = { amount: number; paid: number; left: number; count: number }
    const add = (s: Sum, r: SettleRow) => {
      s.amount += r.amountCny
      s.paid += settlePaid(r)
      s.left += settleOutstanding(r)
      s.count += 1
    }
    const byParty = new Map<string, { total: Sum; months: Map<string, Sum> }>()
    for (const r of rows) {
      if (r.voidedAt) continue
      if (needle && ![r.no, r.party, monthOf(r)].join(' ').toLowerCase().includes(needle)) continue
      const g = byParty.get(r.party) ?? {
        total: { amount: 0, paid: 0, left: 0, count: 0 },
        months: new Map<string, Sum>(),
      }
      add(g.total, r)
      const m = g.months.get(monthOf(r)) ?? { amount: 0, paid: 0, left: 0, count: 0 }
      add(m, r)
      g.months.set(monthOf(r), m)
      byParty.set(r.party, g)
    }
    const r2 = (n: number) => Math.round(n * 100) / 100
    return [...byParty.entries()]
      .map(([party, g]) => ({
        party,
        total: { ...g.total, amount: r2(g.total.amount), paid: r2(g.total.paid), left: r2(g.total.left) },
        months: [...g.months.entries()]
          .map(([period, m]) => ({ period, ...m, amount: r2(m.amount), paid: r2(m.paid), left: r2(m.left) }))
          .filter((m) => !openOnly || m.left > 0)
          .sort((a, b) => b.period.localeCompare(a.period)),
      }))
      .filter((g) => !openOnly || g.total.left > 0)
      .sort((a, b) => b.total.left - a.total.left || a.party.localeCompare(b.party, 'zh'))
  }, [rows, q, openOnly])

  const cols = 'grid-cols-[minmax(0,1fr)_56px_112px_112px_112px]'
  const money = (n: number, cls = 'text-[var(--color-ink-2)]') => (
    <span className={`mono text-right text-[13px] ${cls}`}>{n > 0 ? formatCny(n) : '—'}</span>
  )
  return (
    <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className={`grid ${cols} items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2`}>
        <span className="label">客户 · 审批月份</span>
        <span className="label text-right">张数</span>
        <span className="label text-right">应收</span>
        <span className="label text-right">已收</span>
        <span className="label text-right">未收</span>
      </div>
      {groups.length === 0 ? (
        <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
          {q ? '没有匹配的客户' : openOnly ? '钱都收清了' : '还没有应收单'}
        </p>
      ) : (
        groups.map((g) => (
          <div key={g.party} className="border-b border-[var(--color-border)] last:border-b-0">
            <div className={`grid ${cols} items-center gap-3 px-5 pt-3 pb-1.5`}>
              <span className="truncate text-[14px] font-semibold tracking-tight text-[var(--color-ink)]">
                {g.party}
              </span>
              <span className="mono text-right text-[12.5px] text-[var(--color-ink-3)]">{g.total.count}</span>
              {money(g.total.amount, 'font-medium text-[var(--color-ink)]')}
              {money(g.total.paid, 'font-medium text-[var(--color-ink)]')}
              {g.total.left > 0
                ? money(g.total.left, 'font-semibold text-[var(--color-overdue)]')
                : <span className="text-right text-[12.5px] text-[var(--color-success)]">已收完</span>}
            </div>
            {g.months.map((m) => (
              <button
                key={m.period}
                type="button"
                onClick={() => onPick(g.party, m.period)}
                title="看这个月的应收单"
                className={`grid w-full ${cols} items-center gap-3 px-5 py-1.5 text-left hover:bg-[#faf8f2] last:pb-3`}
              >
                <span className="mono pl-4 text-[12.5px] text-[var(--color-ink-2)]">
                  {m.period.slice(0, 4)}年{Number(m.period.slice(5))}月
                </span>
                <span className="mono text-right text-[12px] text-[var(--color-ink-4)]">{m.count}</span>
                {money(m.amount)}
                {money(m.paid)}
                {m.left > 0
                  ? money(m.left, 'font-medium text-[var(--color-overdue)]')
                  : <span className="text-right text-[12px] text-[var(--color-success)]">已收完</span>}
              </button>
            ))}
          </div>
        ))
      )}
    </div>
  )
}

function StatusTag({
  r,
  todayStr,
  labels,
}: {
  r: SettleRow
  todayStr: string
  labels: Record<SettleStatus, string>
}) {
  const st = settleStatus(r, todayStr)
  const tone: Record<SettleStatus, string> = {
    open: 'text-[var(--color-ink-2)]',
    partial: 'text-[var(--color-warning)]',
    overdue: 'text-[var(--color-overdue)] font-medium',
    paid: 'text-[var(--color-success)]',
    void: 'text-[var(--color-ink-4)]',
  }
  return (
    <span className={`text-right text-[12.5px] ${tone[st]}`}>
      {st === 'overdue' ? `逾期 ${settleOverdueDays(r, todayStr)} 天` : labels[st]}
    </span>
  )
}

function isImage(p: PaymentProof): boolean {
  if (p.contentType?.startsWith('image/')) return true
  return /\.(png|jpe?g|webp|heic)$/i.test(p.filename)
}

// 凭证的那个链接 —— 是图就当场铺满屏幕放大 (左上「‹ 返回」/ Esc 关), PDF
// 和浏览器打不开的 heic 照旧新开一页。
function ProofLink({
  proof,
  className,
  title,
  children,
}: {
  proof: PaymentProof
  className?: string
  title?: string
  children: React.ReactNode
}) {
  const [viewing, setViewing] = useState(false)
  const zoom = isImage(proof) && !/\.heic$/i.test(proof.filename)
  return (
    <>
      <a
        href={proxiedStorageUrl(proof.url)}
        target="_blank"
        rel="noreferrer"
        title={title}
        className={`${className ?? ''} ${zoom ? 'cursor-zoom-in' : ''}`}
        onClick={(e) => {
          if (!zoom) return
          e.preventDefault()
          setViewing(true)
        }}
      >
        {children}
      </a>
      {viewing && (
        <PhotoViewer
          items={[{ url: proof.url, filename: proof.filename }]}
          onClose={() => setViewing(false)}
        />
      )}
    </>
  )
}

// 两个名字是不是说的同一家 —— 回单上的户名常常是全称 ("杭州某某表面处理有限
// 公司"), 系统里是简称 ("某某表处")。去掉空白后一边包含另一边就算对得上;
// 对不上只是提醒一句, 不拦。
function samePayee(a: string, b: string): boolean {
  const x = a.replace(/\s/g, '')
  const y = b.replace(/\s/g, '')
  if (!x || !y) return true
  return x.includes(y) || y.includes(x) || x.slice(0, 2) === y.slice(0, 2)
}

function Detail({
  kind,
  r,
  todayStr,
  canEdit,
}: {
  kind: SettleKind
  r: SettleRow
  todayStr: string
  canEdit: boolean
}) {
  const c = COPY[kind]
  const router = useRouter()
  const [pending, start] = useTransition()
  const left = settleOutstanding(r)
  const [date, setDate] = useState(todayStr)
  const [amount, setAmount] = useState(left > 0 ? String(left) : '')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [armVoid, setArmVoid] = useState(false)
  const [armDel, setArmDel] = useState<string | null>(null)

  // 付款 / 收款凭证 —— 传上去、机器读一遍, 挂在这一笔上 (应收也挂, 于海伟
  // 2026-11-04)。
  const [proof, setProof] = useState<PaymentProof | null>(null)
  const [reading, setReading] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const zoneRef = useRef<HTMLDivElement>(null)

  const uploadProof = useCallback(
    async (file: File) => {
      setError(null)
      setHint(null)
      setReading(true)
      try {
        const fd = new FormData()
        fd.append('file', file)
        fd.append(kind === 'receivable' ? 'receivableId' : 'payableId', r.id)
        const res = await fetch(withBase('/api/payable-proof'), { method: 'POST', body: fd })
        const data = (await res.json()) as
          | {
              ok: true
              proof: PaymentProof
              extracted: {
                date: string | null
                amountCny: number | null
                payee: string | null
                memo: string | null
              } | null
            }
          | { ok: false; error: string }
        if (!data.ok) {
          setError(data.error)
          return
        }
        setProof(data.proof)
        const x = data.extracted
        if (!x || (!x.date && !x.amountCny)) {
          setHint('凭证存好了，没读出日期金额——自己填一下')
          return
        }
        if (x.date) setDate(x.date > todayStr ? todayStr : x.date)
        if (x.amountCny) setAmount(String(x.amountCny))
        if (x.memo) setNote(x.memo)
        // 收款方对不上只问应付 —— 应收的回单上收款方是我们自己。
        if (kind === 'payable' && x.payee && !samePayee(x.payee, r.party)) {
          setHint(`凭证上的收款方是「${x.payee}」，跟「${r.party}」对不上——看一眼再记`)
        } else {
          setHint('日期、金额从凭证上读出来了，看一眼对不对')
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : '传不上')
      } finally {
        setReading(false)
      }
    },
    [kind, r.id, r.party, todayStr],
  )

  usePasteImage(zoneRef, (f) => void uploadProof(f), canEdit)

  function addPayment() {
    const n = Number(amount.trim().replace(/[¥,，元\s]/g, ''))
    if (!Number.isFinite(n) || n <= 0) return setError(`${c.amountPh}要填一个正数`)
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: c.addKind,
          [c.idKey]: r.id,
          input: {
            date,
            amountCny: n,
            note: note.trim() || undefined,
            ...(proof ? { proof } : {}),
          },
        })
        if (n > left + 0.005) {
          showToast(`记下了——${c.over} ${formatCny(n - left)}`, 'warning')
        }
        setNote('')
        setAmount('')
        setProof(null)
        setHint(null)
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '记不上')
      }
    })
  }

  function delPayment(pid: string) {
    start(async () => {
      try {
        await mutate({ kind: c.delKind, [c.idKey]: r.id, paymentId: pid })
        setArmDel(null)
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '删不掉', 'warning')
      }
    })
  }

  function doRestore() {
    start(async () => {
      try {
        await mutate({ kind: 'restoreReceivable', receivableId: r.id })
        showToast(`${r.no} 已恢复`, 'success')
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '恢复不了', 'warning')
      }
    })
  }

  function doVoid() {
    start(async () => {
      try {
        await mutate({ kind: c.voidKind, [c.idKey]: r.id })
        setArmVoid(false)
        router.refresh()
      } catch (e) {
        setArmVoid(false)
        showToast(e instanceof Error ? e.message : '作废不了', 'warning')
      }
    })
  }

  const inp =
    'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'

  // 应付单记着认的是哪几张外协单 —— 看对账单就重印当时那几张 (它们已经不在
  // 对账页上了)。早先整月认的、和应收单, 回到那个月的对账页。
  const reprint = kind === 'payable' && !!r.blockIds && r.blockIds.length > 0
  const sheetHref = reprint
    ? withBase(
        `/duizhang/pdf?kind=vendor&name=${encodeURIComponent(r.party)}&m=${r.period}&sel=${encodeURIComponent(r.blockIds!.join(','))}`,
      )
    : `/duizhang?${c.sheetKind ? `kind=${c.sheetKind}&` : ''}name=${encodeURIComponent(
        r.party,
      )}&m=${r.period}`

  return (
    <div
      ref={zoneRef}
      className="border-b border-[var(--color-border)] bg-[#faf8f2] px-4 py-4 last:border-b-0 md:px-5"
    >
      {/* 已记的每一笔 —— 按日期排, 带着凭证。 */}
      {r.payments.length === 0 ? (
        <p className="text-[12.5px] text-[var(--color-ink-3)]">{c.noPay}</p>
      ) : (
        <div className="max-w-[720px]">
          {r.payments.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-4 border-b border-[var(--color-border)] py-2 last:border-b-0"
            >
              <span className="mono w-[84px] shrink-0 text-[12.5px] text-[var(--color-ink-2)]">
                {p.date}
              </span>
              <span className="mono w-[104px] shrink-0 text-right text-[13px] font-medium text-[var(--color-ink)]">
                {formatCny(p.amountCny)}
              </span>
              {p.proof ? (
                  <ProofLink
                    proof={p.proof}
                    title={`${c.proof} · ${p.proof.filename}`}
                    className="shrink-0"
                  >
                    {isImage(p.proof) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={proxiedStorageUrl(p.proof.url)}
                        alt={c.proof}
                        className="h-8 w-8 rounded-[2px] border border-[var(--color-border)] object-cover"
                      />
                    ) : (
                      <span className="flex h-8 w-8 items-center justify-center rounded-[2px] border border-[var(--color-border)] text-[10px] text-[var(--color-ink-3)]">
                        PDF
                      </span>
                    )}
                  </ProofLink>
                ) : (
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center text-[10.5px] text-[var(--color-ink-4)]"
                    title="这一笔没挂凭证"
                  >
                    无凭证
                  </span>
                )}
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-ink-2)]">
                {p.note}
              </span>
              <span className="shrink-0 text-[11.5px] text-[var(--color-ink-4)]">{p.by}</span>
              {canEdit &&
                (armDel === p.id ? (
                  <button
                    type="button"
                    onClick={() => delPayment(p.id)}
                    disabled={pending}
                    className="shrink-0 text-[11.5px] font-medium text-[var(--color-overdue)] hover:underline disabled:opacity-50"
                  >
                    确认删
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setArmDel(p.id)}
                    className="shrink-0 text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                  >
                    删
                  </button>
                ))}
            </div>
          ))}
        </div>
      )}

      {/* 记一笔 —— 金额默认就是还差的那个数, 一次结清就是点一下。先传凭证
          最省事: 日期金额机器填好, 人看一眼就记。 */}
      {canEdit && !r.voidedAt && left > 0 && (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ''
                    if (f) void uploadProof(f)
                  }}
                />
                {proof ? (
                  <span className="relative inline-flex shrink-0">
                    <ProofLink proof={proof} title={proof.filename}>
                      {isImage(proof) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={proxiedStorageUrl(proof.url)}
                          alt={c.proof}
                          className="h-9 w-9 rounded-[2px] border border-[var(--color-border)] object-cover"
                        />
                      ) : (
                        <span className="flex h-9 w-9 items-center justify-center rounded-[2px] border border-[var(--color-border)] text-[10px] text-[var(--color-ink-3)]">
                          PDF
                        </span>
                      )}
                    </ProofLink>
                    <button
                      type="button"
                      onClick={() => {
                        setProof(null)
                        setHint(null)
                      }}
                      aria-label="拿掉这张凭证"
                      className="absolute -right-1.5 -top-1.5 flex h-[16px] w-[16px] items-center justify-center rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[11px] leading-none text-[var(--color-ink-3)] hover:text-[var(--color-overdue)]"
                    >
                      ×
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={reading}
                    title="传一张银行回单 / 转账截图 —— 日期金额自己填好（也可以 Ctrl+V 粘贴）"
                    className="h-9 shrink-0 rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-3 text-[12.5px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] disabled:opacity-60"
                  >
                    {reading ? '读凭证中…' : '传凭证'}
                  </button>
                )}
            </>
            <DatePop
              value={date}
              onChange={(d) => d && setDate(d)}
              allowFuture={false}
              portal
              triggerClass="text-[13px]"
            />
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={c.amountPh}
              inputMode="decimal"
              className={`mono ${inp} w-[120px] text-right`}
            />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addPayment()}
              placeholder={c.notePh}
              className={`${inp} min-w-[160px] flex-1 md:max-w-[300px]`}
            />
            <button
              type="button"
              onClick={addPayment}
              disabled={pending || reading}
              className="h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
            >
              {c.act}
            </button>
          </div>
          {(hint || error) && (
            <p
              className={`mt-2 text-[12px] ${
                error
                  ? 'text-[var(--color-overdue)]'
                  : hint?.includes('对不上')
                    ? 'text-[var(--color-warning)]'
                    : 'text-[var(--color-ink-3)]'
              }`}
            >
              {error ?? hint}
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[11.5px] text-[var(--color-ink-4)]">
        {r.request ? (
          <>
            <Link
              href={
                r.request.dept === '人事'
                  ? `/hr?v=pay&open=${encodeURIComponent(r.request.id)}`
                  : `/pay?open=${encodeURIComponent(r.request.id)}`
              }
              className="text-[12.5px] font-medium text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
            >
              看付款申请 →
            </Link>
            <span className="text-[12px] text-[var(--color-ink-3)]">
              {r.request.no} · {r.request.dept} · {r.request.category} · {r.request.subject}
            </span>
          </>
        ) : r.manual ? (
          <>
            {r.manual.proof && (
              <ProofLink
                proof={r.manual.proof}
                className="text-[12.5px] font-medium text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
              >
                看凭证 →
              </ProofLink>
            )}
            <span className="text-[12px] text-[var(--color-ink-3)]">
              补录{r.manual.note ? ` · ${r.manual.note}` : ''}
            </span>
          </>
        ) : reprint ? (
          <a
            href={sheetHref}
            target="_blank"
            rel="noopener"
            className="text-[12.5px] font-medium text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
          >
            看对账单 →
          </a>
        ) : (
          <Link
            href={sheetHref}
            className="text-[12.5px] font-medium text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
          >
            看对账单 →
          </Link>
        )}
        {!r.manual && !r.request && (
          <span>
            {r.lineCount} 行 · {r.totalQty} 件
          </span>
        )}
        <span>
          {r.approvedBy} {r.manual ? '补录' : r.request ? '批准' : c.by}于 {r.approvedAt.slice(0, 10)}
        </span>
        <span>约定 {r.dueDate}</span>
        {r.voidedAt && (
          <span>
            {r.voidedBy} 作废于 {r.voidedAt.slice(0, 10)}
          </span>
        )}
        {/* 作废错了 —— 恢复 (只有应收; 单号已经进了别的应收单就恢复不了)。 */}
        {canEdit && r.voidedAt && kind === 'receivable' && (
          <span className="ml-auto">
            <button
              type="button"
              onClick={doRestore}
              disabled={pending}
              className="font-medium text-[var(--color-ink-2)] hover:text-[var(--color-ink)] disabled:opacity-50"
            >
              恢复
            </button>
          </span>
        )}
        {canEdit && !r.voidedAt && r.payments.length === 0 && (
          <span className="ml-auto">
            {armVoid ? (
              <span className="inline-flex gap-3">
                <button
                  type="button"
                  onClick={doVoid}
                  disabled={pending}
                  className="font-medium text-[var(--color-overdue)] hover:underline disabled:opacity-50"
                >
                  确认作废
                </button>
                <button
                  type="button"
                  onClick={() => setArmVoid(false)}
                  className="text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
                >
                  取消
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setArmVoid(true)}
                title={`${c.by}错了、或者单据变了要按新数重来 —— 作废后回到对账里重新${c.by}`}
                className="hover:text-[var(--color-overdue)]"
              >
                作废
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

// 补录 —— 系统上线以前的老账: 对方、哪个月的账、多少钱、约定哪天收/付, 一句
// 备注, 再挂一张凭证 (老对账单 / 发票 / 收据的照片或 PDF, 也可以直接粘贴截图)。
// 落下来就是一张普通的应收 / 应付单, 以后照样记回款、付款。
function ManualForm({
  kind,
  parties,
  todayStr,
  onClose,
  onAdded,
}: {
  kind: SettleKind
  parties: string[]
  todayStr: string
  onClose: () => void
  onAdded: (id: string) => void
}) {
  const c = COPY[kind]
  const router = useRouter()
  const [pending, start] = useTransition()
  const [party, setParty] = useState('')
  const [period, setPeriod] = useState(todayStr.slice(0, 7))
  const [amount, setAmount] = useState('')
  const [due, setDue] = useState(todayStr)
  const [note, setNote] = useState('')
  const [proof, setProof] = useState<PaymentProof | null>(null)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const zoneRef = useRef<HTMLDivElement>(null)

  const upload = useCallback(async (file: File) => {
    setError(null)
    setReading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('payableId', 'manual')
      const res = await fetch(withBase('/api/payable-proof'), { method: 'POST', body: fd })
      const data = (await res.json()) as
        | { ok: true; proof: PaymentProof; extracted: { amountCny: number | null } | null }
        | { ok: false; error: string }
      if (!data.ok) return setError(data.error)
      setProof(data.proof)
      // 金额还空着就用凭证上读出来的数先填上, 人看一眼。
      if (data.extracted?.amountCny) setAmount((cur) => cur || String(data.extracted!.amountCny))
    } catch (e) {
      setError(e instanceof Error ? e.message : '传不上')
    } finally {
      setReading(false)
    }
  }, [])
  usePasteImage(zoneRef, (f) => void upload(f), true)

  function save() {
    const n = Number(amount.trim().replace(/[¥,，元\s]/g, ''))
    if (!party.trim()) return setError(`先填${c.party}`)
    if (!/^\d{4}-\d{2}$/.test(period)) return setError('月份不对')
    if (!Number.isFinite(n) || n <= 0) return setError(`${c.amount}金额要填一个正数`)
    setError(null)
    start(async () => {
      try {
        const r = await mutate<{ id: string; no: string }>({
          kind: 'addManualSettle',
          which: kind,
          party: party.trim(),
          period,
          amountCny: n,
          dueDate: due,
          note: note.trim() || undefined,
          ...(proof ? { proof } : {}),
        })
        showToast(`补录好了${'data' in r && r.data ? ` · ${r.data.no}` : ''}`)
        router.refresh()
        if ('data' in r && r.data) onAdded(r.data.id)
        else onClose()
      } catch (e) {
        setError(e instanceof Error ? e.message : '记不上')
      }
    })
  }

  const inp =
    'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'
  const listId = `manual-parties-${kind}`

  return (
    <div
      ref={zoneRef}
      className="mb-5 rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-4 py-4 md:px-5"
    >
      <p className="label mb-3">补录{c.amount}单 · 系统以前的老账</p>
      <div className="flex flex-wrap items-center gap-2.5">
        <input
          value={party}
          onChange={(e) => setParty(e.target.value)}
          list={listId}
          placeholder={c.party}
          autoFocus
          className={`${inp} w-[180px]`}
        />
        <datalist id={listId}>
          {parties.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <label className="flex items-center gap-1.5 text-[12px] text-[var(--color-ink-3)]">
          哪个月的账
          <input
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className={`${inp} w-[140px]`}
          />
        </label>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={`${c.amount}金额`}
          inputMode="decimal"
          className={`mono ${inp} w-[120px] text-right`}
        />
        <span className="flex items-center gap-1.5 text-[12px] text-[var(--color-ink-3)]">
          约定
          <DatePop value={due} onChange={(d) => d && setDue(d)} portal triggerClass="text-[13px]" />
        </span>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
        <input
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void upload(f)
          }}
        />
        {proof ? (
          <span className="inline-flex items-center gap-2">
            <ProofLink
              proof={proof}
              className="text-[12.5px] text-[var(--color-ink-2)] underline-offset-2 hover:underline"
            >
              {proof.filename}
            </ProofLink>
            <button
              type="button"
              onClick={() => setProof(null)}
              aria-label="拿掉这张凭证"
              className="text-[12px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
            >
              ×
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={reading}
            title="老对账单 / 发票 / 收据的照片或 PDF（也可以 Ctrl+V 粘贴截图）"
            className="h-9 shrink-0 rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-3 text-[12.5px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] disabled:opacity-60"
          >
            {reading ? '传凭证中…' : '传凭证'}
          </button>
        )}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          placeholder="备注 · 哪笔老账…"
          className={`${inp} min-w-[160px] flex-1 md:max-w-[320px]`}
        />
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-[2px] border border-[var(--color-border)] px-3 text-[13px] text-[var(--color-ink-2)] hover:bg-[#f1eee4]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={save}
            disabled={pending || reading}
            className="h-9 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
          >
            {pending ? '补录中…' : '补录'}
          </button>
        </span>
      </div>
      {error && <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>}
    </div>
  )
}
