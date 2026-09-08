'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { withBase } from '@/lib/base-path'
import { formatCny } from '@/lib/data'
import { SearchSelect } from '@/app/_search_select'
import {
  dateLabel,
  monthLabel,
  shiftMonth,
  DUIZHANG_DATE_LABEL,
  DUIZHANG_DETAIL_LABEL,
  DUIZHANG_DOCNO_LABEL,
  DUIZHANG_TITLE,
  DUIZHANG_TITLE_LABEL,
  type Duizhang,
  type DuizhangKind,
  type DuizhangParty,
} from '@/lib/duizhang'

// 对账页顶上那一条 —— 三个选择 (跟谁 · 哪个月 · 客户还是外协) 和两个出口
// (PDF / Excel)。选择一变, 下面那张纸跟着变, 没有"生成"这一步。

function href(kind: DuizhangKind, party: string, month: string): string {
  const p = new URLSearchParams()
  if (kind !== 'customer') p.set('kind', kind)
  if (party) p.set('name', party)
  p.set('m', month)
  return `/duizhang?${p.toString()}`
}

export function DuizhangBar({
  kind,
  party,
  month,
  monthText,
  parties,
  canCustomer,
  canVendor,
  sheet,
}: {
  kind: DuizhangKind
  party: string
  month: string
  monthText: string
  parties: DuizhangParty[]
  canCustomer: boolean
  canVendor: boolean
  sheet: Duizhang | null
}) {
  const router = useRouter()
  const go = (next: { kind?: DuizhangKind; party?: string; month?: string }) =>
    router.push(
      href(next.kind ?? kind, next.party ?? party, next.month ?? month),
    )

  const pdfHref = sheet
    ? withBase(
        `/duizhang/pdf?kind=${kind}&name=${encodeURIComponent(party)}&m=${month}`,
      )
    : ''

  return (
    <div className="no-print flex flex-wrap items-center gap-x-4 gap-y-3">
      {canCustomer && canVendor && (
        <div className="flex items-baseline gap-4">
          {(['customer', 'vendor'] as DuizhangKind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => k !== kind && go({ kind: k, party: '' })}
              className={`text-[14px] tracking-tight transition-colors ${
                k === kind
                  ? 'font-semibold text-[var(--color-ink)]'
                  : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
              }`}
            >
              {k === 'customer' ? '客户' : '供应商'}
            </button>
          ))}
        </div>
      )}

      <SearchSelect
        options={parties.map((p) => ({ id: p.name, label: p.name }))}
        value={party}
        onChange={(name) => go({ party: name })}
        placeholder={kind === 'customer' ? '选客户' : '选供应商'}
        searchPlaceholder={kind === 'customer' ? '找客户' : '找供应商'}
        triggerClass="min-w-[180px]"
      />

      {/* 月份 —— 对账是按月对的, 所以只有月, 没有起止两个日期框。 */}
      <div className="flex items-center gap-1">
        <Step label="上一月" onClick={() => go({ month: shiftMonth(month, -1) })}>
          ‹
        </Step>
        <span className="min-w-[92px] text-center text-[13.5px] tabular-nums text-[var(--color-ink)]">
          {monthText}
        </span>
        <Step label="下一月" onClick={() => go({ month: shiftMonth(month, 1) })}>
          ›
        </Step>
      </div>

      {sheet && (
        <div className="ml-auto flex items-center gap-2">
          <ExportButton sheet={sheet} />
          <a
            href={pdfHref}
            target="_blank"
            rel="noopener"
            className="rounded-[2px] bg-[var(--color-ink)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-surface)] hover:opacity-80"
          >
            打印 / 下载 PDF
          </a>
        </div>
      )}
    </div>
  )
}

function Step({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="px-1.5 text-[15px] leading-none text-[var(--color-ink-3)] transition-colors hover:text-[var(--color-ink)]"
    >
      {children}
    </button>
  )
}

// 还没选对方时, 页面本身就是那张一览: 这个月每一家各该收/该付多少, 金额大的
// 在上 —— 月底对账先看的就是这个。点一家, 就是他这个月的对账单。
// 本期没往来的不占版面 (上面的下拉里照样搜得到)。
export function DuizhangPartyList({
  kind,
  month,
  parties,
}: {
  kind: DuizhangKind
  month: string
  parties: DuizhangParty[]
}) {
  const router = useRouter()
  const who = kind === 'customer' ? '客户' : '供应商'
  const live = parties.filter((p) => p.inPeriod)
  const total = live.reduce((s, p) => s + p.amountCny, 0)
  const orders = live.reduce((s, p) => s + p.count, 0)

  if (live.length === 0)
    return (
      <p className="py-24 text-center text-[13px] text-[var(--color-ink-3)]">
        {monthLabel(month)}没有{kind === 'customer' ? '出货' : '回厂的外协单'}
        {parties.length > 0 ? ' — 换个月, 或者上面直接选一家' : ''}
      </p>
    )

  return (
    <div className="mx-auto mt-8 max-w-[620px]">
      <div className="flex items-baseline justify-between gap-4">
        <p className="label">
          {monthLabel(month)} · 按{who}
        </p>
        <p className="text-[12px] tabular-nums text-[var(--color-ink-3)]">
          {live.length} 家 · {orders} 单 ·{' '}
          <span className="text-[var(--color-ink)]">{formatCny(total)}</span>
        </p>
      </div>
      <div className="mt-2">
        {live.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => router.push(href(kind, p.name, month))}
            className="flex w-full items-baseline justify-between gap-4 border-b border-[var(--color-border)] px-1 py-3 text-left transition-colors hover:bg-[var(--color-active-bg)]"
          >
            <span className="min-w-0 truncate text-[14.5px] text-[var(--color-ink)]">
              {p.name}
            </span>
            <span className="shrink-0 tabular-nums">
              <span className="text-[12px] text-[var(--color-ink-3)]">
                {p.count} 单
              </span>
              <span className="ml-3 text-[15px] font-medium text-[var(--color-ink)]">
                {formatCny(p.amountCny)}
              </span>
            </span>
          </button>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-[var(--color-ink-3)]">
        {kind === 'customer'
          ? '按出货日期归月。'
          : '按回厂结算日归月 —— 还没回齐的单不算这个月的账。'}
      </p>
    </div>
  )
}

function ExportButton({ sheet }: { sheet: Duizhang }) {
  const [busy, setBusy] = useState(false)
  const k = sheet.kind
  const onExport = async () => {
    if (busy || sheet.lines.length === 0) return
    setBusy(true)
    try {
      const XLSX = await import('xlsx')
      // 客户版多三列 (合同号 · 单价, 物料号独立成列) —— 客户核的是物料明细。
      const isCustomer = k === 'customer'
      const head = isCustomer
        ? [
            '序号',
            DUIZHANG_DATE_LABEL[k],
            DUIZHANG_DOCNO_LABEL[k],
            '合同号',
            '物料号',
            '物料名称',
            '数量',
            '单价',
            '金额',
          ]
        : [
            '序号',
            DUIZHANG_DATE_LABEL[k],
            DUIZHANG_DOCNO_LABEL[k],
            DUIZHANG_TITLE_LABEL[k],
            DUIZHANG_DETAIL_LABEL[k],
            '数量',
            '金额',
          ]
      const blanks: (string | number)[] = head.map(() => '')
      const body: (string | number)[][] = sheet.lines.map((l, i) =>
        isCustomer
          ? [
              i + 1,
              l.date,
              l.docNo,
              l.contractNo ?? '',
              l.partNo ?? '',
              l.title,
              l.qty,
              typeof l.unitPriceCny === 'number' ? l.unitPriceCny : '',
              typeof l.amountCny === 'number' ? l.amountCny : '',
            ]
          : [
              i + 1,
              l.date,
              l.docNo,
              l.title,
              l.detail,
              l.qty,
              typeof l.amountCny === 'number' ? l.amountCny : '',
            ],
      )
      const totalRow: (string | number)[] = [...blanks]
      totalRow[0] = '合计'
      totalRow[head.indexOf('数量')] = sheet.totalQty
      totalRow[head.indexOf('金额')] = sheet.totalAmountCny
      body.push(totalRow)
      body.push([])
      const sum = (label: string, v: number) => {
        const row: (string | number)[] = [...blanks]
        row[0] = label
        row[head.length - 1] = v
        body.push(row)
      }
      if (isCustomer) {
        sum('本期出货', sheet.totalAmountCny)
        sum('本期开票', sheet.invoicedCny)
        sum('本期回款', sheet.paidCny)
        sum('截至今日未收', sheet.carryAmountCny)
      } else {
        sum('本期应付', sheet.totalAmountCny)
        sum(`尚在外未结 (${sheet.carryCount} 单)`, sheet.carryAmountCny)
      }
      const title = [
        [`${sheet.party} · ${DUIZHANG_TITLE[k]}`],
        [`对账期间 ${sheet.from} 至 ${sheet.to}`],
        [],
      ]
      const ws = XLSX.utils.aoa_to_sheet([...title, head, ...body])
      ws['!cols'] = head.map((h) =>
        h === '物料名称' || h === DUIZHANG_TITLE_LABEL[k]
          ? { wch: 30 }
          : h === '序号' || h === '数量'
            ? { wch: 8 }
            : h === '金额' || h === '单价'
              ? { wch: 12 }
              : { wch: 16 },
      )
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '对账单')
      XLSX.writeFile(wb, `${sheet.party}_对账单_${sheet.from.slice(0, 7)}.xlsx`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      onClick={onExport}
      disabled={busy || sheet.lines.length === 0}
      title={`${sheet.count} 单 · 截至 ${dateLabel(sheet.to)}`}
      className="rounded-[2px] border border-[var(--color-border-strong)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-ink-2)] transition-colors hover:text-[var(--color-ink)] disabled:opacity-40"
    >
      {busy ? '导出中…' : '导出 Excel'}
    </button>
  )
}
