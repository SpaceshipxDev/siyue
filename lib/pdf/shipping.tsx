import 'server-only'
import { Document, Image, Page, Text, View } from '@react-pdf/renderer'
import type { Customer, Job } from './../data'
import {
  customerById,
  latestShipment,
} from './../data'
import { BRAND } from './../brand'
import { COLOR, styles } from './styles'
import { DocFooter } from './footer'
import { ensureFontsRegistered } from './fonts'
import type { ImageSource } from './images'
import { stripProcessMethodFromNotes } from './sanitize'

ensureFontsRegistered()

// Column widths for the shipping table — fixed flex weights so a long product
// name doesn't push the qty column off the page.
const COL = {
  seq: 28,
  thumb: 56,
  name: 120,
  material: 80,
  qty: 56,
  partNo: 90,
  notes: 92,
} as const

export function ShippingDocPDF({
  job,
  customers,
  images,
}: {
  job: Job
  customers: Customer[]
  images: Map<string, ImageSource>
}) {
  const customer = customerById(job.customerId, customers)
  const customerName = customer?.name ?? job.customer

  // PDF mirrors the print page: the most recent shipment is the printable
  // batch. Older shipments are audit history and are not re-rendered.
  const shipment = latestShipment(job)
  const componentById = new Map(job.components.map((c) => [c.id, c]))
  const shippingRows = shipment
    ? shipment.parts
        .map((sp) => {
          const c = componentById.get(sp.componentId)
          return c ? { component: c, qty: sp.qty } : null
        })
        .filter((x): x is { component: Job['components'][number]; qty: number } => x !== null)
    : []
  const shippingStarted = shippingRows.length > 0
  const totalShipped = shippingRows.reduce((s, r) => s + r.qty, 0)
  // 出货单号 prints the 销售单号 (工单号) verbatim, not the internal shipment doc_no.
  const docNo = job.jobNo ?? ''

  return (
    <Document
      title={docNo ? `出货单 ${docNo}` : '出货单'}
      author={BRAND.legalName}
      creator={BRAND.softwareCredit}
      producer={BRAND.softwareCredit}
    >
      <Page size="A4" style={styles.page} wrap>
        {/* Header */}
        <View style={styles.headerRule}>
          <Text style={styles.brandLine}>{BRAND.legalName}</Text>
          <Text style={styles.title}>出货单</Text>
          <Text style={styles.titleEn}>SHIPPING NOTE</Text>
        </View>

        {/* Field grid */}
        <View style={styles.fieldGrid}>
          <Field
            label="出货单号"
            value={docNo || '—'}
          />
          <Field label="送货日期" value={job.dueDate} />
          <Field label="客户名称" value={customerName || '—'} />
          <Field label="制单人" value={job.createdBy || '—'} />
          <Field label="工程师" value={job.engineer || '—'} />
          <Field label="联系人" value={customer?.contact || '—'} />
          <Field label="合同编号" value={job.contractNo || '—'} />
          <Field label="联系方式" value={customer?.phone || '—'} />
          <Field label="生产批次" value={job.batchNo || '—'} />
          <Field full label="备注" value={stripProcessMethodFromNotes(job.notes) || '—'} />
        </View>

        {/* Table — rendered only after the shipping stage has been opened on at
            least one component. Until then the doc prints as a blank intent
            note: header + customer info, no line items, no totals, no amount. */}
        {shippingStarted ? (
          <>
            <View style={styles.tableWrap}>
              <View style={styles.tableHeaderRow} fixed>
                <Text style={[styles.th, { width: COL.seq }]}>序号</Text>
                <Text style={[styles.th, { width: COL.thumb }]}>产品图片</Text>
                <Text style={[styles.th, { flex: 1 }]}>产品名称</Text>
                <Text style={[styles.th, { width: COL.material }]}>材质</Text>
                <Text style={[styles.th, { width: COL.qty, textAlign: 'right' }]}>
                  出货数量
                </Text>
                <Text style={[styles.th, { width: COL.partNo }]}>料号</Text>
                <Text style={[styles.th, { width: COL.notes }]}>备注</Text>
              </View>

              {shippingRows.map(({ component: c, qty }, i) => {
                const img = c.imageUrl ? images.get(c.imageUrl) : undefined
                return (
                  <View key={c.id} style={styles.tableRow} wrap={false}>
                    <Text style={[styles.tdSeq, { width: COL.seq }]}>
                      {String(i + 1).padStart(2, '0')}
                    </Text>
                    <View style={[styles.thumbCell, { width: COL.thumb }]}>
                      {img ? (
                        // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer Image, no alt prop
                        <Image style={styles.thumb} src={img.data} />
                      ) : (
                        <Text style={styles.thumbPlaceholder}>—</Text>
                      )}
                    </View>
                    <Text style={[styles.td, { flex: 1, fontWeight: 500 }]}>
                      {c.name}
                    </Text>
                    <Text style={[styles.tdMuted, { width: COL.material }]}>
                      {c.material ?? '—'}
                    </Text>
                    <Text
                      style={[styles.td, { width: COL.qty, textAlign: 'right' }]}
                    >
                      {qty}
                    </Text>
                    <Text style={[styles.tdMuted, { width: COL.partNo }]}>
                      {c.partNo ?? ''}
                    </Text>
                    <Text style={[styles.tdMuted, { width: COL.notes }]}>
                      {stripProcessMethodFromNotes(c.notes)}
                    </Text>
                  </View>
                )
              })}

              {/* Totals row */}
              <View style={styles.tableTotalRow}>
                <Text
                  style={[
                    styles.th,
                    {
                      width: COL.seq + COL.thumb + COL.material,
                      flex: 1,
                      textAlign: 'right',
                    },
                  ]}
                >
                  合计
                </Text>
                <Text
                  style={[
                    styles.td,
                    {
                      width: COL.qty,
                      textAlign: 'right',
                      fontWeight: 600,
                    },
                  ]}
                >
                  {totalShipped}
                </Text>
                <Text style={[styles.td, { width: COL.partNo + COL.notes }]} />
              </View>
            </View>

          </>
        ) : null}

        {/* Footer signature */}
        <View style={[styles.signatureBlock, { justifyContent: 'flex-end' }]}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
            <Text style={styles.amountLabel}>签收人</Text>
            <View
              style={{
                width: 160,
                borderBottomWidth: 0.5,
                borderBottomColor: COLOR.ink,
                height: 12,
              }}
            />
          </View>
        </View>

        <DocFooter />
      </Page>
    </Document>
  )
}

function Field({
  label,
  value,
  full,
}: {
  label: string
  value: string
  full?: boolean
}) {
  return (
    <View style={full ? styles.fieldFull : styles.fieldHalf}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  )
}
