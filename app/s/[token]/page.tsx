import type { Metadata } from 'next'
import Link from 'next/link'
import { cookies } from 'next/headers'
import { stageLabel } from '@/lib/data'
import { getPartScanView } from '@/lib/db'
import { workerToday } from '@/lib/packets'
import { BRAND } from '@/lib/brand'
import { scanSetWorker } from './_actions'
import { ReportForm } from './_report_form'
import { TallyStrip } from './_tally'
import { WORKER_COOKIE, decodeWorker } from './_worker'

// 车间报工 — what a worker's phone shows after scanning the traveller QR.
// One part, its route, the current OP, and exactly one act: 报数量. The
// default tap is 全部完成 (finish the remaining count at this OP) because
// that's what happens 9 times out of 10 on the floor; a partial count is the
// secondary path, never the primary.
//
// Server-rendered, plain <form> POSTs — must work in decade-old WeChat
// webviews, JS or no JS. The token in the URL is the auth; the page and
// every action re-verify it server-side.

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>
}): Promise<Metadata> {
  const { token } = await params
  const view = await getPartScanView(token).catch(() => undefined)
  const title = view
    ? `${view.partName || view.product} · 报工`
    : `车间报工 · ${BRAND.shortName}`
  return { title, description: '扫码报工 — 这道工序完成多少件' }
}

function mdCn(ymd?: string): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return ymd ?? ''
  const [, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return `${m}月${d}日`
}

export default async function ScanPage(props: PageProps<'/s/[token]'>) {
  const { token } = await props.params
  const sp = await props.searchParams
  const reported =
    typeof sp.reported === 'string' ? Number.parseInt(sp.reported, 10) : undefined

  const view = await getPartScanView(token)
  const jar = await cookies()
  const worker = decodeWorker(jar.get(WORKER_COOKIE)?.value)
  const src = sp.via === 'photo' ? 'photo' : 'scan'
  const tally = worker ? await workerToday(worker) : undefined

  if (!view) {
    return (
      <main className="min-h-dvh bg-[var(--color-bg)] flex items-center justify-center p-6">
        <div className="max-w-sm w-full bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-[3px] p-8 text-center">
          <p className="text-[15px] font-semibold">二维码无效</p>
          <p className="text-[12px] text-[var(--color-ink-2)] mt-2 leading-relaxed">
            这张随工单的二维码没有对应的零件。
            <br />
            请找文员重新打印随工单。
          </p>
        </div>
      </main>
    )
  }

  const current = view.currentStage
    ? view.stages.find((s) => s.stage === view.currentStage)
    : undefined
  const remaining = current ? Math.max(0, view.qty - current.doneQty) : 0
  const allDone = !view.currentStage

  return (
    <main className="min-h-dvh bg-[var(--color-bg)]">
      <header className="h-12 px-4 bg-[var(--color-surface)] border-b border-[var(--color-border)] flex items-center justify-between">
        <span className="text-[13px] font-semibold">
          {BRAND.shortName} · 车间报工
        </span>
        {worker ? (
          <span className="text-[11px] text-[var(--color-ink-2)]">{worker}</span>
        ) : null}
      </header>

      <div className="max-w-md mx-auto px-4 py-5 space-y-4">
        {reported !== undefined && Number.isFinite(reported) ? (
          <div className="bg-[var(--color-success-soft)] border border-[var(--color-success)] rounded-[3px] px-4 py-3">
            <p className="text-[13px] font-semibold text-[var(--color-success)]">
              ✓ 已报工 +{reported} 件，进度表已同步更新
            </p>
          </div>
        ) : null}

        {/* Just reported → the next act is almost always "scan the next
            sheet". Give it the biggest button, right here at the top. */}
        {reported !== undefined && Number.isFinite(reported) ? (
          <Link
            href="/p"
            className="w-full h-16 text-[17px] font-semibold bg-[var(--color-ink)] text-[var(--color-surface)] rounded-[3px] flex items-center justify-center"
          >
            📷 拍照报下一单
          </Link>
        ) : null}

        {worker && tally && (tally.pieces > 0 || reported !== undefined) ? (
          <TallyStrip
            pieces={tally.pieces}
            reports={tally.reports}
            justAdded={reported}
          />
        ) : null}

        {/* The part — one tight block: who/what on top, one inline facts
            line, then the route chips. No label/value grid to decode. */}
        <section className="bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-[3px] p-5">
          <p className="text-[11px] text-[var(--color-ink-3)]">
            {view.customer}
            {view.partNo ? (
              <span className="font-mono ml-2 break-all">{view.partNo}</span>
            ) : null}
          </p>
          <h1 className="text-[24px] font-semibold tracking-tight mt-0.5">
            {view.partName || view.product}
          </h1>
          <p className="text-[14px] mt-1">
            <span className="font-semibold font-mono">{view.qty}</span> 件
            {view.material ? <span className="text-[var(--color-ink-2)]"> · {view.material}</span> : null}
            {view.dueDate ? <span className="text-[var(--color-ink-2)]"> · 交期 {mdCn(view.dueDate)}</span> : null}
          </p>
          <div className="flex items-center gap-1.5 flex-wrap mt-3 pt-3 border-t border-[var(--color-border)]">
            {view.stages.map((s) => {
              const isCurrent = s.stage === view.currentStage
              if (s.status === 'done') {
                return (
                  <span
                    key={s.stage}
                    className="inline-flex items-center h-7 px-2.5 rounded-[3px] text-[12px] font-medium bg-[var(--color-success-soft)] text-[var(--color-success)] border border-[var(--color-success)]"
                  >
                    {stageLabel(s.stage)} ✓
                  </span>
                )
              }
              if (isCurrent) {
                return (
                  <span
                    key={s.stage}
                    className="inline-flex items-center h-7 px-2.5 rounded-[3px] text-[12px] font-semibold bg-[color-mix(in_srgb,var(--color-warning)_14%,transparent)] text-[var(--color-warning)] border border-[var(--color-warning)]"
                  >
                    {stageLabel(s.stage)}
                    {s.doneQty > 0 ? ` ${s.doneQty}/${view.qty}` : ''}
                  </span>
                )
              }
              return (
                <span
                  key={s.stage}
                  className="inline-flex items-center h-7 px-2.5 rounded-[3px] text-[12px] text-[var(--color-ink-3)] border border-[var(--color-border)]"
                >
                  {stageLabel(s.stage)}
                </span>
              )
            })}
          </div>
        </section>

        {allDone ? (
          <section className="bg-[var(--color-success-soft)] border border-[var(--color-success)] rounded-[3px] p-6 text-center">
            <p className="text-[16px] font-semibold text-[var(--color-success)]">
              全部工序已完成
            </p>
            <p className="text-[12px] text-[var(--color-ink-2)] mt-1">
              这个零件的加工已经全部做完，等待出货。
            </p>
          </section>
        ) : !worker ? (
          /* First scan on this phone: one name, once, then never again. */
          <section className="bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-[3px] p-5">
            <h2 className="text-[14px] font-semibold">你是谁？</h2>
            <p className="text-[11px] text-[var(--color-ink-2)] mt-1">
              只填一次，以后扫码直接报工。
            </p>
            <form action={scanSetWorker} className="mt-3 flex gap-2">
              <input type="hidden" name="token" value={token} />
              <input
                name="name"
                required
                maxLength={20}
                placeholder="例如：王师傅"
                className="flex-1 h-12 px-3 text-[15px] border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] outline-none focus:border-[var(--color-ink)]"
              />
              <button
                type="submit"
                className="h-12 px-5 text-[14px] font-semibold bg-[var(--color-ink)] text-[var(--color-surface)] rounded-[3px]"
              >
                确定
              </button>
            </form>
          </section>
        ) : (
          <section className="bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-[3px] p-5">
            <p className="text-[10px] tracking-[0.18em] text-[var(--color-ink-3)] uppercase">
              当前工序
            </p>
            <h2 className="text-[20px] font-semibold mt-1">
              {view.currentStage ? stageLabel(view.currentStage) : ''}
            </h2>
            <p className="text-[12px] text-[var(--color-ink-2)] mt-1">
              {current && current.doneQty > 0
                ? `已完成 ${current.doneQty} 件，还剩 ${remaining} 件`
                : `共 ${view.qty} 件`}
            </p>

            {/* One control: the count arrives prefilled with everything still
                open (the default act is "finished the rest"); −/+ or typing
                adjusts it; one button reports. */}
            <ReportForm token={token} src={src} remaining={remaining} />
          </section>
        )}

        {reported === undefined ? (
          <Link
            href="/p"
            className="w-full h-12 text-[14px] font-medium border border-[var(--color-border-strong)] text-[var(--color-ink)] rounded-[3px] bg-[var(--color-surface)] flex items-center justify-center"
          >
            📷 拍照报下一单
          </Link>
        ) : null}

        <p className="text-center text-[10px] text-[var(--color-ink-4)] pt-2 pb-6">
          {BRAND.software} · {BRAND.domain}
        </p>
      </div>
    </main>
  )
}
