'use client'

import { Fragment, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { formatCny } from '@/lib/data'
import { DatePop } from '@/app/_datepop'
import { LoanSlips } from '@/app/_loan_slips'
import {
  LOAN_STAGE_LABEL,
  loanOutstanding,
  loanRepaid,
  loanStage,
  type Loan,
  type LoanStage,
} from '@/lib/loan-shared'

// 财务 · 借款 — 人事那边批下来的借款转到这里: 放款, 然后看它一个月一个月从
// 工资里扣回来, 扣完自己关掉。
//
//   (人事) 填申请 → 审批 →【这里】放款 → 每月工资自动扣回 → 已还清
//
// 这一页每天要回答的是两件事: 批了还没给钱的 (待放款), 和还欠着的 (还款中)。
// 工资扣回不用谁来记 —— 发工资那一下就记上了; 这里只有工资之外的还款 (交了
// 现金) 要手记。

type Filter = 'approved' | 'repaying' | 'all'

const STAGE_TONE: Record<LoanStage, string> = {
  pending: 'text-[var(--color-ink-3)]',
  rejected: 'text-[var(--color-ink-4)]',
  approved: 'text-[var(--color-warning)] font-medium',
  repaying: 'text-[var(--color-ink-2)]',
  cleared: 'text-[var(--color-success)]',
}

const COLS =
  'grid-cols-[minmax(0,1fr)_72px] md:grid-cols-[108px_minmax(0,1fr)_104px_104px_104px_80px]'

export function LoanBoard({
  loans,
  todayStr,
  canSettle,
}: {
  /** 只有批下来的 (待放款 / 还款中 / 已还清) —— 待审批和驳回的留在人事。 */
  loans: Loan[]
  todayStr: string
  /** 放款 / 记还款 —— 管钱那一档 (lib/auth canSettleAccounts)。 */
  canSettle: boolean
}) {
  const waiting = loans.filter((l) => loanStage(l) === 'approved').length
  const [filter, setFilter] = useState<Filter>(waiting > 0 ? 'approved' : 'repaying')
  const [open, setOpen] = useState<string | null>(null)
  const month = todayStr.slice(0, 7)

  const stats = useMemo(() => {
    let out = 0
    let back = 0
    for (const l of loans) {
      out += loanOutstanding(l)
      for (const r of l.repayments) if (r.date.slice(0, 7) === month) back += r.amountCny
    }
    return { out: Math.round(out * 100) / 100, back: Math.round(back * 100) / 100 }
  }, [loans, month])

  const shown = useMemo(
    () => (filter === 'all' ? loans : loans.filter((l) => loanStage(l) === filter)),
    [loans, filter],
  )

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <p className="text-[32px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-overdue)]">
            {formatCny(stats.out)}
          </p>
          <p className="label mt-2.5">借出未还</p>
        </div>
        <div>
          <p
            className={`text-[22px] font-semibold leading-none tracking-tight tabular-nums ${
              waiting > 0 ? 'text-[var(--color-warning)]' : 'text-[var(--color-ink-3)]'
            }`}
          >
            {waiting}
          </p>
          <p className="label mt-2.5">待放款</p>
        </div>
        <div>
          <p className="text-[22px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">
            {formatCny(stats.back)}
          </p>
          <p className="label mt-2.5">{Number(month.slice(5))}月还回</p>
        </div>
        <div className="ml-auto flex items-baseline gap-4">
          {(
            [
              ['approved', '待放款'],
              ['repaying', '还款中'],
              ['all', '全部'],
            ] as [Filter, string][]
          ).map(([f, label]) => (
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
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div
          className={`hidden ${COLS} items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid`}
        >
          <span className="label">借款单号</span>
          <span className="label">借款人 · 事由</span>
          <span className="label text-right">借款</span>
          <span className="label text-right">已还</span>
          <span className="label text-right">未还</span>
          <span className="label text-right">状态</span>
        </div>
        {shown.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] leading-relaxed text-[var(--color-ink-3)]">
            {loans.length === 0
              ? '还没有批下来的借款 —— 借款申请在「人事 · 借款」里填，批了就转到这里'
              : filter === 'approved'
                ? '没有等着放款的'
                : filter === 'repaying'
                  ? '没有还欠着的'
                  : '还没有借款'}
          </p>
        ) : (
          shown.map((l) => {
            const st = loanStage(l)
            const repaid = loanRepaid(l)
            const left = loanOutstanding(l)
            return (
              <Fragment key={l.id}>
                <button
                  type="button"
                  onClick={() => setOpen(open === l.id ? null : l.id)}
                  className={`grid w-full ${COLS} items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 text-left last:border-b-0 md:px-5 ${
                    open === l.id ? 'bg-[#faf8f2]' : 'hover:bg-[#faf8f2]'
                  }`}
                >
                  <span className="mono hidden text-[12.5px] text-[var(--color-ink-2)] md:block">
                    {l.no}
                  </span>
                  <span className="min-w-0 truncate text-[14px] font-medium tracking-tight text-[var(--color-ink)]">
                    {l.name}
                    <span className="ml-2 text-[12px] font-normal text-[var(--color-ink-3)]">
                      {l.reason}
                    </span>
                  </span>
                  <span className="mono hidden text-right text-[13px] text-[var(--color-ink)] md:block">
                    {formatCny(l.amountCny)}
                  </span>
                  <span className="mono hidden text-right text-[13px] text-[var(--color-ink-2)] md:block">
                    {repaid > 0 ? formatCny(repaid) : '—'}
                  </span>
                  <span
                    className={`mono hidden text-right text-[13px] font-medium md:block ${
                      left > 0 ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink-4)]'
                    }`}
                  >
                    {left > 0 ? formatCny(left) : '—'}
                  </span>
                  <span className={`text-right text-[12.5px] ${STAGE_TONE[st]}`}>
                    {LOAN_STAGE_LABEL[st]}
                  </span>
                </button>
                {open === l.id && <Detail l={l} todayStr={todayStr} canSettle={canSettle} />}
              </Fragment>
            )
          })
        )}
      </div>

      <p className="mt-4 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
        放款以后，每个月的工资条上会自动多一格「借款扣回」（约定的每月扣回，没约定就一次扣清，不会扣到实发为负）；
        工资一发放就记成一笔还款，扣完这笔借款自动变成已还清。撤销工资发放，那笔扣回也跟着退回。
      </p>
    </div>
  )
}

function Detail({ l, todayStr, canSettle }: { l: Loan; todayStr: string; canSettle: boolean }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const st = loanStage(l)
  const [payDate, setPayDate] = useState(todayStr)
  const [date, setDate] = useState(todayStr)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [armDel, setArmDel] = useState<string | null>(null)
  // 点错了往回退 —— 先点一下, 再点一下「确认」, 防手滑。
  const [armBack, setArmBack] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function run(body: Record<string, unknown> & { kind: string }, done?: () => void) {
    setError(null)
    start(async () => {
      try {
        await mutate(body)
        done?.()
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '办不了')
      }
    })
  }

  // 工资之外交回来的钱 (现金) —— 工资扣回不用在这里记。
  function repay() {
    const n = Number(amount.trim().replace(/[¥,，元\s]/g, ''))
    if (!Number.isFinite(n) || n <= 0) return setError('还款金额要填一个正数')
    run(
      {
        kind: 'addLoanRepayment',
        loanId: l.id,
        input: { date, amountCny: n, method: '现金', note: note.trim() || undefined },
      },
      () => {
        setAmount('')
        setNote('')
      },
    )
  }

  const inp =
    'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'
  const btnPri =
    'h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50'

  return (
    <div className="border-b border-[var(--color-border)] bg-[#faf8f2] px-4 py-4 last:border-b-0 md:px-5">
      <div className="space-y-1 text-[12.5px] text-[var(--color-ink-2)]">
        <p>
          <span className="text-[var(--color-ink-4)]">申请</span> {l.appliedBy} ·{' '}
          {l.appliedAt.slice(0, 10)} · {l.reason}，
          {l.monthlyCny ? `每月工资扣回 ${formatCny(l.monthlyCny)}` : '下个工资一次扣清'}
        </p>
        <p>
          <span className="text-[var(--color-ink-4)]">同意</span> {l.decidedBy} ·{' '}
          {l.decidedAt?.slice(0, 10)}
        </p>
        {l.paidOutAt && (
          <p>
            <span className="text-[var(--color-ink-4)]">放款</span> {l.paidOutBy} · {l.paidOutAt}
          </p>
        )}
      </div>

      {/* 点错了往回退: 待放款 → 退回重审 (回到人事那边重新批); 放了款还没还
          过一笔 → 撤销放款 (回到待放款)。开始还钱以后就退不了了。 */}
      {canSettle && (st === 'approved' || (st === 'repaying' && l.repayments.length === 0)) && (
        <div className="mt-2 text-[12px]">
          {armBack ? (
            <span className="inline-flex items-center gap-3">
              <span className="text-[var(--color-ink-3)]">
                {st === 'approved' ? '退回人事那边重新审批？' : '撤销这次放款，回到待放款？'}
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(
                    { kind: st === 'approved' ? 'reopenLoan' : 'undoPayOutLoan', loanId: l.id },
                    () => setArmBack(false),
                  )
                }
                className="font-medium text-[var(--color-overdue)] hover:underline disabled:opacity-50"
              >
                确认
              </button>
              <button
                type="button"
                onClick={() => setArmBack(false)}
                className="text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                取消
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setArmBack(true)}
              className="text-[var(--color-ink-4)] hover:text-[var(--color-ink)]"
            >
              {st === 'approved' ? '批错了，退回重审' : '放款点错了，撤销'}
            </button>
          )}
        </div>
      )}

      {/* 借支单 —— 放款前照着它核一眼签名和金额; 放款后只看不删。 */}
      <div className="mt-3">
        <LoanSlips loanId={l.id} slips={l.slips} canUpload={canSettle} canDelete={canSettle && !l.paidOutAt} />
      </div>

      {st === 'approved' && canSettle && (
        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <span className="text-[12.5px] text-[var(--color-ink-2)]">放款日</span>
          <DatePop
            value={payDate}
            onChange={(d) => d && setPayDate(d)}
            allowFuture={false}
            portal
            triggerClass="text-[13px]"
          />
          <button
            type="button"
            disabled={pending}
            onClick={() => run({ kind: 'payOutLoan', loanId: l.id, date: payDate })}
            className={btnPri}
          >
            已放款 {formatCny(l.amountCny)}
          </button>
        </div>
      )}

      {l.repayments.length > 0 && (
        <div className="mt-3 max-w-[640px]">
          {l.repayments.map((r) => (
            <div
              key={r.id}
              className="flex items-baseline gap-4 border-b border-[var(--color-border)] py-2 last:border-b-0"
            >
              <span className="mono w-[84px] shrink-0 text-[12.5px] text-[var(--color-ink-2)]">
                {r.date}
              </span>
              <span className="mono w-[96px] shrink-0 text-right text-[13px] font-medium text-[var(--color-ink)]">
                {formatCny(r.amountCny)}
              </span>
              <span className="w-[56px] shrink-0 text-[12px] text-[var(--color-ink-3)]">{r.method}</span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-ink-2)]">
                {r.note}
              </span>
              <span className="shrink-0 text-[11.5px] text-[var(--color-ink-4)]">{r.by}</span>
              {/* 工资扣回的那几笔不在这儿删 —— 撤销那个月的工资发放才退回。 */}
              {canSettle &&
                !r.payrollMonth &&
                (armDel === r.id ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      run({ kind: 'deleteLoanRepayment', loanId: l.id, repaymentId: r.id }, () =>
                        setArmDel(null),
                      )
                    }
                    className="shrink-0 text-[11.5px] font-medium text-[var(--color-overdue)] hover:underline"
                  >
                    确认删
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setArmDel(r.id)}
                    className="shrink-0 text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                  >
                    删
                  </button>
                ))}
            </div>
          ))}
        </div>
      )}

      {st === 'repaying' && canSettle && (
        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <span className="text-[12px] text-[var(--color-ink-3)]">工资之外交回来的</span>
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
            placeholder="现金还款"
            inputMode="decimal"
            className={`mono ${inp} w-[110px] text-right`}
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && repay()}
            placeholder="备注 · 可空"
            className={`${inp} min-w-[140px] flex-1 md:max-w-[240px]`}
          />
          <button type="button" disabled={pending} onClick={repay} className={btnPri}>
            记还款
          </button>
        </div>
      )}

      {error && <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>}
    </div>
  )
}
