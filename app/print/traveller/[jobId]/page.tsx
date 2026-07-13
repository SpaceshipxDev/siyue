import { notFound } from 'next/navigation'
import { headers } from 'next/headers'
import QRCode from 'qrcode'
import { partRoute, stageLabel } from '@/lib/data'
import { ensurePartQrToken, getJob } from '@/lib/db'
import { requireOutsourceManager } from '@/lib/auth'
import { BRAND } from '@/lib/brand'
import { PrintToolbar } from '@/app/_print'
import { travellerDocNo } from './_doc'

export const dynamic = 'force-dynamic'

// 随工单 preview — one .doc article per component, mirroring the PDF. This
// page is what the clerk eyeballs before pressing 打印; the deterministic
// render lives in ./pdf/raw (same split as the 外协单).
export default async function TravellerDocPage(
  props: PageProps<'/print/traveller/[jobId]'>,
) {
  await requireOutsourceManager()
  const { jobId } = await props.params
  const job = await getJob(jobId)
  if (!job) notFound()

  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? BRAND.domain
  const proto =
    h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')

  const parts = await Promise.all(
    job.components.map(async (component, i) => {
      const token = await ensurePartQrToken(job.id, component.id)
      const scanUrl = token ? `${proto}://${host}/s/${token}` : undefined
      return {
        component,
        docNo: travellerDocNo(job, i),
        qrSvg: scanUrl
          ? await QRCode.toString(scanUrl, { type: 'svg', margin: 0 })
          : undefined,
        scanUrlShort: token ? `${host}/s/${token.slice(0, 6)}…` : undefined,
      }
    }),
  )

  return (
    <>
      <PrintToolbar pdfHref={`/print/traveller/${job.id}/pdf`} />
      {parts.map(({ component: c, docNo, qrSvg, scanUrlShort }) => {
        const route = partRoute(c)
        return (
          <article key={c.id} className="doc" style={{ pageBreakAfter: 'always' }}>
            <header className="relative border-b border-[var(--color-ink)] pb-3">
              <p className="text-center text-[12px] text-[var(--color-ink-2)] tracking-wide">
                {BRAND.legalName}
              </p>
              <h1 className="text-center text-[28px] font-semibold tracking-tight mt-1">
                随工单
              </h1>
              <p className="text-center text-[10px] text-[var(--color-ink-3)] tracking-[0.18em] uppercase mt-0.5">
                Production Traveller
              </p>
              <span className="absolute top-0 right-0 text-[11px] text-[var(--color-ink-2)]">
                {docNo}
              </span>
            </header>

            <section className="grid grid-cols-3 border border-[var(--color-ink)] mt-5">
              {(
                [
                  ['客户', job.customer],
                  ['数量', c.qty > 0 ? `${c.qty} 件` : undefined],
                  ['交期', job.dueDate],
                  ['产品名称', c.name || job.product],
                  ['材质', c.material],
                  ['表面处理', c.surfaceTreatment],
                ] as [string, string | undefined][]
              ).map(([label, value]) => (
                <div
                  key={label}
                  className="px-3 py-2.5 border-r border-b border-[var(--color-border-strong)]"
                >
                  <p className="text-[9px] tracking-[0.2em] text-[var(--color-ink-3)]">
                    {label}
                  </p>
                  <p className="text-[15px] font-semibold mt-0.5">
                    {value?.trim() || '—'}
                  </p>
                </div>
              ))}
              <div className="col-span-3 px-3 py-2.5 border-b border-[var(--color-border-strong)]">
                <p className="text-[9px] tracking-[0.2em] text-[var(--color-ink-3)]">
                  图纸号
                </p>
                <p className="text-[15px] font-semibold mt-0.5">
                  {c.partNo?.trim() || '—'}
                </p>
              </div>
            </section>

            <h2 className="text-[12px] font-semibold tracking-[0.2em] mt-6 mb-1.5">
              加工工序
            </h2>
            <table>
              <thead>
                <tr>
                  <th className="w-10">序</th>
                  <th>工序</th>
                  <th className="w-24">完成数量</th>
                  <th className="w-24">日期</th>
                  <th className="w-24">操作人</th>
                </tr>
              </thead>
              <tbody>
                {route.map((stage, i) => (
                  <tr key={stage}>
                    <td className="text-[var(--color-ink-2)]">{i + 1}</td>
                    <td className="text-[14px] font-semibold py-3">
                      {stageLabel(stage)}
                    </td>
                    <td />
                    <td />
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>

            {qrSvg ? (
              <div className="flex items-center gap-5 mt-8">
                <div
                  className="w-[96px] h-[96px] shrink-0"
                  dangerouslySetInnerHTML={{ __html: qrSvg }}
                />
                <div>
                  <p className="text-[14px] font-semibold">微信扫一扫 · 报工</p>
                  <p className="text-[11px] text-[var(--color-ink-2)] mt-1 leading-relaxed">
                    每道工序做完，用手机扫码，点「全部完成」。
                    <br />
                    只完成一部分也可以填数量。不用登录，不用装软件。
                  </p>
                  {scanUrlShort ? (
                    <p className="text-[9px] text-[var(--color-ink-3)] mt-1.5">
                      {scanUrlShort}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </article>
        )
      })}
    </>
  )
}
