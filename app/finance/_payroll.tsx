'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { EditableText } from '@/app/_editable'
import { formatCny } from '@/lib/data'
import {
  monthLabel,
  payrollTotal,
  type PayrollRules,
  type Payslip,
} from '@/lib/payroll'

// 工资 — one month, one line per person, and the month's arithmetic done for
// you.
//
// The 考勤 columns (事假/病假/旷工/迟到) are not typed here: they come straight
// off 人事, which the 工段长 already fills in the day something happens. The
// only two things nobody can know from the log — 加班小时 and 奖罚 — are the
// only two cells that take a keystroke. 实发 derives.
//
// The sentence under the title IS the 制度: 月休4天, 每天8小时, and what a 病假
// or a 旷工 hour costs. Change a number in it and every row re-reads itself,
// because there is no second place the rules are written down.
//
// 发放 turns the month into 支出台账 rows (类别 工资) and freezes it — after
// that the numbers on screen are the ones that were handed over, not a live
// formula. 撤销 deletes exactly the rows 发放 created.

export type PayrollBoardProps = {
  month: string
  months: string[]
  rules: PayrollRules
  slips: Payslip[]
  /** 名册里还没定月薪的人 — 填上月薪就上工资表。 */
  offRoster: string[]
  paid: { at: string; by: string; total: number; count: number } | null
}

const COLS =
  'grid-cols-[minmax(0,1fr)_92px] md:grid-cols-[minmax(0,1fr)_84px_50px_50px_50px_44px_58px_74px_96px]'

export function PayrollBoard({
  month,
  months,
  rules,
  slips,
  offRoster,
  paid,
}: PayrollBoardProps) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [open, setOpen] = useState<string | null>(null)
  // 未定月薪 is setup, not daily reading — it opens itself the first time
  // (nobody on payroll yet) and stays folded away after that.
  const [showOff, setShowOff] = useState(slips.length === 0)

  const locked = paid !== null
  const total = paid ? paid.total : payrollTotal(slips)

  const monthOptions = [...new Set([...months, month])].sort().reverse()

  function go(m: string) {
    setOpen(null)
    router.push(`/finance?tab=payroll&pm=${m}`)
  }

  // Lets the failure through on purpose: EditableText reverts the cell and
  // toasts the server's own words (e.g. 这个月已发放，先撤销再改).
  async function save(body: Record<string, unknown> & { kind: string }) {
    await mutate(body)
    router.refresh()
  }

  function pay() {
    if (
      !confirm(
        `发放${monthLabel(month)}工资 · ${slips.length} 人 · ${formatCny(total)}？\n发放后会自动记进支出台账。`,
      )
    )
      return
    start(async () => {
      try {
        const r = await mutate<{ count: number; total: number }>({
          kind: 'payPayroll',
          month,
        })
        showToast(
          `已发放 · ${r.data.count} 人 · ${formatCny(r.data.total)}`,
          'success',
        )
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '发放失败', 'warning')
      }
    })
  }

  function unpay() {
    if (
      !confirm(
        `撤销${monthLabel(month)}的发放？\n会一并删掉它记进支出台账的 ${paid?.count ?? 0} 条工资。`,
      )
    )
      return
    start(async () => {
      try {
        await mutate({ kind: 'unpayPayroll', month })
        showToast('已撤销', 'success')
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '撤销失败', 'warning')
      }
    })
  }

  const chip =
    'rounded-[2px] border px-3 py-1.5 text-[12.5px] font-medium whitespace-nowrap bg-[var(--color-surface)]'

  return (
    <div>
      {/* 月份 */}
      <div className="mb-6 flex flex-wrap items-center gap-1.5">
        {monthOptions.slice(0, 13).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => go(m)}
            className={`${chip} ${
              m === month
                ? 'border-[var(--color-ink)] text-[var(--color-ink)] shadow-[inset_0_0_0_1px_var(--color-ink)]'
                : 'border-[var(--color-border)] text-[var(--color-ink-3)] hover:border-[var(--color-border-strong)]'
            }`}
          >
            {monthLabel(m)}
          </button>
        ))}
      </div>

      {/* 合计 + 发放 */}
      <div className="mb-8 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div>
          <p className="text-[32px] md:text-[36px] font-semibold tracking-tight tabular-nums leading-none text-[var(--color-ink)]">
            {formatCny(total)}
          </p>
          <p className="label mt-3">
            {monthLabel(month)}
            {paid ? '实发' : '应发'}
          </p>
          <p className="mt-1 text-[12px] tabular-nums text-[var(--color-ink-3)]">
            {paid
              ? `${paid.count} 人 · ${paid.by} 于 ${paid.at.slice(0, 10)} 发放`
              : `${slips.length} 人在册`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={`/finance/payroll/export?m=${month}`}
            className="rounded-[2px] border border-[var(--color-border)] px-4 py-2 text-[13px] font-medium text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)]"
          >
            导出工资表
          </Link>
          {paid ? (
            <button
              type="button"
              onClick={unpay}
              disabled={pending}
              className="rounded-[2px] border border-[var(--color-border)] px-4 py-2 text-[13px] font-medium text-[var(--color-ink-3)] hover:border-[var(--color-overdue)] hover:text-[var(--color-overdue)] disabled:opacity-50"
            >
              撤销发放
            </button>
          ) : (
            <button
              type="button"
              onClick={pay}
              disabled={pending || slips.length === 0}
              className="rounded-[2px] bg-[var(--color-ink)] px-5 py-2 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-40"
            >
              发放
            </button>
          )}
        </div>
      </div>

      {/* 制度 — the sentence every number on this page is computed from. */}
      <div className="mb-6 flex flex-wrap items-center gap-x-1 gap-y-2 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[12.5px] text-[var(--color-ink-3)]">
        <span className="mr-2 font-medium text-[var(--color-ink-2)]">制度</span>
        <Rule label="月休" unit="天" value={rules.restDays} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'restDays', value: v })} />
        <Sep />
        <Rule label="每天" unit="小时" value={rules.hoursPerDay} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'hoursPerDay', value: v })} />
        <Sep />
        <Rule label="病假扣" unit="%" value={rules.sickPct} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'sickPct', value: v })} />
        <Sep />
        <Rule label="旷工扣" unit="%" value={rules.absentPct} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'absentPct', value: v })} />
        <Sep />
        <Rule label="迟到每次扣" unit="元" value={rules.latePerTime} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'latePerTime', value: v })} />
        <Sep />
        <Rule label="加班" unit="倍" value={rules.otRate} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'otRate', value: v })} />
        <span className="ml-auto text-[11.5px] text-[var(--color-ink-4)]">
          事假全扣 · 工伤不扣 · 违纪和质量异常自己定奖罚
        </span>
      </div>

      {/* 工资表 */}
      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div
          className={`hidden ${COLS} items-center gap-2 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid`}
        >
          <span className="label">姓名</span>
          <span className="label text-right">月薪</span>
          <span className="label text-center">事假</span>
          <span className="label text-center">病假</span>
          <span className="label text-center">旷工</span>
          <span className="label text-center">迟到</span>
          <span className="label text-center">加班</span>
          <span className="label text-center">奖罚</span>
          <span className="label text-right">实发</span>
        </div>

        {slips.length === 0 && offRoster.length === 0 ? (
          <p className="px-5 py-10 text-center text-[13px] text-[var(--color-ink-3)]">
            名册还是空的 — 人事里记过一笔的人会出现在这里
          </p>
        ) : null}

        {slips.map((s) => (
          <div
            key={s.name}
            className="border-b border-[var(--color-border)] last:border-b-0"
          >
            <div
              className={`grid ${COLS} items-center gap-2 px-4 py-2.5 md:px-5 ${
                open === s.name ? 'bg-[#faf8f2]' : 'hover:bg-[#faf8f2]'
              }`}
            >
              <button
                type="button"
                onClick={() => setOpen(open === s.name ? null : s.name)}
                className="flex min-w-0 items-baseline gap-2 text-left"
              >
                <span className="truncate text-[14.5px] font-medium tracking-tight text-[var(--color-ink)]">
                  {s.name}
                </span>
                {s.attendance.disciplineTimes > 0 && (
                  <span className="shrink-0 text-[11.5px] text-[var(--color-overdue)]">
                    违纪{s.attendance.disciplineTimes}
                  </span>
                )}
                {s.attendance.qualityTimes > 0 && (
                  <span className="shrink-0 text-[11.5px] text-[var(--color-overdue)]">
                    质量{s.attendance.qualityTimes}
                  </span>
                )}
              </button>

              <Num
                className="hidden md:block"
                value={s.monthlyCny}
                locked={locked}
                onSave={(v) =>
                  save({ kind: 'setPayrollBase', name: s.name, monthlyCny: v })
                }
              />
              <Att value={s.attendance.leaveHours} unit="h" />
              <Att value={s.attendance.sickHours} unit="h" />
              <Att value={s.attendance.absentHours} unit="h" heavy />
              <Att value={s.attendance.lateTimes} unit="" heavy />
              <Num
                className="hidden md:block"
                align="center"
                value={s.otHours}
                locked={locked}
                onSave={(v) =>
                  save({
                    kind: 'setPayrollLine',
                    month,
                    name: s.name,
                    patch: { otHours: v },
                  })
                }
              />
              <Num
                className="hidden md:block"
                align="center"
                signed
                value={s.adjustCny}
                locked={locked}
                onSave={(v) =>
                  save({
                    kind: 'setPayrollLine',
                    month,
                    name: s.name,
                    patch: { adjustCny: v },
                  })
                }
              />
              <button
                type="button"
                onClick={() => setOpen(open === s.name ? null : s.name)}
                className={`mono text-right text-[13.5px] font-semibold tabular-nums ${
                  s.netCny < 0
                    ? 'text-[var(--color-overdue)]'
                    : 'text-[var(--color-ink)]'
                }`}
              >
                {formatCny(s.netCny)}
              </button>
            </div>

            {open === s.name && <Slip slip={s} />}
          </div>
        ))}

        {/* 还没定月薪的人 — 填一个数就上表。 */}
        {offRoster.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setShowOff(!showOff)}
              className="flex w-full items-center gap-1.5 border-b border-t border-[var(--color-border)] bg-[#f5f3ed] px-5 py-1.5 text-left hover:bg-[#efece4]"
            >
              <span className="label text-[var(--color-ink-3)]">
                未定月薪 · {offRoster.length} 人
              </span>
              <span className="text-[11px] text-[var(--color-ink-4)]">
                {showOff ? '收起' : '填月薪就上表'}
              </span>
            </button>
            {showOff && offRoster.map((name) => (
              <div
                key={name}
                className={`grid ${COLS} items-center gap-2 border-b border-[var(--color-border)] px-4 py-2 last:border-b-0 md:px-5`}
              >
                <span className="truncate text-[14px] text-[var(--color-ink-3)]">
                  {name}
                </span>
                <Num
                  className="hidden md:block"
                  value={0}
                  locked={locked}
                  placeholder="填月薪"
                  onSave={(v) =>
                    save({ kind: 'setPayrollBase', name, monthlyCny: v })
                  }
                />
              </div>
            ))}
          </>
        )}
      </div>

      <p className="mt-4 text-[12px] text-[var(--color-ink-3)]">
        事假 · 病假 · 旷工 · 迟到 全部读自
        <Link href={`/hr?p=${month}`} className="mx-1 underline decoration-[var(--color-border-strong)] underline-offset-2 hover:text-[var(--color-ink)]">
          人事
        </Link>
        ，在那边记，这边自动算。点名字看工资条。
      </p>
    </div>
  )
}

// 工资条 — the arithmetic in the order it runs, so it answers the question a
// person actually asks: 为什么是这个数.
function Slip({ slip: s }: { slip: Payslip }) {
  const rows: [string, string, number][] = []
  if (s.attendance.leaveHours > 0)
    rows.push(['事假', `${num(s.attendance.leaveHours)} 小时`, -s.leaveCut])
  if (s.attendance.sickHours > 0)
    rows.push(['病假', `${num(s.attendance.sickHours)} 小时`, -s.sickCut])
  if (s.attendance.injuryHours > 0)
    rows.push(['工伤', `${num(s.attendance.injuryHours)} 小时 · 不扣`, 0])
  if (s.attendance.absentHours > 0)
    rows.push(['旷工', `${num(s.attendance.absentHours)} 小时`, -s.absentCut])
  if (s.attendance.lateTimes > 0)
    rows.push(['迟到', `${s.attendance.lateTimes} 次`, -s.lateCut])
  if (s.otHours > 0) rows.push(['加班', `${num(s.otHours)} 小时`, s.otPay])
  if (s.adjustCny !== 0)
    rows.push([s.adjustCny > 0 ? '奖' : '罚', s.note ?? '', s.adjustCny])

  return (
    <div className="border-t border-[var(--color-border)] bg-[#faf8f2] px-4 py-3 md:px-5">
      <div className="mx-auto max-w-[520px]">
        <p className="mono mb-2 text-[12px] text-[var(--color-ink-3)] tabular-nums">
          月薪 {formatCny(s.monthlyCny)} ÷ 应出勤 {s.standardDays} 天 ÷{' '}
          {num(s.standardHours / s.standardDays)} 小时 = 时薪 ¥
          {s.hourlyCny.toFixed(1)}
        </p>
        <div className="flex items-baseline justify-between border-b border-[var(--color-border)] py-1.5">
          <span className="text-[13px] text-[var(--color-ink-2)]">月薪</span>
          <span className="mono text-[13px] tabular-nums text-[var(--color-ink)]">
            {formatCny(s.monthlyCny)}
          </span>
        </div>
        {rows.map(([label, detail, amount], i) => (
          <div
            key={`${label}-${i}`}
            className="flex items-baseline justify-between gap-3 border-b border-[var(--color-border)] py-1.5"
          >
            <span className="min-w-0 truncate text-[13px] text-[var(--color-ink-2)]">
              {label}
              {detail && (
                <span className="ml-2 text-[12px] text-[var(--color-ink-3)]">
                  {detail}
                </span>
              )}
            </span>
            <span
              className={`mono shrink-0 text-[13px] tabular-nums ${
                amount < 0
                  ? 'text-[var(--color-overdue)]'
                  : amount > 0
                    ? 'text-[var(--color-success)]'
                    : 'text-[var(--color-ink-3)]'
              }`}
            >
              {amount === 0
                ? '—'
                : `${amount > 0 ? '+' : '−'}${formatCny(Math.abs(amount))}`}
            </span>
          </div>
        ))}
        <div className="flex items-baseline justify-between py-2">
          <span className="text-[13px] font-medium text-[var(--color-ink)]">
            实发
          </span>
          <span className="mono text-[15px] font-semibold tabular-nums text-[var(--color-ink)]">
            {formatCny(s.netCny)}
          </span>
        </div>
        <p className="mono text-[11.5px] text-[var(--color-ink-4)] tabular-nums">
          实际工时 {num(s.workedHours)} 小时 · 应出勤 {num(s.standardHours)} 小时
        </p>
      </div>
    </div>
  )
}

// 考勤格 — read-only, it belongs to 人事.
function Att({
  value,
  unit,
  heavy,
}: {
  value: number
  unit: string
  heavy?: boolean
}) {
  return (
    <span
      className={`mono hidden text-center text-[12.5px] tabular-nums md:block ${
        value === 0
          ? 'text-[var(--color-ink-4)]'
          : heavy
            ? 'font-semibold text-[var(--color-overdue)]'
            : 'text-[var(--color-ink-2)]'
      }`}
    >
      {value === 0 ? '·' : `${num(value)}${unit}`}
    </span>
  )
}

// 可改的数字格. A paid-out month is history, so every cell goes read-only once
// 发放 has happened.
function Num({
  value,
  onSave,
  locked,
  align = 'right',
  signed = false,
  placeholder = '—',
  className = '',
}: {
  value: number
  onSave: (v: number) => Promise<void>
  locked: boolean
  align?: 'right' | 'center'
  signed?: boolean
  placeholder?: string
  className?: string
}) {
  const shown = value === 0 ? '' : signed && value > 0 ? `+${num(value)}` : num(value)
  if (locked) {
    return (
      <span
        className={`mono text-${align} text-[12.5px] tabular-nums text-[var(--color-ink-2)] ${className}`}
      >
        {shown || '·'}
      </span>
    )
  }
  return (
    <div className={className}>
      <EditableText
        mono
        align={align}
        value={shown}
        placeholder={placeholder}
        className="text-[12.5px] tabular-nums"
        onSave={async (next) => {
          const t = next.trim().replace(/[¥,，元\s]/g, '').replace(/−/g, '-')
          const n = t === '' ? 0 : Number(t)
          if (!Number.isFinite(n)) throw new Error('要填数字')
          await onSave(n)
        }}
      />
    </div>
  )
}

function Rule({
  label,
  unit,
  value,
  onSave,
  locked,
}: {
  label: string
  unit: string
  value: number
  onSave: (v: number) => Promise<void>
  locked: boolean
}) {
  return (
    <span className="inline-flex items-baseline">
      {label}
      {locked ? (
        <span className="mono mx-1 text-[var(--color-ink)] tabular-nums">
          {num(value)}
        </span>
      ) : (
        <span className="mx-0.5 inline-block w-[42px]">
          <EditableText
            mono
            align="center"
            value={num(value)}
            className="text-[12.5px] tabular-nums text-[var(--color-ink)]"
            onSave={async (next) => {
              const n = Number(next.trim())
              if (!Number.isFinite(n)) throw new Error('要填数字')
              await onSave(n)
            }}
          />
        </span>
      )}
      {unit}
    </span>
  )
}

function Sep() {
  return <span className="mx-2 text-[var(--color-ink-4)]">·</span>
}

// 8 not 8.0, 7.5 stays 7.5.
function num(n: number): string {
  return String(Math.round(n * 10) / 10)
}
