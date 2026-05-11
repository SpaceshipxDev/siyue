import 'server-only'
import { Document, Image, Page, Text, View } from '@react-pdf/renderer'
import type { OutsourceBlock, Vendor } from './../data'
import { formatCny, vendorById } from './../data'
import { BRAND } from './../brand'
import { styles } from './styles'
import { ensureFontsRegistered } from './fonts'
import type { ImageSource } from './images'

ensureFontsRegistered()

const COL = {
  seq: 28,
  thumb: 56,
  partNo: 100,
  name: 120,
  qty: 56,
  material: 70,
  notes: 76,
} as const

export function OutsourceDocPDF({
  block,
  jobNo,
  vendors,
  docNo,
  createdAt,
  images,
}: {
  block: OutsourceBlock
  jobNo: string
  vendors: Vendor[]
  docNo: string
  createdAt: string
  images: Map<string, ImageSource>
}) {
  const vendor = vendorById(block.vendorId, vendors)
  const recipientAddress = block.recipientAddress ?? BRAND.address
  const recipientName =
    block.recipientContactName ?? BRAND.receivingContact.name
  const recipientPhone =
    block.recipientContactPhone ?? BRAND.receivingContact.phone
  const totalQty = block.members.reduce((s, m) => s + m.qty, 0)

  return (
    <Document
      title={`外协单 ${docNo}`}
      author={BRAND.legalName}
      creator={BRAND.software}
      producer={BRAND.software}
    >
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.headerRule}>
          <Text style={styles.brandLine}>{BRAND.legalName}</Text>
          <Text style={styles.title}>外协单</Text>
          <Text style={styles.titleEn}>PURCHASE / OUTSOURCE ORDER</Text>
        </View>

        <View style={styles.fieldGrid}>
          <Field label="外协单号" value={docNo} />
          <Field label="供应商" value={vendor?.name ?? '—'} />
          <Field label="制单人" value={block.createdBy ?? '—'} />
          <Field label="联系人" value={vendor?.notes ?? '—'} />
          <Field label="制单时间" value={createdAt} />
          <Field label="寄出时间" value={block.sentDate} />
          <Field full label="供应商地址" value={vendor?.address ?? '—'} />
          <Field full label="收件地址" value={recipientAddress} />
          <Field label="收件人" value={recipientName} />
          <Field label="联系电话" value={recipientPhone} />
          <Field label="订单金额" value={formatCny(block.amountCny)} />
          <Field label="销售单号" value={jobNo} />
          <Field full label="备注" value={block.notes ?? '—'} />
        </View>

        <View style={styles.tableWrap}>
          <View style={styles.tableHeaderRow} fixed>
            <Text style={[styles.th, { width: COL.seq }]}>序号</Text>
            <Text style={[styles.th, { width: COL.thumb }]}>产品图片</Text>
            <Text style={[styles.th, { width: COL.partNo }]}>产品编号</Text>
            <Text style={[styles.th, { flex: 1 }]}>产品名称</Text>
            <Text style={[styles.th, { width: COL.qty, textAlign: 'right' }]}>
              采购数量
            </Text>
            <Text style={[styles.th, { width: COL.material }]}>材料</Text>
            <Text style={[styles.th, { width: COL.notes }]}>备注</Text>
          </View>

          {block.members.map((m, i) => {
            const isOrphan = m.componentId.startsWith('__orphan__')
            const img = m.imageUrl ? images.get(m.imageUrl) : undefined
            return (
              <View
                key={`${m.componentId}-${i}`}
                style={styles.tableRow}
                wrap={false}
              >
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
                <Text style={[styles.tdMuted, { width: COL.partNo }]}>
                  {m.name}
                </Text>
                {isOrphan ? (
                  <Text style={[styles.orphanRowText, { flex: 1 }]}>
                    {m.name}
                  </Text>
                ) : (
                  <Text style={[styles.td, { flex: 1, fontWeight: 500 }]}>
                    {m.name}
                  </Text>
                )}
                <Text
                  style={[styles.td, { width: COL.qty, textAlign: 'right' }]}
                >
                  {m.qty}
                </Text>
                <Text style={[styles.tdMuted, { width: COL.material }]}>
                  {m.material ?? '—'}
                </Text>
                <Text style={[styles.tdMuted, { width: COL.notes }]}>
                  {i === 0 ? (block.notes ?? '') : ''}
                </Text>
              </View>
            )
          })}

          <View style={styles.tableTotalRow}>
            <Text
              style={[
                styles.th,
                {
                  width: COL.seq + COL.thumb + COL.partNo,
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
                { width: COL.qty, textAlign: 'right', fontWeight: 600 },
              ]}
            >
              {totalQty}
            </Text>
            <Text style={[styles.td, { width: COL.material }]} />
            <Text
              style={[
                styles.td,
                { width: COL.notes, textAlign: 'right', fontWeight: 600 },
              ]}
            >
              {formatCny(block.amountCny)}
            </Text>
          </View>
        </View>

        <View style={styles.signatureBlock}>
          <View style={styles.signatureColumn}>
            <Text style={styles.signatureLabel}>甲方签章</Text>
            <Text style={styles.signatureLine}>{BRAND.shortName}</Text>
          </View>
          <View style={styles.signatureColumn}>
            <Text style={styles.signatureLabel}>乙方签章</Text>
            <Text style={styles.signatureLine}>{vendor?.name ?? '外协厂'}</Text>
          </View>
        </View>

        <Text style={styles.softwareCredit}>{BRAND.software}</Text>
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
      <Text style={styles.fieldLabelWide}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  )
}
