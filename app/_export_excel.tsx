'use client'

import { useState } from 'react'
import { JOB_TYPE_LABEL, STAGES } from '@/lib/data'
import { rowRollupStage, type MasterRow } from '@/lib/master'

// 导出 — downloads the CURRENT filtered view as .xlsx, mirroring the finance
// export's contract: "export" means "export what's on screen". The caller
// hands us the post-filter row list (search + date + ship scope + column
// status filters all applied), so the file always matches the count chip.
//
// Built fully client-side: the rows are already in the browser, and a server
// round-trip would mean re-serializing the whole filter state into a URL.
// `xlsx` is dynamically imported on click so the ~400KB parser never lands in
// the dashboard bundle — it only loads the first time someone actually
// exports.

// Per-stage cell text in the sheet. Mirrors the on-screen rollup legend but
// in words Excel readers can sort/filter on (✓ glyphs sort badly).
function stageCellText(row: MasterRow, stage: (typeof STAGES)[number]): string {
  const r = rowRollupStage(row, stage)
  if (r.kind === 'na') return '—'
  if (r.kind === 'done') return '已完成'
  if (r.kind === 'partial') return `${r.done}/${r.total}`
  return '未开始'
}

function isoLocalToday(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function ExportExcelButton({
  rows,
  showMoney,
  showCustomer,
}: {
  /** The filtered rows currently on screen, in display order. */
  rows: MasterRow[]
  /** Commerce only — amounts are PII for the floor. */
  showMoney: boolean
  /** Production users never see 客户; mirror that in the file. */
  showCustomer: boolean
}) {
  const [busy, setBusy] = useState(false)
  const disabled = busy || rows.length === 0

  const onExport = async () => {
    if (disabled) return
    setBusy(true)
    try {
      const XLSX = await import('xlsx')

      const header: (string | number)[] = [
        '工号',
        '类型',
        ...(showCustomer ? ['客户'] : []),
        '产品',
        ...(showMoney ? ['金额', '外发', '毛利'] : []),
        '交期',
        ...STAGES,
        '备注',
      ]
      const body = rows.map((r) => [
        r.jobNo,
        r.jobType ? JOB_TYPE_LABEL[r.jobType] : '',
        ...(showCustomer ? [r.customer] : []),
        r.product,
        // Raw numbers (not formatted strings) so Excel can sum the columns.
        ...(showMoney
          ? [r.amountCny ?? '', r.externalSpendCny || '', r.marginCny ?? '']
          : []),
        r.effectiveDueDate,
        ...STAGES.map((s) => stageCellText(r, s)),
        r.notes ?? '',
      ])

      const ws = XLSX.utils.aoa_to_sheet([header, ...body])
      ws['!cols'] = header.map((h) => {
        if (h === '工号') return { wch: 16 }
        if (h === '客户' || h === '产品') return { wch: 22 }
        if (h === '备注') return { wch: 28 }
        if (h === '交期') return { wch: 12 }
        return { wch: 9 }
      })
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '工单')
      XLSX.writeFile(wb, `工单_${isoLocalToday()}.xlsx`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={onExport}
      disabled={disabled}
      title="导出当前筛选结果为 Excel"
      className={`inline-flex items-baseline gap-1.5 rounded-[2px] border px-2.5 py-[3px] text-[10px] tracking-[0.14em] uppercase transition-colors ${
        disabled
          ? 'border-[var(--color-border)] text-[var(--color-ink-4)] cursor-default'
          : 'border-[var(--color-border)] text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-ink)]'
      }`}
    >
      <span className="translate-y-[1px]">
        <DownloadIcon />
      </span>
      <span>{busy ? '导出中…' : '导出'}</span>
    </button>
  )
}

// Tray-with-arrow download glyph, drawn to match the bar's 13px line icons.
function DownloadIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M6 1.5 V7.5 M3.5 5.5 L6 8 L8.5 5.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M1.5 9.5 V10.5 H10.5 V9.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
