'use client'

import { useState } from 'react'
import { procurementTotalCny } from '@/lib/data'
import type { Procurement } from '@/lib/data'

// 采购 导出 — same contract as the 工单 board's export (app/_export_excel.tsx):
// "export" means "export the list you are looking at". The caller hands us the
// rows already filtered by the search box, in display order, so the file always
// matches what's on screen.
//
// Client-side for the same reason the board's is: the rows are already in the
// browser, and `xlsx` is dynamically imported on click so the ~400KB parser
// never lands in the page bundle.

// Money goes in as raw numbers, never formatted strings — the whole point of
// handing 财务 a sheet is that they can sum the 金额 column.
function statusText(p: Procurement): string {
  if (p.status === 'arrived') return '已到货'
  // 待下单 exists in the lifecycle work that hasn't shipped yet; treat any
  // unknown state as 在途 rather than printing a raw enum into the sheet.
  if ((p.status as string) === 'pending') return '待下单'
  return '采购中'
}

function isoLocalToday(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function ProcurementExportButton({
  rows,
  filename,
  compact,
}: {
  /** The rows currently on screen, in display order. */
  rows: Procurement[]
  /** Without the .xlsx suffix; defaults to 采购_<今天>. */
  filename?: string
  /** Sits inside the 已到货 month bar rather than the top control row. */
  compact?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const disabled = busy || rows.length === 0

  const onExport = async () => {
    if (disabled) return
    setBusy(true)
    try {
      const XLSX = await import('xlsx')

      const header = [
        '状态',
        '品名',
        '供应商',
        '数量',
        '单价',
        '金额',
        '采购日期',
        '预计到货',
        '到货日期',
        '采购人',
        '备注',
        '链接',
      ]
      const body = rows.map((p) => [
        statusText(p),
        p.item,
        p.supplier ?? '',
        p.qty ?? '',
        p.unitPriceCny ?? '',
        procurementTotalCny(p) ?? '',
        p.orderDate,
        p.expectedDate ?? '',
        p.arrivedDate ?? '',
        p.buyer,
        p.notes ?? '',
        p.link ?? '',
      ])

      const ws = XLSX.utils.aoa_to_sheet([header, ...body])
      ws['!cols'] = header.map((h) => {
        if (h === '品名') return { wch: 26 }
        if (h === '链接') return { wch: 34 }
        if (h === '供应商' || h === '备注') return { wch: 20 }
        if (h.endsWith('日期') || h === '预计到货') return { wch: 12 }
        return { wch: 9 }
      })
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '采购')
      XLSX.writeFile(wb, `${filename ?? `采购_${isoLocalToday()}`}.xlsx`)
    } finally {
      setBusy(false)
    }
  }

  const base = disabled
    ? 'border-[var(--color-border)] text-[var(--color-ink-4)] cursor-default'
    : 'border-[var(--color-border)] text-[var(--color-ink-2)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-ink)]'

  return (
    <button
      type="button"
      onClick={onExport}
      disabled={disabled}
      title="导出为 Excel"
      className={
        compact
          ? `inline-flex items-baseline gap-1.5 rounded-[2px] border px-2 py-[3px] text-[10px] tracking-[0.14em] uppercase transition-colors ${base}`
          : `inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[2px] border bg-[var(--color-surface)] px-3 text-[13px] transition-colors ${base}`
      }
    >
      <span className={compact ? 'translate-y-[1px]' : ''}>
        <DownloadIcon />
      </span>
      <span>{busy ? '导出中…' : '导出'}</span>
    </button>
  )
}

// Tray-with-arrow download glyph — same drawing as the 工单 board's.
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
