import { notFound } from 'next/navigation'
import { customerById } from '@/lib/data'
import { ensureShippingDocNo, getCustomers, getJob } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { BRAND } from '@/lib/brand'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { PrintToolbar } from '@/app/_print'
import {
  CustomerText,
  JobAmount,
  JobDueDate,
  JobNotes,
  JobShippingText,
  NameCombobox,
} from '@/app/_editable'

export const dynamic = 'force-dynamic'

export default async function ShippingDocPage(
  props: PageProps<'/jobs/[id]/print/shipping'>,
) {
  await requireUser()
  const { id } = await props.params
  const [job, customers] = await Promise.all([getJob(id), getCustomers()])
  if (!job) notFound()

  const docNo = job.shippingDocNo ?? (await ensureShippingDocNo(id))
  const totalQty = job.components.reduce((s, c) => s + c.qty, 0)
  const customer = customerById(job.customerId, customers)
  const customerName = customer?.name ?? job.customer

  return (
    <>
      <PrintToolbar pdfHref={`/jobs/${job.id}/print/shipping/pdf`} />
      <article className="doc">
        <header className="border-b border-[var(--color-ink)] pb-3">
          <p className="text-center text-[12px] text-[var(--color-ink-2)] tracking-wide">
            {BRAND.legalName}
          </p>
          <h1 className="text-center text-[28px] font-semibold tracking-tight mt-1">
            出货单
          </h1>
          <p className="text-center text-[10px] text-[var(--color-ink-3)] tracking-[0.18em] uppercase mt-0.5">
            Shipping Note
          </p>
        </header>

        <section className="grid grid-cols-2 gap-x-10 gap-y-2 py-4 text-[12px] border-b border-[var(--color-border)]">
          <Field label="出货单号" value={<span className="mono">{docNo}</span>} />
          <Field
            label="送货日期"
            value={<JobDueDate jobId={job.id} value={job.dueDate} className="mono" />}
          />
          <Field
            label="客户名称"
            value={
              <NameCombobox
                target={{ kind: 'customer', jobId: job.id }}
                value={customerName}
                options={customers.map((c) => ({ id: c.id, name: c.name }))}
              />
            }
          />
          <Field
            label="制单人"
            value={
              <JobShippingText
                jobId={job.id}
                field="createdBy"
                value={job.createdBy}
              />
            }
          />
          <Field
            label="联系人"
            value={
              <CustomerText
                customerId={customer?.id}
                field="contact"
                value={customer?.contact}
              />
            }
          />
          <Field
            label="合同编号"
            value={
              <JobShippingText
                jobId={job.id}
                field="contractNo"
                value={job.contractNo}
              />
            }
          />
          <Field
            label="联系方式"
            value={
              <CustomerText
                customerId={customer?.id}
                field="phone"
                value={customer?.phone}
                className="mono"
              />
            }
          />
          <Field
            label="生产批次"
            value={
              <JobShippingText
                jobId={job.id}
                field="batchNo"
                value={job.batchNo}
              />
            }
          />
          <Field
            label="备注"
            colSpan={2}
            value={
              <JobNotes
                jobId={job.id}
                value={job.notes}
                placeholder="—"
              />
            }
          />
        </section>

        <section className="py-4">
          <table>
            <thead>
              <tr>
                <th style={{ width: 36 }}>序号</th>
                <th style={{ width: 64 }}>产品图片</th>
                <th>产品名称</th>
                <th style={{ width: 96 }}>材质</th>
                <th style={{ width: 80, textAlign: 'right' }}>出货数量</th>
                <th>料号</th>
                <th style={{ width: 110 }}>备注</th>
              </tr>
            </thead>
            <tbody>
              {job.components.map((c, i) => (
                <tr key={c.id}>
                  <td className="mono text-[var(--color-ink-3)]">
                    {String(i + 1).padStart(2, '0')}
                  </td>
                  <td>
                    {c.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={proxiedStorageUrl(c.imageUrl)} alt={c.name} className="doc-thumb" />
                    ) : (
                      <span className="text-[var(--color-ink-4)]">—</span>
                    )}
                  </td>
                  <td className="font-medium">{c.name}</td>
                  <td className="text-[var(--color-ink-2)]">{c.material ?? '—'}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {c.qty}
                  </td>
                  <td className="mono text-[var(--color-ink-2)]">{c.name}</td>
                  <td className="text-[var(--color-ink-2)]">{c.notes ?? ''}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={4} className="label" style={{ textAlign: 'right' }}>
                  合计
                </td>
                <td className="mono font-semibold" style={{ textAlign: 'right' }}>
                  {totalQty}
                </td>
                <td colSpan={2} />
              </tr>
            </tbody>
          </table>
        </section>

        <section className="py-2 border-t border-[var(--color-border)] text-right text-[12px] flex items-baseline justify-end gap-2">
          <span className="label">金额</span>
          <span className="mono text-[16px] font-semibold inline-flex items-baseline gap-0.5">
            <span>¥</span>
            <JobAmount
              jobId={job.id}
              value={job.amountCny}
              className="text-[16px] font-semibold [field-sizing:content] min-w-[2ch]"
            />
          </span>
        </section>

        <footer className="mt-16 flex items-end justify-between text-[12px] text-[var(--color-ink-2)]">
          <p className="text-[10px] text-[var(--color-ink-4)] tracking-[0.14em] uppercase">
            {BRAND.software}
          </p>
          <p className="min-w-[220px]">
            <span className="label mr-3">签收人</span>
            <span className="inline-block border-b border-[var(--color-ink)] w-[160px] align-bottom" />
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
  colSpan?: 1 | 2
}) {
  return (
    <div
      className={`flex items-baseline gap-3 ${colSpan === 2 ? 'col-span-2' : ''}`}
    >
      <span className="label shrink-0 min-w-[64px]">{label}</span>
      <span className="flex-1 border-b border-[var(--color-border)] pb-0.5 min-h-[18px]">
        {value || <span>&nbsp;</span>}
      </span>
    </div>
  )
}
