import { notFound } from 'next/navigation'
import {
  customerById,
  selectShipment,
} from '@/lib/data'
import { formatShipDate } from '@/lib/ship-date'
import {
  getCustomers,
  getJob,
  updateJob,
  upsertCustomerByName,
} from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { BRAND } from '@/lib/brand'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { stripProcessMethodFromNotes } from '@/lib/pdf/sanitize'
import { PrintToolbar } from '@/app/_print'
import {
  ComponentText,
  CustomerText,
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
  const sp = await props.searchParams
  const shipmentId = typeof sp.shipment === 'string' ? sp.shipment : undefined
  let [job, customers] = await Promise.all([getJob(id), getCustomers()])
  if (!job) notFound()

  // Auto-link the customer record when only the name is set. Imports leave
  // customerId null with the name on job.customer, but the inline edits on
  // this page (联系人 / 联系方式 → CustomerText) need a customerId to persist.
  // Without this, users would type a contact, see it locally, then watch the
  // value vanish on the printed PDF because the save silently no-op'd.
  if (job.customer && !customerById(job.customerId, customers)) {
    const upserted = await upsertCustomerByName(job.customer)
    if (upserted && job.customerId !== upserted.id) {
      await updateJob(job.id, { customerId: upserted.id })
      const refreshed = await Promise.all([getJob(id), getCustomers()])
      if (!refreshed[0]) notFound()
      job = refreshed[0]
      customers = refreshed[1]
    }
  }

  const customer = customerById(job.customerId, customers)
  const customerName = customer?.name ?? job.customer

  // Each 制作出货单 submission emits a new shipment row. By default this page
  // prints the latest batch (制作出货单 / 重新打印 land here with no param), but
  // the 出货记录 history deep-links any past batch via ?shipment=<id> so its
  // exact 出货单 / PDF is reprintable.
  const shipment = selectShipment(job, shipmentId)
  const componentById = new Map(job.components.map((c) => [c.id, c]))
  const shippingRows = shipment
    ? shipment.parts
        .map((sp) => {
          const c = componentById.get(sp.componentId)
          return c ? { component: c, qty: sp.qty } : null
        })
        .filter((x): x is { component: typeof job.components[number]; qty: number } => x !== null)
    : []
  const shippingStarted = shippingRows.length > 0
  const totalShipped = shippingRows.reduce((s, r) => s + r.qty, 0)
  // 交货单号 prints the 销售单号 (工单号) verbatim — the delivery note carries
  // the sales-order number itself, not the internal per-day shipment doc_no.
  const docNo = job.jobNo
  // 送货日期 = when this batch actually shipped (mirrors the PDF). Read-only:
  // it's the shipment's timestamp, not the order's editable 交期.
  const shipDate = formatShipDate(shipment?.createdAt)
  // 制单人 = whoever made this delivery note; falls back to the order creator.
  const preparedBy = job.createdBy || shipment?.createdBy || ''

  return (
    <>
      <PrintToolbar
        pdfHref={
          shipment
            ? `/jobs/${job.id}/print/shipping/pdf?shipment=${shipment.id}`
            : `/jobs/${job.id}/print/shipping/pdf`
        }
      />
      <article className="doc">
        <header className="border-b border-[var(--color-ink)] pb-3">
          <p className="text-center text-[13px] text-[var(--color-ink)] tracking-wide">
            {BRAND.legalName}
          </p>
          <h1 className="text-center text-[26px] font-semibold tracking-[0.2em] mt-2">
            交货单
          </h1>
        </header>

        <section className="grid grid-cols-2 gap-x-10 gap-y-3 py-5 text-[14px] font-medium border-b border-[var(--color-border)]">
          <Field
            label="交货单号"
            value={<span className="mono">{docNo || '—'}</span>}
          />
          <div />
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
            label="送货日期"
            value={<span className="mono">{shipDate}</span>}
          />
          <Field
            label="联系人"
            value={
              <JobShippingText
                jobId={job.id}
                field="engineer"
                value={job.engineer}
              />
            }
          />
          <Field
            label="制单人"
            value={
              <JobShippingText
                jobId={job.id}
                field="createdBy"
                value={preparedBy}
              />
            }
          />
          <Field
            label="联系方式"
            value={
              <CustomerText
                customerId={customer?.id}
                jobId={job.id}
                field="phone"
                value={customer?.phone}
                className="mono"
              />
            }
          />
          <Field
            label="货品总数"
            value={
              <span className="mono">{shippingStarted ? totalShipped : '—'}</span>
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
                value={stripProcessMethodFromNotes(job.notes)}
                placeholder="—"
              />
            }
          />
        </section>

        {shippingStarted ? (
          <section className="py-4">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 36 }}>序号</th>
                  <th style={{ width: 64 }}>产品图片</th>
                  <th>产品名称</th>
                  <th style={{ width: 96 }}>料号</th>
                  <th style={{ width: 96 }}>材质</th>
                  <th style={{ width: 80, textAlign: 'right' }}>交货数量</th>
                  <th style={{ width: 110 }}>备注</th>
                </tr>
              </thead>
              <tbody>
                {shippingRows.map(({ component: c, qty }, i) => (
                  <tr key={c.id}>
                    <td className="mono text-[var(--color-ink-3)]">
                      {String(i + 1).padStart(2, '0')}
                    </td>
                    <td>
                      {c.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={proxiedStorageUrl(c.imageUrl)}
                          alt={c.name}
                          className="doc-thumb"
                        />
                      ) : (
                        <span className="text-[var(--color-ink-4)]">—</span>
                      )}
                    </td>
                    <td className="font-medium">{c.name}</td>
                    <td className="mono text-[var(--color-ink-2)]">
                      <ComponentText
                        jobId={job.id}
                        componentId={c.id}
                        field="partNo"
                        value={c.partNo}
                        placeholder="—"
                      />
                    </td>
                    <td className="text-[var(--color-ink-2)]">{c.material ?? '—'}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {qty}
                    </td>
                    <td className="text-[var(--color-ink-2)]">{stripProcessMethodFromNotes(c.notes)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={5} className="label" style={{ textAlign: 'right' }}>
                    合计
                  </td>
                  <td className="mono font-semibold" style={{ textAlign: 'right' }}>
                    {totalShipped}
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          </section>
        ) : (
          <section className="screen-only py-16 text-center text-[13px] text-[var(--color-ink-3)]">
            <p>出货单尚未制作。</p>
            <p className="mt-1 label">回到工单详情页,点击「制作出货单」即可生成。</p>
          </section>
        )}

        <footer className="mt-16 flex items-end justify-between text-[12px] text-[var(--color-ink-2)]">
          <p className="flex items-baseline gap-1.5 text-[11px]">
            <span className="tracking-[0.1em] text-[var(--color-ink-3)]">{BRAND.software}</span>
            <span className="text-[var(--color-ink-4)]">·</span>
            <span className="tracking-[0.02em] text-[var(--color-ink-2)]">{BRAND.domain}</span>
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
      <span className="shrink-0 min-w-[72px] text-[var(--color-ink)]">{label}</span>
      <span className="flex-1 border-b border-[var(--color-border)] pb-0.5 min-h-[18px]">
        {value || <span>&nbsp;</span>}
      </span>
    </div>
  )
}
