import Link from 'next/link'
import {
  blockClosedAt,
  blockLineTotalsSum,
  formatCny,
} from '@/lib/data'
import { getFinanceRows, getOutsourceBlockRows, getVendors } from '@/lib/db'
import { shanghaiDay } from '@/lib/today'
import {
  closedInMonth,
  outsourceStatsByVendor,
  outsourceTotals,
  shipStatsByDay,
  shipStatsBySalesperson,
  shipTotals,
  shipmentsInPeriod,
  type OutsourceStatRow,
} from '@/lib/finance'

// 统计 — 这个月钱进来多少 (出货), 外协出去多少, 各自摊到谁头上.
//
// 一个月份切一次, 两段一起动: 老板月底问的从来不是"出货多少"或"外协多少",
// 而是这两个数摆在一起的样子。
//
// 出货 —
//
// 一份数据回答三个问题, 而且没有一个字是重新录的: 出货单开出来的那一刻这页就
// 变了。金额取的是记账表上那一栏 (财务改过的数优先, 没改过就是零件单价 × 出
// 货数算出来的), 所以这页和记账表永远是同一个数, 不会各说各话。
//
// 商务按「越侬商务」算 — 那是导入时必填、这单归谁的那个名字。老单没这个字段,
// 退回建单人。
//
// 按天那半边是给对账用的 (哪天出了什么), 按人那半边是给月底看的 (谁出的多)。
// 两边的合计必然相等, 因为是同一批单子的两种切法。

const MONTHS = [
  '01', '02', '03', '04', '05', '06',
  '07', '08', '09', '10', '11', '12',
]

export async function MonthlyStats({
  sm,
  todayStr,
}: {
  sm?: string
  todayStr: string
}) {
  const year = todayStr.slice(0, 4)
  const currentMonth = todayStr.slice(5, 7)
  const month = sm && MONTHS.includes(sm) ? sm : currentMonth
  const ym = `${year}-${month}`
  const idx = MONTHS.indexOf(month)
  const prevM = MONTHS[(idx + 11) % 12]
  const nextM = MONTHS[(idx + 1) % 12]

  const [all, blockRows, vendors] = await Promise.all([
    getFinanceRows(),
    getOutsourceBlockRows(),
    getVendors(),
  ])

  const rows = shipmentsInPeriod(all, ym, shanghaiDay)
  const totals = shipTotals(rows)
  const byDay = shipStatsByDay(rows, shanghaiDay)
  const byPerson = shipStatsBySalesperson(rows)

  // 今年累计 — the month strip answers "这个月", this answers "到今天为止".
  const yearTotals = shipTotals(shipmentsInPeriod(all, year, shanghaiDay))

  const peak = Math.max(1, ...byPerson.map((s) => s.amountCny))

  // 外协 — 同「月度」口径: 单头总价, 加急单退回按件小计; 记在回件结算日。
  const vendorName = new Map(vendors.map((v) => [v.id, v.name]))
  const outAll: OutsourceStatRow[] = blockRows.map((r) => {
    const priced =
      r.block.amountCny != null || blockLineTotalsSum(r.block) != null
    return {
      amountCny: r.block.amountCny ?? blockLineTotalsSum(r.block) ?? 0,
      closedAt: blockClosedAt(r.block),
      vendorName: vendorName.get(r.block.vendorId) ?? r.block.vendorId,
      priced,
    }
  })
  const outMonth = outAll.filter(
    (r) => r.closedAt && closedInMonth(r.closedAt, month),
  )
  const outTotals = outsourceTotals(outMonth)
  const byVendor = outsourceStatsByVendor(outMonth)
  const vendorPeak = Math.max(1, ...byVendor.map((s) => s.amountCny))

  // 还压在外面的钱 — 发出去了还没全部回厂, 所以还没结。跟当月成本是两个问题,
  // 所以是一句话, 不是一张表。
  // 没有结算日 = 还没回齐 (blockClosedAt 只在整单全回时才给日期), 所以这一
  // 个条件就够, 不用再拿下标去对第二个数组。
  const openOut = outsourceTotals(outAll.filter((r) => !r.closedAt))

  return (
    <div>
      {/* 月份 + 两个总数 */}
      <div className="mb-10 flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
        <div>
          <p className="text-[32px] md:text-[36px] font-semibold tracking-tight tabular-nums leading-none text-[var(--color-ink)]">
            {formatCny(totals.amountCny)}
          </p>
          <p className="label mt-3">
            {year}年{Number(month)}月出货
          </p>
          <p className="mt-1 text-[12px] tabular-nums text-[var(--color-ink-3)]">
            {totals.count} 单
            {totals.unpriced > 0 ? ` · 其中 ${totals.unpriced} 单没金额` : ''}
          </p>
        </div>
        <div>
          <p className="text-[22px] font-semibold tracking-tight tabular-nums leading-none text-[var(--color-ink-2)]">
            {formatCny(yearTotals.amountCny)}
          </p>
          <p className="label mt-2.5">今年累计</p>
          <p className="mt-1 text-[12px] tabular-nums text-[var(--color-ink-3)]">
            {yearTotals.count} 单
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <MonthLink m={prevM} label="←" />
          <span className="mono px-1 text-[13px] font-semibold text-[var(--color-ink)]">
            {Number(month)}月
          </span>
          <MonthLink m={nextM} label="→" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        {/* 按商务 — 月底真正要看的那张 */}
        <section>
          <h2 className="label mb-3">出货 · 按商务</h2>
          <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
            {byPerson.length === 0 ? (
              <Empty />
            ) : (
              byPerson.map((s) => (
                <div
                  key={s.key}
                  className="relative border-b border-[var(--color-border)] px-5 py-3 last:border-b-0"
                >
                  {/* 一条极淡的量感条 — 谁多谁少一眼看出, 不用去比数字。 */}
                  <div
                    aria-hidden
                    className="absolute inset-y-0 left-0 bg-[var(--color-active-bg)]"
                    style={{ width: `${(s.amountCny / peak) * 100}%` }}
                  />
                  <div className="relative flex items-baseline gap-3">
                    <span className="truncate text-[14px] font-medium tracking-tight text-[var(--color-ink)]">
                      {s.key}
                    </span>
                    <span className="mono ml-auto shrink-0 text-[12px] text-[var(--color-ink-3)] tabular-nums">
                      {s.count} 单
                      {s.unpriced > 0 ? ` · ${s.unpriced} 无价` : ''}
                    </span>
                    <span className="mono shrink-0 text-[14px] font-semibold tabular-nums text-[var(--color-ink)]">
                      {formatCny(s.amountCny)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* 按出货日期 — 对账用的 */}
        <section>
          <h2 className="label mb-3">出货 · 按日期</h2>
          <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
            {byDay.length === 0 ? (
              <Empty />
            ) : (
              byDay.map((s) => (
                <div
                  key={s.key}
                  className="flex items-baseline gap-3 border-b border-[var(--color-border)] px-5 py-2.5 last:border-b-0"
                >
                  <span className="mono shrink-0 text-[13px] text-[var(--color-ink)] tabular-nums">
                    {s.key.slice(5)}
                  </span>
                  <span className="mono ml-auto shrink-0 text-[12px] text-[var(--color-ink-3)] tabular-nums">
                    {s.count} 单
                  </span>
                  <span className="mono shrink-0 text-[13.5px] font-medium tabular-nums text-[var(--color-ink)]">
                    {formatCny(s.amountCny)}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <p className="mt-5 text-[12px] text-[var(--color-ink-3)]">
        出货金额跟「记账」是同一栏——财务改过的数优先，没改过就按零件单价×出货数算。
        商务按「越侬商务」算，老单没填的记在建单人名下。
      </p>

      {/* ===== 外协 ===== */}
      <div className="mt-14 border-t border-[var(--color-border)] pt-10">
        <div className="mb-6 flex flex-wrap items-end gap-x-10 gap-y-4">
          <div>
            <p className="text-[26px] font-semibold tracking-tight tabular-nums leading-none text-[var(--color-ink)]">
              {formatCny(outTotals.amountCny)}
            </p>
            <p className="label mt-2.5">
              {Number(month)}月外协结算
            </p>
            <p className="mt-1 text-[12px] tabular-nums text-[var(--color-ink-3)]">
              {outTotals.count} 单
              {outTotals.unpriced > 0
                ? ` · 其中 ${outTotals.unpriced} 单没报价`
                : ''}
            </p>
          </div>
          {openOut.count > 0 && (
            <div>
              <p className="text-[18px] font-semibold tracking-tight tabular-nums leading-none text-[var(--color-warning)]">
                {formatCny(openOut.amountCny)}
              </p>
              <p className="label mt-2.5">还在外面没结</p>
              <p className="mt-1 text-[12px] tabular-nums text-[var(--color-ink-3)]">
                {openOut.count} 单未回齐
              </p>
            </div>
          )}
        </div>

        <h2 className="label mb-3">外协 · 按供应商</h2>
        <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
          {byVendor.length === 0 ? (
            <p className="px-5 py-10 text-center text-[13px] text-[var(--color-ink-3)]">
              这个月没有结算的外协单
            </p>
          ) : (
            byVendor.map((s) => (
              <div
                key={s.key}
                className="relative border-b border-[var(--color-border)] px-5 py-3 last:border-b-0"
              >
                <div
                  aria-hidden
                  className="absolute inset-y-0 left-0 bg-[var(--color-active-bg)]"
                  style={{ width: `${(s.amountCny / vendorPeak) * 100}%` }}
                />
                <div className="relative flex items-baseline gap-3">
                  <span className="truncate text-[14px] font-medium tracking-tight text-[var(--color-ink)]">
                    {s.key}
                  </span>
                  <span className="mono ml-auto shrink-0 text-[12px] text-[var(--color-ink-3)] tabular-nums">
                    {s.count} 单
                    {s.unpriced > 0 ? ` · ${s.unpriced} 无价` : ''}
                  </span>
                  <span className="mono shrink-0 text-[14px] font-semibold tabular-nums text-[var(--color-ink)]">
                    {formatCny(s.amountCny)}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        <p className="mt-5 text-[12px] text-[var(--color-ink-3)]">
          外协按<span className="text-[var(--color-ink-2)]">回件结算日</span>
          计入——整单全部回厂那天才算这个月的成本，跟「月度」页那一行是同一个数。
          发出去还没回齐的单子不算成本，单列在上面。
        </p>
      </div>
    </div>
  )
}

function MonthLink({ m, label }: { m: string; label: string }) {
  return (
    <Link
      href={`/finance?tab=ship&sm=${m}`}
      aria-label={`${Number(m)}月`}
      className="inline-flex h-7 w-7 items-center justify-center rounded-[2px] border border-[var(--color-border)] text-[13px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
    >
      {label}
    </Link>
  )
}

function Empty() {
  return (
    <p className="px-5 py-10 text-center text-[13px] text-[var(--color-ink-3)]">
      这个月还没有出货
    </p>
  )
}
