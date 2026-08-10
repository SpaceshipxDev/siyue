'use client'

import { useState } from 'react'
import { memberRemainingQty, memberReturnedQty } from '@/lib/data'
import type { LedgerLine } from './_ledger'

// 外协 导出 — same contract as 采购 / 报工: "export" means "export the list you
// are looking at". The caller hands over the rows already filtered and in
// display order, so the file always matches the screen. Three sheets:
//   外协明细 — one row per 外协单 (the ledger, 1:1 with the sheet on screen)
//   零件明细 — one row per 零件 (what 财务 reconciles against the vendor's bill)
//   供应商汇总 — per-vendor 单数 / 件数 / 金额 / 逾期
//
// Money goes in as raw numbers, never formatted strings — the whole point of
// handing someone a sheet is that they can sum the 金额 column.

export function OutsourceExportButton({
  lines,
  filename,
}: {
  lines: LedgerLine[]
  filename: string
}) {
  const [busy, setBusy] = useState(false)
  const disabled = busy || lines.length === 0

  const onExport = async () => {
    if (disabled) return
    setBusy(true)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.utils.book_new()

      // ── 外协明细 ─────────────────────────────────────────────────────────
      const head = [
        '状态',
        '寄出日期',
        '工序',
        '供应商',
        '工号',
        '客户',
        '产品',
        '零件',
        '件数',
        '在外',
        '已回',
        '金额',
        '要求回厂',
        '回厂日期',
        '外协单号',
        '微信',
        '厂商诺期',
        '厂商发货',
        '备注',
      ]
      const body = lines.map((l) => [
        l.closed ? '已回' : l.overdue ? `逾期${Math.abs(l.daysLeft)}天` : '在外',
        l.block.sentDate,
        l.activity,
        l.vendorName,
        l.jobNo,
        l.customer,
        l.product,
        l.block.members.map((m) => m.name).join(' · '),
        l.totalQty,
        l.remainingQty,
        l.returnedQty,
        l.block.amountCny ?? '',
        l.block.expectedReturn,
        l.closedAt ?? '',
        l.block.docNo ?? '',
        l.block.wechatSentAt ? l.block.wechatSentAt.slice(0, 10) : '',
        l.block.vendorPromisedDate ?? '',
        l.block.vendorShippedAt ? l.block.vendorShippedAt.slice(0, 10) : '',
        l.block.notes ?? '',
      ])
      const total = lines.reduce((s, l) => s + (l.block.amountCny ?? 0), 0)
      const totalQty = lines.reduce((s, l) => s + l.totalQty, 0)
      const totalOut = lines.reduce((s, l) => s + l.remainingQty, 0)
      body.push([
        '合计',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        totalQty,
        totalOut,
        lines.reduce((s, l) => s + l.returnedQty, 0),
        Math.round(total),
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ])
      const ws = XLSX.utils.aoa_to_sheet([head, ...body])
      ws['!cols'] = head.map((h) =>
        h === '零件' ? { wch: 34 } : h === '客户' || h === '产品' || h === '备注' ? { wch: 20 } : h === '工号' || h === '外协单号' ? { wch: 18 } : h.includes('日期') || h.includes('回厂') || h === '厂商诺期' || h === '厂商发货' ? { wch: 12 } : { wch: 10 },
      )
      XLSX.utils.book_append_sheet(wb, ws, '外协明细')

      // ── 零件明细 ─────────────────────────────────────────────────────────
      const pHead = [
        '寄出日期',
        '工序',
        '供应商',
        '工号',
        '客户',
        '零件',
        '料号',
        '材料',
        '数量',
        '在外',
        '已回',
        '回厂日期',
        '单价',
        '外协单号',
      ]
      const pBody: (string | number)[][] = []
      for (const l of lines) {
        for (const m of l.block.members) {
          pBody.push([
            l.block.sentDate,
            l.activity,
            l.vendorName,
            l.jobNo,
            l.customer,
            m.name,
            m.partNo ?? '',
            m.material ?? '',
            m.qty,
            memberRemainingQty(m),
            memberReturnedQty(m),
            m.returnedAt ?? '',
            m.unitPriceCny ?? '',
            l.block.docNo ?? '',
          ])
        }
      }
      const pWs = XLSX.utils.aoa_to_sheet([pHead, ...pBody])
      pWs['!cols'] = pHead.map((h) =>
        h === '零件' ? { wch: 28 } : h === '客户' ? { wch: 20 } : h === '工号' || h === '外协单号' ? { wch: 18 } : h.includes('日期') ? { wch: 12 } : { wch: 10 },
      )
      XLSX.utils.book_append_sheet(wb, pWs, '零件明细')

      // ── 供应商汇总 ───────────────────────────────────────────────────────
      const byVendor = new Map<
        string,
        { blocks: number; qty: number; out: number; amount: number; overdue: number }
      >()
      for (const l of lines) {
        let v = byVendor.get(l.vendorName)
        if (!v) {
          v = { blocks: 0, qty: 0, out: 0, amount: 0, overdue: 0 }
          byVendor.set(l.vendorName, v)
        }
        v.blocks += 1
        v.qty += l.totalQty
        v.out += l.remainingQty
        v.amount += l.block.amountCny ?? 0
        if (l.overdue) v.overdue += 1
      }
      const vHead = ['供应商', '外协单', '件数', '在外件数', '金额', '逾期单']
      const vBody: (string | number)[][] = [...byVendor.entries()]
        .sort((a, b) => b[1].amount - a[1].amount || b[1].blocks - a[1].blocks)
        .map(([name, v]) => [name, v.blocks, v.qty, v.out, Math.round(v.amount), v.overdue])
      vBody.push(['合计', lines.length, totalQty, totalOut, Math.round(total), lines.filter((l) => l.overdue).length])
      const vWs = XLSX.utils.aoa_to_sheet([vHead, ...vBody])
      vWs['!cols'] = vHead.map((h) => ({ wch: h === '供应商' ? 20 : 10 }))
      XLSX.utils.book_append_sheet(wb, vWs, '供应商汇总')

      XLSX.writeFile(wb, `${filename}.xlsx`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={onExport}
      disabled={disabled}
      title="导出当前列表为 Excel"
      className={`inline-flex items-baseline gap-1.5 rounded-[2px] border px-2.5 py-[5px] text-[10px] uppercase tracking-[0.14em] transition-colors ${
        disabled
          ? 'cursor-default border-[var(--color-border)] text-[var(--color-ink-4)]'
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

function DownloadIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M6 1.5 V7.5 M3.5 5.5 L6 8 L8.5 5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M1.5 9.5 V10.5 H10.5 V9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
