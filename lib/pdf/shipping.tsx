import 'server-only'
import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import type { Customer, Job } from './../data'
import {
  customerById,
  selectShipment,
} from './../data'
import { formatShipDate } from './../ship-date'
import { BRAND } from './../brand'
import { COLOR, styles } from './styles'
import { DocFooter } from './footer'
import { ensureFontsRegistered } from './fonts'
import type { ImageSource } from './images'
import { stripProcessMethodFromNotes } from './sanitize'

ensureFontsRegistered()

// Column widths for the shipping table. Every column is fixed and they add up
// to the page's usable width (A4 595.28pt − 2×40pt padding ≈ 515), so nothing
// is elastic and a long product name can't push the qty column off the page.
//
// 图片栏按 72pt 的图定 (56 图 + 边距) — 客户在收货台上核对的就是这张图, 小
// 了看不清。宽度是守恒的, 所以名称和备注各让出一点给它。
const COL = {
  seq: 28,
  thumb: 84,
  name: 96,
  partNo: 90,
  material: 80,
  qty: 56,
  notes: 81,
} as const

// This document is a boundary object — it leaves our system and lands on the
// customer's receiving dock, where a clerk pattern-matches it against 越侬's
// 带料号-交货单 template. So this one PDF drops the house warm-paper skin (gray
// small-caps labels, English subtitle, oversized title) for a plain black form
// that mirrors that template: 交货单 wording, 料号 ahead of 材质, a 货品总数
// header total, and the real ship date. Every other PDF keeps the house style.
// 格线 — 横竖都画, 外框深、内线浅。这是一张交出去给人核对签字的纸: 只有横
// 线的话, 一行里哪个数属于哪一栏全靠眼睛对齐, 收货的人拿笔一划就串行了。
//
// 竖线必须画在包住单元格的 View 上, 不能画在 Text 上 —— Text 的高度就是文
// 字高度, 一行里名字换了三行、数量只有一行, 竖线就成了几段长短不一的短杠,
// 比没有还难看 (试出来的)。View 会被 flex 拉伸到整行高, 线才到底。
// 除了备注, 每一栏都居中。备注是一句话, 居中的话每行开头都不在一处, 读的时
// 候要一行一行找头。
const CENTER = { textAlign: 'center' } as const

// 缩略图本地放大 — lib/pdf/styles.ts 的 thumb 是外协单和检验报告共用的。
const THUMB = { width: 56, height: 56 } as const

const GRID = StyleSheet.create({
  headRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderTopWidth: 1,
    borderTopColor: COLOR.ink,
    borderLeftWidth: 1,
    borderLeftColor: COLOR.ink,
    borderBottomWidth: 1,
    borderBottomColor: COLOR.ink,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderLeftWidth: 1,
    borderLeftColor: COLOR.ink,
    borderBottomWidth: 0.5,
    borderBottomColor: COLOR.borderStrong,
    minHeight: 30,
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderLeftWidth: 1,
    borderLeftColor: COLOR.ink,
    borderTopWidth: 0.5,
    borderTopColor: COLOR.ink,
    borderBottomWidth: 1,
    borderBottomColor: COLOR.ink,
  },
  // 每一格: 右边一条竖线 (最后一格那条就是右外框), 内容上下居中 —— 一行里
  // 图片 36pt 高、数量只有一行字, 贴顶排会显得整行是歪的。
  cell: {
    borderRightWidth: 0.5,
    borderRightColor: COLOR.borderStrong,
    paddingVertical: 6,
    justifyContent: 'center',
  },
  headCell: {
    borderRightWidth: 1,
    borderRightColor: COLOR.ink,
    paddingTop: 4,
    paddingBottom: 6,
    justifyContent: 'flex-end',
  },
  thumbCell: {
    borderRightWidth: 0.5,
    borderRightColor: COLOR.borderStrong,
    paddingVertical: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
})

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
              <View style={GRID.headRow} fixed>
                <View style={[GRID.headCell, { width: COL.seq }]}>
                  <Text style={[S.th, CENTER]}>序号</Text>
                </View>
                <View style={[GRID.headCell, { width: COL.thumb }]}>
                  <Text style={[S.th, CENTER]}>产品图片</Text>
                </View>
                <View style={[GRID.headCell, { width: COL.name }]}>
                  <Text style={[S.th, CENTER]}>产品名称</Text>
                </View>
                <View style={[GRID.headCell, { width: COL.partNo }]}>
                  <Text style={[S.th, CENTER]}>料号</Text>
                </View>
                <View style={[GRID.headCell, { width: COL.material }]}>
                  <Text style={[S.th, CENTER]}>材质</Text>
                </View>
                <View style={[GRID.headCell, { width: COL.qty }]}>
                  <Text style={[S.th, CENTER]}>交货数量</Text>
                </View>
                <View style={[GRID.headCell, { width: COL.notes }]}>
                  <Text style={S.th}>备注</Text>
                </View>
              </View>

              {shippingRows.map(({ component: c, qty }, i) => {
                const img = c.imageUrl ? images.get(c.imageUrl) : undefined
                return (
                  <View key={c.id} style={GRID.row} wrap={false}>
                    <View style={[GRID.cell, { width: COL.seq }]}>
                      <Text style={[styles.tdSeq, CENTER]}>
                        {String(i + 1).padStart(2, '0')}
                      </Text>
                    </View>
                    <View style={[GRID.thumbCell, { width: COL.thumb }]}>
                      {img ? (
                        // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer Image, no alt prop
                        <Image style={[styles.thumb, THUMB]} src={img.data} />
                      ) : (
                        <Text style={styles.thumbPlaceholder}>—</Text>
                      )}
                    </View>
                    <View style={[GRID.cell, { width: COL.name }]}>
                      <Text style={[styles.td, CENTER, { fontWeight: 500 }]}>
                        {c.name || '—'}
                      </Text>
                    </View>
                    {/* 空格子也要有个破折号 — 一张交货单上几个格子纯白, 客户
                        收货时会当成"这一项还没定", 而不是"厂里没填"。 */}
                    <View style={[GRID.cell, { width: COL.partNo }]}>
                      <Text style={[styles.td, CENTER]}>{c.partNo || '—'}</Text>
                    </View>
                    <View style={[GRID.cell, { width: COL.material }]}>
                      <Text style={[styles.td, CENTER]}>
                        {c.material || '—'}
                      </Text>
                    </View>
                    <View style={[GRID.cell, { width: COL.qty }]}>
                      <Text style={[styles.td, CENTER]}>{qty}</Text>
                    </View>
                    <View style={[GRID.cell, { width: COL.notes }]}>
                      <Text style={styles.td}>
                        {stripProcessMethodFromNotes(c.notes) || '—'}
                      </Text>
                    </View>
                  </View>
                )
              })}

              {/* Totals row */}
              <View style={GRID.totalRow}>
                <View
                  style={[
                    GRID.cell,
                    {
                      width:
                        COL.seq +
                        COL.thumb +
                        COL.name +
                        COL.partNo +
                        COL.material,
                    },
                  ]}
                >
                  <Text style={[S.th, { textAlign: 'right' }]}>合计</Text>
                </View>
                <View style={[GRID.cell, { width: COL.qty }]}>
                  <Text style={[styles.td, CENTER, { fontWeight: 600 }]}>
                    {totalShipped}
                  </Text>
                </View>
                <View style={[GRID.cell, { width: COL.notes }]} />
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
