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
          应出勤 {s.standardDays} 天 / {fmt(s.standardHours)} 小时 · 实际出勤{' '}
          {fmt(s.workedDays)} 天
        </span>
      </div>

      {/* 一张条子两段: 前半段出勤工资 (人到岗才有的那几项), 后半段各项补
          助, 两段加起来是应发工资。顺序和屏幕上、导出的工资表完全一样 ——
          三处读到的是同一张表。 */}
      <div className="grid grid-cols-2 gap-x-8 py-2">
        <div>
          <p className="label mb-0.5">出勤工资</p>
          <Row label="基本工资" v={s.baseSalaryCny} />
          {s.splitApplies && <Row label="岗位补助" v={s.postSubsidyCny} />}
          <Row
            label={s.otHours > 0 ? `加班费 · ${fmt(s.otHours)} 小时` : '加班费'}
            v={s.otPay}
          />
          <Row label="出勤工资" v={s.attendancePayCny} strong />

          <p className="label mt-2 mb-0.5">其他项目</p>
          <Row label="餐补" v={s.mealCny} />
          <Row label="话费补助" v={s.phoneAllowanceCny} />
          <Row label="交通补助" v={s.transportAllowanceCny} />
          <Row label="绩效工资" v={s.perfPayCny} />
          {s.splitApplies && (
            <>
              <Row label="安全补贴" v={s.safetyFeeCny} />
              <Row label="保密补贴" v={s.secretFeeCny} />
            </>
          )}
          {s.splitApplies && (
            <>
              <Row label="全勤" v={s.fullAttendanceCny} />
            </>
          )}
          <Row label="社保补贴" v={s.socialSubsidyCny} />
          <Row label="福利" v={s.welfareCny} />
          {PAYROLL_ADD_FIELDS.map(([k, label]) => (
            <Row key={k} label={label} v={s[k]} />
          ))}
          {s.adjustCny !== 0 && (
            <Row label={s.adjustCny > 0 ? '奖' : '罚'} v={s.adjustCny} />
          )}
          <Row label="应发工资" v={s.grossCny} strong />
          {/* 房补不进应发, 实发时加回去 —— 单独一行摆在应发下面。 */}
          <Row
            label={
              s.workedDays < s.standardDays && s.housingBaseCny > 0
                ? `房补 · 出勤 ${fmt(s.workedDays)}/${s.standardDays} 天`
                : '房补'
            }
            v={s.housingAllowanceCny}
          />
        </div>
        <div>
          <p className="label mb-0.5">扣款</p>
          {s.attendanceCutCny > 0 && (
            <Row label="缺勤扣" v={s.attendanceCutCny} />
          )}
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
