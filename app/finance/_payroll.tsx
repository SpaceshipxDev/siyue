'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { mutate } from '@/lib/mutate'
import { withBase } from '@/lib/base-path'
import { showToast } from '@/app/_toast'
import { EditableText } from '@/app/_editable'
import { formatCny } from '@/lib/data'
import {
  deptsInUse,
  hoursForDept,
  monthLabel,
  payrollTotal,
  PAYROLL_ADD_FIELDS,
  PAYROLL_ALLOWANCE_FIELDS,
  PAYROLL_CUT_FIELDS,
  DEPARTMENTS,
  NO_DEPARTMENT,
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
  /** 名册里还没定月薪的人 — 填上月薪就上工资表。部门是猜出来的起手值。 */
  offRoster: { name: string; dept: string }[]
  paid: { at: string; by: string; total: number; count: number } | null
}

const COLS =
  'grid-cols-[minmax(0,1fr)_92px] md:grid-cols-[minmax(0,1fr)_76px_84px_50px_50px_50px_44px_58px_74px_96px]'

const DEPT_OPTIONS = [...DEPARTMENTS, NO_DEPARTMENT]

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
  // 每天工时 normally lists only the 部门 that have somebody in them; the whole
  // org chart is one click away, and shows itself while the sheet is empty.
  const [allDepts, setAllDepts] = useState(slips.length === 0)
  const inUse = deptsInUse(slips)
  const hoursDepts = allDepts || inUse.length === 0 ? DEPT_OPTIONS : inUse

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
          {/* 一沓打出来、沿虚线剪开、连着钱发下去 —— 厂里发工资就是这么发
              的, 所以这一步不该是"先导出 Excel 再自己排版"。 */}
          <a
            href={withBase(`/finance/payroll/print?m=${month}`)}
            target="_blank"
            rel="noopener"
            className="rounded-[2px] border border-[var(--color-border)] px-4 py-2 text-[13px] font-medium text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)]"
          >
            打印工资条
          </a>
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

      {/* 制度 — 全厂一条月休, 一个部门一个工时, 剩下的是缺勤怎么算钱。 */}
      <div className="mb-6 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[12.5px] text-[var(--color-ink-3)]">
        <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
          <span className="mr-2 w-[52px] shrink-0 font-medium text-[var(--color-ink-2)]">
            制度
          </span>
          <Rule label="月休" unit="天" value={rules.restDays} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'restDays', value: v })} />
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

        {/* 工资构成 —— 工资条上把综合工资拆成基本工资 + 几项补贴时用的数。
            这几个数只影响条子上怎么写, 不影响实发, 所以随手调不会把钱调错。 */}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-1 gap-y-2 border-t border-[var(--color-border)] pt-2.5">
          <span className="mr-2 w-[52px] shrink-0 font-medium text-[var(--color-ink-2)]">
            工资构成
          </span>
          <Rule label="基本工资" unit="元" value={rules.baseSalaryCny} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'baseSalaryCny', value: v })} />
          <Sep />
          <Rule label="话费默认" unit="元" value={rules.phoneAllowanceCny} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'phoneAllowanceCny', value: v })} />
          <Sep />
          <Rule label="交通默认" unit="元" value={rules.transportAllowanceCny} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'transportAllowanceCny', value: v })} />
          <Sep />
          <Rule label="福利默认" unit="元" value={rules.welfareAllowanceCny} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'welfareAllowanceCny', value: v })} />
          <Sep />
          <Rule label="超过" unit="元才拆" value={rules.splitThresholdCny} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'splitThresholdCny', value: v })} />
          <Sep />
          <Rule label="岗位补贴" unit="%" value={rules.postPct} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'postPct', value: v })} />
          <Sep />
          <Rule label="保密费" unit="%" value={rules.secretPct} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'secretPct', value: v })} />
          <Sep />
          <Rule label="安全费" unit="%" value={rules.safetyPct} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'safetyPct', value: v })} />
          <Sep />
          <Rule label="绩效工资" unit="%" value={rules.perfPct} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'perfPct', value: v })} />
          <span className="ml-auto text-[11.5px] text-[var(--color-ink-4)]">
            话费/交通/福利是默认数, 每个人可在工资条上单改 · 百分比按「综合工
            资 − 基本工资 − 这三项」算 · 只影响拆法, 不影响实发
          </span>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-1 gap-y-2 border-t border-[var(--color-border)] pt-2.5">
          <span className="mr-2 w-[52px] shrink-0 font-medium text-[var(--color-ink-2)]">
            每天工时
          </span>
          {hoursDepts.map((d, i) => (
            <span key={d} className="inline-flex items-baseline">
              {i > 0 && <Sep />}
              <span className="text-[var(--color-ink-2)]">{d}</span>
              <Rule
                label=""
                unit=""
                value={hoursForDept(rules, d)}
                locked={locked}
                onSave={(v) =>
                  save({ kind: 'setPayrollDeptHours', dept: d, hours: v })
                }
              />
            </span>
          ))}
          <Sep />
          <button
            type="button"
            onClick={() => setAllDepts(!allDepts)}
            className="text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-ink-2)]"
          >
            {allDepts ? '只看在册部门' : '全部部门'}
          </button>
        </div>
      </div>

      {/* 工资表 */}
      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div
          className={`hidden ${COLS} items-center gap-2 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid`}
        >
          <span className="label">姓名</span>
          <span className="label">部门</span>
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
                {!locked && (
                  // 名字是这张表的钥匙, 打错了以前只能重加一个人。改名只动名
                  // 册和还没发放的月份 —— 发过的工资条上那个名字是凭据。
                  <span
                    role="button"
                    tabIndex={0}
                    title="改名 — 已发放月份的工资条不动"
                    onClick={(e) => {
                      e.stopPropagation()
                      const next = prompt(`把「${s.name}」改成`, s.name)
                      if (!next || next.trim() === s.name) return
                      void save({
                        kind: 'renamePayrollPerson',
                        from: s.name,
                        to: next.trim(),
                      })
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="shrink-0 text-[11px] text-[var(--color-ink-4)] hover:text-[var(--color-ink)]"
                  >
                    改名
                  </span>
                )}
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

              <Dept
                value={s.dept}
                locked={locked}
                onSave={(d) =>
                  save({ kind: 'setPayrollDept', name: s.name, dept: d })
                }
              />
              <Num
                className="hidden md:block"
                value={s.monthlyCny}
                locked={locked}
                onSave={(v) =>
                  save({
                    kind: 'setPayrollBase',
                    name: s.name,
                    monthlyCny: v,
                    dept: s.dept,
                  })
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

            {open === s.name && (
              <Slip
                slip={s}
                month={month}
                locked={locked}
                save={save}
              />
            )}
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
            {showOff && offRoster.map((p) => (
              <div
                key={p.name}
                className={`grid ${COLS} items-center gap-2 border-b border-[var(--color-border)] px-4 py-2 last:border-b-0 md:px-5`}
              >
                <span className="truncate text-[14px] text-[var(--color-ink-3)]">
                  {p.name}
                </span>
                <span className="mono hidden truncate text-[12px] text-[var(--color-ink-4)] md:block">
                  {p.dept}
                </span>
                <Num
                  className="hidden md:block"
                  value={0}
                  locked={locked}
                  placeholder="填月薪"
                  onSave={(v) =>
                    save({
                      kind: 'setPayrollBase',
                      name: p.name,
                      monthlyCny: v,
                      dept: p.dept,
                    })
                  }
                />
              </div>
            ))}
          </>
        )}

        {/* 加人 —— 名册是被动长出来的 (开过账号、或者人事里记过一笔的人才在
            上面)。临时工、刚来的人两样都没有, 以前就只能先去别处记一笔再回
            来。填个名字和月薪, 这个人就上表了。 */}
        {!locked && (
          <AddPerson
            onAdd={(name, monthlyCny, dept) =>
              save({ kind: 'setPayrollBase', name, monthlyCny, dept })
            }
          />
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

// 直接往工资表上加一个人。收起来只有一行字, 展开是三个格 —— 名字、月薪、
// 部门。名字是这张表的钥匙, 所以填错了还能改 (见每一行名字上的「改名」)。
function AddPerson({
  onAdd,
}: {
  onAdd: (name: string, monthlyCny: number, dept: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [pay, setPay] = useState('')
  const [dept, setDept] = useState<string>(NO_DEPARTMENT)
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-1.5 border-t border-[var(--color-border)] px-5 py-2 text-left text-[12.5px] text-[var(--color-ink-3)] hover:bg-[#faf8f2] hover:text-[var(--color-ink)]"
      >
        ＋ 加人
        <span className="text-[11px] text-[var(--color-ink-4)]">
          没账号、人事里也没记过的人, 从这里进表
        </span>
      </button>
    )
  }

  const submit = () => {
    setError(null)
    const n = name.trim()
    const v = Number(pay.trim().replace(/[¥,，元\s]/g, ''))
    if (!n) {
      setError('先填名字')
      return
    }
    if (!Number.isFinite(v) || v <= 0) {
      setError('月薪要填一个数')
      return
    }
    start(async () => {
      try {
        await onAdd(n, Math.round(v), dept)
        setName('')
        setPay('')
        setDept(NO_DEPARTMENT)
        setOpen(false)
      } catch (e) {
        setError(e instanceof Error ? e.message : '加不上')
      }
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] bg-[#faf8f2] px-5 py-2.5">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="姓名"
        className="w-[120px] border-b border-[var(--color-border-strong)] bg-transparent py-1 text-[13px] focus:border-[var(--color-ink)] focus:outline-none"
      />
      <input
        value={pay}
        onChange={(e) => setPay(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="月薪"
        inputMode="numeric"
        className="mono w-[92px] border-b border-[var(--color-border-strong)] bg-transparent py-1 text-[13px] focus:border-[var(--color-ink)] focus:outline-none"
      />
      <select
        value={dept}
        onChange={(e) => setDept(e.target.value)}
        className="border-b border-[var(--color-border-strong)] bg-transparent py-1 text-[13px] focus:border-[var(--color-ink)] focus:outline-none"
      >
        {DEPT_OPTIONS.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={submit}
        disabled={pending}
        className="rounded-[2px] bg-[var(--color-ink)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-surface)] hover:opacity-80 disabled:opacity-40"
      >
        {pending ? '加中…' : '加进表'}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        disabled={pending}
        className="px-2 py-1.5 text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
      >
        取消
      </button>
      {error && (
        <span className="text-[12px] text-[var(--color-overdue)]">{error}</span>
      )}
    </div>
  )
}

// 工资条 — the arithmetic in the order it runs, so it answers the question a
// person actually asks: 为什么是这个数.
function Dept({
  value,
  onSave,
  locked,
}: {
  value: string
  onSave: (dept: string) => Promise<void>
  locked: boolean
}) {
  const [pending, setPending] = useState(false)
  if (locked) {
    return (
      <span className="mono hidden truncate text-[12px] text-[var(--color-ink-2)] md:block">
        {value}
      </span>
    )
  }
  return (
    <select
      value={value}
      disabled={pending}
      onChange={async (e) => {
        setPending(true)
        try {
          await onSave(e.target.value)
        } finally {
          setPending(false)
        }
      }}
      className={`mono hidden w-full cursor-pointer appearance-none rounded-[2px] border-0 bg-transparent px-1 -mx-1 py-0.5 text-[12px] text-[var(--color-ink-2)] outline-none transition-[background-color,box-shadow] duration-150 hover:bg-[var(--color-active-bg)] hover:shadow-[inset_0_-1px_0_var(--color-border-strong)] focus:bg-[var(--color-active-bg)] focus:shadow-[inset_0_-1px_0_var(--color-ink)] md:block ${
        pending ? 'opacity-60' : ''
      } ${value === NO_DEPARTMENT ? 'text-[var(--color-ink-4)]' : ''}`}
    >
      {DEPT_OPTIONS.map((d) => (
        <option key={d} value={d}>
          {d}
        </option>
      ))}
    </select>
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

// 工资条 —— 厂里发到手上的那张纸, 长在这一行下面。
//
// 左边应发, 右边扣款, 底下实发 —— 跟纸上的排法一样, 所以拿着条子的人不用重
// 新认一遍。能填的格子当场点着填 (社保、个税、房补这些是每月手录的), 发放之
// 后整张锁住。
//
// 条子上**不列事假 / 病假 / 工伤 / 旷工 / 迟到, 也不列它们各自的扣款**。那几
// 笔已经折进「出勤工资」这一个数里了; 把明细印在发到人手上的纸上, 换来的只
// 是当场对着条子争一句"那天不算旷工"。要查明细去人事页, 或者导出的工资表 ——
// 那两处一项都没少。
//
// 顶上那一段是"综合工资是怎么构成的": 基本工资加几项按比例的补贴。这几行只
// 是把综合工资拆开写, **不参与实发计算** —— 拆法改了，钱一分不变。
function Slip({
  slip: s,
  month,
  locked,
  save,
}: {
  slip: Payslip
  month: string
  locked: boolean
  save: (body: Record<string, unknown> & { kind: string }) => Promise<void>
}) {
  const setLine = (patch: Record<string, number>) =>
    save({ kind: 'setPayrollLine', month, name: s.name, patch })

  return (
    <div className="border-t border-[var(--color-border)] bg-[#faf8f2] px-4 py-4 md:px-5">
      <div className="mx-auto max-w-[860px]">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <p className="mono text-[12px] tabular-nums text-[var(--color-ink-3)]">
            {s.dept} · 应出勤 {s.standardDays} 天 · 实际出勤 {num(s.workedDays)} 天
            · 每天 {num(s.hoursPerDay)} 小时 · 时薪 ¥{s.hourlyCny.toFixed(1)}
          </p>
          <a
            href={withBase(`/finance/payroll/print?m=${month}&name=${encodeURIComponent(s.name)}`)}
            target="_blank"
            rel="noopener"
            className="text-[12px] text-[var(--color-ink-3)] underline underline-offset-2 hover:text-[var(--color-ink)]"
          >
            打印这张工资条
          </a>
        </div>

        {/* 工资构成 —— 只是拆法, 不加钱。 */}
        <div className="mb-4 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
          <p className="label mb-1.5 text-[var(--color-ink-3)]">
            工资构成 · 综合工资 {formatCny(s.monthlyCny)}
            {!s.splitApplies && ' · 未过拆分门槛'}
          </p>
          {s.splitApplies ? (
            <div className="grid grid-cols-2 gap-x-8 gap-y-1 md:grid-cols-3">
              <Ln label="基本工资" v={s.baseSalaryCny} />
              {/* 这两样一人一个价 (有人跑客户, 有人不出厂门), 所以点着就能
                  改; 不改就是制度里那个默认数。改完可分配额和下面四项立刻
                  跟着重算。 */}
              {PAYROLL_ALLOWANCE_FIELDS.map(([k, label]) => (
                <Edit
                  key={k}
                  label={label}
                  value={s[k]}
                  locked={locked}
                  onSave={(v) => setLine({ [k]: v })}
                />
              ))}
              <Ln label="岗位补贴" v={s.postSubsidyCny} />
              <Ln label="保密费" v={s.secretFeeCny} />
              <Ln label="安全费" v={s.safetyFeeCny} />
              <Ln label="绩效工资" v={s.perfPayCny} />
              {/* 按比例拆完剩下的那一截 —— 多了少了都落在奖金上, 所以上面
                  六项加起来永远等于综合工资。 */}
              <Ln label="奖金" v={s.splitBonusCny} />
            </div>
          ) : (
            <p className="text-[12.5px] text-[var(--color-ink-3)]">
              综合工资不高于拆分门槛，工资条上不拆分。
            </p>
          )}
          <p className="mt-1.5 text-[11px] text-[var(--color-ink-4)]">
            基本工资、话费、交通、福利是定额，先扣掉；后三项点着能改（一人一
            个价，不改就用制度里的默认数）。剩下的
            {s.splitApplies ? ` ${formatCny(s.splitBaseCny)} ` : ' '}
            才按比例分成岗位/保密/安全/绩效，分完的余额归入奖金。所以这六项加
            起来正好是综合工资。这是拆法，不额外加钱——实发从下面的出勤工资算起。
          </p>
        </div>

        <div className="grid grid-cols-1 gap-x-10 gap-y-1 md:grid-cols-2">
          {/* 应发 */}
          <div>
            <p className="label mb-1 text-[var(--color-ink-3)]">应发</p>
            <Ln label="出勤工资" v={s.attendancePayCny} strong />
            <Ln
              label={`加班费${s.otHours > 0 ? ` · ${num(s.otHours)} 小时` : ''}`}
              v={s.otPay}
            />
            {PAYROLL_ADD_FIELDS.map(([k, label]) => (
              <Edit
                key={k}
                label={label}
                value={s[k]}
                locked={locked}
                onSave={(v) => setLine({ [k]: v })}
              />
            ))}
            {s.adjustCny !== 0 && (
              <Ln label={s.adjustCny > 0 ? '奖' : '罚'} v={s.adjustCny} />
            )}
            <Ln label="应发合计" v={s.grossCny} strong divider />
          </div>

          {/* 扣款 */}
          <div>
            <p className="label mb-1 text-[var(--color-ink-3)]">扣款</p>
            {PAYROLL_CUT_FIELDS.map(([k, label]) => (
              <Edit
                key={k}
                label={label}
                value={s[k]}
                locked={locked}
                negative
                onSave={(v) => setLine({ [k]: v })}
              />
            ))}
            <Ln label="扣款合计" v={-s.deductCny} strong divider />
          </div>
        </div>

        <div className="mt-3 flex items-baseline justify-between border-t border-[var(--color-ink)] pt-2.5">
          <span className="text-[13.5px] font-medium text-[var(--color-ink)]">
            实发工资
          </span>
          <span
            className={`mono text-[17px] font-semibold tabular-nums ${
              s.netCny < 0
                ? 'text-[var(--color-overdue)]'
                : 'text-[var(--color-ink)]'
            }`}
          >
            {formatCny(s.netCny)}
          </span>
        </div>
        {s.note && (
          <p className="mt-1.5 text-[12px] text-[var(--color-ink-3)]">
            备注 · {s.note}
          </p>
        )}
      </div>
    </div>
  )
}

/** 一行只读的钱。 */
function Ln({
  label,
  detail,
  v,
  strong,
  divider,
}: {
  label: string
  detail?: string
  v: number
  strong?: boolean
  divider?: boolean
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 py-1 ${
        divider ? 'mt-0.5 border-t border-[var(--color-border-strong)]' : ''
      }`}
    >
      <span className="min-w-0 truncate text-[12.5px] text-[var(--color-ink-2)]">
        {label}
        {detail && (
          <span className="ml-2 text-[11.5px] text-[var(--color-ink-3)]">
            {detail}
          </span>
        )}
      </span>
      <span
        className={`mono shrink-0 tabular-nums ${
          strong
            ? 'text-[13.5px] font-semibold text-[var(--color-ink)]'
            : v < 0
              ? 'text-[12.5px] text-[var(--color-overdue)]'
              : 'text-[12.5px] text-[var(--color-ink)]'
        }`}
      >
        {v === 0 ? '—' : formatCny(v)}
      </span>
    </div>
  )
}

/** 一行能填的钱 —— 点着就改, 发放之后是死的。 */
function Edit({
  label,
  value,
  locked,
  negative,
  onSave,
}: {
  label: string
  value: number
  locked: boolean
  negative?: boolean
  onSave: (v: number) => Promise<void>
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="min-w-0 truncate text-[12.5px] text-[var(--color-ink-2)]">
        {label}
      </span>
      <span className="w-[96px] shrink-0">
        <Num
          value={value}
          locked={locked}
          onSave={onSave}
          placeholder="—"
          className={
            negative && value > 0 ? 'text-[var(--color-overdue)]' : undefined
          }
        />
      </span>
    </div>
  )
}

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
