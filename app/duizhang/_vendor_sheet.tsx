'use client'

import { Fragment, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { withBase } from '@/lib/base-path'
import { formatCny } from '@/lib/data'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { BRAND } from '@/lib/brand'
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
  type DuizhangLine,
} from '@/lib/duizhang'
import { settleOutstanding, settlePaid, type Payable } from '@/lib/settle-shared'
import { ExportButton } from './_bar'

// 外协对账单 —— 跟客户对账单一个样子 (一个零件一行: 图、料号、零件名、数量、
// 单价、金额), 多一样: 勾。
//
// 纸上是这一家截至月底、回了厂、还没对过账的外协单。每张单前面一个勾 (一张
// 单里几个零件, 勾一下整张一起勾 —— 一张单是一起付的)。勾上的就是这一回要跟
// 他对的: 合计跟着勾走, 打印 / 导出也只出勾上的那几张。点「确认所选」, 这几张
// 落成一张应付单, 下一回打开就不在纸上了; 没勾的留着, 下回接着对。
//
// 没定价的单勾不上 —— 一个没数的单认下来, 差的那部分就再也没人对了。

const K = 'vendor' as const

export function VendorSheet({
  sheet,
  month,
  preparedBy,
  todayStr,
  records,
  canApprove,
  canOpenLedger,
}: {
  sheet: Duizhang
  month: string
  preparedBy: string
  todayStr: string
  /** 这一家这个月已经确认过的应付单 —— 它们认过的单已经不在纸上了。 */
  records: Payable[]
  canApprove: boolean
  canOpenLedger: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // 一张外协单 = 一组行。组的顺序跟纸上一致。
  const groups = useMemo(() => {
    const out: { id: string; amount?: number; lines: DuizhangLine[] }[] = []
    const byId = new Map<string, (typeof out)[number]>()
    for (const l of sheet.lines) {
      const id = l.groupId ?? l.key
      let g = byId.get(id)
      if (!g) {
        g = { id, amount: l.groupAmountCny, lines: [] }
        byId.set(id, g)
        out.push(g)
      }
      g.lines.push(l)
    }
    return out
  }, [sheet.lines])

  const priced = useMemo(
    () => new Set(groups.filter((g) => typeof g.amount === 'number').map((g) => g.id)),
    [groups],
  )
  // 默认全勾 (定过价的) —— 多数时候一家这个月的单是一次对完的。
  const [picked, setPicked] = useState<Set<string>>(() => new Set(priced))

  const chosen = groups.filter((g) => picked.has(g.id))
  const chosenLines = chosen.flatMap((g) => g.lines)
  const chosenQty = chosenLines.reduce((s, l) => s + l.qty, 0)
  const chosenAmount =
    Math.round(chosen.reduce((s, g) => s + (g.amount ?? 0), 0) * 100) / 100
  const unpricedLeft = groups.length - priced.size

  function toggle(id: string) {
    if (!priced.has(id)) return
    setPicked((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const allOn = priced.size > 0 && [...priced].every((id) => picked.has(id))
  function toggleAll() {
    setPicked(allOn ? new Set() : new Set(priced))
  }

  function confirm() {
    if (chosen.length === 0) return
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'confirmVendorDuizhang',
          vendor: sheet.party,
          period: month,
          blockIds: chosen.map((g) => g.id),
        })
        setPicked(new Set())
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '确认不上')
      }
    })
  }

  // 勾上的那几张 —— 导出 Excel 和打印 PDF 都只出它们。
  const chosenSheet: Duizhang = {
    ...sheet,
    lines: chosenLines,
    count: chosen.length,
    totalQty: chosenQty,
    totalAmountCny: chosenAmount,
    unpricedCount: 0,
  }
  const pdfHref = withBase(
    `/duizhang/pdf?kind=vendor&name=${encodeURIComponent(sheet.party)}&m=${month}${
      allOn && chosen.length === groups.length
        ? ''
        : `&sel=${encodeURIComponent(chosen.map((g) => g.id).join(','))}`
    }`,
  )

  // 序号只数勾上的行 —— 打印出去的那张纸上是 01、02、03 连着的。
  const seqOf = new Map<string, number>()
  for (const l of chosenLines) seqOf.set(l.key, seqOf.size + 1)

  return (
    <>
      {/* 这一家这个月已经对过的几回 —— 认过的单已经不在下面的纸上了。 */}
      {records.length > 0 && (
        <div className="no-print mt-5 space-y-1.5 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 md:px-5">
          {records.map((r) => {
            const paid = settlePaid(r)
            const left = settleOutstanding(r)
            return (
              <div key={r.id} className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
                <span className="text-[13px] font-semibold text-[var(--color-success)]">
                  ✓ 已确认
                </span>
                <span className="mono text-[13px] text-[var(--color-ink)]">{r.no}</span>
                <span className="text-[13px] text-[var(--color-ink-2)]">
                  {r.blockIds?.length ?? r.lineCount} 张单 · 应付{' '}
                  <b className="mono font-medium text-[var(--color-ink)]">
                    {formatCny(r.amountCny)}
                  </b>
                </span>
                <span className="text-[13px] text-[var(--color-ink-2)]">
                  已付 <b className="mono font-medium">{formatCny(paid)}</b>
                </span>
                <span className="text-[13px] text-[var(--color-ink-2)]">
                  未付{' '}
                  <b
                    className={`mono font-medium ${
                      left > 0 ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink-3)]'
                    }`}
                  >
                    {formatCny(left)}
                  </b>
                </span>
                <span className="text-[11.5px] text-[var(--color-ink-4)]">
                  {r.approvedBy} 确认于 {r.approvedAt.slice(0, 10)}
                </span>
                {canOpenLedger && (
                  <Link
                    href={`/finance?tab=payable&open=${r.id}`}
                    className="ml-auto text-[13px] font-medium text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
                  >
                    去应付 →
                  </Link>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 这一回要对哪几张 —— 勾了多少、合计多少、打印导出、确认。 */}
      {groups.length > 0 && (
        <div className="no-print mt-5 rounded-[2px] border border-dashed border-[var(--color-border-strong)] px-4 py-3 md:px-5">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <button
              type="button"
              onClick={toggleAll}
              disabled={priced.size === 0}
              className="text-[13px] font-medium text-[var(--color-ink-2)] hover:text-[var(--color-ink)] disabled:opacity-40"
            >
              {allOn ? '全不选' : '全选'}
            </button>
            <span className="text-[13px] text-[var(--color-ink-2)]">
              已选 <b className="text-[var(--color-ink)]">{chosen.length}</b> / {groups.length} 张单 ·{' '}
              {chosenQty} 件 · 应付{' '}
              <b className="mono font-medium text-[var(--color-ink)]">{formatCny(chosenAmount)}</b>
            </span>
            {unpricedLeft > 0 && (
              <span className="text-[12px] text-[var(--color-overdue)]">
                {unpricedLeft} 张没定价，补上价钱才能勾
              </span>
            )}
            <span className="ml-auto flex items-center gap-2">
              <ExportButton sheet={chosenSheet} />
              <a
                href={pdfHref}
                target="_blank"
                rel="noopener"
                aria-disabled={chosen.length === 0}
                className={`rounded-[2px] border border-[var(--color-border-strong)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-ink-2)] hover:text-[var(--color-ink)] ${
                  chosen.length === 0 ? 'pointer-events-none opacity-40' : ''
                }`}
              >
                打印 / 下载 PDF
              </a>
              {canApprove ? (
                <button
                  type="button"
                  onClick={confirm}
                  disabled={pending || chosen.length === 0}
                  className="h-9 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-40"
                >
                  {pending ? '确认中…' : '确认所选，生成应付单'}
                </button>
              ) : (
                <span className="text-[12px] text-[var(--color-ink-4)]">确认由于海伟或财务来点</span>
              )}
            </span>
          </div>
          {error && <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>}
          <p className="mt-2 text-[11.5px] text-[var(--color-ink-4)]">
            确认过的单下一回对账不再出现；没勾的留着，下回接着对。
          </p>
        </div>
      )}

      <article className="doc mt-6">
        <header className="border-b border-[var(--color-ink)] pb-3">
          <p className="text-center text-[13px] tracking-wide text-[var(--color-ink)]">
            {BRAND.legalName}
          </p>
          <h1 className="mt-2 text-center text-[26px] font-semibold tracking-[0.2em]">
            {DUIZHANG_TITLE[K]}
          </h1>
        </header>

        <section className="grid grid-cols-2 gap-x-10 gap-y-3 border-b border-[var(--color-border)] py-5 text-[14px] font-medium">
          <Field label={DUIZHANG_PARTY_LABEL[K]} value={sheet.party} />
          <Field
            label="对账期间"
            value={
              <span className="mono">
                {chosenLines.length > 0
                  ? `${chosenLines.reduce((m, l) => (l.date < m ? l.date : m), chosenLines[0].date)} 至 ${sheet.to}`
                  : `${sheet.from} 至 ${sheet.to}`}
              </span>
            }
          />
          <Field label="制单人" value={preparedBy || '—'} />
          <Field label="制单日期" value={<span className="mono">{todayStr}</span>} />
        </section>

        {groups.length === 0 ? (
          <p className="py-16 text-center text-[13px] text-[var(--color-ink-3)]">
            {records.length > 0
              ? '截至这个月底回厂的外协单都对过账了'
              : '截至这个月底没有回厂、还没对账的外协单'}
          </p>
        ) : (
          <section className="py-4">
            <table className="doc-grid">
              <thead>
                <tr>
                  <th className="no-print" style={{ width: 28 }} />
                  <th style={{ width: 30 }}>序号</th>
                  <th style={{ width: 58 }}>{DUIZHANG_DATE_LABEL[K]}</th>
                  <th style={{ width: 110 }}>{DUIZHANG_DOCNO_LABEL[K]}</th>
                  <th style={{ width: 64 }}>{DUIZHANG_DETAIL_LABEL[K]}</th>
                  <th style={{ width: 56 }}>图片</th>
                  <th style={{ width: 82 }}>料号</th>
                  <th>{DUIZHANG_TITLE_LABEL[K]}</th>
                  <th style={{ width: 44 }}>数量</th>
                  <th style={{ width: 58 }}>单价</th>
                  <th style={{ width: 72 }}>金额</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const on = picked.has(g.id)
                  const canPick = priced.has(g.id)
                  return (
                    <Fragment key={g.id}>
                      {g.lines.map((l, i) => {
                        const seq = seqOf.get(l.key)
                        return (
                          <tr
                            key={l.key}
                            className={on ? '' : 'print:hidden opacity-40'}
                            onClick={() => toggle(g.id)}
                            style={{ cursor: canPick ? 'pointer' : 'default' }}
                          >
                            {i === 0 && (
                              <td
                                className="no-print"
                                rowSpan={g.lines.length}
                                style={{ verticalAlign: 'middle', textAlign: 'center' }}
                              >
                                <input
                                  type="checkbox"
                                  checked={on}
                                  disabled={!canPick}
                                  onChange={() => toggle(g.id)}
                                  onClick={(e) => e.stopPropagation()}
                                  title={canPick ? '这一回对这张单' : '没定价，勾不上'}
                                  className="h-4 w-4 cursor-pointer accent-[var(--color-ink)] disabled:cursor-not-allowed"
                                />
                              </td>
                            )}
                            <td className="mono text-[var(--color-ink-3)]">
                              {seq ? String(seq).padStart(2, '0') : '—'}
                            </td>
                            <td className="mono">{dateLabel(l.date)}</td>
                            <td className="mono">{i === 0 ? l.docNo : ''}</td>
                            <td className="text-[var(--color-ink-2)]">{l.detail || '—'}</td>
                            <td>
                              {l.imageUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={proxiedStorageUrl(l.imageUrl)}
                                  alt={l.title}
                                  className="doc-thumb"
                                />
                              ) : (
                                <span className="text-[var(--color-ink-4)]">—</span>
                              )}
                            </td>
                            <td className="mono text-[var(--color-ink-2)]">{l.partNo || '—'}</td>
                            <td className="font-medium">{l.title}</td>
                            <td className="mono">{l.qty}</td>
                            <td className="mono">
                              {typeof l.unitPriceCny === 'number'
                                ? formatCny(l.unitPriceCny)
                                : '—'}
                            </td>
                            <td className="mono">
                              {typeof l.amountCny === 'number'
                                ? formatCny(l.amountCny)
                                : i === 0 && typeof g.amount === 'number'
                                  ? formatCny(g.amount)
                                  : i === 0 && !canPick
                                    ? <span className="text-[var(--color-overdue)]">没定价</span>
                                    : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </Fragment>
                  )
                })}
                <tr>
                  <td className="no-print" />
                  <td colSpan={7} className="label" style={{ textAlign: 'right' }}>
                    合计
                  </td>
                  <td className="mono font-semibold">{chosenQty}</td>
                  <td />
                  <td className="mono font-semibold">{formatCny(chosenAmount)}</td>
                </tr>
              </tbody>
            </table>
          </section>
        )}

        <section className="mt-2 border-t border-[var(--color-ink)] pt-4">
          <div className="grid grid-cols-2 gap-x-10 gap-y-2.5 text-[13px]">
            <Money label="本次应付" value={chosenAmount} strong />
            <Money
              label={`尚在外未结${sheet.carryCount > 0 ? ` (${sheet.carryCount} 单)` : ''}`}
              value={sheet.carryAmountCny}
            />
          </div>
        </section>

        <footer className="mt-14">
          <div className="flex items-end justify-between gap-10">
            {DUIZHANG_SIGN[K].map((s) => (
              <p key={s} className="min-w-[200px] flex-1">
                <span className="label mr-3">{s}</span>
                <span className="mt-8 block h-px w-full bg-[var(--color-ink)]" />
              </p>
            ))}
          </div>
          <p className="mt-6 flex items-baseline gap-1.5 text-[11px]">
            <span className="tracking-[0.1em] text-[var(--color-ink-3)]">{BRAND.software}</span>
            <span className="text-[var(--color-ink-4)]">·</span>
            <span className="tracking-[0.02em] text-[var(--color-ink-2)]">{BRAND.domain}</span>
          </p>
        </footer>
      </article>
    </>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="label shrink-0">{label}</span>
      <span className="min-w-0 flex-1 border-b border-[var(--color-border-strong)] pb-0.5">
        {value || '—'}
      </span>
    </div>
  )
}

function Money({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="label">{label}</span>
      <span className={`mono tabular-nums ${strong ? 'text-[17px] font-semibold' : 'text-[14px]'}`}>
        {formatCny(value)}
      </span>
    </div>
  )
}
