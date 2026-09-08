import { notFound } from 'next/navigation'
import { listOpenReturns } from '@/lib/db'
import { requireReturnsDesk } from '@/lib/auth'
import { getReturnFlow } from '@/lib/return-flow-store'
import { BRAND } from '@/lib/brand'
import { today } from '@/lib/today'
import { PrintButton } from '@/app/_print_button'

export const dynamic = 'force-dynamic'

// 返工工单 —— 下发那一步交到车间的那张纸。
//
// 车间要知道的就四件事: 哪个工单的哪几个件、退回几件、为什么退、怎么救、什
// 么时候要。所以这张纸上没有客户、没有价钱, 只有这四件事和两个签名。
export default async function ReworkOrderPage(props: {
  params: Promise<{ id: string }>
}) {
  await requireReturnsDesk()
  const { id } = await props.params
  const [rows, flow] = await Promise.all([listOpenReturns(), getReturnFlow(id)])
  const row = rows.find((r) => r.ret.id === id)
  if (!row) notFound()

  const totalQty = row.parts.reduce((s, p) => s + p.qty, 0)

  return (
    <>
      <PrintButton />
      <article className="doc">
        <header className="border-b border-[var(--color-ink)] pb-3">
          <p className="text-center text-[13px] tracking-wide text-[var(--color-ink)]">
            {BRAND.legalName}
          </p>
          <h1 className="mt-2 text-center text-[26px] font-semibold tracking-[0.2em]">
            返工工单
          </h1>
        </header>

        <section className="grid grid-cols-2 gap-x-10 gap-y-3 border-b border-[var(--color-border)] py-5 text-[14px] font-medium">
          <Field label="工号" value={<span className="mono">{row.jobNo}</span>} />
          <Field
            label="二次交期"
            value={<span className="mono">{row.ret.dueDate}</span>}
          />
          <Field label="产品" value={row.product} />
          <Field
            label="退货日期"
            value={<span className="mono">{row.ret.createdAt.slice(0, 10)}</span>}
          />
          <Field label="不良原因" value={row.ret.reason} />
          <Field label="返工件数" value={<span className="mono">{totalQty}</span>} />
          {row.ret.reasonText && (
            <Field label="客户描述" colSpan value={row.ret.reasonText} />
          )}
        </section>

        <section className="py-4">
          <table className="doc-grid">
            <thead>
              <tr>
                <th style={{ width: 40 }}>序号</th>
                <th>零件名称</th>
                <th style={{ width: 80 }}>原数量</th>
                <th style={{ width: 80 }}>返工数量</th>
                <th style={{ width: 120 }}>完成签收</th>
              </tr>
            </thead>
            <tbody>
              {row.parts.map((p, i) => (
                <tr key={p.componentId}>
                  <td className="mono text-[var(--color-ink-3)]">
                    {String(i + 1).padStart(2, '0')}
                  </td>
                  <td className="font-medium">{p.name}</td>
                  <td className="mono">{p.totalQty}</td>
                  <td className="mono font-semibold">{p.qty}</td>
                  <td />
                </tr>
              ))}
              <tr>
                <td colSpan={3} className="label" style={{ textAlign: 'right' }}>
                  合计
                </td>
                <td className="mono font-semibold">{totalQty}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </section>

        <section className="border-t border-[var(--color-ink)] pt-4">
          <Block
            title="处理方案"
            owner="工程"
            text={flow?.plan}
            sign={sign(flow?.planBy, flow?.planAt)}
          />
          <Block
            title="原因调查"
            owner="质量"
            text={flow?.cause}
            sign={sign(flow?.causeBy, flow?.causeAt)}
          />
        </section>

        <footer className="mt-12">
          <div className="flex items-end justify-between gap-10">
            <p className="min-w-[200px] flex-1">
              <span className="label mr-3">下发</span>
              <span className="text-[13px] text-[var(--color-ink-2)]">
                {sign(flow?.releasedBy, flow?.releasedAt) ?? ''}
              </span>
              <span className="mt-8 block h-px w-full bg-[var(--color-ink)]" />
            </p>
            <p className="min-w-[200px] flex-1">
              <span className="label mr-3">车间接收</span>
              <span className="mt-8 block h-px w-full bg-[var(--color-ink)]" />
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
            <span className="mono text-[var(--color-ink-3)]">
              打印 {today()}
            </span>
          </p>
        </footer>
      </article>
    </>
  )
}

function Field({
  label,
  value,
  colSpan,
}: {
  label: string
  value: React.ReactNode
  colSpan?: boolean
}) {
  return (
    <div className={`flex items-baseline gap-3 ${colSpan ? 'col-span-2' : ''}`}>
      <span className="label shrink-0">{label}</span>
      <span className="min-w-0 flex-1 border-b border-[var(--color-border-strong)] pb-0.5">
        {value || '—'}
      </span>
    </div>
  )
}

function Block({
  title,
  owner,
  text,
  sign,
}: {
  title: string
  owner: string
  text?: string
  sign?: string
}) {
  return (
    <div className="mb-4">
      <p className="flex items-baseline gap-2">
        <span className="label">{title}</span>
        <span className="label text-[var(--color-ink-4)]">{owner}</span>
        {sign && (
          <span className="ml-auto text-[11px] text-[var(--color-ink-3)]">
            {sign}
          </span>
        )}
      </p>
      <p className="mt-1 min-h-[38px] whitespace-pre-wrap border-b border-[var(--color-border)] pb-2 text-[13px] leading-relaxed text-[var(--color-ink)]">
        {text || '—'}
      </p>
    </div>
  )
}

function sign(by?: string, at?: string): string | undefined {
  if (!by && !at) return undefined
  return [by, at?.slice(0, 10)].filter(Boolean).join(' · ')
}
