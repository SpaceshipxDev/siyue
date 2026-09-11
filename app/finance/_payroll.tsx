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
  PAYROLL_CUT_FIELDS,
  deptPickerOptions,
  NO_DEPARTMENT,
  type PayrollRules,
  type Payslip,
} from '@/lib/payroll'

// 工资 — one month, one line per person, and the month's arithmetic done for
// you.
//
// The 考勤 columns (加班/事假/病假/旷工/迟到) are not typed here: they come
// straight off 人事, which the 工段长 already fills in the day something
// happens — 加班 included, so the shop's overtime hours live in exactly one
// book. 奖罚 is the one thing nobody can know from the log, so it is the one
// cell on the row that takes a keystroke. 实发 derives.
//
// The sentence under the title IS the 制度: 月休4天, 周六8小时, 每个部门每天几
// 小时, and what a 病假 or a 旷工 hour costs. Change a number in it and every
// row re-reads itself, because there is no second place the rules are written
// down.
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
  // 「每天工时」那一行展开时列的部门 —— 废掉的「操机」不在里面; 真还有人挂
  // 在它上面时, 它会从 deptsInUse 那条路进来, 照样能改工时。
  const allOptions = [...deptPickerOptions(rules), NO_DEPARTMENT]
  const hoursDepts = allDepts || inUse.length === 0 ? allOptions : inUse

  // 按部门筛 + 按姓名找 —— 一张表几十号人, 发工资是一个部门一个部门过的,
  // 而要改某一个人的时候, 想的是他的名字。
  const [deptFilter, setDeptFilter] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const needle = q.trim()
  const shown = slips.filter(
    (s) =>
      (deptFilter === null || s.dept === deptFilter) &&
      (needle === '' || s.name.includes(needle)),
  )

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
          <Rule label="周六" unit="小时" value={rules.saturdayHours} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'saturdayHours', value: v })} />
          <Sep />
          <Rule label="病假扣" unit="%" value={rules.sickPct} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'sickPct', value: v })} />
          <Sep />
          <Rule label="旷工扣" unit="%" value={rules.absentPct} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'absentPct', value: v })} />
          <Sep />
          <Rule label="迟到每次扣" unit="元" value={rules.latePerTime} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'latePerTime', value: v })} />
          <Sep />
          <span className="ml-auto text-[11.5px] text-[var(--color-ink-4)]">
            事假全扣 · 工伤不扣 · 违纪和质量异常自己定奖罚
          </span>
        </div>

        {/* 加班费 —— 厂里定死的小时价, 跟月薪无关。周六周日一个价, 平时一个
            价; 是哪种由人事那条记录的日期决定, 记的人不用选。 */}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-1 gap-y-2 border-t border-[var(--color-border)] pt-2.5">
          <span className="mr-2 w-[52px] shrink-0 font-medium text-[var(--color-ink-2)]">
            加班费
          </span>
          <Rule label="平时" unit="元/小时" value={rules.otWeekdayCny} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'otWeekdayCny', value: v })} />
          <Sep />
          <Rule label="周六周日" unit="元/小时" value={rules.otWeekendCny} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'otWeekendCny', value: v })} />
          <span className="ml-auto text-[11.5px] text-[var(--color-ink-4)]">
            加班小时记在人事, 哪天加的就按哪天的价 —— 周六周日一个价, 平时一
            个价
          </span>
        </div>

        {/* 工资构成 —— 工资条上把综合工资拆成一列项目时用的数。这几个数只影
            响条子上怎么写, 不影响实发, 所以随手调不会把钱调错。 */}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-1 gap-y-2 border-t border-[var(--color-border)] pt-2.5">
          <span className="mr-2 w-[52px] shrink-0 font-medium text-[var(--color-ink-2)]">
            工资构成
          </span>
          <Rule label="基本工资" unit="元" value={rules.baseSalaryCny} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'baseSalaryCny', value: v })} />
          <Sep />
          <Rule label="岗位补助" unit="%" value={rules.postRatePct} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'postRatePct', value: v })} />
          <Sep />
          <Rule label="绩效工资" unit="%" value={rules.perfRatePct} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'perfRatePct', value: v })} />
          <Sep />
          <Rule label="安全补贴" unit="%" value={rules.safetyRatePct} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'safetyRatePct', value: v })} />
          <Sep />
          <Rule label="保密补贴" unit="%" value={rules.secretRatePct} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'secretRatePct', value: v })} />
          <Sep />
          <Rule label="社保补贴" unit="%" value={rules.socialRatePct} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'socialRatePct', value: v })} />
          <Sep />
          <Rule label="全勤" unit="元" value={rules.fullAttendanceCny} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'fullAttendanceCny', value: v })} />
          <Sep />
          <Rule label="超过" unit="元才拆" value={rules.splitThresholdCny} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'splitThresholdCny', value: v })} />
          <span className="ml-auto text-[11.5px] text-[var(--color-ink-4)]">
            这几项乘的都是「综合工资 − 出勤工资」· 福利 = 综合工资 − 出勤工资
            − 后面全部
          </span>
        </div>

        {/* 补助档 —— 话费 / 餐补 / 内宿 / 交通 四项共用一张表, 按这个人的综
            合工资落在哪一档给多少。工资条上那四格照样能一人一个数地改。 */}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-1 gap-y-2 border-t border-[var(--color-border)] pt-2.5">
          <span className="mr-2 w-[52px] shrink-0 font-medium text-[var(--color-ink-2)]">
            补助档
          </span>
          <Rule label="综合工资满" unit="元 补" value={rules.tier1MinCny} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'tier1MinCny', value: v })} />
          <Rule label="" unit="元" value={rules.tier1Cny} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'tier1Cny', value: v })} />
          <Sep />
          <Rule label="满" unit="元 补" value={rules.tier2MinCny} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'tier2MinCny', value: v })} />
          <Rule label="" unit="元" value={rules.tier2Cny} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'tier2Cny', value: v })} />
          <Sep />
          <Rule label="满" unit="元 补" value={rules.tier3MinCny} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'tier3MinCny', value: v })} />
          <Rule label="" unit="元" value={rules.tier3Cny} locked={locked} onSave={(v) => save({ kind: 'setPayrollRule', key: 'tier3Cny', value: v })} />
          <span className="ml-auto text-[11.5px] text-[var(--color-ink-4)]">
            话费补助 · 餐补 · 内宿补贴 · 交通补助 四项各按这张表给 · 够不到第一
            档的没有 · 工资条上填了数就以填的为准
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
          {/* 厂里自己加的部门 —— 组织架构是会长的, 不必等改代码。 */}
          {!locked && (
            <>
              <Sep />
              <AddDept
                onAdd={(d) => save({ kind: 'addPayrollDept', dept: d })}
              />
              {rules.extraDepts.length > 0 && (
                <>
                  <Sep />
                  <span className="text-[11.5px] text-[var(--color-ink-4)]">
                    自己加的
                  </span>
                  {rules.extraDepts.map((d) => (
                    <span
                      key={d}
                      className="ml-1.5 inline-flex items-baseline gap-1 text-[11.5px] text-[var(--color-ink-3)]"
                    >
                      {d}
                      <button
                        type="button"
                        title={`删掉「${d}」— 还有人在这个部门就删不掉`}
                        onClick={() => {
                          if (!confirm(`删掉部门「${d}」？`)) return
                          void save({
                            kind: 'removePayrollDept',
                            dept: d,
                          }).catch((e) =>
                            showToast(
                              e instanceof Error ? e.message : '删不掉',
                              'warning',
                            ),
                          )
                        }}
                        className="text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </>
              )}
            </>
          )}
          <span className="ml-auto text-[11.5px] text-[var(--color-ink-4)]">
            平时按本部门这个数, 周六按上面那个数 —— 两个加起来就是当月应出勤
            工时
          </span>
        </div>
      </div>

      {/* 找人 + 按部门筛 —— 在册的部门才出现。 */}
      {slips.length > 0 && (
        <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="找人"
            className="w-[92px] border-b border-[var(--color-border)] bg-transparent py-0.5 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-ink)] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setDeptFilter(null)}
            className={`text-[13px] transition-colors ${
              deptFilter === null
                ? 'font-semibold text-[var(--color-ink)]'
                : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
            }`}
          >
            全部 {slips.length}
          </button>
          {inUse.length > 1 && inUse.map((d) => {
            const n = slips.filter((s) => s.dept === d).length
            return (
              <button
                key={d}
                type="button"
                onClick={() => setDeptFilter(deptFilter === d ? null : d)}
                className={`text-[13px] transition-colors ${
                  deptFilter === d
                    ? 'font-semibold text-[var(--color-ink)]'
                    : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
                }`}
              >
                {d}{' '}
                <span className="mono text-[11.5px] tabular-nums text-[var(--color-ink-4)]">
                  {n}
                </span>
              </button>
            )
          })}
          {(deptFilter !== null || needle !== '') && (
            <span className="mono ml-auto text-[12px] tabular-nums text-[var(--color-ink-3)]">
              {shown.length} 人 · 应发 {formatCny(payrollTotal(shown))}
            </span>
          )}
        </div>
      )}

      {/* 工资表 */}
      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div
          className={`hidden ${COLS} items-center gap-2 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid`}
        >
          <span className="label">姓名</span>
          <span className="label">部门</span>
          <span className="label text-right">综合工资</span>
          <span className="label text-center">事假</span>
          <span className="label text-center">病假</span>
          <span className="label text-center">旷工</span>
          <span className="label text-center">迟到</span>
          <span className="label text-center">加班</span>
          <span className="label text-center">奖罚</span>
          <span className="label text-right">实发</span>
        </div>

        {shown.length === 0 ? (
          <p className="px-5 py-10 text-center text-[13px] text-[var(--color-ink-3)]">
            {slips.length === 0
              ? '名册还是空的 — 人事里记过一笔的人会出现在这里'
              : '没有符合的人'}
          </p>
        ) : null}

        {shown.map((s) => (
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
                {!locked && (
                  // 人走了就从工资表上拿下来。只动名册和往后的月份: 已经发放
                  // 过的月份是凭据, 一个字不动; 系统同时在调薪记录里留一条
                  // "停发", 所以这个人什么时候、由谁拿下来的, 事后查得到。
                  <span
                    role="button"
                    tabIndex={0}
                    title="移出工资表 — 已发放月份的工资条不动"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (
                        !confirm(
                          `把「${s.name}」移出工资表？\n已发放月份的工资条不动，调薪记录里会留一条停发。`,
                        )
                      )
                        return
                      void save({
                        kind: 'setPayrollBase',
                        name: s.name,
                        monthlyCny: 0,
                        dept: s.dept,
                      })
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="shrink-0 text-[11px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                  >
                    移出
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
                rules={rules}
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
              {/* 加班也是考勤 —— 人事记, 这里只读。 */}
              <Att value={s.otHours} unit="h" />
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
            rules={rules}
            onAdd={(name, monthlyCny, dept) =>
              save({ kind: 'setPayrollBase', name, monthlyCny, dept })
            }
          />
        )}
      </div>

      <p className="mt-4 text-[12px] text-[var(--color-ink-3)]">
        加班 · 事假 · 病假 · 旷工 · 迟到 全部读自
        <Link href={`/hr?p=${month}`} className="mx-1 underline decoration-[var(--color-border-strong)] underline-offset-2 hover:text-[var(--color-ink)]">
          人事
        </Link>
        ，在那边记，这边自动算。加班费按厂里定的小时价：周六周日一个价、平时
        一个价，哪天加的就按哪天的。点名字看工资条。
      </p>
    </div>
  )
}

// 加一个部门 —— 收起来是一行小字, 点开是一个输入框。部门加完就出现在下拉
// 和「每天工时」里, 跟内置的那些没有区别。
function AddDept({ onAdd }: { onAdd: (dept: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-ink-2)]"
      >
        ＋ 部门
      </button>
    )
  }

  const submit = () => {
    const n = name.trim()
    if (!n) {
      setOpen(false)
      return
    }
    setPending(true)
    onAdd(n)
      .then(() => {
        setName('')
        setOpen(false)
      })
      .catch((e) =>
        showToast(e instanceof Error ? e.message : '加不上', 'warning'),
      )
      .finally(() => setPending(false))
  }

  return (
    <span className="inline-flex items-baseline gap-1">
      <input
        autoFocus
        value={name}
        disabled={pending}
        onChange={(e) => setName(e.target.value)}
        onBlur={submit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') {
            setName('')
            setOpen(false)
          }
        }}
        placeholder="部门名"
        className="w-[72px] border-b border-[var(--color-border-strong)] bg-transparent py-0.5 text-[12.5px] text-[var(--color-ink)] focus:border-[var(--color-ink)] focus:outline-none"
      />
    </span>
  )
}

// 直接往工资表上加一个人。收起来只有一行字, 展开是三个格 —— 名字、月薪、
// 部门。名字是这张表的钥匙, 所以填错了还能改 (见每一行名字上的「改名」)。
function AddPerson({
  rules,
  onAdd,
}: {
  rules: PayrollRules
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
        {[...deptPickerOptions(rules), NO_DEPARTMENT].map((d) => (
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
  rules,
  onSave,
  locked,
}: {
  value: string
  rules: PayrollRules
  onSave: (dept: string) => Promise<void>
  locked: boolean
}) {
  const [pending, setPending] = useState(false)
  if (locked) {
    return (
      <span
        title="这个月已发放，先撤销发放才能改"
        className="mono hidden truncate text-[12px] text-[var(--color-ink-2)] md:block"
      >
        {value}
      </span>
    )
  }
  // 一个 appearance-none 的 select 在表格里长得跟一行灰字一模一样, 没人知道
  // 它能点。右边留出一个小三角 (背景画的, 不占 DOM), 一眼就看出这一格是能
  // 换的 —— 部门换了, 这个人的每天工时、时薪、整张工资条跟着重算。
  return (
    <select
      value={value}
      disabled={pending}
      title="换部门 — 每天工时和整张工资条跟着重算"
      onChange={async (e) => {
        setPending(true)
        try {
          await onSave(e.target.value)
        } finally {
          setPending(false)
        }
      }}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'><path d='M0 0l4 5 4-5z' fill='%23a8a29a'/></svg>\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 2px center',
      }}
      className={`mono hidden w-full cursor-pointer appearance-none rounded-[2px] border-0 bg-transparent py-0.5 pl-1 pr-3.5 -ml-1 text-[12px] text-[var(--color-ink-2)] outline-none transition-[background-color,box-shadow] duration-150 hover:bg-[var(--color-active-bg)] hover:shadow-[inset_0_-1px_0_var(--color-border-strong)] focus:bg-[var(--color-active-bg)] focus:shadow-[inset_0_-1px_0_var(--color-ink)] md:block ${
        pending ? 'opacity-60' : ''
      } ${value === NO_DEPARTMENT ? 'text-[var(--color-ink-4)]' : ''}`}
    >
      {[...deptPickerOptions(rules, value), NO_DEPARTMENT].map((d) => (
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
          <p className="mono flex items-baseline gap-1.5 text-[12px] tabular-nums text-[var(--color-ink-3)]">
            {/* 综合工资 —— 一切都从这个数分出去, 所以它就摆在条子顶上, 点着
                就能改, 改完下面整张条子当场重算。 */}
            <span className="text-[var(--color-ink-2)]">综合工资</span>
            <span className="inline-block w-[72px]">
              <Num
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
            </span>
            <span className="text-[var(--color-ink-4)]">·</span>
            {s.dept} · 应出勤 {s.standardDays} 天 (含周六 {s.saturdays} 天) ·
            实际出勤 {num(s.workedDays)} 天 · 平时每天 {num(s.hoursPerDay)} 小时
            · 周六 {num(s.saturdayHours)} 小时 · 应出勤 {num(s.standardHours)}{' '}
            小时 · 时薪 ¥{num(s.hourlyCny)}（缺勤按它扣）
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

        <div className="grid grid-cols-1 gap-x-10 gap-y-1 md:grid-cols-2">
          {/* 工资明细 —— 前半段是出勤工资 (人到岗才有的那几项), 后半段是各
              项补助, 两段加起来就是应发工资。福利是倒挤的, 所以这一列永远
              加得回综合工资。 */}
          <div>
            <p className="label mb-1 text-[var(--color-ink-3)]">
              出勤工资
              {!s.splitApplies && ' · 综合工资未过拆分门槛, 不拆'}
            </p>
            {s.splitApplies ? (
              <>
                <Ln label="基本工资" v={s.baseSalaryCny} />
                <Ln label="岗位补助" v={s.postSubsidyCny} />
                <Ln label="加班费" detail={otDetail(s)} v={s.otPay} />
              </>
            ) : (
              <>
                <Ln label="综合工资" v={s.monthlyCny} />
                <Ln label="加班费" detail={otDetail(s)} v={s.otPay} />
              </>
            )}
            <Ln
              label="出勤工资"
              detail={
                s.splitApplies
                  ? `余下 ${formatCny(s.ratedBaseCny)} 按比例分`
                  : undefined
              }
              v={s.attendancePayCny}
              strong
              divider
            />

            <p className="label mt-3 mb-1 text-[var(--color-ink-3)]">其他项目</p>
            {/* 手填的几项每个人都有 —— 有没有房补、住不住厂里, 跟综合工资够
                不够拆没关系。按比例分出来的那几项才看门槛。 */}
            <Edit
              label="餐补"
              value={s.mealCny}
              locked={locked}
              onSave={(v) => setLine({ mealCny: v })}
            />
            <Edit
              label="话费补助"
              value={s.phoneAllowanceCny}
              locked={locked}
              onSave={(v) => setLine({ phoneAllowanceCny: v })}
            />
            <Edit
              label="交通补助"
              value={s.transportAllowanceCny}
              locked={locked}
              onSave={(v) => setLine({ transportAllowanceCny: v })}
            />
            {s.splitApplies && (
              <>
                <Ln label="绩效工资" v={s.perfPayCny} />
                <Ln label="安全补贴" v={s.safetyFeeCny} />
                <Ln label="保密补贴" v={s.secretFeeCny} />
              </>
            )}
            {/* 内宿补贴按天折 —— 格子里填的是满勤该给的数, 条子上出来的是
                折算后的。 */}
            <Edit
              label="内宿补贴"
              detail={
                s.workedDays < s.standardDays
                  ? `出勤 ${num(s.workedDays)}/${s.standardDays} 天 → ${formatCny(s.housingCny)}`
                  : undefined
              }
              value={s.housingBaseCny}
              locked={locked}
              onSave={(v) => setLine({ housingCny: v })}
            />
            {/* 房补 —— 在外面租房的那一份, 只手填, 空着就是没有。 */}
            <Edit
              label="房补"
              value={s.housingAllowanceCny}
              locked={locked}
              onSave={(v) => setLine({ housingAllowanceCny: v })}
            />
            {s.splitApplies && (
              <Ln
                label="全勤"
                detail={s.fullAttendance ? undefined : '本月有缺勤'}
                v={s.fullAttendanceCny}
              />
            )}
            {/* 社保补贴按比例算, 点着能改 —— 清空就回到按比例。 */}
            <Edit
              label="社保补贴"
              value={s.socialSubsidyCny}
              locked={locked}
              onSave={(v) => setLine({ socialSubsidyCny: v })}
            />
            {/* 兜底的那一格 —— 上面各项加起来永远等于综合工资。手填的几项
                填得太多, 它会变成负数, 那时候是红的。 */}
            {s.splitApplies && <Ln label="福利" v={s.welfareCny} />}
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
            <Ln label="应发工资" v={s.grossCny} strong divider />
          </div>

          {/* 扣款 */}
          <div>
            <p className="label mb-1 text-[var(--color-ink-3)]">扣款</p>
            {/* 缺勤扣 —— 一行合计, 不拆事假/病假/旷工/迟到。要明细去人事页。 */}
            {s.attendanceCutCny > 0 && (
              <Ln
                label="缺勤扣"
                detail="事假·病假·旷工·迟到"
                v={-s.attendanceCutCny}
              />
            )}
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
            <p className="mt-3 text-[11px] text-[var(--color-ink-4)]">
              基本工资、岗位补助、加班费合起来是出勤工资；再加上后面这一串子
              项目，就是应发工资。按比例的那几项——岗位补助、绩效工资、安全补
              贴、保密补贴、社保补贴——乘的都是「综合工资 − 出勤工资」
              {s.splitApplies ? ` = ${formatCny(s.ratedBaseCny)}` : ''}
              ；话费、餐补、内宿、交通按综合工资的档位给（点着能给这个人单独
              填一个数）；全勤当月没有事假、病假、旷工、迟到才有；福利 = 综合
              工资 − 出勤工资 − 后面这一串，所以没有额外奖金时应发工资正好是
              综合工资。缺勤扣在右边扣款栏里。
            </p>
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
  detail,
  value,
  locked,
  negative,
  onSave,
}: {
  label: string
  /** 算式那一句 —— 折算过的项 (内宿补贴) 靠它说清楚为什么不是整数。 */
  detail?: string
  value: number
  locked: boolean
  negative?: boolean
  onSave: (v: number) => Promise<void>
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="min-w-0 truncate text-[12.5px] text-[var(--color-ink-2)]">
        {label}
        {detail && (
          <span className="ml-2 text-[11.5px] text-[var(--color-ink-3)]">
            {detail}
          </span>
        )}
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
        <span className="mx-0.5 inline-block w-[54px]">
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

// 8 not 8.00, 7.5 stays 7.5, 22.94 stays 22.94.
function num(n: number): string {
  return String(Math.round(n * 100) / 100)
}

// 加班费旁边那一句算式 —— 平时和周末两个价, 有哪个写哪个。
function otDetail(s: Payslip): string {
  const parts: string[] = []
  if (s.otWeekdayHours > 0)
    parts.push(`平时 ${num(s.otWeekdayHours)}h × ¥${num(s.otWeekdayCny)}`)
  if (s.otWeekendHours > 0)
    parts.push(`周末 ${num(s.otWeekendHours)}h × ¥${num(s.otWeekendCny)}`)
  return parts.length > 0 ? parts.join(' + ') : '人事没记加班'
}
