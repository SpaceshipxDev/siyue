import type { Metadata } from 'next'
import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { BRAND } from '@/lib/brand'
import { WeeklyBars, WeeklyLine } from './_charts'
import { AS_OF, DAYS_LIVE, GO_LIVE, TIMELINE, TOTALS, WEEKS } from './_data'

// /data — 使用数据实证页. A standalone sales artifact, not part of the MES
// chrome: no TopBar, no tabs, no nav. One page a salesperson can scroll on a
// phone and answer the only question a factory owner actually asks —
// "会有人用吗?"
//
// Session-gated (requireUser) like every other route. To make it public for
// external sharing, add '/data' to PUBLIC_PATHS in proxy.ts — one line — but
// note that publishes 越侬's order volume, output and headcount to anyone with
// the URL, so that is the owner's call to make, not a default.
//
// Numbers are baked into _data.ts with a date stamp. See that file for why.

export const metadata: Metadata = {
  title: '使用数据 · 上线 96 天',
  description: '一家精密加工厂上线 96 天的真实使用数据',
}

const NUM = 'tabular-nums'

function Stat({
  k,
  v,
  unit,
  note,
}: {
  k: string
  v: string
  unit?: string
  note: string
}) {
  return (
    <div className="bg-[var(--color-surface)] px-4 py-4">
      <div className="mb-2 text-[10px] font-medium tracking-[0.14em] text-[var(--color-ink-3)]">
        {k}
      </div>
      <div className={`text-[26px] leading-none font-semibold tracking-tight ${NUM}`}>
        {v}
        {unit && (
          <span className="ml-1 text-[12px] font-normal text-[var(--color-ink-3)]">{unit}</span>
        )}
      </div>
      <div className="mt-2 text-[11px] leading-snug text-[var(--color-ink-3)]">{note}</div>
    </div>
  )
}

function SectionHead({ n, title, tag }: { n: string; title: string; tag?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline gap-3 border-b border-[var(--color-border-strong)] pb-2.5">
      <span className={`text-[10px] tracking-[0.14em] text-[var(--color-ink-4)] ${NUM}`}>{n}</span>
      <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
      {tag && (
        <span className="ml-auto text-[10px] tracking-wide text-[var(--color-ink-3)]">{tag}</span>
      )}
    </div>
  )
}

function Card({
  title,
  sub,
  children,
}: {
  title: string
  sub?: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <span className="text-[12px] font-semibold">{title}</span>
        {sub && <span className="text-[10px] text-[var(--color-ink-3)]">{sub}</span>}
      </div>
      {children}
    </div>
  )
}

function QA({ q, a }: { q: string; a: React.ReactNode }) {
  return (
    <div className="border-b border-[var(--color-border)] py-3.5 last:border-b-0">
      <div className="mb-1.5 text-[13px] font-semibold">{q}</div>
      <div className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">{a}</div>
    </div>
  )
}

export default async function DataPage() {
  await requireUser()

  return (
    <div className="min-h-dvh bg-[var(--color-bg)]">
      <main className="mx-auto max-w-[900px] px-5 pt-10 pb-24 md:px-8">
        {/* ---------- hero ---------- */}
        <p className="mb-3.5 text-[10px] font-medium tracking-[0.16em] text-[var(--color-ink-3)]">
          客户实证 · {BRAND.shortName}
        </p>
        <h1 className="text-[clamp(26px,4.6vw,40px)] leading-[1.12] font-semibold tracking-tight text-balance">
          上线 {DAYS_LIVE} 天,
          <br className="hidden sm:block" />
          全厂每天在系统里报工
        </h1>
        <p className="mt-4 max-w-[54ch] text-[14px] leading-relaxed text-[var(--color-ink-2)]">
          一家做精密零件和手板的工厂,{GO_LIVE} 上线。到 {AS_OF} 为止,累计{' '}
          <b className="font-semibold text-[var(--color-ink)]">
            {TOTALS.baogong.toLocaleString('en-US')}
          </b>{' '}
          条报工记录、{TOTALS.jobs.toLocaleString('en-US')} 张工单、
          {TOTALS.shipments.toLocaleString('en-US')} 张出货单。
          <b className="font-semibold text-[var(--color-ink)]">14 周,使用量没有一周回落。</b>
        </p>
        <div
          className={`mt-5 flex flex-wrap gap-x-6 gap-y-1.5 border-t border-[var(--color-border)] pt-3.5 text-[11px] text-[var(--color-ink-3)] ${NUM}`}
        >
          <span>数据截至 {AS_OF}</span>
          <span>取自生产数据库 · 非抽样</span>
          <span>全厂 {TOTALS.accounts} 个账号</span>
        </div>

        {/* ---------- stat rail ---------- */}
        {/* 6 tiles — fixed column counts that divide evenly, so the rail never
            leaves an orphan cell showing the gap colour. */}
        <div className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-3 lg:grid-cols-6">
          <Stat k="上线天数" v={String(DAYS_LIVE)} unit="天" note={`${GO_LIVE} 第一张工单`} />
          <Stat
            k="报工记录"
            v={TOTALS.baogong.toLocaleString('en-US')}
            note="工人在工序上点的每一次"
          />
          <Stat
            k="工单 / 零件"
            v={TOTALS.jobs.toLocaleString('en-US')}
            note={`${TOTALS.parts.toLocaleString('en-US')} 个零件在册`}
          />
          <Stat k="每周报工人数" v="7 → 26" note="首周 7 人,现稳定 26–29 人" />
          <Stat k="每周报工次数" v="+139" unit="%" note="2,213(6/01)→ 5,297(8/03)" />
          <Stat
            k="每周活跃账号"
            v={String(TOTALS.peakWau)}
            note={`全厂共 ${TOTALS.accounts} 个账号`}
          />
        </div>

        {/* ---------- 01 ---------- */}
        <section className="mt-14">
          <SectionHead n="01" title="采用曲线 —— 只看这一条也够" tag="每周" />
          <p className="max-w-[64ch] text-[13px] leading-relaxed text-[var(--color-ink-2)]">
            报工是唯一没法作假的指标:必须是一个工人,站在机床边,把一个真实零件推过一道真实工序。
            刷页面刷不出来,管理层替他点也点不了那么多。
          </p>

          <div className="mt-4 space-y-3.5">
            <Card title="每周实际报工人数" sub="当周真正动手点过的人">
              <WeeklyLine
                metric="tap"
                title="报工人数"
                extra={[{ label: '报工完成', metric: 'fin' }]}
                aria="每周实际报工人数,从 7 人增长到 26 至 29 人并保持稳定"
              />
            </Card>
            <Card title="每周报工完成数" sub="次 / 周">
              <WeeklyBars
                metric="fin"
                title="报工完成"
                height={170}
                every={2}
                hatchBackfill
                extra={[
                  { label: '开工', metric: 'st' },
                  { label: '报工人数', metric: 'tap' },
                ]}
                aria="每周报工完成数,从 496 增长到约 5,300"
              />
              <div className="mt-2 text-[10.5px] leading-snug text-[var(--color-ink-3)]">
                斜纹柱 = 5 月中的历史补录周(把在制品一次性录入系统)与仅 1 天的当前周,
                均不计入增长口径。
              </div>
            </Card>
          </div>

          <div className="mt-4 rounded-[2px] border border-[var(--color-border)] border-l-2 border-l-[var(--color-info)] bg-[var(--color-surface)] p-4">
            <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
              <b className="font-semibold text-[var(--color-ink)]">人数第 3 周就到位,之后不再涨。</b>{' '}
              真正一直在涨的是人均使用量 ——{' '}
              <b className={`font-semibold text-[var(--color-ink)] ${NUM}`}>
                每人每周 85 次 → 204 次
              </b>
              。这条差别很重要:如果只是被要求打卡,曲线会平、会掉;人均翻倍,说明工人是真的靠它干活,
              不靠它就找不到活该干哪一道。
            </p>
          </div>
        </section>

        {/* ---------- 02 ---------- */}
        <section className="mt-14">
          <SectionHead n="02" title="四个模块,四条互相独立的曲线" tag="每周" />
          <p className="max-w-[64ch] text-[13px] leading-relaxed text-[var(--color-ink-2)]">
            写这四张表的是四拨不同的人:商务开单、商务出货、跟单外协、采购下单。
            四条线同时在涨,说明不是某一个热心的人在撑场面。
          </p>
          <div className="mt-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <Card title="新工单" sub="张 / 周">
              <WeeklyBars
                metric="jobs"
                title="新工单"
                extra={[{ label: '零件', metric: 'parts' }]}
                aria="每周新工单数,稳定在每周约 110 至 143 张"
              />
            </Card>
            <Card title="出货单" sub="张 / 周">
              <WeeklyBars metric="ship" title="出货单" aria="每周出货单数,从 26 增长到 134" />
            </Card>
            <Card title="外协寄出" sub="批 / 周">
              <WeeklyBars metric="out" title="外协寄出" aria="每周外协寄出批次,从 18 增长到 67" />
            </Card>
            <Card title="采购下单" sub="条 / 周">
              <WeeklyBars metric="proc" title="采购下单" aria="每周采购下单条数,从 0 增长到 126" />
            </Card>
          </div>
        </section>

        {/* ---------- 03 ---------- */}
        <section className="mt-14">
          <SectionHead n="03" title="现场提的需求,多久能真正用上" tag="采购模块实例" />
          <p className="max-w-[64ch] text-[13px] leading-relaxed text-[var(--color-ink-2)]">
            工厂最怕的是「上了个系统,提需求没人改」。这里有一个可以拿数字讲的例子:
            生产负责人和老板先后提出「采购要能看到预计到料时间、是否下单、是否到货」。
          </p>
          <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-border)] lg:grid-cols-4">
            <Stat k="第一条记录" v="7/06" note="采购模块开始被使用" />
            <Stat k="五周后" v="126" unit="条/周" note="全厂采购都在系统里下单" />
            <Stat k="全流程上线" v="8/02" note="待下单 → 下单 → 到货 → 检验" />
            <Stat
              k="累计"
              v={TOTALS.procurements.toLocaleString('en-US')}
              unit="条"
              note="并可关联到具体工号"
            />
          </div>

          <div className="mt-5">
            <div className="mb-2.5 text-[11px] font-medium tracking-[0.1em] text-[var(--color-ink-3)]">
              上线后持续交付
            </div>
            <ol className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
              {TIMELINE.map((t) => (
                <li
                  key={t.when}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[var(--color-border)] px-4 py-3 last:border-b-0"
                >
                  <span
                    className={`w-[52px] shrink-0 text-[11px] text-[var(--color-ink-3)] ${NUM}`}
                  >
                    {t.when}
                  </span>
                  <span className="text-[13px] font-semibold">{t.what}</span>
                  <span className="basis-full pl-[64px] text-[12px] text-[var(--color-ink-3)] sm:basis-auto sm:pl-0">
                    {t.note}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ---------- 04 ---------- */}
        <section className="mt-14">
          <SectionHead n="04" title="客户会这样问,就这样答" tag="销售话术" />
          <div className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4">
            <QA
              q="「我们工人不会用电脑,肯定用不起来。」"
              a={
                <>
                  越侬车间 26 个人,每周主动点{' '}
                  <b className={`font-semibold text-[var(--color-ink)] ${NUM}`}>5,000 多次</b>
                  。用的是自己的手机,一道工序点一下,不打字、不填表。第 3 周全厂 22 个人就都在用了。
                </>
              }
            />
            <QA
              q="「上线要多久?会不会耽误生产?」"
              a={
                <>
                  第一周就有 7 个人在用,第三周 22 人。中间没有停产、没有并行跑两套。
                  5 月中那一周把在制品一次性录进系统,之后就是正常干活。
                </>
              }
            />
            <QA
              q="「买了会不会用两个月就丢在一边?」"
              a={
                <>
                  这页给的是{' '}
                  <b className="font-semibold text-[var(--color-ink)]">14 周的完整曲线</b>,
                  不是上线首月的截图。报工、出货、外协、采购四条线到今天都还在往上走,没有一周回落。
                </>
              }
            />
            <QA
              q="「我们厂的流程和别人不一样,能改吗?」"
              a={
                <>
                  这套系统上线后一直在按现场提的需求改:质检报告、图纸变更、交接单、外协厂商门户、
                  采购全流程,都是上线之后加的。采购从提出需求到全厂用上,数据在上面 —— 五周。
                </>
              }
            />
            <QA
              q="「老板能看到什么?」"
              a={
                <>
                  一块看板看完全厂 {TOTALS.jobs.toLocaleString('en-US')} 张工单卡在哪道工序、
                  哪张要逾期、哪张钱还没收。不用问人,不用等报表。
                </>
              }
            />
          </div>
        </section>

        {/* ---------- 05 ---------- */}
        <section className="mt-14">
          <SectionHead n="05" title="每周明细" tag="全部原始数据" />
          <div className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
            <table className={`w-full min-w-[720px] border-collapse text-[11.5px] ${NUM}`}>
              <thead>
                <tr>
                  {[
                    '周起',
                    '新工单',
                    '零件',
                    '开工',
                    '报工完成',
                    '报工人数',
                    '出货',
                    '外协',
                    '采购',
                    '活跃账号',
                  ].map((h, i) => (
                    <th
                      key={h}
                      scope="col"
                      className={`sticky top-0 border-b border-[var(--color-border-strong)] bg-[var(--color-muted-bg)] px-2.5 py-2 text-[9.5px] font-medium tracking-[0.08em] text-[var(--color-ink-3)] ${
                        i === 0 ? 'text-left' : 'text-right'
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {WEEKS.map((d) => (
                  <tr
                    key={d.w}
                    className={`border-b border-[var(--color-border)] last:border-b-0 ${
                      d.partial ? 'text-[var(--color-ink-4)]' : ''
                    }`}
                  >
                    <th
                      scope="row"
                      className="px-2.5 py-1.5 text-left font-normal whitespace-nowrap"
                    >
                      {d.w}
                      {d.backfill && (
                        <span className="ml-1 text-[9.5px] text-[var(--color-ink-4)]">补录</span>
                      )}
                      {d.partial && (
                        <span className="ml-1 text-[9.5px] text-[var(--color-ink-4)]">1天</span>
                      )}
                    </th>
                    {(
                      [
                        d.jobs,
                        d.parts,
                        d.st,
                        d.fin,
                        d.tap,
                        d.ship,
                        d.out,
                        d.proc,
                        d.wau,
                      ] as (number | null)[]
                    ).map((v, i) => (
                      <td
                        key={i}
                        className={`px-2.5 py-1.5 text-right whitespace-nowrap ${
                          v === null || v === 0 ? 'text-[var(--color-ink-4)]' : ''
                        }`}
                      >
                        {v === null ? '—' : v.toLocaleString('en-US')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ---------- 口径 ---------- */}
        <section className="mt-12 border-t border-[var(--color-border)] pt-5">
          <div className="mb-3 text-[10px] font-medium tracking-[0.14em] text-[var(--color-ink-3)]">
            口径说明 —— 引用数字前请先读
          </div>
          <ol className="list-decimal space-y-2 pl-5 text-[11.5px] leading-relaxed text-[var(--color-ink-3)]">
            <li>
              <b className="font-medium text-[var(--color-ink-2)]">5/18 当周为历史补录。</b>
              当周 9,895 次报工完成、3,857 次开工,而新进零件只有 493 个 —— 这是把已有在制品一次性录入系统,
              不是当周产出。所有增长口径均已剔除。
            </li>
            <li>
              <b className="font-medium text-[var(--color-ink-2)]">出货会级联关闭工序。</b>
              一张出货单会自动把该工单剩余工序标记完成,因此「报工完成数」偏高。
              <b className="font-medium text-[var(--color-ink-2)]">以「每周报工人数」为准</b>,那是干净的采用指标。
            </li>
            <li>
              <b className="font-medium text-[var(--color-ink-2)]">页面埋点 2026-07-08 才上线。</b>
              「活跃账号」在此之前显示为「—」,含义是未采集,不是没人用。
            </li>
            <li>最后一周({WEEKS[WEEKS.length - 1].w})只有 1 天数据,不计入趋势。</li>
            <li>数据取自生产数据库全量计数,非抽样、非估算。截至 {AS_OF}。</li>
          </ol>
        </section>

        <div className="mt-10 flex items-center justify-between border-t border-[var(--color-border)] pt-5 text-[11px] text-[var(--color-ink-3)]">
          <span>{BRAND.softwareCredit}</span>
          <Link href="/" className="underline underline-offset-2 hover:text-[var(--color-ink-2)]">
            返回看板
          </Link>
        </div>
      </main>
    </div>
  )
}
