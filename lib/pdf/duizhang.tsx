import 'server-only'
import { Document, Page, Text, View } from '@react-pdf/renderer'
import { formatCny } from './../data'
import { BRAND } from './../brand'
import {
  dateLabel,
  DUIZHANG_DATE_LABEL,
  DUIZHANG_DETAIL_LABEL,
  DUIZHANG_DOCNO_LABEL,
  DUIZHANG_PARTY_LABEL,
  DUIZHANG_SIGN,
  DUIZHANG_TITLE,
  DUIZHANG_TITLE_LABEL,
  type Duizhang,
} from './../duizhang'
import { styles } from './styles'
import { DocFooter } from './footer'
import { ensureFontsRegistered } from './fonts'

ensureFontsRegistered()

// 对账单 PDF —— 客户和供应商共用一张纸, 只有抬头和几个字不同。这是真正发出
// 去的那一份 (微信发文件 / 打印盖章寄回), 所以底下留了双方盖章的位置。

const COL = {
  seq: 26,
  date: 54,
  docNo: 96,
  detail: 74,
  qty: 40,
  amount: 66,
} as const

export function DuizhangPDF({
  sheet,
  preparedBy,
  todayStr,
}: {
  sheet: Duizhang
  preparedBy: string
  todayStr: string
}) {
  const k = sheet.kind
  const [signLeft, signRight] = DUIZHANG_SIGN[k]

  return (
    <Document
      title={`${sheet.party} ${DUIZHANG_TITLE[k]} ${sheet.from}~${sheet.to}`}
      author={BRAND.legalName}
      creator={BRAND.softwareCredit}
      producer={BRAND.softwareCredit}
    >
      <Page size="A4" style={styles.page} wrap>
        <View style={styles.headerRule}>
          <Text style={styles.brandLine}>{BRAND.legalName}</Text>
          <Text style={styles.title}>{DUIZHANG_TITLE[k]}</Text>
        </View>

        <View style={styles.fieldGrid}>
          <Field label={DUIZHANG_PARTY_LABEL[k]} value={sheet.party} />
          <Field label="对账期间" value={`${sheet.from} 至 ${sheet.to}`} />
          <Field label="制单人" value={preparedBy || '—'} />
          <Field label="制单日期" value={todayStr} />
        </View>

        <View style={styles.tableWrap}>
          <View style={styles.tableHeaderRow} fixed>
            <Text style={[styles.th, { width: COL.seq }]}>序号</Text>
            <Text style={[styles.th, { width: COL.date }]}>
              {DUIZHANG_DATE_LABEL[k]}
            </Text>
            <Text style={[styles.th, { width: COL.docNo }]}>
              {DUIZHANG_DOCNO_LABEL[k]}
            </Text>
            <Text style={[styles.th, { flex: 1 }]}>{DUIZHANG_TITLE_LABEL[k]}</Text>
            <Text style={[styles.th, { width: COL.detail }]}>
              {DUIZHANG_DETAIL_LABEL[k]}
            </Text>
            <Text style={[styles.th, { width: COL.qty, textAlign: 'right' }]}>
              数量
            </Text>
            <Text style={[styles.th, { width: COL.amount, textAlign: 'right' }]}>
              金额
            </Text>
          </View>

          {sheet.lines.length === 0 ? (
            <View style={styles.tableRow}>
              <Text style={[styles.tdMuted, { flex: 1 }]}>
                本期没有{k === 'customer' ? '出货' : '回厂的外协单'}
              </Text>
            </View>
          ) : (
            sheet.lines.map((l, i) => (
              <View key={l.key} style={styles.tableRow} wrap={false}>
                <Text style={[styles.tdSeq, { width: COL.seq }]}>
                  {String(i + 1).padStart(2, '0')}
                </Text>
                <Text style={[styles.tdMuted, { width: COL.date }]}>
                  {dateLabel(l.date)}
                </Text>
                <Text style={[styles.tdMuted, { width: COL.docNo }]}>
                  {l.docNo}
                </Text>
                <Text style={[styles.td, { flex: 1, fontWeight: 500 }]}>
                  {l.title}
                </Text>
                <Text style={[styles.tdMuted, { width: COL.detail }]}>
                  {l.detail || '—'}
                </Text>
                <Text style={[styles.td, { width: COL.qty, textAlign: 'right' }]}>
                  {l.qty}
                </Text>
                <Text
                  style={[styles.td, { width: COL.amount, textAlign: 'right' }]}
                >
                  {typeof l.amountCny === 'number' ? formatCny(l.amountCny) : '—'}
                </Text>
              </View>
            ))
          )}

          <View style={styles.tableTotalRow}>
            <Text
              style={[
                styles.th,
                {
                  width: COL.seq + COL.date + COL.docNo + COL.detail,
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
              {sheet.totalQty}
            </Text>
            <Text
              style={[
                styles.td,
                { width: COL.amount, textAlign: 'right', fontWeight: 600 },
              ]}
            >
              {formatCny(sheet.totalAmountCny)}
            </Text>
          </View>

          {sheet.unpricedCount > 0 && (
            <Text style={[styles.tdMuted, { fontSize: 8, paddingTop: 6 }]}>
              其中 {sheet.unpricedCount} 单尚未定价,未计入合计。
            </Text>
          )}
        </View>

        {/* 结论 —— 双方要点头的那两三个数。 */}
        <View
          style={{
            marginTop: 6,
            paddingTop: 10,
            borderTopWidth: 1,
            borderTopColor: '#14130f',
          }}
        >
          {k === 'customer' ? (
            <>
              <SumLine label="本期出货" value={sheet.totalAmountCny} />
              <SumLine label="本期开票" value={sheet.invoicedCny} />
              <SumLine label="本期回款" value={sheet.paidCny} />
              <SumLine label="截至今日未收" value={sheet.carryAmountCny} strong />
            </>
          ) : (
            <>
              <SumLine label="本期应付" value={sheet.totalAmountCny} strong />
              <SumLine
                label={`尚在外未结${sheet.carryCount > 0 ? ` (${sheet.carryCount} 单)` : ''}`}
                value={sheet.carryAmountCny}
              />
            </>
          )}
        </View>

        <View style={styles.signatureBlock}>
          <View style={styles.signatureColumn}>
            <Text style={styles.signatureLabel}>{signLeft}</Text>
            <Text style={styles.signatureLine}>
              {k === 'customer' ? BRAND.shortName : sheet.party}
            </Text>
          </View>
          <View style={styles.signatureColumn}>
            <Text style={styles.signatureLabel}>{signRight}</Text>
            <Text style={styles.signatureLine}>
              {k === 'customer' ? sheet.party : BRAND.shortName}
            </Text>
          </View>
        </View>

        <DocFooter />
      </Page>
    </Document>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fieldHalf}>
      <Text style={styles.fieldLabelWide}>{label}</Text>
      <Text style={styles.fieldValue}>{value || '—'}</Text>
    </View>
  )
}

function SumLine({
  label,
  value,
  strong,
}: {
  label: string
  value: number
  strong?: boolean
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        paddingVertical: 2.5,
        width: '58%',
      }}
    >
      <Text style={styles.amountLabel}>{label}</Text>
      <Text style={strong ? styles.amountValue : { fontSize: 10.5 }}>
        {formatCny(value)}
      </Text>
    </View>
  )
}
