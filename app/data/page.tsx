import type { Metadata } from 'next'
import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { BRAND } from '@/lib/brand'
import { WeeklyBars, WeeklyLine } from './_charts'
import { AS_OF, DAYS_LIVE, GO_LIVE, TIMELINE, TOTALS, WEEKS } from './_data'

// /data — 越侬上线以来的使用数据.
//
// A dated account of what happened, written to be read by someone who wants to
// understand the system, not be persuaded by it. That means: name the factory,
// state the numbers, and include the two surfaces that went to zero. A page
// that only shows the lines going up is not informative, and anyone competent
// reads it as advertising and discounts the whole thing.
//
// Standalone — no TopBar, no tabs. Session-gated like every other route; to
// open it up, add '/data' to PUBLIC_PATHS in proxy.ts (that publishes 越侬's
// order volume and headcount to anyone with the URL, so it is the owner's
// call). Numbers are baked into _data.ts with a date stamp — see that file.

export const metadata: Metadata = {
  title: '使用数据 · 上线 96 天',
  description: '越侬上线 96 天的系统使用数据',
}

const NUM = 'tabular-nums'

function Stat({ k, v, unit, note }: { k: string; v: string; unit?: string; note: string }) {
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

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
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

function Read({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-[2px] border border-[var(--color-border)] border-l-2 border-l-[var(--color-info)] bg-[var(--color-surface)] p-4">
      <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">{children}</p>
    </div>
  )
}

const P = 'max-w-[66ch] text-[13px] leading-relaxed text-[var(--color-ink-2)]'
const B = 'font-semibold text-[var(--color-ink)]'

export default async function DataPage() {
  await requireUser()

  return (
    <div className="min-h-dvh bg-[var(--color-bg)]">
      <main className="mx-auto max-w-[900px] px-5 pt-10 pb-24 md:px-8">
        {/* ---------- hero ---------- */}
        <p className="mb-3.5 text-[10px] font-medium tracking-[0.16em] text-[var(--color-ink-3)]">
          {BRAND.legalName}
        </p>
        <h1 className="text-[clamp(26px,4.6vw,40px)] leading-[1.12] font-semibold tracking-tight text-balance">
          越侬上线 {DAYS_LIVE} 天,
          <br className="hidden sm:block" />
          系统里发生了什么
        </h1>
        <p className={`mt-4 ${P}`}>
          {GO_LIVE} 第一张工单进系统。到 {AS_OF} 为止,共{' '}
          <b className={B}>{TOTALS.baogong.toLocaleString('en-US')}</b> 条报工记录、
          {TOTALS.jobs.toLocaleString('en-US')} 张工单、{TOTALS.parts.toLocaleString('en-US')}{' '}
          个零件、{TOTALS.shipments.toLocaleString('en-US')} 张出货单。
          下面是每周的完整数字,包括两个已经没人用的模块,以及几处会让人读错的口径。
        </p>
        <div
          className={`mt-5 flex flex-wrap gap-x-6 gap-y-1.5 border-t border-[var(--color-border)] pt-3.5 text-[11px] text-[var(--color-ink-3)] ${NUM}`}
        >
          <span>数据截至 {AS_OF}</span>
          <span>生产数据库全量计数 · 非抽样</span>
          <span>共 {TOTALS.accounts} 个账号</span>
        </div>

        {/* ---------- stat rail ---------- */}
        <div className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-3 lg:grid-cols-6">
          <Stat k="上线天数" v={String(DAYS_LIVE)} unit="天" note={`${GO_LIVE} 第一张工单`} />
          <Stat
            k="报工记录"
            v={TOTALS.baogong.toLocaleString('en-US')}
            note="工序上的每一次点击"
          />
          <Stat
            k="工单 / 零件"
            v={TOTALS.jobs.toLocaleString('en-US')}
            note={`${TOTALS.parts.toLocaleString('en-US')} 个零件在册`}
          />
          <Stat k="每周报工人数" v="7 → 26" note="首周 7 人,现 26–29 人" />
          <Stat k="每周报工次数" v="5,297" unit="次" note="8/03 当周;6/01 为 2,213" />
          <Stat
            k="每周活跃账号"
            v={String(TOTALS.peakWau)}
            note={`共 ${TOTALS.accounts} 个账号`}
          />
        </div>

        {/* ---------- 01 ---------- */}
        <section className="mt-14">
          <SectionHead n="01" title="报工:每周有多少人,点了多少次" tag="part_stages · 每周" />
          <p className={P}>
            报工是把一个零件在一道工序上标记开工或完成。它是这套数据里唯一必须有人动手才会产生的记录 ——
            所以看使用情况,先看这两条。
          </p>

          <div className="mt-4 space-y-3.5">
            <Card title="每周实际报工人数" sub="当周有过报工动作的人数">
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
                斜纹柱 = 5 月中的历史补录周与仅 1 天的当前周,两者都不计入趋势。
              </div>
            </Card>
          </div>

          <Read>
            人数在第 3 周到 22 人,之后基本不动;一直在变的是人均 ——{' '}
            <b className={`${B} ${NUM}`}>每人每周 85 次 → 204 次</b>。
            两种解释:一是工序颗粒度变细了(报工点位变多),二是同一批人把更多环节放进了系统。
            从新工单量基本持平、而开工数同步翻倍看,第二种解释更站得住,但这份数据本身分不干净。
          </Read>
        </section>

        {/* ---------- 02 ---------- */}
        <section className="mt-14">
          <SectionHead n="02" title="另外四张表" tag="每周" />
          <p className={P}>
            这四张表由不同岗位写入:商务开单与出货、跟单外协、采购下单。曲线互相独立,可以分别看。
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
          <Read>
            新工单量 14 周基本持平(每周 110 张上下),出货和外协翻了几倍。
            也就是说,增长不来自订单变多,而来自原本在微信和纸上的流转搬进了系统。
          </Read>
        </section>

        {/* ---------- 03 ---------- */}
        <section className="mt-14">
          <SectionHead n="03" title="采购模块:从第一条到全厂在用" tag="5 周" />
          <p className={P}>
            采购是最近一个补上的模块。生产负责人和老板先后提过同一件事 ——
            采购要能看到预计到料时间、是否下单、是否到货。第一条记录出现在 7/06,
            完整流程(待下单 → 下单 → 到货 → 检验)8/02 上线。
          </p>
          <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-border)] lg:grid-cols-4">
            <Stat k="第一条记录" v="7/06" note="模块开始被使用" />
            <Stat k="五周后" v="126" unit="条/周" note="8/03 当周" />
            <Stat k="全流程上线" v="8/02" note="待下单 → 下单 → 到货 → 检验" />
            <Stat
              k="累计"
              v={TOTALS.procurements.toLocaleString('en-US')}
              unit="条"
              note="可关联到具体工号"
            />
          </div>

          <div className="mt-5">
            <div className="mb-2.5 text-[11px] font-medium tracking-[0.1em] text-[var(--color-ink-3)]">
              上线后陆续加的模块
            </div>
            <ol className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
              {TIMELINE.map((t) => (
                <li
                  key={t.when}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[var(--color-border)] px-4 py-3 last:border-b-0"
                >
                  <span className={`w-[52px] shrink-0 text-[11px] text-[var(--color-ink-3)] ${NUM}`}>
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
          <SectionHead n="04" title="两个已经没人用的模块" tag="写入量 · 每周" />
          <p className={P}>
            不是所有模块都被接受了。这两个都经历了「上线 → 被用起来 → 归零」,和上面那些曲线出自同一个库、同一段时间。
          </p>
          <div className="mt-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <Card title="笔记" sub="条 / 周">
              <WeeklyBars
                metric="notes"
                title="笔记"
                aria="笔记每周写入量,7 月中峰值 17 条,7 月底起归零"
              />
            </Card>
            <Card title="每日焦点" sub="条 / 周">
              <WeeklyBars
                metric="foc"
                title="每日焦点"
                aria="每日焦点每周写入量,6 月底峰值 173 条,之后回落到个位数"
              />
            </Card>
          </div>
          <Read>
            笔记 7 月中到过每周 17 条,<b className={B}>7/31 之后没有任何人再写</b>;
            每日焦点在 6 月底那周冲到 173 条,现在是个位数。
            共同点是:两者都不是干活必须经过的一步 —— 不写,零件照样往下走。
            报工、出货、外协、采购不是这样,跳过就断链。这条区别比任何一条上升曲线更能说明模块该怎么设计。
          </Read>
        </section>

        {/* ---------- 05 ---------- */}
        <section className="mt-14">
          <SectionHead n="05" title="每周明细" tag="全部原始数据" />
          <div className="overflow-x-auto rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
            <table className={`w-full min-w-[820px] border-collapse text-[11.5px] ${NUM}`}>
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
                    '笔记',
                    '焦点',
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
                    <th scope="row" className="px-2.5 py-1.5 text-left font-normal whitespace-nowrap">
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
                        d.notes,
                        d.foc,
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
            口径 —— 引用任何一个数字前先读
          </div>
          <ol className="list-decimal space-y-2 pl-5 text-[11.5px] leading-relaxed text-[var(--color-ink-3)]">
            <li>
              <b className="font-medium text-[var(--color-ink-2)]">5/18 当周是历史补录。</b>
              当周 9,895 次报工完成、3,857 次开工,而新进零件只有 493 个 —— 这是把已有在制品一次性录入,
              不是当周产出。所有趋势口径已剔除。
            </li>
            <li>
              <b className="font-medium text-[var(--color-ink-2)]">出货会级联关闭工序。</b>
              一张出货单会自动把该工单剩余工序标记完成,因此「报工完成数」被高估,且这些完成会记在出货的人名下。
              <b className="font-medium text-[var(--color-ink-2)]">看采用情况应以「每周报工人数」为准。</b>
            </li>
            <li>
              <b className="font-medium text-[var(--color-ink-2)]">页面埋点 2026-07-08 才上线。</b>
              「活跃账号」在此之前是「—」,含义是未采集,不是没人用。
            </li>
            <li>
              <b className="font-medium text-[var(--color-ink-2)]">报工人按姓名文本记录。</b>
              8/04 上线改名功能后曾出现历史断裂,8/05 已修复;早期个别周的「报工人数」可能把同一个人算成两个。
            </li>
            <li>
              2,422 条报工记录早于 <code>finished_at</code> 字段,只有文本日期,不在每周曲线里(但计入累计)。
            </li>
            <li>
              最后一周({WEEKS[WEEKS.length - 1].w})只有 1 天数据。数据取自生产数据库全量计数,截至 {AS_OF}。
            </li>
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
