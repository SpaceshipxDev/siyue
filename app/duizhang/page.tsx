import { canSeeOrderLedger, canSeeReport } from '@/lib/auth'
import { formatCny } from '@/lib/data'
import { proxiedStorageUrl } from '@/lib/storage-url'
import {
  dateLabel,
  monthLabel,
  DUIZHANG_DATE_LABEL,
  DUIZHANG_DETAIL_LABEL,
  DUIZHANG_DOCNO_LABEL,
  DUIZHANG_PARTY_LABEL,
  DUIZHANG_SIGN,
  DUIZHANG_TITLE,
  DUIZHANG_TITLE_LABEL,
  type Duizhang,
} from '@/lib/duizhang'
import { BRAND } from '@/lib/brand'
import { TopBar } from '../_ui'
import { DuizhangBar, DuizhangPartyList } from './_bar'
import { loadDuizhang } from './_load'

export const dynamic = 'force-dynamic'

// 对账 — 月底和外面那一方把账对齐的那张纸。
//
// 客户那半边的行是「出货单」: 货交掉了才上对账单, 所以这页天然就是"出货完成
// 后的客户对账单" —— 没有第二个地方要点、也没有第二个数要填。
// 供应商那半边的行是「回厂的外协单」: 做完了才该付钱, 口径和月度统计一致。
//
// 页面本身就是那张纸: 上面一条控件 (客户/供应商 · 选谁 · 哪个月), 下面直接
// 是印出来的样子。不做"设置好条件再点生成"那一套 —— 要看的东西就在眼前, 改
// 一个条件, 纸跟着变。

export default async function DuizhangPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; name?: string; m?: string }>
}) {
  const params = await searchParams
  const {
    user,
    kind,
    party,
    month,
    todayStr,
    sheet,
    parties,
    canCustomer,
    canVendor,
  } = await loadDuizhang(params)

  return (
    <div className="flex flex-1 flex-col">
      <div className="no-print">
        <TopBar
          title="对账"
          subtitle={kind === 'customer' ? '客户' : '外协'}
          currentTab={kind === 'customer' ? '财务' : '外协'}
          role={user.role}
          defaultStage={user.defaultStage}
          userName={user.name}
          canSeeReport={canSeeReport(user)}
          canSeeFinance={canSeeOrderLedger(user)}
        />
      </div>

      <main className="w-full flex-1 px-4 py-6 print:p-0 md:px-10 md:py-8">
        <DuizhangBar
          kind={kind}
          party={party}
          month={month}
          monthText={monthLabel(month)}
          parties={parties}
          canCustomer={canCustomer}
          canVendor={canVendor}
          sheet={sheet}
        />

        {sheet ? (
          <Sheet sheet={sheet} preparedBy={user.name} todayStr={todayStr} />
        ) : (
          <DuizhangPartyList kind={kind} month={month} parties={parties} />
        )}
      </main>
    </div>
  )
}

// ── 那张纸 ────────────────────────────────────────────────────────────────

function Sheet({
  sheet,
  preparedBy,
  todayStr,
}: {
  sheet: Duizhang
  preparedBy: string
  todayStr: string
}) {
  const k = sheet.kind
  const isCustomer = k === 'customer'
  return (
    <article className="doc mt-6">
      <header className="border-b border-[var(--color-ink)] pb-3">
        <p className="text-center text-[13px] tracking-wide text-[var(--color-ink)]">
          {BRAND.legalName}
        </p>
        <h1 className="mt-2 text-center text-[26px] font-semibold tracking-[0.2em]">
          {DUIZHANG_TITLE[k]}
        </h1>
      </header>

      <section className="grid grid-cols-2 gap-x-10 gap-y-3 border-b border-[var(--color-border)] py-5 text-[14px] font-medium">
        <Field label={DUIZHANG_PARTY_LABEL[k]} value={sheet.party} />
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

      {sheet.lines.length === 0 ? (
        <p className="py-16 text-center text-[13px] text-[var(--color-ink-3)]">
          本期没有{isCustomer ? '出货' : '回厂的外协单'}
        </p>
      ) : (
        <section className="py-4">
          {/* 客户版一行是一个物料 (带图、物料号、单价), 供应商版一行是一张
              外协单 —— 两边核的东西不一样, 列就不一样。 */}
          <table className="doc-grid">
            <thead>
              <tr>
                <th style={{ width: 30 }}>序号</th>
                <th style={{ width: 58 }}>{DUIZHANG_DATE_LABEL[k]}</th>
                <th style={{ width: 96 }}>{DUIZHANG_DOCNO_LABEL[k]}</th>
                {isCustomer && <th style={{ width: 78 }}>合同号</th>}
                {isCustomer && <th style={{ width: 56 }}>图片</th>}
                <th style={{ width: 82 }}>{DUIZHANG_DETAIL_LABEL[k]}</th>
                <th>{DUIZHANG_TITLE_LABEL[k]}</th>
                <th style={{ width: 44 }}>数量</th>
                {isCustomer && <th style={{ width: 58 }}>单价</th>}
                <th style={{ width: 72 }}>金额</th>
              </tr>
            </thead>
            <tbody>
              {sheet.lines.map((l, i) => (
                <tr key={l.key}>
                  <td className="mono text-[var(--color-ink-3)]">
                    {String(i + 1).padStart(2, '0')}
                  </td>
                  <td className="mono">{dateLabel(l.date)}</td>
                  <td className="mono">{l.docNo}</td>
                  {isCustomer && (
                    <td className="mono text-[var(--color-ink-2)]">
                      {l.contractNo || '—'}
                    </td>
                  )}
                  {isCustomer && (
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
                  )}
                  <td className="mono text-[var(--color-ink-2)]">
                    {l.detail || '—'}
                  </td>
                  <td className="font-medium">{l.title}</td>
                  <td className="mono">{l.qty}</td>
                  {isCustomer && (
                    <td className="mono">
                      {typeof l.unitPriceCny === 'number'
                        ? formatCny(l.unitPriceCny)
                        : '—'}
                    </td>
                  )}
                  <td className="mono">
                    {typeof l.amountCny === 'number' ? formatCny(l.amountCny) : '—'}
                  </td>
                </tr>
              ))}
              <tr>
                <td
                  colSpan={isCustomer ? 7 : 5}
                  className="label"
                  style={{ textAlign: 'right' }}
                >
                  合计
                </td>
                <td className="mono font-semibold">{sheet.totalQty}</td>
                {isCustomer && <td />}
                <td className="mono font-semibold">
                  {formatCny(sheet.totalAmountCny)}
                </td>
              </tr>
            </tbody>
          </table>
          {sheet.unpricedCount > 0 && (
            <p className="mt-2 text-[11px] text-[var(--color-ink-3)]">
              其中 {sheet.unpricedCount} 单尚未定价,未计入合计。
            </p>
          )}
        </section>
      )}

      {/* 结论 —— 这张纸真正要双方点头的那两三个数。 */}
      <section className="mt-2 border-t border-[var(--color-ink)] pt-4">
        {k === 'customer' ? (
          <div className="grid grid-cols-2 gap-x-10 gap-y-2.5 text-[13px]">
            <Money label="本期出货" value={sheet.totalAmountCny} />
            <Money label="本期开票" value={sheet.invoicedCny} />
            <Money label="本期回款" value={sheet.paidCny} />
            <Money label="截至今日未收" value={sheet.carryAmountCny} strong />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-10 gap-y-2.5 text-[13px]">
            <Money label="本期应付" value={sheet.totalAmountCny} strong />
            <Money
              label={`尚在外未结${sheet.carryCount > 0 ? ` (${sheet.carryCount} 单)` : ''}`}
              value={sheet.carryAmountCny}
            />
          </div>
        )}
      </section>

      <footer className="mt-14">
        <div className="flex items-end justify-between gap-10">
          {DUIZHANG_SIGN[k].map((s) => (
            <p key={s} className="min-w-[200px] flex-1">
              <span className="label mr-3">{s}</span>
              <span className="mt-8 block h-px w-full bg-[var(--color-ink)]" />
            </p>
          ))}
        </div>
        <p className="mt-6 flex items-baseline gap-1.5 text-[11px]">
          <span className="tracking-[0.1em] text-[var(--color-ink-3)]">
            {BRAND.software}
          </span>
          <span className="text-[var(--color-ink-4)]">·</span>
          <span className="tracking-[0.02em] text-[var(--color-ink-2)]">
            {BRAND.domain}
          </span>
        </p>
      </footer>
    </article>
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

function Money({
  label,
  value,
  strong,
}: {
  label: string
  value: number
  strong?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="label">{label}</span>
      <span
        className={`mono tabular-nums ${
          strong ? 'text-[17px] font-semibold' : 'text-[14px]'
        }`}
      >
        {formatCny(value)}
      </span>
    </div>
  )
}
