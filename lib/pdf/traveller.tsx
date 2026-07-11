import 'server-only'
import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import type { Component, Job } from './../data'
import { partRoute, stageLabel } from './../data'
import { BRAND } from './../brand'
import { COLOR, styles } from './styles'
import { DocFooter } from './footer'
import { ensureFontsRegistered } from './fonts'

ensureFontsRegistered()

// 随工单 — the traveller that replaces Yingma's stamped drawing printout.
// One PAGE per component: the paper physically travels with that one part's
// batch, so a multi-part job prints as a stack the clerk splits. The route
// table keeps handwriting columns (数量/日期/签名) on purpose — the QR is the
// fast path, the pen is the fallback, and both land on the same sheet the
// floor already trusts.
const S = StyleSheet.create({
  docNo: {
    position: 'absolute',
    top: 0,
    right: 0,
    fontSize: 9,
    color: COLOR.ink2,
  },
  // The six facts the floor actually reads, oversized: this sheet is read at
  // arm's length on a machine table, not at a desk.
  factGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderWidth: 1,
    borderColor: COLOR.ink,
    marginTop: 16,
  },
  fact: {
    width: '33.3333%',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRightWidth: 0.75,
    borderBottomWidth: 0.75,
    borderColor: COLOR.borderStrong,
  },
  factLabel: {
    fontSize: 8,
    color: COLOR.ink3,
    letterSpacing: 2,
  },
  factValue: {
    fontSize: 14,
    fontWeight: 600,
    marginTop: 3,
  },
  factWide: { width: '100%' },
  routeTitle: {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 2,
    marginTop: 22,
    marginBottom: 6,
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 0.75,
    borderBottomColor: COLOR.borderStrong,
    minHeight: 34,
    alignItems: 'center',
  },
  headRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: COLOR.ink,
    paddingBottom: 4,
  },
  th: {
    fontSize: 8,
    color: COLOR.ink2,
    letterSpacing: 1.5,
  },
  seq: { width: 34 },
  op: { flexGrow: 1 },
  opName: { fontSize: 12, fontWeight: 600 },
  blank: { width: 90, borderLeftWidth: 0.5, borderLeftColor: COLOR.border, alignSelf: 'stretch' },
  qrBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 26,
    gap: 14,
  },
  qrImg: { width: 92, height: 92 },
  qrHintTitle: { fontSize: 12, fontWeight: 600 },
  qrHintBody: { fontSize: 9, color: COLOR.ink2, marginTop: 4, lineHeight: 1.5 },
  qrUrl: { fontSize: 7.5, color: COLOR.ink3, marginTop: 5 },
})

function Fact({
  label,
  value,
  wide,
}: {
  label: string
  value?: string
  wide?: boolean
}) {
  return (
    <View style={wide ? [S.fact, S.factWide] : S.fact}>
      <Text style={S.factLabel}>{label}</Text>
      <Text style={S.factValue}>{value?.trim() || '—'}</Text>
    </View>
  )
}

export type TravellerPart = {
  component: Component
  docNo: string
  // Data-URL QR pointing at /s/<token>; undefined on a pre-migration DB —
  // the sheet then prints with the handwriting columns only.
  qrDataUrl?: string
  scanUrlShort?: string
}

export function TravellerDocPDF({
  job,
  parts,
}: {
  job: Job
  parts: TravellerPart[]
}) {
  return (
    <Document>
      {parts.map(({ component: c, docNo, qrDataUrl, scanUrlShort }) => {
        const route = partRoute(c)
        return (
          <Page key={c.id} size="A4" style={styles.page}>
            <View style={styles.headerRule}>
              <Text style={styles.brandLine}>{BRAND.legalName}</Text>
              <Text style={styles.title}>随工单</Text>
              <Text style={styles.titleEn}>PRODUCTION TRAVELLER</Text>
              <Text style={S.docNo}>{docNo}</Text>
            </View>

            <View style={S.factGrid}>
              <Fact label="客户" value={job.customer} />
              <Fact label="数量" value={c.qty > 0 ? `${c.qty} 件` : undefined} />
              <Fact label="交期" value={job.dueDate} />
              <Fact label="产品名称" value={c.name || job.product} />
              <Fact label="材质" value={c.material} />
              <Fact label="表面处理" value={c.surfaceTreatment} />
              <Fact label="图纸号" value={c.partNo} wide />
            </View>

            <Text style={S.routeTitle}>加工工序</Text>
            <View style={S.headRow}>
              <Text style={[S.th, S.seq]}>序</Text>
              <Text style={[S.th, S.op]}>工序</Text>
              <Text style={[S.th, { width: 90 }]}>完成数量</Text>
              <Text style={[S.th, { width: 90 }]}>日期</Text>
              <Text style={[S.th, { width: 90 }]}>操作人</Text>
            </View>
            {route.map((stage, i) => (
              <View key={stage} style={S.row}>
                <Text style={[S.seq, { fontSize: 10, color: COLOR.ink2 }]}>
                  {i + 1}
                </Text>
                <View style={S.op}>
                  <Text style={S.opName}>{stageLabel(stage)}</Text>
                </View>
                <View style={S.blank} />
                <View style={S.blank} />
                <View style={S.blank} />
              </View>
            ))}

            {qrDataUrl ? (
              <View style={S.qrBlock}>
                {/* eslint-disable-next-line jsx-a11y/alt-text */}
                <Image src={qrDataUrl} style={S.qrImg} />
                <View>
                  <Text style={S.qrHintTitle}>微信扫一扫 · 报工</Text>
                  <Text style={S.qrHintBody}>
                    每道工序做完，用手机扫码，点「全部完成」。{'\n'}
                    只完成一部分也可以填数量。不用登录，不用装软件。
                  </Text>
                  {scanUrlShort ? <Text style={S.qrUrl}>{scanUrlShort}</Text> : null}
                </View>
              </View>
            ) : null}

            <DocFooter />
          </Page>
        )
      })}
    </Document>
  )
}
