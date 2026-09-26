'use client'

import { Fragment, useId, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { formatCny } from '@/lib/data'
import { LOAN_STAGE_LABEL, loanStage, type Loan, type LoanStage } from '@/lib/loan-shared'

// 人事 · 借款 — 员工来借钱, 人事在这里把申请填下来, 等人批。
//
//   人事填申请 → 审批 (同意 / 驳回) → 批了就转到财务 → 财务放款 → 每月工资
//   自动扣回 → 扣完自动关闭
//
// 这一页管前半截: 填、批、看批没批。批下来以后放款和还款是财务的事, 这里只
// 写一句它走到哪了 (待放款 / 还款中 / 已还清), 不摊还款明细 —— 那是钱的账,
// 在财务那边。
//
// 审批就在这一行上点: 能批的人 (于海伟 / 老板 / 财务) 打开看到「同意 · 驳回」。
// 自己填的自己批不了 (老板除外) —— 审批是第二双眼睛。

type Filter = 'pending' | 'all'

const STAGE_TONE: Record<LoanStage, string> = {
  pending: 'text-[var(--color-overdue)] font-medium',
  approved: 'text-[var(--color-ink-2)]',
  repaying: 'text-[var(--color-ink-2)]',
  cleared: 'text-[var(--color-success)]',
  rejected: 'text-[var(--color-ink-4)]',
}

// 批下来以后, 人事这边读到的就是"转到财务了"加上它在财务那边走到哪一步。
function stageText(st: LoanStage): string {
  if (st === 'pending' || st === 'rejected') return LOAN_STAGE_LABEL[st]
  return `已转财务 · ${LOAN_STAGE_LABEL[st]}`
}

const COLS =
  'grid-cols-[minmax(0,1fr)_96px] md:grid-cols-[108px_minmax(0,1fr)_104px_104px_132px]'

export function HrLoanBoard({
  loans,
  roster,
  userName,
  canSettle,
  isBoss,
}: {
  loans: Loan[]
  roster: string[]
  userName: string
  /** 管钱那一档 —— 能批 (但自己填的不行)。 */
  canSettle: boolean
  isBoss: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const listId = useId()

  const pendingCount = loans.filter((l) => loanStage(l) === 'pending').length
  const [filter, setFilter] = useState<Filter>(pendingCount > 0 ? 'pending' : 'all')
  const [open, setOpen] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [monthly, setMonthly] = useState('')
  const [error, setError] = useState<string | null>(null)

  const shown = useMemo(
    () => (filter === 'pending' ? loans.filter((l) => loanStage(l) === 'pending') : loans),
    [loans, filter],
  )

  function num(s: string): number {
    return Number(s.trim().replace(/[¥,，元\s]/g, ''))
  }

  function apply() {
    const n = num(amount)
    if (!name.trim()) return setError('先填借款人')
    if (!Number.isFinite(n) || n <= 0) return setError('借款金额要填一个正数')
    if (!reason.trim()) return setError('写一句借款事由')
    const m = monthly.trim() ? num(monthly) : undefined
    if (m !== undefined && (!Number.isFinite(m) || m < 0)) return setError('每月扣回要填数字')
    setError(null)
    start(async () => {
      try {
        const r = await mutate<{ id: string; no: string }>({
          kind: 'createLoan',
          input: { name: name.trim(), amountCny: n, reason: reason.trim(), monthlyCny: m },
        })
        setName('')
        setAmount('')
        setReason('')
        setMonthly('')
        setFilter('pending')
        setOpen(r.data.id)
        showToast(`${r.data.no} 已提交，等审批`, 'success')
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '提交不上')
      }
    })
  }

  const inp =
    'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 md:px-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="借款人"
            list={listId}
            className={`${inp} w-[120px]`}
          />
          <datalist id={listId}>
            {roster.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="借款金额"
            inputMode="decimal"
            className={`mono ${inp} w-[104px] text-right`}
          />
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="事由"
            className={`${inp} min-w-[140px] flex-1`}
          />
          <input
            value={monthly}
            onChange={(e) => setMonthly(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
            placeholder="每月工资扣回 · 空=一次扣清"
            inputMode="decimal"
            className={`mono ${inp} w-[180px] text-right`}
          />
          <button
            type="button"
            onClick={apply}
            disabled={pending}
            className="h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
          >
            提交申请
          </button>
        </div>
        {error && <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>}
      </div>

      <div className="mb-4 flex items-baseline gap-4">
        {(
          [
            ['pending', `待审批${pendingCount > 0 ? ` ${pendingCount}` : ''}`],
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

      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div
          className={`hidden ${COLS} items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid`}
        >
          <span className="label">借款单号</span>
          <span className="label">借款人 · 事由</span>
          <span className="label text-right">借款</span>
          <span className="label text-right">每月扣回</span>
          <span className="label text-right">状态</span>
        </div>
        {shown.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {loans.length === 0 ? '还没有借款申请 —— 上面填一笔就开始了' : '没有等着批的'}
          </p>
        ) : (
          shown.map((l) => {
            const st = loanStage(l)
            const canApprove = canSettle && (isBoss || l.appliedBy !== userName)
            return (
              <Fragment key={l.id}>
                <button
                  type="button"
                  onClick={() => setOpen(open === l.id ? null : l.id)}
                  className={`grid w-full ${COLS} items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 text-left last:border-b-0 md:px-5 ${
                    open === l.id ? 'bg-[#faf8f2]' : 'hover:bg-[#faf8f2]'
                  } ${st === 'rejected' ? 'opacity-55' : ''}`}
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
                  <span className="mono hidden text-right text-[12.5px] text-[var(--color-ink-2)] md:block">
                    {l.monthlyCny ? formatCny(l.monthlyCny) : '一次扣清'}
                  </span>
                  <span className={`text-right text-[12.5px] ${STAGE_TONE[st]}`}>
                    {stageText(st)}
                  </span>
                </button>
                {open === l.id && (
                  <Detail l={l} canApprove={canApprove} canSettle={canSettle} />
                )}
              </Fragment>
            )
          })
        )}
      </div>

      <p className="mt-4 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
        填好的申请由于海伟、老板或财务来批，自己填的自己批不了。批下来就转到财务，放款以后每个月发工资时自动扣回，扣完自动关闭。
      </p>
    </div>
  )
}

function Detail({
  l,
  canApprove,
  canSettle,
}: {
  l: Loan
  canApprove: boolean
  canSettle: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const st = loanStage(l)
  const [armReject, setArmReject] = useState(false)
  const [rejectNote, setRejectNote] = useState('')
  const [armWithdraw, setArmWithdraw] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function run(body: Record<string, unknown> & { kind: string }, ok?: string) {
    setError(null)
    start(async () => {
      try {
        await mutate(body)
        if (ok) showToast(ok, 'success')
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '办不了')
      }
    })
  }

  const btn =
    'h-9 shrink-0 rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 text-[13px] font-medium text-[var(--color-ink-2)] hover:border-[var(--color-ink-3)] hover:text-[var(--color-ink)] disabled:opacity-50'

  return (
    <div className="border-b border-[var(--color-border)] bg-[#faf8f2] px-4 py-4 last:border-b-0 md:px-5">
      <div className="space-y-1 text-[12.5px] text-[var(--color-ink-2)]">
        <p>
          <span className="text-[var(--color-ink-4)]">申请</span> {l.appliedBy} ·{' '}
          {l.appliedAt.slice(0, 10)} · 借 {formatCny(l.amountCny)}，{l.reason}，
          {l.monthlyCny ? `每月工资扣回 ${formatCny(l.monthlyCny)}` : '放款后下个工资一次扣清'}
        </p>
        {l.decision && (
          <p>
            <span className="text-[var(--color-ink-4)]">
              {l.decision === 'approved' ? '同意' : '驳回'}
            </span>{' '}
            {l.decidedBy} · {l.decidedAt?.slice(0, 10)}
            {l.rejectNote ? `，${l.rejectNote}` : ''}
          </p>
        )}
        {l.paidOutAt && (
          <p>
            <span className="text-[var(--color-ink-4)]">放款</span> {l.paidOutBy} · {l.paidOutAt}
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        {st === 'pending' &&
          (canApprove ? (
            armReject ? (
              <>
                <input
                  value={rejectNote}
                  onChange={(e) => setRejectNote(e.target.value)}
                  placeholder="驳回原因 · 可空"
                  autoFocus
                  className="h-9 min-w-[200px] flex-1 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-[13px] outline-none md:max-w-[320px]"
                />
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run({ kind: 'decideLoan', loanId: l.id, decision: 'rejected', note: rejectNote }, '已驳回')
                  }
                  className="h-9 shrink-0 rounded-[2px] bg-[var(--color-overdue)] px-4 text-[13px] font-medium text-white hover:opacity-85 disabled:opacity-50"
                >
                  确认驳回
                </button>
                <button
                  type="button"
                  onClick={() => setArmReject(false)}
                  className="text-[12.5px] text-[var(--color-ink-3)]"
                >
                  取消
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run({ kind: 'decideLoan', loanId: l.id, decision: 'approved' }, '已同意，转到财务等放款')
                  }
                  className="h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
                >
                  同意
                </button>
                <button type="button" onClick={() => setArmReject(true)} className={btn}>
                  驳回
                </button>
              </>
            )
          ) : (
            <span className="text-[12.5px] text-[var(--color-ink-3)]">
              {canSettle ? '这笔是你填的，要让另一个人来批' : '等于海伟、老板或财务来批'}
            </span>
          ))}

        {error && <span className="text-[12px] text-[var(--color-overdue)]">{error}</span>}

        {!l.paidOutAt && (
          <span className="ml-auto text-[11.5px]">
            {armWithdraw ? (
              <span className="inline-flex gap-3">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run({ kind: 'withdrawLoan', loanId: l.id }, '已撤回')}
                  className="font-medium text-[var(--color-overdue)] hover:underline"
                >
                  确认撤回
                </button>
                <button
                  type="button"
                  onClick={() => setArmWithdraw(false)}
                  className="text-[var(--color-ink-3)]"
                >
                  取消
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setArmWithdraw(true)}
                className="text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
              >
                撤回这笔申请
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  )
}
