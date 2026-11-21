import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { getBalloonSheet } from '@/lib/balloon-store'
import { judge, limits, rowVerdict, sheetVerdict } from '@/lib/balloon'
import { BRAND } from '@/lib/brand'
import { withBase } from '@/lib/base-path'
import { PrintButton } from '@/app/_print_button'

export const dynamic = 'force-dynamic'

// 质检报表 —— 气泡图打出来的那张纸: 表头、带编号气泡的图纸、逐项检验表、
// 结论、签字。一个气泡一行, 编号对得上图。
export default async function BalloonReportPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requireUser()
  const { id } = await params
  const s = await getBalloonSheet(id)
  if (!s) notFound()
  const verdict = sheetVerdict(s)
  const info: [string, string][] = [
    ['图名', s.title],
    ['图号', s.drawingNo],
    ['工单号', s.jobNo],
    ['客户', s.customer],
    ['材料', s.material],
    ['抽检数量', `${s.samples} 件`],
    ['检验员', s.inspector],
    ['检验日期', s.inspectedAt],
  ]
  return (
    <>
      <PrintButton />
      <article className="doc">
        <header className="border-b border-[var(--color-ink)] pb-3 text-center">
          <p className="text-[13px] tracking-wide text-[var(--color-ink)]">{BRAND.legalName}</p>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight">质检报表</h1>
        </header>

        <section className="grid grid-cols-4 gap-x-4 gap-y-1.5 py-3 text-[12px]">
          {info.map(([k, v]) => (
            <p key={k} className="flex gap-2">
              <span className="shrink-0 text-[var(--color-ink-3)]">{k}</span>
              <span className="mono min-w-0 break-all text-[var(--color-ink)]">{v || '—'}</span>
            </p>
          ))}
        </section>

        {/* 带气泡的图纸 —— 气泡位置按图的比例叠上去, 打出来跟屏幕上一样。 */}
        <section style={{ breakInside: 'avoid' }} className="mb-4 border border-[#c4c1b8]">
          <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={withBase(s.imageUrl)} alt={s.title} className="block w-full" />
            {s.balloons.map((b) => (
              <span
                key={b.n}
                style={{
                  left: `${b.x * 100}%`,
                  top: `${b.y * 100}%`,
                  position: 'absolute',
                  transform: 'translate(-50%, -50%)',
                  border: '1.5px solid #e0301e',
                  color: '#e0301e',
                  background: '#fff',
                  borderRadius: 999,
                  minWidth: 17,
                  height: 17,
                  padding: '0 3px',
                  fontSize: 9.5,
                  fontWeight: 700,
                  lineHeight: '14px',
                  textAlign: 'center',
                }}
              >
                {b.n}
              </span>
            ))}
          </div>
        </section>

        <p className="mb-1.5 text-[13px] font-semibold">尺寸检验</p>
        <table className="doc-grid">
          <thead>
            <tr>
              <th style={{ width: 30 }}>序号</th>
              <th style={{ width: 110 }}>图上标注</th>
              <th>名义值</th>
              <th>上公差</th>
              <th>下公差</th>
              <th>下限</th>
              <th>上限</th>
              {Array.from({ length: s.samples }, (_, i) => (
                <th key={i}>实测{i + 1}</th>
              ))}
              <th style={{ width: 34 }}>判定</th>
              <th>量具</th>
            </tr>
          </thead>
          <tbody>
            {s.balloons.map((b) => {
              const lim = limits(b)
              const v = rowVerdict(b, s.samples)
              return (
                <tr key={b.n} style={{ breakInside: 'avoid' }}>
                  <td>{b.n}</td>
                  <td>{b.spec}</td>
                  <td className="mono">{b.nominal}</td>
                  <td className="mono">{b.tolUp}</td>
                  <td className="mono">{b.tolDown}</td>
                  <td className="mono">{lim.lo}</td>
                  <td className="mono">{lim.hi}</td>
                  {Array.from({ length: s.samples }, (_, i) => {
                    const m = b.measured[i] ?? ''
                    return (
                      <td key={i} className="mono" style={judge(b, m) === 'NG' ? { color: '#c0261a', fontWeight: 700 } : undefined}>
                        {m}
                      </td>
                    )
                  })}
                  <td style={v === 'NG' ? { color: '#c0261a', fontWeight: 700 } : undefined}>{v}</td>
                  <td>{b.gauge}</td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {s.appearance.length > 0 && (
          <>
            <p className="mt-5 mb-1.5 text-[13px] font-semibold">外观检验</p>
            <table className="doc-grid">
              <thead>
                <tr>
                  <th style={{ width: 30 }}>序号</th>
                  <th style={{ width: 90 }}>检验项目</th>
                  <th>要求</th>
                  <th style={{ width: 54 }}>结果</th>
                  <th style={{ width: 120 }}>说明</th>
                </tr>
              </thead>
              <tbody>
                {s.appearance.map((a, i) => (
                  <tr key={i} style={{ breakInside: 'avoid' }}>
                    <td>{i + 1}</td>
                    <td>{a.item}</td>
                    <td style={{ textAlign: 'left' }}>{a.req}</td>
                    <td style={a.result === 'NG' ? { color: '#c0261a', fontWeight: 700 } : undefined}>
                      {a.result === 'OK' ? '合格' : a.result === 'NG' ? '不合格' : ''}
                    </td>
                    <td>{a.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <section className="mt-4 grid grid-cols-[1fr_auto] gap-6 text-[12px]" style={{ breakInside: 'avoid' }}>
          <p>
            <span className="text-[var(--color-ink-3)]">备注</span>　{s.note || '—'}
          </p>
          <p className="text-[14px]">
            结论
            <span style={{ fontWeight: 700, color: verdict === '不合格' ? '#c0261a' : undefined }}>
              {verdict || '—'}
            </span>
          </p>
        </section>
        <section className="mt-8 grid grid-cols-3 gap-6 text-[12px]" style={{ breakInside: 'avoid' }}>
          {['检验员', '审核', '批准'].map((k) => (
            <p key={k} className="flex items-end gap-2">
              <span className="shrink-0 text-[var(--color-ink-3)]">{k}</span>
              <span className="h-px flex-1 translate-y-[-3px] bg-[var(--color-ink)]" />
            </p>
          ))}
        </section>
      </article>
    </>
  )
}
