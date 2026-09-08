import { notFound } from 'next/navigation'
import { getJob } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getNcPrograms } from '@/lib/nc-program-store'
import { programsByPart, type NcProgram } from '@/lib/nc-program'
import { partRef } from '@/lib/data'
import { BRAND } from '@/lib/brand'
import { today } from '@/lib/today'
import { PrintButton } from '@/app/_print_button'

export const dynamic = 'force-dynamic'

// 加工程序单 —— 编程出完程序之后, 交到机台边的那张纸。
//
// 为什么要这张纸: 程序单在屏幕上只解决了"存下来", 没解决"送到手上"。机台前
// 未必有电脑, 操机也不会为了看一行刀具去翻系统 —— 厂里认的是纸。这张纸上就
// 四件事: 哪个件、调哪个程序、上哪台机怎么装夹、备哪几把刀。
//
// 没出程序的零件照样印, 格子留白 —— 现场手写补上, 回头再录进系统。这跟沟通
// 确认单是同一个道理: 一张能带着走、能当场写的纸, 比一张只能看的完美表格有用。
export default async function ProgramSheetPrintPage(props: {
  params: Promise<{ id: string }>
}) {
  await requireUser()
  const { id } = await props.params
  const [job, all] = await Promise.all([getJob(id), getNcPrograms()])
  if (!job) notFound()

  const byPart = programsByPart(all.filter((p) => p.jobId === job.id))
  const rows = job.components.map((c, i) => ({
    seq: c.seqLabel || String(i + 1).padStart(2, '0'),
    name: c.name,
    partNo: c.partNo,
    material: c.material,
    qty: c.qty,
    programs: byPart.get(partRef(job.id, c.id)) ?? [],
  }))
  const totalPrograms = rows.reduce((s, r) => s + r.programs.length, 0)

  return (
    <>
      <PrintButton />
      <article className="doc">
        <header className="border-b border-[var(--color-ink)] pb-3">
          <p className="text-center text-[13px] tracking-wide text-[var(--color-ink)]">
            {BRAND.legalName}
          </p>
          <h1 className="mt-2 text-center text-[26px] font-semibold tracking-[0.2em]">
            加工程序单
          </h1>
        </header>

        <section className="grid grid-cols-2 gap-x-10 gap-y-3 border-b border-[var(--color-border)] py-5 text-[14px] font-medium">
          <Field label="工号" value={<span className="mono">{job.jobNo}</span>} />
          <Field
            label="交期"
            value={<span className="mono">{job.dueDate || '—'}</span>}
          />
          <Field label="产品" value={job.product} />
          <Field
            label="零件 / 程序"
            value={
              <span className="mono">
                {rows.length} 件 · {totalPrograms} 个程序
              </span>
            }
          />
        </section>

        <section className="py-4">
          <table className="doc-grid">
            <thead>
              <tr>
                <th style={{ width: 34 }}>序号</th>
                <th>零件名称</th>
                <th style={{ width: 78 }}>料号</th>
                <th style={{ width: 66 }}>材质</th>
                <th style={{ width: 40 }}>数量</th>
                <th style={{ width: 92 }}>程序号</th>
                <th style={{ width: 62 }}>机床</th>
                <th style={{ width: 72 }}>装夹</th>
                <th style={{ width: 118 }}>刀具</th>
                <th style={{ width: 42 }}>单件分</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <PartRows key={r.seq + r.name} row={r} />
              ))}
            </tbody>
          </table>
        </section>

        <footer className="mt-10">
          <div className="flex items-end justify-between gap-10">
            <p className="min-w-[190px] flex-1">
              <span className="label mr-3">编程</span>
              <span className="mt-9 block h-px w-full bg-[var(--color-ink)]" />
            </p>
            <p className="min-w-[190px] flex-1">
              <span className="label mr-3">车间接收</span>
              <span className="mt-9 block h-px w-full bg-[var(--color-ink)]" />
            </p>
          </div>
          <p className="mt-6 flex items-baseline justify-between text-[11px]">
            <span className="flex items-baseline gap-1.5">
              <span className="tracking-[0.1em] text-[var(--color-ink-3)]">
                {BRAND.software}
              </span>
              <span className="text-[var(--color-ink-4)]">·</span>
              <span className="text-[var(--color-ink-2)]">{BRAND.domain}</span>
            </span>
            <span className="mono text-[var(--color-ink-3)]">打印 {today()}</span>
          </p>
        </footer>
      </article>
    </>
  )
}

// 一个零件一行; 出了几个程序就是几行, 左边那几格竖着并起来 —— 粗精两刀、二
// 次装夹, 在纸上就该是同一个件下面的两行。
function PartRows({
  row,
}: {
  row: {
    seq: string
    name: string
    partNo?: string
    material?: string
    qty: number
    programs: NcProgram[]
  }
}) {
  const list: (NcProgram | null)[] =
    row.programs.length > 0 ? row.programs : [null]
  const span = list.length
  return (
    <>
      {list.map((p, i) => (
        <tr key={p?.id ?? 'blank'}>
          {i === 0 && (
            <>
              <td rowSpan={span} className="mono text-[var(--color-ink-3)]">
                {row.seq}
              </td>
              <td rowSpan={span} className="font-medium">
                {row.name || '—'}
              </td>
              <td rowSpan={span} className="mono text-[var(--color-ink-2)]">
                {row.partNo || ''}
              </td>
              <td rowSpan={span} className="text-[var(--color-ink-2)]">
                {row.material || ''}
              </td>
              <td rowSpan={span} className="mono">
                {row.qty}
              </td>
            </>
          )}
          <td className="mono font-medium">{p?.no ?? ' '}</td>
          <td>{p?.machine ?? ' '}</td>
          <td>{p?.fixture ?? ' '}</td>
          <td style={{ textAlign: 'left' }}>{p?.tools ?? ' '}</td>
          <td className="mono">{p?.minutes ?? ' '}</td>
        </tr>
      ))}
    </>
  )
}

function Field({
  label,
  value,
}: {
  label: string
  value?: React.ReactNode
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="label shrink-0">{label}</span>
      <span className="min-w-0 flex-1 border-b border-[var(--color-border-strong)] pb-0.5">
        {value || '—'}
      </span>
    </div>
  )
}
