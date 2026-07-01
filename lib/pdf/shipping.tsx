import 'server-only'
import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import type { Customer, Job } from './../data'
import {
  customerById,
  selectShipment,
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

// This document is a boundary object — it leaves our system and lands on the
// customer's receiving dock, where a clerk pattern-matches it against 越侬's
// 带料号-交货单 template. So this one PDF drops the house warm-paper skin (gray
// small-caps labels, English subtitle, oversized title) for a plain black form
// that mirrors that template: 交货单 wording, 料号 ahead of 材质, a 货品总数
// header total, and the real ship date. Every other PDF keeps the house style.
const S = StyleSheet.create({
  header: {
    borderBottomWidth: 1,
    borderBottomColor: COLOR.ink,
    paddingBottom: 8,
  },
  brandName: {
    textAlign: 'center',
    fontSize: 15,
    color: COLOR.ink,
  },
  docTitle: {
    textAlign: 'center',
    fontSize: 19,
    fontWeight: 600,
    letterSpacing: 6,
    marginTop: 6,
    color: COLOR.ink,
  },
  fieldGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingTop: 10,
    paddingBottom: 8,
    borderBottomWidth: 0.75,
    borderBottomColor: COLOR.borderStrong,
  },
  fieldHalf: {
    width: '50%',
    flexDirection: 'row',
    paddingVertical: 3,
    paddingRight: 12,
  },
  fieldFull: {
    width: '100%',
    flexDirection: 'row',
    paddingVertical: 3,
  },
  fieldText: {
    fontSize: 11,
    color: COLOR.ink,
  },
  th: {
    fontSize: 9,
    fontWeight: 600,
    color: COLOR.ink,
    paddingHorizontal: 4,
  },
})

// 送货日期 = the batch's actual ship date (出库时间), not the order's 交期.
// Formatted YYYY-MM-DD in the factory's timezone to match 越侬's template.
function formatShipDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

export function ShippingDocPDF({
  job,
  customers,
  images,
  shipmentId,
}: {
  job: Job
  customers: Customer[]
  images: Map<string, ImageSource>
  shipmentId?: string
}) {
  const customer = customerById(job.customerId, customers)
  const customerName = customer?.name ?? job.customer

  // PDF mirrors the print page: prints the latest batch by default, or the
  // specific past batch the 出货记录 history deep-linked via ?shipment=<id>.
  const shipment = selectShipment(job, shipmentId)
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
  // 交货单号 prints the 销售单号 (工单号) verbatim, not the internal shipment doc_no.
  const docNo = job.jobNo ?? ''
  // 送货日期 = when this batch actually shipped. 制单人 = who made this delivery
  // note (falls back to the job's creator on legacy shipments).
  const shipDate = formatShipDate(shipment?.createdAt)
  const preparedBy = shipment?.createdBy || job.createdBy || '—'

  return (
    <Document
      title={docNo ? `出货单 ${docNo}` : '出货单'}
      author={BRAND.legalName}
      creator={BRAND.softwareCredit}
      producer={BRAND.softwareCredit}
    >
      <Page size="A4" style={styles.page} wrap>
        {/* Header */}
        <View style={S.header}>
          <Text style={S.brandName}>{BRAND.legalName}</Text>
          <Text style={S.docTitle}>交货单</Text>
        </View>

        {/* Field grid — order + wording mirror 越侬's 带料号-交货单 template. */}
        <View style={S.fieldGrid}>
          <Field label="交货单号" value={docNo || '—'} />
          <View style={S.fieldHalf} />
          <Field label="客户名称" value={customerName || '—'} />
          <Field label="送货日期" value={shipDate} />
          <Field label="联系人" value={job.engineer || '—'} />
          <Field label="制单人" value={preparedBy} />
          <Field label="联系方式" value={customer?.phone || '—'} />
          <Field label="货品总数" value={shippingStarted ? String(totalShipped) : '—'} />
          <Field label="合同编号" value={job.contractNo || '—'} />
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
                <Text style={[S.th, { width: COL.seq }]}>序号</Text>
                <Text style={[S.th, { width: COL.thumb }]}>产品图片</Text>
                <Text style={[S.th, { flex: 1 }]}>产品名称</Text>
                <Text style={[S.th, { width: COL.partNo }]}>料号</Text>
                <Text style={[S.th, { width: COL.material }]}>材质</Text>
                <Text style={[S.th, { width: COL.qty, textAlign: 'right' }]}>
                  交货数量
                </Text>
                <Text style={[S.th, { width: COL.notes }]}>备注</Text>
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
                    <Text style={[styles.td, { width: COL.partNo }]}>
                      {c.partNo ?? ''}
                    </Text>
                    <Text style={[styles.td, { width: COL.material }]}>
                      {c.material ?? '—'}
                    </Text>
                    <Text
                      style={[styles.td, { width: COL.qty, textAlign: 'right' }]}
                    >
                      {qty}
                    </Text>
                    <Text style={[styles.td, { width: COL.notes }]}>
                      {stripProcessMethodFromNotes(c.notes)}
                    </Text>
                  </View>
                )
              })}

              {/* Totals row */}
              <View style={styles.tableTotalRow}>
                <Text
                  style={[
                    S.th,
                    {
                      width: COL.seq + COL.thumb + COL.partNo + COL.material,
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
                <Text style={[styles.td, { width: COL.notes }]} />
              </View>
            </View>

          </>
        ) : null}

        {/* Footer signature */}
        <View style={[styles.signatureBlock, { justifyContent: 'flex-start', marginTop: 28 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
            <Text style={S.fieldText}>签收人</Text>
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
    <View style={full ? S.fieldFull : S.fieldHalf}>
      <Text style={S.fieldText}>
        {label}：{value}
      </Text>
    </View>
  )
}
