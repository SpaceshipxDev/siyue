import 'server-only'
import { Document, Image, Page, Text, View } from '@react-pdf/renderer'
import type { OutsourceBlock, Vendor } from './../data'
import {
  blockLineTotalsSum,
  effectiveMemberLineTotal,
  effectiveUnitPriceCny,
  formatCny,
  vendorById,
} from './../data'
import { BRAND } from './../brand'
import { styles } from './styles'
import { ensureFontsRegistered } from './fonts'
import type { ImageSource } from './images'
import { stripProcessMethodFromNotes } from './sanitize'

ensureFontsRegistered()

// Column widths. The vendor PO format vendors expect:
//   序号 · 图 · 产品名称 · 料号 · 材料 · 数量 · 单价 · 金额 · 备注
// 产品名称 still takes flex slack so material/notes can stay tight. 料号
// sits right after the name so the vendor can match a part number to the
// description without their eye crossing the rest of the row.
const COL = {
  seq: 24,
  thumb: 50,
  partNo: 56,
  material: 70,
  qty: 36,
  unitPrice: 52,
  lineTotal: 60,
  notes: 50,
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
  // 合计 prefers the sum of per-line subtotals when any member has a
  // unit price set — that's the breakdown vendors expect to see add up.
  // Falls back to the block's manually-entered amountCny otherwise so
  // legacy blocks (no per-line prices) still print a grand total.
  const lineTotalSum = blockLineTotalsSum(block)
  const grandTotal = lineTotalSum ?? block.amountCny ?? null

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
          <Field label="销售单号" value={jobNo} />
          {/* 寄出 + 到料 side by side — the boss asked for the expected
              return date on paper ("改成：到料时间"); we keep both. */}
          <Field label="寄出时间" value={block.sentDate} />
          <Field label="到料时间" value={block.expectedReturn} />
          <Field full label="供应商地址" value={vendor?.address ?? '—'} />
          <Field full label="收件地址" value={recipientAddress} />
          <Field label="收件人" value={recipientName} />
          <Field label="联系电话" value={recipientPhone} />
          <Field label="订单金额" value={formatCny(block.amountCny)} />
          <Field full label="备注" value={stripProcessMethodFromNotes(block.notes) || '—'} />
        </View>

        <View style={styles.tableWrap}>
          <View style={styles.tableHeaderRow} fixed>
            <Text style={[styles.th, { width: COL.seq }]}>序号</Text>
            <Text style={[styles.th, { width: COL.thumb }]}>产品图片</Text>
            <Text style={[styles.th, { flex: 1 }]}>产品名称</Text>
            <Text style={[styles.th, { width: COL.partNo }]}>料号</Text>
            <Text style={[styles.th, { width: COL.material }]}>材料</Text>
            <Text style={[styles.th, { width: COL.qty, textAlign: 'right' }]}>
              数量
            </Text>
            <Text
              style={[styles.th, { width: COL.unitPrice, textAlign: 'right' }]}
            >
              单价
            </Text>
            <Text
              style={[styles.th, { width: COL.lineTotal, textAlign: 'right' }]}
            >
              金额
            </Text>
            <Text style={[styles.th, { width: COL.notes }]}>备注</Text>
          </View>

          {block.members.map((m, i) => {
            const isOrphan = m.componentId.startsWith('__orphan__')
            const img = m.imageUrl ? images.get(m.imageUrl) : undefined
            const up = effectiveUnitPriceCny(m, block)
            const lt = effectiveMemberLineTotal(m, block)
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
                {isOrphan ? (
                  <Text style={[styles.orphanRowText, { flex: 1 }]}>
                    {m.name}
                  </Text>
                ) : (
                  <Text style={[styles.td, { flex: 1, fontWeight: 500 }]}>
                    {m.name}
                  </Text>
                )}
                <Text style={[styles.tdMuted, { width: COL.partNo }]}>
                  {m.partNo ?? ''}
                </Text>
                <Text style={[styles.tdMuted, { width: COL.material }]}>
                  {m.material ?? '—'}
                </Text>
                <Text
                  style={[styles.td, { width: COL.qty, textAlign: 'right' }]}
                >
                  {m.qty}
                </Text>
                <Text
                  style={[
                    styles.tdMuted,
                    { width: COL.unitPrice, textAlign: 'right' },
                  ]}
                >
                  {up != null ? formatCny(up) : '—'}
                </Text>
                <Text
                  style={[
                    styles.td,
                    { width: COL.lineTotal, textAlign: 'right' },
                  ]}
                >
                  {lt != null ? formatCny(lt) : '—'}
                </Text>
                <Text style={[styles.tdMuted, { width: COL.notes }]}>
                  {i === 0 ? stripProcessMethodFromNotes(block.notes) : ''}
                </Text>
              </View>
            )
          })}

          <View style={styles.tableTotalRow}>
            <Text
              style={[
                styles.th,
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
                { width: COL.qty, textAlign: 'right', fontWeight: 600 },
              ]}
            >
              {totalQty}
            </Text>
            <Text style={[styles.td, { width: COL.unitPrice }]} />
            <Text
              style={[
                styles.td,
                { width: COL.lineTotal, textAlign: 'right', fontWeight: 600 },
              ]}
            >
              {grandTotal != null ? formatCny(grandTotal) : '—'}
            </Text>
            <Text style={[styles.td, { width: COL.notes }]} />
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
