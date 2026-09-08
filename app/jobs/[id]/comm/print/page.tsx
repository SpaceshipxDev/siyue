import { notFound } from 'next/navigation'
import { getJob } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getCommSheet } from '@/lib/comm-sheet-store'
import {
  COMM_AGREED_LABEL,
  COMM_STAGES,
  COMM_TOPIC_SPECS,
  type CommPhoto,
} from '@/lib/comm-sheet'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { BRAND } from '@/lib/brand'
import { today } from '@/lib/today'
import { PrintButton } from '@/app/_print_button'

export const dynamic = 'force-dynamic'

// 工程部沟通确认单 —— 发给客户签字的那一份。
//
// 纸上的样子照着厂里原来那张 Excel 来: 抬头四格 + 一排阶段方框, 底下七项,
// 每项三行。没填的项照样印出来 (空着的格子是留给现场手写的) —— 这张纸常常
// 是带着去客户那儿边谈边补的。
export default async function CommSheetPrintPage(props: {
  params: Promise<{ id: string }>
}) {
  await requireUser()
  const { id } = await props.params
  const [job, sheet] = await Promise.all([getJob(id), getCommSheet(id)])
  if (!job) notFound()

  return (
    <>
      <PrintButton />
      <article className="doc">
        <header className="border-b border-[var(--color-ink)] pb-3">
          <p className="text-center text-[13px] tracking-wide text-[var(--color-ink)]">
            {BRAND.legalName}
          </p>
          <h1 className="mt-2 text-center text-[26px] font-semibold tracking-[0.2em]">
            工程部沟通确认单
          </h1>
        </header>

        <section className="grid grid-cols-2 gap-x-10 gap-y-3 py-5 text-[14px] font-medium">
          <Field
            label="项目名称"
            value={sheet?.projectName || job.product || job.jobNo}
          />
          <Field label="客户对接人" value={sheet?.customerContact} />
          <Field label="商务/工程对接人" value={sheet?.ourContact} />
          <Field
            label="沟通日期"
            value={
              sheet?.talkedAt ? (
                <span className="mono">{sheet.talkedAt}</span>
              ) : undefined
            }
          />
          <Field label="工号" value={<span className="mono">{job.jobNo}</span>} />
          <Field label="数量" value={<span className="mono">{job.components.length} 项零件</span>} />
        </section>

        {/* 项目当前阶段 —— 纸上那一排方框, 勾中的那个填实。 */}
        <section className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-y border-[var(--color-border)] py-3">
          <span className="label">项目当前阶段</span>
          {COMM_STAGES.map((st) => (
            <span key={st} className="flex items-baseline gap-1.5 text-[13px]">
              <span
                aria-hidden
                className={`inline-block h-[10px] w-[10px] border border-[var(--color-ink)] ${
                  sheet?.stage === st ? 'bg-[var(--color-ink)]' : ''
                }`}
              />
              {st}
            </span>
          ))}
        </section>

        <section className="py-4">
          <table className="doc-grid">
            <thead>
              <tr>
                <th style={{ width: 96 }}>沟通项</th>
                <th style={{ width: 168 }}>内容</th>
                <th>填写</th>
              </tr>
            </thead>
            <tbody>
              {COMM_TOPIC_SPECS.map((spec) => {
                const e = sheet?.items?.[spec.key]
                return (
                  <Rows
                    key={spec.key}
                    title={spec.title}
                    rows={[
                      [spec.askLabel, e?.ask],
                      [spec.oursLabel, e?.ours],
                      [COMM_AGREED_LABEL, e?.agreed],
                    ]}
                    photos={e?.photos ?? []}
                  />
                )
              })}
            </tbody>
          </table>
        </section>

        <footer className="mt-10">
          <div className="flex items-end justify-between gap-10">
            <p className="min-w-[200px] flex-1">
              <span className="label mr-3">我方确认 (签章)</span>
              <span className="mt-10 block h-px w-full bg-[var(--color-ink)]" />
            </p>
            <p className="min-w-[200px] flex-1">
              <span className="label mr-3">客户确认 (签章)</span>
              <span className="mt-10 block h-px w-full bg-[var(--color-ink)]" />
            </p>
          </div>
          <p className="mt-6 flex items-baseline justify-between text-[11px]">
            <span className="flex items-baseline gap-1.5">
              <span className="tracking-[0.1em] text-[var(--color-ink-3)]">
                {BRAND.software}
              </span>
              <span className="text-[var(--color-ink-4)]">·</span>
              <span className="text-[var(--color-ink-2)]">{BRAND.domain}</span>
            </span>
            <span className="mono text-[var(--color-ink-3)]">打印 {today()}</span>
          </p>
        </footer>
      </article>
    </>
  )
}

// 一项三行 (贴了图就是四行) —— 第一格把「沟通项」竖着并起来, 和纸上的合并单
// 元格一样。图跟着这一项印在最后一行: 客户签的是"图上这个样子", 比签一段文
// 字牢靠。
function Rows({
  title,
  rows,
  photos,
}: {
  title: string
  rows: [string, string | undefined][]
  photos: CommPhoto[]
}) {
  const span = rows.length + (photos.length > 0 ? 1 : 0)
  return (
    <>
      {rows.map(([label, value], i) => (
        <tr key={label}>
          {i === 0 && (
            <td
              rowSpan={span}
              className="font-medium"
              style={{ verticalAlign: 'middle' }}
            >
              {title}
            </td>
          )}
          <td className="text-[var(--color-ink-2)]" style={{ textAlign: 'left' }}>
            {label}
          </td>
          <td
            className="whitespace-pre-wrap"
            style={{ textAlign: 'left', minHeight: 34 }}
          >
            {value?.trim() || ' '}
          </td>
        </tr>
      ))}
      {photos.length > 0 && (
        <tr>
          <td className="text-[var(--color-ink-2)]" style={{ textAlign: 'left' }}>
            图示
          </td>
          <td style={{ textAlign: 'left' }}>
            <span className="flex flex-wrap gap-2">
              {photos.map((p) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={p.id}
                  src={proxiedStorageUrl(p.url)}
                  alt={p.filename}
                  className="doc-thumb"
                  style={{ width: 108, height: 108, objectFit: 'contain' }}
                />
              ))}
            </span>
          </td>
        </tr>
      )}
    </>
  )
}

function Field({
  label,
  value,
}: {
  label: string
  value?: React.ReactNode
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="label shrink-0">{label}</span>
      <span className="min-w-0 flex-1 border-b border-[var(--color-border-strong)] pb-0.5">
        {value || ' '}
      </span>
    </div>
  )
}
