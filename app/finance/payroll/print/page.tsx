import { requireOrderLedgerViewer, canSeeExpenses } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { loadPayroll } from '@/lib/payroll-store'
import {
  isPayrollMonth,
  monthLabel,
  PAYROLL_ADD_FIELDS,
  PAYROLL_CUT_FIELDS,
  type Payslip,
} from '@/lib/payroll'
import { formatCny } from '@/lib/data'
import { today } from '@/lib/today'
import { BRAND } from '@/lib/brand'
import { PrintButton } from '@/app/_print_button'

export const dynamic = 'force-dynamic'

// 工资条 —— 发到人手上的那一小张。
//
// 一页三张, 中间虚线剪开: 厂里发工资就是这么发的, 一沓打出来、剪开、连着钱
// 一起给。每张右下角留了领款人签名 —— 那一笔字是这张条子存在的理由, 钱发出
// 去以后再问"发没发", 靠的就是它。
//
// 不带客户、不带别人的数: 一个人只看得到自己那张。
export default async function PayslipPrintPage(props: {
  searchParams: Promise<{ m?: string; name?: string }>
}) {
  const user = await requireOrderLedgerViewer()
  if (!canSeeExpenses(user)) redirect('/finance')
  const sp = await props.searchParams
  const month = isPayrollMonth(sp.m) ? sp.m : today().slice(0, 7)
  const only = (sp.name ?? '').trim()

  const view = await loadPayroll(month)
  const all = view.paid ? view.paid.slips : view.slips
  const slips = only ? all.filter((s) => s.name === only) : all

  return (
    <>
      <PrintButton />
      <div className="doc">
        <p className="mb-4 text-center text-[13px] tracking-wide text-[var(--color-ink)]">
          {BRAND.legalName} · {monthLabel(month)}工资条
          {view.paid ? ' (已发放)' : ''}
        </p>
        {slips.length === 0 ? (
          <p className="py-16 text-center text-[13px] text-[var(--color-ink-3)]">
            这个月还没有工资条
          </p>
        ) : (
          slips.map((s) => <Slip key={s.name} s={s} month={month} />)
        )}
      </div>
    </>
  )
}

function Slip({ s, month }: { s: Payslip; month: string }) {
  return (
    <section
      // 每张条子自成一块, 打印时不许从中间断开 —— 断在一半的工资条是废纸。
      style={{ breakInside: 'avoid' }}
      className="mb-5 border border-dashed border-[var(--color-ink-3)] px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-[var(--color-ink)] pb-1.5">
        <span className="text-[15px] font-semibold tracking-tight">
          {s.name}
        </span>
        <span className="text-[12px] text-[var(--color-ink-2)]">
          {s.dept} · {monthLabel(month)}
        </span>
        <span className="mono text-[12px] text-[var(--color-ink-2)]">
          应出勤 {s.standardDays} 天 · 实际出勤 {fmt(s.workedDays)} 天
        </span>
      </div>

      {/* 工资构成 —— 综合工资怎么拆的。不加钱, 只是写清楚。 */}
      <div className="flex flex-wrap gap-x-6 gap-y-0.5 border-b border-[var(--color-border)] py-1.5 text-[11.5px] text-[var(--color-ink-2)]">
        <span>综合工资 {formatCny(s.monthlyCny)}</span>
        {s.splitApplies && (
          <>
            <span>基本工资 {formatCny(s.baseSalaryCny)}</span>
            <span>话费补贴 {formatCny(s.phoneAllowanceCny)}</span>
            <span>交通补贴 {formatCny(s.transportAllowanceCny)}</span>
            <span>福利补贴 {formatCny(s.welfareAllowanceCny)}</span>
            <span>岗位补贴 {formatCny(s.postSubsidyCny)}</span>
            <span>保密费 {formatCny(s.secretFeeCny)}</span>
            <span>安全费 {formatCny(s.safetyFeeCny)}</span>
            <span>绩效工资 {formatCny(s.perfPayCny)}</span>
            <span>奖金 {formatCny(s.splitBonusCny)}</span>
          </>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-8 py-2">
        <div>
          <p className="label mb-0.5">应发</p>
          <Row label="出勤工资" v={s.attendancePayCny} />
          <Row label="加班费" v={s.otPay} />
          {PAYROLL_ADD_FIELDS.map(([k, label]) => (
            <Row key={k} label={label} v={s[k]} />
          ))}
          {s.adjustCny !== 0 && (
            <Row label={s.adjustCny > 0 ? '奖' : '罚'} v={s.adjustCny} />
          )}
          <Row label="应发合计" v={s.grossCny} strong />
        </div>
        <div>
          <p className="label mb-0.5">扣款</p>
          {PAYROLL_CUT_FIELDS.map(([k, label]) => (
            <Row key={k} label={label} v={s[k]} />
          ))}
          <Row label="扣款合计" v={s.deductCny} strong />
        </div>
      </div>

      <div className="flex items-end justify-between gap-6 border-t border-[var(--color-ink)] pt-2">
        <span className="flex items-baseline gap-2">
          <span className="label">实发工资</span>
          <span className="mono text-[17px] font-semibold tabular-nums">
            {formatCny(s.netCny)}
          </span>
        </span>
        <span className="flex min-w-[200px] items-end gap-2">
          <span className="label shrink-0">领款人签名</span>
          <span className="h-px flex-1 translate-y-[-3px] bg-[var(--color-ink)]" />
        </span>
      </div>
    </section>
  )
}

function Row({
  label,
  v,
  strong,
}: {
  label: string
  v: number
  strong?: boolean
}) {
  // 0 也印出来 —— 工资条上一格空着, 拿到手的人第一反应是"是不是漏了"。
  return (
    <div
      className={`flex items-baseline justify-between gap-3 py-[1px] text-[12px] ${
        strong ? 'mt-0.5 border-t border-[var(--color-border-strong)] pt-1' : ''
      }`}
    >
      <span className="text-[var(--color-ink-2)]">{label}</span>
      <span
        className={`mono tabular-nums ${
          strong ? 'font-semibold text-[var(--color-ink)]' : 'text-[var(--color-ink)]'
        }`}
      >
        {formatCny(v)}
      </span>
    </div>
  )
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}
