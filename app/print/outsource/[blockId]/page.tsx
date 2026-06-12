import { notFound } from 'next/navigation'
import {
  blockLineTotalsSum,
  effectiveMemberLineTotal,
  effectiveUnitPriceCny,
  formatCny,
  vendorById,
} from '@/lib/data'
import { ensureOutsourceDocNo, getOutsourceBlock, getVendors } from '@/lib/db'
import { requireOutsourceManager } from '@/lib/auth'
import { BRAND } from '@/lib/brand'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { PrintToolbar } from '@/app/_print'
import {
  BlockMemberUnitPrice,
  ComponentQty,
  ComponentText,
  NameCombobox,
  OutsourceBlockAmount,
  OutsourceBlockDate,
  OutsourceBlockText,
  VendorText,
} from '@/app/_editable'

export const dynamic = 'force-dynamic'

export default async function OutsourceDocPage(
  props: PageProps<'/print/outsource/[blockId]'>,
) {
  await requireOutsourceManager()
  const { blockId } = await props.params
  const [info, vendors] = await Promise.all([
    getOutsourceBlock(blockId),
    getVendors(),
  ])
  if (!info) notFound()
  const vendor = vendorById(info.block.vendorId, vendors)
  const docNo =
    info.block.docNo ?? (await ensureOutsourceDocNo(info.block.id))

  const now = new Date()
  const createdAt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

  const recipientAddress = info.block.recipientAddress ?? BRAND.address
  const recipientName =
    info.block.recipientContactName ?? BRAND.receivingContact.name
  const recipientPhone =
    info.block.recipientContactPhone ?? BRAND.receivingContact.phone

  return (
    <>
      <PrintToolbar pdfHref={`/print/outsource/${info.block.id}/pdf`} />
      <article className="doc">
        <header className="border-b border-[var(--color-ink)] pb-3">
          <p className="text-center text-[12px] text-[var(--color-ink-2)] tracking-wide">
            {BRAND.legalName}
          </p>
          <h1 className="text-center text-[28px] font-semibold tracking-tight mt-1">
            外协单
          </h1>
          <p className="text-center text-[10px] text-[var(--color-ink-3)] tracking-[0.18em] uppercase mt-0.5">
            Purchase / Outsource Order
          </p>
        </header>

        <section className="grid grid-cols-2 gap-x-10 gap-y-3 py-5 text-[14px] font-medium border-b border-[var(--color-border)]">
          <Field
            label="外协单号"
            value={
              <OutsourceBlockText
                blockId={info.block.id}
                jobId={info.jobId}
                field="docNo"
                value={docNo}
                className="mono"
              />
            }
          />
          <Field
            label="供应商"
            value={
              <NameCombobox
                target={{ kind: 'vendor', blockId: info.block.id, jobId: info.jobId }}
                value={vendor?.name}
                options={vendors.map((v) => ({ id: v.id, name: v.name }))}
              />
            }
          />
          <Field
            label="制单人"
            value={
              <OutsourceBlockText
                blockId={info.block.id}
                jobId={info.jobId}
                field="createdBy"
                value={info.block.createdBy}
              />
            }
          />
          <Field
            label="联系人"
            value={
              <VendorText
                vendorId={vendor?.id}
                field="notes"
                value={vendor?.notes}
              />
            }
          />
          <Field
            label="制单时间"
            value={<span className="mono">{createdAt}</span>}
          />
          <Field
            label="销售单号"
            value={<span className="mono">{info.jobNo}</span>}
          />
          <Field
            label="寄出时间"
            value={
              <OutsourceBlockDate
                blockId={info.block.id}
                jobId={info.jobId}
                field="sentDate"
                value={info.block.sentDate}
              />
            }
          />
          <Field
            label="到料时间"
            value={
              <OutsourceBlockDate
                blockId={info.block.id}
                jobId={info.jobId}
                field="expectedReturn"
                value={info.block.expectedReturn}
              />
            }
          />
          <Field
            label="供应商地址"
            colSpan={2}
            value={
              <VendorText
                vendorId={vendor?.id}
                field="address"
                value={vendor?.address}
              />
            }
          />
          <Field
            label="收件地址"
            colSpan={2}
            value={
              <OutsourceBlockText
                blockId={info.block.id}
                jobId={info.jobId}
                field="recipientAddress"
                value={recipientAddress}
              />
            }
          />
          <Field
            label="收件人"
            value={
              <OutsourceBlockText
                blockId={info.block.id}
                jobId={info.jobId}
                field="recipientContactName"
                value={recipientName}
              />
            }
          />
          <Field
            label="联系电话"
            value={
              <OutsourceBlockText
                blockId={info.block.id}
                jobId={info.jobId}
                field="recipientContactPhone"
                value={recipientPhone}
                className="mono"
              />
            }
          />
          <Field
            label="订单金额（含税）"
            value={
              <span className="font-semibold inline-flex items-baseline gap-0.5">
                <span>¥</span>
                <OutsourceBlockAmount
                  blockId={info.block.id}
                  jobId={info.jobId}
                  value={info.block.amountCny}
                  className="font-semibold [field-sizing:content] min-w-[2ch]"
                />
              </span>
            }
          />
          <Field
            label="备注"
            colSpan={2}
            value={
              <OutsourceBlockText
                blockId={info.block.id}
                jobId={info.jobId}
                field="notes"
                value={info.block.notes}
              />
            }
          />
        </section>

        <section className="py-4">
          <table>
            <thead>
              <tr>
                <th style={{ width: 36 }}>序号</th>
                <th style={{ width: 72 }}>产品图片</th>
                <th>产品名称</th>
                <th style={{ width: 90 }}>料号</th>
                <th style={{ width: 90 }}>材料</th>
                <th style={{ width: 64, textAlign: 'right' }}>采购数量</th>
                <th style={{ width: 72, textAlign: 'right' }}>单价</th>
                <th style={{ width: 84, textAlign: 'right' }}>总价</th>
                <th style={{ width: 84 }}>备注</th>
              </tr>
            </thead>
            <tbody>
              {info.block.members.map((m, i) => {
                const isOrphan = m.componentId.startsWith('__orphan__')
                const up = effectiveUnitPriceCny(m, info.block)
                const lt = effectiveMemberLineTotal(m, info.block)
                return (
                  <tr key={`${m.componentId}-${i}`}>
                    <td className="mono text-[var(--color-ink-3)]">
                      {String(i + 1).padStart(2, '0')}
                    </td>
                    <td>
                      {m.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={proxiedStorageUrl(m.imageUrl)} alt={m.name} className="doc-thumb" />
                      ) : (
                        <span className="text-[var(--color-ink-4)]">—</span>
                      )}
                    </td>
                    <td
                      className={
                        isOrphan
                          ? 'italic text-[var(--color-overdue)]'
                          : 'font-medium'
                      }
                    >
                      {m.name}
                    </td>
                    <td className="mono text-[var(--color-ink-2)]">
                      {isOrphan ? (
                        m.partNo ?? ''
                      ) : (
                        <ComponentText
                          jobId={info.jobId}
                          componentId={m.componentId}
                          field="partNo"
                          value={m.partNo}
                          placeholder="—"
                        />
                      )}
                    </td>
                    <td className="text-[var(--color-ink-2)]">
                      {m.material ?? '—'}
                    </td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {isOrphan ? (
                        m.qty
                      ) : (
                        <ComponentQty
                          jobId={info.jobId}
                          componentId={m.componentId}
                          value={m.qty}
                          className="mono text-right [field-sizing:content] min-w-[3ch]"
                        />
                      )}
                    </td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      <span className="inline-flex items-baseline gap-0.5">
                        <span className="text-[var(--color-ink-3)]">¥</span>
                        {isOrphan ? (
                          <span>{up != null ? Math.round(up) : '—'}</span>
                        ) : (
                          <BlockMemberUnitPrice
                            blockId={info.block.id}
                            componentId={m.componentId}
                            jobId={info.jobId}
                            value={m.unitPriceCny}
                            className="mono text-right [field-sizing:content] min-w-[3ch]"
                          />
                        )}
                      </span>
                    </td>
                    <td className="mono font-medium" style={{ textAlign: 'right' }}>
                      {lt != null ? formatCny(lt) : '—'}
                    </td>
                    <td className="text-[var(--color-ink-2)]">
                      {i === 0 ? (info.block.notes ?? '') : ''}
                    </td>
                  </tr>
                )
              })}
              <tr>
                <td colSpan={5} className="label" style={{ textAlign: 'right' }}>
                  合计
                </td>
                <td className="mono font-semibold" style={{ textAlign: 'right' }}>
                  {info.block.members.reduce((s, m) => s + m.qty, 0)}
                </td>
                <td />
                <td className="mono font-semibold" style={{ textAlign: 'right' }}>
                  {(() => {
                    const sum = blockLineTotalsSum(info.block)
                    const grand = sum ?? info.block.amountCny
                    return grand != null ? formatCny(grand) : '—'
                  })()}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </section>

        <footer className="mt-12 grid grid-cols-2 gap-12 text-[12px] text-[var(--color-ink-2)]">
          <div>
            <p className="label mb-12">甲方签章</p>
            <p className="border-t border-[var(--color-ink)] pt-1 text-[10px] text-[var(--color-ink-3)]">
              {BRAND.shortName}
            </p>
          </div>
          <div>
            <p className="label mb-12">乙方签章</p>
            <p className="border-t border-[var(--color-ink)] pt-1 text-[10px] text-[var(--color-ink-3)]">
              {vendor?.name ?? '外协厂'}
            </p>
          </div>
        </footer>

        <p className="mt-8 text-[10px] text-[var(--color-ink-4)] tracking-[0.14em] uppercase">
          {BRAND.software}
        </p>
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
      <span className="label shrink-0 min-w-[80px]">{label}</span>
      <span className="flex-1 border-b border-[var(--color-border)] pb-0.5 min-h-[18px]">
        {value || <span>&nbsp;</span>}
      </span>
    </div>
  )
}
