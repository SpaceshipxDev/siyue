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
import { settleOutstanding, settlePaid, type Receivable } from '@/lib/settle-shared'
import { ExportButton } from './_bar'

// 客户对账单 —— 按单号勾着对, 跟外协那边一个路子。
//
// 一个交货单号一组 (一张单里几个零件, 勾一下整张一起勾)。默认全勾; 客户只
// 认其中几张的时候, 在上面那一格打单号 (几个就空格隔开) 回车, 就只勾这几张。
// 合计、打印、导出都跟着勾走。点「审批所选」, 这几张落成一张应收单, 下一回
// 打开就不在纸上了; 没勾的留着, 下回接着审。
//
// 没定价的单勾不上 —— 一个偏小的合计认下来, 差的那部分就再也没人对了。

const K = 'customer' as const

export function CustomerSheet({
  sheet,
  month,
  preparedBy,
  todayStr,
  records,
  canApprove,
  canOpenLedger,
  initialQuery = '',
  skipped = [],
}: {
  sheet: Duizhang
  month: string
  preparedBy: string
  todayStr: string
  /** 这个客户这个月按单号审过的应收单 —— 它们认过的单号已经不在纸上了。 */
  records: Receivable[]
  canApprove: boolean
  canOpenLedger: boolean
  /** 从顶上「按工单号找」过来的 —— 一打开就只勾对上的那几张。 */
  initialQuery?: string
  /** 这个月标了「无需对账」的工单号 —— 不在纸上, 列在下面好恢复。 */
  skipped?: string[]
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState(initialQuery)

  // 一个单号 = 一组行, 顺序跟纸上一致。
  const groups = useMemo(() => {
    const out: { no: string; lines: DuizhangLine[]; priced: boolean }[] = []
    const byNo = new Map<string, (typeof out)[number]>()
    for (const l of sheet.lines) {
      let g = byNo.get(l.docNo)
      if (!g) {
        g = { no: l.docNo, lines: [], priced: true }
        byNo.set(l.docNo, g)
        out.push(g)
      }
      g.lines.push(l)
      if (typeof l.amountCny !== 'number') g.priced = false
    }
    return out
  }, [sheet.lines])

  const priced = useMemo(
    () => new Set(groups.filter((g) => g.priced).map((g) => g.no)),
    [groups],
  )
  const [picked, setPicked] = useState<Set<string>>(() => {
    const q = initialQuery.toLowerCase()
    const hits = q ? [...priced].filter((no) => no.toLowerCase().includes(q)) : []
    return new Set(hits.length > 0 ? hits : priced)
  })

  const chosen = groups.filter((g) => picked.has(g.no))
  const chosenLines = chosen.flatMap((g) => g.lines)
  const chosenQty = chosenLines.reduce((s, l) => s + l.qty, 0)
  const chosenAmount =
    Math.round(chosenLines.reduce((s, l) => s + (l.amountCny ?? 0), 0) * 100) / 100
  const unpricedLeft = groups.length - priced.size

  function toggle(no: string) {
    if (!priced.has(no)) return
    setPicked((cur) => {
      const next = new Set(cur)
      if (next.has(no)) next.delete(no)
      else next.add(no)
      return next
    })
  }
  const allOn = priced.size > 0 && [...priced].every((no) => picked.has(no))
  function toggleAll() {
    setPicked(allOn ? new Set() : new Set(priced))
  }

  // 打单号回车 —— 只勾这几张。打半截也认 (单号尾巴几位就够)。
  const [miss, setMiss] = useState<string[]>([])
  function pickByNo() {
    const words = query.split(/[\s,，、;；]+/).map((w) => w.trim()).filter(Boolean)
    if (words.length === 0) return
    const next = new Set<string>()
    const notFound: string[] = []
    for (const w of words) {
      const hits = groups.filter(
        (g) => priced.has(g.no) && g.no.toLowerCase().includes(w.toLowerCase()),
      )
      if (hits.length === 0) notFound.push(w)
      for (const g of hits) next.add(g.no)
    }
    setPicked(next)
    setMiss(notFound)
  }

  // 无需对账 —— 勾上的这几张标掉 (再点一下确认); 标过的在下面一条里恢复。
  const [armSkip, setArmSkip] = useState(false)
  function markSkip(nos: string[], on: boolean) {
    if (nos.length === 0) return
    setError(null)
    start(async () => {
      try {
        await mutate({ kind: 'setNoReconcile', jobNos: nos, on })
        setArmSkip(false)
        if (on) setPicked(new Set())
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '标不上')
      }
    })
  }

  function approve() {
    if (chosen.length === 0) return
    setError(null)
    start(async () => {
      try {
        await mutate({
          kind: 'approveDuizhang',
          customer: sheet.party,
          period: month,
          jobNos: chosen.map((g) => g.no),
        })
        setPicked(new Set())
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '审批不上')
      }
    })
  }

  // 勾上的那几张 —— 导出 Excel 和打印 PDF 都只出它们。
  const chosenSheet: Duizhang = {
    ...sheet,
    lines: chosenLines,
    count: chosenLines.length,
    totalQty: chosenQty,
    totalAmountCny: chosenAmount,
    unpricedCount: 0,
  }
  const pdfHref = withBase(
    `/duizhang/pdf?name=${encodeURIComponent(sheet.party)}&m=${month}${
      allOn && chosen.length === groups.length
        ? ''
        : `&sel=${encodeURIComponent(chosen.map((g) => g.no).join(','))}`
    }`,
  )

  // 序号只数勾上的行 —— 打印出去的那张纸上是连着的。
  const seqOf = new Map<string, number>()
  for (const l of chosenLines) seqOf.set(l.key, seqOf.size + 1)

  return (
    <>
      {/* 这个月已经审过的几回 —— 认过的单号已经不在下面的纸上了。 */}
      {records.length > 0 && (
        <div className="no-print mt-5 space-y-1.5 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 md:px-5">
          {records.map((r) => {
            const left = settleOutstanding(r)
            return (
              <div key={r.id} className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
                <span className="text-[13px] font-semibold text-[var(--color-success)]">✓ 已审批</span>
                <span className="mono text-[13px] text-[var(--color-ink)]">{r.no}</span>
                <span
                  className="max-w-[260px] truncate text-[13px] text-[var(--color-ink-2)]"
                  title={r.jobNos?.join('、')}
                >
                  {r.jobNos?.length ?? 0} 个单号 · 应收{' '}
                  <b className="mono font-medium text-[var(--color-ink)]">{formatCny(r.amountCny)}</b>
                </span>
                <span className="text-[13px] text-[var(--color-ink-2)]">
                  已回款 <b className="mono font-medium">{formatCny(settlePaid(r))}</b>
                </span>
                <span className="text-[13px] text-[var(--color-ink-2)]">
                  未收{' '}
                  <b
                    className={`mono font-medium ${
                      left > 0 ? 'text-[var(--color-overdue)]' : 'text-[var(--color-ink-3)]'
                    }`}
                  >
                    {formatCny(left)}
                  </b>
                </span>
                <span className="text-[11.5px] text-[var(--color-ink-4)]">
                  {r.approvedBy} 审批于 {r.approvedAt.slice(0, 10)}
                </span>
                {canOpenLedger && (
                  <Link
                    href={`/finance?tab=receivable&open=${r.id}`}
                    className="ml-auto text-[13px] font-medium text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
                  >
                    去应收 →
                  </Link>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 这一回要审哪几张 —— 按单号选、勾了多少、合计、打印导出、审批。 */}
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
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setMiss([])
              }}
              onKeyDown={(e) => e.key === 'Enter' && pickByNo()}
              placeholder="按单号选 · 几个用空格隔开，回车"
              className="h-8 w-[240px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
            />
            <span className="text-[13px] text-[var(--color-ink-2)]">
              已选 <b className="text-[var(--color-ink)]">{chosen.length}</b> / {groups.length} 个单号 ·{' '}
              {chosenQty} 件 · 应收{' '}
              <b className="mono font-medium text-[var(--color-ink)]">{formatCny(chosenAmount)}</b>
            </span>
            {unpricedLeft > 0 && (
              <span className="text-[12px] text-[var(--color-overdue)]">
                {unpricedLeft} 个单号有没定价的，补上单价才能勾
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
              {canApprove &&
                (armSkip ? (
                  <span className="flex items-center gap-2 text-[12.5px]">
                    <button
                      type="button"
                      onClick={() => markSkip(chosen.map((g) => g.no), true)}
                      disabled={pending}
                      className="font-medium text-[var(--color-overdue)] hover:underline disabled:opacity-50"
                    >
                      确认 {chosen.length} 张无需对账
                    </button>
                    <button
                      type="button"
                      onClick={() => setArmSkip(false)}
                      className="text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
                    >
                      取消
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setArmSkip(true)}
                    disabled={pending || chosen.length === 0}
                    title="样品、现结之类不用跟客户对的单 —— 标掉之后不再出现在对账单上，随时能恢复"
                    className="text-[12.5px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] disabled:opacity-40"
                  >
                    所选无需对账
                  </button>
                ))}
              {canApprove ? (
                <button
                  type="button"
                  onClick={approve}
                  disabled={pending || chosen.length === 0}
                  className="h-9 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-40"
                >
                  {pending ? '审批中…' : '审批所选，生成应收单'}
                </button>
              ) : (
                <span className="text-[12px] text-[var(--color-ink-4)]">审批由于海伟或财务来点</span>
              )}
            </span>
          </div>
          {miss.length > 0 && (
            <p className="mt-2 text-[12px] text-[var(--color-warning)]">
              这个月没找到：{miss.join('、')}
            </p>
          )}
          {error && <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>}
          <p className="mt-2 text-[11.5px] text-[var(--color-ink-4)]">
            审过的单号下一回不再出现；没勾的留着，下回接着审。
          </p>
        </div>
      )}

      {/* 这个月标了无需对账的 —— 不在纸上, 点一下恢复。 */}
      {skipped.length > 0 && (
        <div className="no-print mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 text-[12px] text-[var(--color-ink-3)]">
          <span>无需对账 {skipped.length} 张：</span>
          {skipped.map((no) => (
            <span key={no} className="inline-flex items-baseline gap-1.5">
              <span className="mono text-[var(--color-ink-2)]">{no}</span>
              {canApprove && (
                <button
                  type="button"
                  onClick={() => markSkip([no], false)}
                  disabled={pending}
                  className="text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-ink)] disabled:opacity-50"
                >
                  恢复
                </button>
              )}
            </span>
          ))}
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
                {sheet.from} 至 {sheet.to}
              </span>
            }
          />
          <Field label="制单人" value={preparedBy || '—'} />
          <Field label="制单日期" value={<span className="mono">{todayStr}</span>} />
        </section>

        {groups.length === 0 ? (
          <p className="py-16 text-center text-[13px] text-[var(--color-ink-3)]">
            {records.length > 0 ? '这个月出货的单都审过了' : '本期没有出货'}
          </p>
        ) : (
          <section className="py-4">
            <table className="doc-grid">
              <thead>
                <tr>
                  <th className="no-print" style={{ width: 28 }} />
                  <th style={{ width: 30 }}>序号</th>
                  <th style={{ width: 58 }}>{DUIZHANG_DATE_LABEL[K]}</th>
                  <th style={{ width: 96 }}>{DUIZHANG_DOCNO_LABEL[K]}</th>
                  <th style={{ width: 78 }}>合同号</th>
                  <th style={{ width: 56 }}>图片</th>
                  <th style={{ width: 82 }}>{DUIZHANG_DETAIL_LABEL[K]}</th>
                  <th>{DUIZHANG_TITLE_LABEL[K]}</th>
                  <th style={{ width: 44 }}>数量</th>
                  <th style={{ width: 58 }}>单价</th>
                  <th style={{ width: 72 }}>金额</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const on = picked.has(g.no)
                  const canPick = priced.has(g.no)
                  return (
                    <Fragment key={g.no}>
                      {g.lines.map((l, i) => {
                        const seq = seqOf.get(l.key)
                        return (
                          <tr
                            key={l.key}
                            className={on ? '' : 'print:hidden opacity-40'}
                            onClick={() => toggle(g.no)}
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
                                  onChange={() => toggle(g.no)}
                                  onClick={(e) => e.stopPropagation()}
                                  title={canPick ? '这一回审这张单' : '有没定价的，勾不上'}
                                  className="h-4 w-4 cursor-pointer accent-[var(--color-ink)] disabled:cursor-not-allowed"
                                />
                              </td>
                            )}
                            <td className="mono text-[var(--color-ink-3)]">
                              {seq ? String(seq).padStart(2, '0') : '—'}
                            </td>
                            <td className="mono">{dateLabel(l.date)}</td>
                            <td className="mono">{i === 0 ? l.docNo : ''}</td>
                            <td className="mono text-[var(--color-ink-2)]">{l.contractNo || '—'}</td>
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
                            <td className="mono text-[var(--color-ink-2)]">{l.detail || '—'}</td>
                            <td className="font-medium">{l.title}</td>
                            <td className="mono">{l.qty}</td>
                            <td className="mono">
                              {typeof l.unitPriceCny === 'number' ? formatCny(l.unitPriceCny) : '—'}
                            </td>
                            <td className="mono">
                              {typeof l.amountCny === 'number' ? (
                                formatCny(l.amountCny)
                              ) : (
                                <span className="text-[var(--color-overdue)]">没定价</span>
                              )}
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
            <Money label="本次出货" value={chosenAmount} />
            <Money label="本期开票" value={sheet.invoicedCny} />
            <Money label="本期回款" value={sheet.paidCny} />
            <Money label="截至今日未收" value={sheet.carryAmountCny} strong />
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
