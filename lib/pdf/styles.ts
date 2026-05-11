import { StyleSheet } from '@react-pdf/renderer'
import { PDF_FONT_FAMILY } from './fonts'

// Mirrors the warm-paper palette in app/globals.css. Hex literals (no CSS
// variables) because pdfkit doesn't resolve custom properties.
export const COLOR = {
  ink: '#14130f',
  ink2: '#5a5851',
  ink3: '#9b988f',
  ink4: '#c4c1b8',
  border: '#e7e5e0',
  borderStrong: '#d6d3cc',
  surface: '#ffffff',
  overdue: '#b8341c',
  warning: '#b8881c',
} as const

export const styles = StyleSheet.create({
  page: {
    fontFamily: PDF_FONT_FAMILY,
    fontSize: 10,
    color: COLOR.ink,
    paddingTop: 40,
    paddingBottom: 40,
    paddingHorizontal: 40,
    backgroundColor: COLOR.surface,
  },

  // Header block
  brandLine: {
    textAlign: 'center',
    fontSize: 10,
    color: COLOR.ink2,
  },
  title: {
    textAlign: 'center',
    fontSize: 22,
    fontWeight: 600,
    marginTop: 4,
  },
  titleEn: {
    textAlign: 'center',
    fontSize: 8,
    color: COLOR.ink3,
    letterSpacing: 1.6,
    marginTop: 2,
  },
  headerRule: {
    borderBottomWidth: 1,
    borderBottomColor: COLOR.ink,
    paddingBottom: 8,
  },

  // Field grid (two-column form area)
  fieldGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingTop: 12,
    paddingBottom: 12,
    borderBottomWidth: 0.75,
    borderBottomColor: COLOR.border,
  },
  fieldHalf: {
    width: '50%',
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingRight: 16,
    paddingVertical: 4,
  },
  fieldFull: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingRight: 0,
    paddingVertical: 4,
  },
  fieldLabel: {
    fontSize: 8,
    color: COLOR.ink3,
    letterSpacing: 1.2,
    width: 64,
    flexShrink: 0,
    paddingTop: 1,
  },
  fieldLabelWide: {
    fontSize: 8,
    color: COLOR.ink3,
    letterSpacing: 1.2,
    width: 80,
    flexShrink: 0,
    paddingTop: 1,
  },
  fieldValue: {
    flex: 1,
    fontSize: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: COLOR.borderStrong,
    paddingBottom: 2,
    minHeight: 14,
  },
  fieldValueMono: {
    flex: 1,
    fontSize: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: COLOR.borderStrong,
    paddingBottom: 2,
    minHeight: 14,
    letterSpacing: 0.2,
  },

  // Table
  tableWrap: {
    paddingTop: 14,
    paddingBottom: 8,
  },
  tableHeaderRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: COLOR.ink,
    paddingBottom: 6,
    paddingTop: 4,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: COLOR.borderStrong,
    paddingTop: 6,
    paddingBottom: 6,
    minHeight: 28,
  },
  tableTotalRow: {
    flexDirection: 'row',
    paddingTop: 6,
    paddingBottom: 6,
    borderTopWidth: 0.5,
    borderTopColor: COLOR.ink,
  },
  th: {
    fontSize: 8,
    color: COLOR.ink2,
    letterSpacing: 1.2,
    paddingHorizontal: 4,
  },
  td: {
    fontSize: 9.5,
    color: COLOR.ink,
    paddingHorizontal: 4,
  },
  tdMuted: {
    fontSize: 9.5,
    color: COLOR.ink2,
    paddingHorizontal: 4,
  },
  tdSeq: {
    fontSize: 9.5,
    color: COLOR.ink3,
    paddingHorizontal: 4,
  },
  thumbCell: {
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumb: {
    width: 36,
    height: 36,
    objectFit: 'contain',
    borderWidth: 0.5,
    borderColor: COLOR.borderStrong,
  },
  thumbPlaceholder: {
    fontSize: 9,
    color: COLOR.ink4,
    textAlign: 'center',
  },

  // Footer / signatures
  amountRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 4,
    borderTopWidth: 0.5,
    borderTopColor: COLOR.borderStrong,
    marginTop: 4,
    gap: 8,
  },
  amountLabel: {
    fontSize: 8,
    color: COLOR.ink3,
    letterSpacing: 1.2,
  },
  amountValue: {
    fontSize: 14,
    fontWeight: 600,
  },
  signatureBlock: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 36,
    fontSize: 9,
    color: COLOR.ink2,
  },
  softwareCredit: {
    fontSize: 7,
    color: COLOR.ink4,
    letterSpacing: 1.2,
    marginTop: 24,
  },

  // Outsource-specific signature column
  signatureColumn: {
    flex: 1,
    paddingRight: 24,
  },
  signatureLabel: {
    fontSize: 8,
    color: COLOR.ink3,
    letterSpacing: 1.2,
    marginBottom: 56,
  },
  signatureLine: {
    borderTopWidth: 0.5,
    borderTopColor: COLOR.ink,
    paddingTop: 4,
    fontSize: 8,
    color: COLOR.ink3,
  },

  // Inline orphan warning row — keeps the row count honest.
  orphanRowText: {
    fontSize: 9,
    color: COLOR.overdue,
    fontStyle: 'italic',
  },
})
