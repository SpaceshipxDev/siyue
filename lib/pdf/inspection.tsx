import 'server-only'
import { Document, Page, Text, View } from '@react-pdf/renderer'
import { BRAND } from './../brand'
import { styles, COLOR } from './styles'
import { DocFooter } from './footer'
import { ensureFontsRegistered } from './fonts'
import {
  dimLimit,
  PROCESS_CHECKS,
  type InspectionReport,
} from './../inspection-report'

ensureFontsRegistered()

// 出厂检验报告 PDF — the deterministic print render of the editable page,
// mirroring the shop's QR0707-004 Excel template section for section.

const DIM_COL = {
  label: 64,
  num: 44,
  unit: 28,
  verdict: 48,
} as const

export type InspectionHeader = {
  jobNo: string
  customer: string
  partName: string
  material: string
  surfaceTreatment: string
  qty: number
}

export function InspectionReportPDF({
  header,
  report,
}: {
  header: InspectionHeader
  report: InspectionReport
}) {
  const dims = report.dims.filter(
    (d) =>
      d.nominal.trim() ||
      d.measured.trim() ||
      d.gauge.trim() ||
      d.verdict,
  )
  return (
    <Document
      title={`出厂检验报告 ${report.reportNo ?? header.jobNo}`}
      author={BRAND.legalName}
      creator={BRAND.softwareCredit}
      producer={BRAND.softwareCredit}
    >
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.headerRule}>
          <Text style={styles.brandLine}>{BRAND.legalName}</Text>
          <Text style={styles.title}>出厂检验报告</Text>
          <Text style={styles.titleEn}>OUTGOING QUALITY INSPECTION REPORT</Text>
          {report.reportNo ? (
            <Text style={{ textAlign: 'right', fontSize: 9, marginTop: 4 }}>
              {report.reportNo}
            </Text>
          ) : null}
        </View>

        <View style={styles.fieldGrid}>
          <Field label="订单编号" value={header.jobNo} />
          <Field label="客户名称" value={header.customer} />
          <Field label="零件名称" value={header.partName} />
          <Field label="发货数/PCS" value={String(header.qty)} />
          <Field label="材料" value={header.material || '—'} />
          <Field label="表面处理" value={header.surfaceTreatment || '—'} />
          <Field full label="检验方法" value={report.inspectMethod || '—'} />
        </View>

        {/* 尺寸检验 */}
        <View style={styles.tableWrap}>
          <Text style={sec.title}>尺寸检验</Text>
          <View style={styles.tableHeaderRow} fixed>
            <Text style={[styles.th, { width: DIM_COL.label }]}>位置</Text>
            <Text style={[styles.th, { width: DIM_COL.num, textAlign: 'right' }]}>标准值</Text>
            <Text style={[styles.th, { width: DIM_COL.unit }]}>单位</Text>
            <Text style={[styles.th, { width: DIM_COL.num, textAlign: 'right' }]}>上公差</Text>
            <Text style={[styles.th, { width: DIM_COL.num, textAlign: 'right' }]}>下公差</Text>
            <Text style={[styles.th, { width: DIM_COL.num, textAlign: 'right' }]}>上限</Text>
            <Text style={[styles.th, { width: DIM_COL.num, textAlign: 'right' }]}>下限</Text>
            <Text style={[styles.th, { width: DIM_COL.num, textAlign: 'right' }]}>实测</Text>
            <Text style={[styles.th, { width: DIM_COL.verdict }]}>判定</Text>
            <Text style={[styles.th, { flex: 1 }]}>使用量具</Text>
          </View>
          {dims.length === 0 ? (
            <View style={styles.tableRow}>
              <Text style={styles.tdMuted}>—</Text>
            </View>
          ) : (
            dims.map((d, i) => (
              <View key={i} style={styles.tableRow} wrap={false}>
                <Text style={[styles.td, { width: DIM_COL.label }]}>{d.label}</Text>
                <Text style={[styles.td, { width: DIM_COL.num, textAlign: 'right' }]}>{d.nominal}</Text>
                <Text style={[styles.tdMuted, { width: DIM_COL.unit }]}>{d.unit}</Text>
                <Text style={[styles.td, { width: DIM_COL.num, textAlign: 'right' }]}>{d.tolUp}</Text>
                <Text style={[styles.td, { width: DIM_COL.num, textAlign: 'right' }]}>{d.tolDown}</Text>
                <Text style={[styles.tdMuted, { width: DIM_COL.num, textAlign: 'right' }]}>
                  {dimLimit(d.nominal, d.tolUp)}
                </Text>
                <Text style={[styles.tdMuted, { width: DIM_COL.num, textAlign: 'right' }]}>
                  {dimLimit(d.nominal, d.tolDown)}
                </Text>
                <Text style={[styles.td, { width: DIM_COL.num, textAlign: 'right' }]}>{d.measured}</Text>
                <Text
                  style={[
                    styles.td,
                    { width: DIM_COL.verdict },
                    d.verdict === 'NG' ? { color: COLOR.overdue, fontWeight: 600 } : {},
                  ]}
                >
                  {d.verdict}
                </Text>
                <Text style={[styles.tdMuted, { flex: 1 }]}>{d.gauge}</Text>
              </View>
            ))
          )}
        </View>

        {/* 其他工序检查 */}
        <Section title="其他工序检查">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {PROCESS_CHECKS.map((item) => {
              const on = report.processChecks.includes(item)
              return (
                <Text
                  key={item}
                  style={{
                    fontSize: 9.5,
                    width: '14.28%',
                    paddingVertical: 2,
                    color: on ? COLOR.ink : COLOR.ink3,
                  }}
                >
                  {on ? '■' : '□'} {item}
                </Text>
              )
            })}
          </View>
        </Section>

        {/* 产品性能 */}
        <Section title="产品性能">
          <KV k="涂层附着力" v={report.performance.coatingAdhesion} />
          <KV k="丝印耐醇性" v={report.performance.silkAlcohol} />
          <KV k="丝印附着力" v={report.performance.silkAdhesion} />
          <KV k="螺母通止规" v={report.performance.nutGauge} />
          <KV k="其他项" v={report.performance.other} />
        </Section>

        {/* 产品外观 */}
        <Section title="产品外观">
          <KV k="色差值 (要求 ⊿E≤1.5)" v={report.appearance.colorDiffMeasured} wide />
          <KV k="外观缺陷" v={report.appearance.defects} wide />
          <KV k="外观不良描述" v={report.appearance.defectDesc} wide />
        </Section>

        {/* 来料包装 */}
        <Section title="来料包装">
          <KV k="打包方式" v={report.packaging.method} />
          <KV k="外箱外观" v={report.packaging.boxAppearance} />
          <KV k="外箱标识" v={report.packaging.boxLabel} />
          <KV k="随货文件" v={report.packaging.documents} />
        </Section>

        {/* 处理方案 + 判定 */}
        <Section title="处理方案 · 判定">
          <KV k="本批次产品处理方案" v={report.disposition ?? ''} wide />
          <KV k="客户沟通后处理方案" v={report.customerPlan ?? ''} wide />
          <KV k="最终判定结果" v={report.finalVerdict ?? ''} wide />
          <KV k="评估处理结果" v={report.evaluation ?? ''} />
          <KV k="确认人" v={report.confirmer ?? ''} />
        </Section>

        {/* Signatures */}
        <View
          style={{
            flexDirection: 'row',
            marginTop: 22,
            paddingTop: 10,
            borderTopWidth: 0.5,
            borderTopColor: COLOR.borderStrong,
          }}
          wrap={false}
        >
          <Sig label="质检员" value={report.inspector ?? ''} />
          <Sig label="审核 / 批准" value={report.approver ?? ''} />
          <Sig label="检验时间" value={report.inspectedAt ?? ''} />
        </View>

        <DocFooter />
      </Page>
    </Document>
  )
}

const sec = {
  title: {
    fontSize: 8,
    color: COLOR.ink3,
    letterSpacing: 1.6,
    marginBottom: 4,
  },
} as const

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View
      style={{
        paddingTop: 10,
        paddingBottom: 8,
        borderBottomWidth: 0.5,
        borderBottomColor: COLOR.border,
      }}
      wrap={false}
    >
      <Text style={sec.title}>{title}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{children}</View>
    </View>
  )
}

function KV({ k, v, wide }: { k: string; v: string; wide?: boolean }) {
  return (
    <View
      style={{
        width: wide ? '100%' : '33.33%',
        flexDirection: 'row',
        paddingVertical: 3,
        paddingRight: 12,
      }}
    >
      <Text style={{ fontSize: 8, color: COLOR.ink3, letterSpacing: 0.8, flexShrink: 0, paddingTop: 1 }}>
        {k}
      </Text>
      <Text
        style={{
          flex: 1,
          fontSize: 10,
          marginLeft: 6,
          borderBottomWidth: 0.5,
          borderBottomColor: COLOR.borderStrong,
          paddingBottom: 1,
          minHeight: 12,
        }}
      >
        {v}
      </Text>
    </View>
  )
}

function Sig({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1, flexDirection: 'row', paddingRight: 16 }}>
      <Text style={{ fontSize: 8, color: COLOR.ink3, letterSpacing: 1.2, paddingTop: 2 }}>
        {label}
      </Text>
      <Text
        style={{
          flex: 1,
          fontSize: 11,
          marginLeft: 8,
          borderBottomWidth: 0.5,
          borderBottomColor: COLOR.ink2,
          minHeight: 16,
          paddingBottom: 2,
        }}
      >
        {value}
      </Text>
    </View>
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
