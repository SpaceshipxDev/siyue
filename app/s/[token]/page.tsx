import type { Metadata } from 'next'
import Link from 'next/link'
import { cookies } from 'next/headers'
import { stageLabel, type Stage } from '@/lib/data'
import { getPartScanView } from '@/lib/db'
import { workerToday, listWorkers } from '@/lib/packets'
import { BRAND } from '@/lib/brand'
import { scanSetWorker } from './_actions'
import { ReportForm } from './_report_form'
import { TallyStrip } from './_tally'
import { WORKER_COOKIE, decodeWorker } from './_worker'
import { SESSION_COOKIE } from '@/lib/session'
import { MobileNav } from '@/app/_mobile_nav'
import { currentUser } from '@/lib/auth'

// 车间报工 — what a worker's phone shows after scanning the traveller QR.
// One part, its route, and exactly one act: 报数量. The stage chips ARE the
// stage picker (links, so no JS needed): the next unfinished stage arrives
// pre-selected, but the second guy who is already running OP2 while OP1's
// tail is open just taps his chip. The count arrives prefilled with
// everything still open at the selected stage; −10/−/+/+10 adjust it.
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

export default async function ScanPage(props: PageProps<'/s/[token]'>) {
  const { token } = await props.params
  const sp = await props.searchParams
  const reported =
    typeof sp.reported === 'string' ? Number.parseInt(sp.reported, 10) : undefined

  const view = await getPartScanView(token)
  const jar = await cookies()
  const sessionUser = await currentUser()
  const rememberedWorker = decodeWorker(jar.get(WORKER_COOKIE)?.value)
  const worker =
    sessionUser?.role === 'production' ? sessionUser.name : rememberedWorker
  const hasSession = Boolean(jar.get(SESSION_COOKIE)?.value)
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

  // Selected stage: ?stage= wins when it names one of THIS part's open
  // stages; otherwise the first unfinished stage. Chips link back here.
  const requested = typeof sp.stage === 'string' ? (sp.stage as Stage) : undefined
  const selectedStage =
    requested && view.stages.some((s) => s.stage === requested && s.status !== 'done')
      ? requested
      : view.currentStage
  const selected = selectedStage
    ? view.stages.find((s) => s.stage === selectedStage)
    : undefined
  const remaining = selected ? Math.max(0, view.qty - selected.doneQty) : 0
  const allDone = !view.currentStage
  const chipHref = (stage: Stage) =>
    `/s/${token}?stage=${encodeURIComponent(stage)}${src === 'photo' ? '&via=photo' : ''}`

  const roster = worker || allDone ? [] : await listWorkers()

  return (
    <main className="min-h-dvh bg-[var(--color-bg)] pb-20 md:pb-0">
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
            line, then the route chips. The chips are the stage picker. */}
        <section className="bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-[3px] p-5">
          {view.partNo ? <p className="font-mono text-[11px] text-[var(--color-ink-3)] break-all">{view.partNo}</p> : null}
          <h1 className="text-[24px] font-semibold tracking-tight mt-0.5">
            {view.partName || view.product}
          </h1>
          <p className="text-[14px] mt-1">
            <span className="font-semibold font-mono">{view.qty}</span> 件
          </p>
          <div className="flex items-center gap-1.5 flex-wrap mt-3 pt-3 border-t border-[var(--color-border)]">
            {view.stages.map((s) => {
              const isSelected = s.stage === selectedStage
              if (s.status === 'done') {
                return (
                  <span
                    key={s.stage}
                    className="inline-flex items-center h-9 px-3 rounded-[3px] text-[13px] font-medium bg-[var(--color-success-soft)] text-[var(--color-success)] border border-[var(--color-success)]"
                  >
                    {stageLabel(s.stage)} ✓
                  </span>
                )
              }
              if (isSelected) {
                return (
                  <span
                    key={s.stage}
                    className="inline-flex items-center h-9 px-3 rounded-[3px] text-[13px] font-semibold bg-[color-mix(in_srgb,var(--color-warning)_14%,transparent)] text-[var(--color-warning)] border-2 border-[var(--color-warning)]"
                  >
                    {stageLabel(s.stage)}
                    {s.doneQty > 0 ? ` ${s.doneQty}/${view.qty}` : ''}
                  </span>
                )
              }
              // Open, not selected → a tap moves the report target here.
              return (
                <Link
                  key={s.stage}
                  href={chipHref(s.stage)}
                  className="inline-flex items-center h-9 px-3 rounded-[3px] text-[13px] text-[var(--color-ink-2)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] active:bg-[var(--color-bg)]"
                >
                  {stageLabel(s.stage)}
                  {s.doneQty > 0 ? ` ${s.doneQty}/${view.qty}` : ''}
                </Link>
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
          /* First scan on this phone: pick your name from the roster grid —
             once. Free text stays for a new hire (lazily joins the grid). */
          <section className="bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-[3px] p-5">
            <h2 className="text-[14px] font-semibold">你是谁？</h2>
            <p className="text-[11px] text-[var(--color-ink-2)] mt-1">
              点一次自己的名字，以后扫码直接报工。
            </p>
            {roster.length > 0 ? (
              <form action={scanSetWorker} className="mt-3 grid grid-cols-3 gap-2">
                <input type="hidden" name="token" value={token} />
                {selectedStage ? (
                  <input type="hidden" name="stage" value={selectedStage} />
                ) : null}
                {roster.map((name) => (
                  <button
                    key={name}
                    type="submit"
                    name="name"
                    value={name}
                    className="h-12 px-1 text-[14px] font-medium border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] active:bg-[var(--color-bg)] truncate"
                  >
                    {name}
                  </button>
                ))}
              </form>
            ) : null}
            <form action={scanSetWorker} className="mt-3 flex gap-2">
              <input type="hidden" name="token" value={token} />
              {selectedStage ? (
                <input type="hidden" name="stage" value={selectedStage} />
              ) : null}
              <input
                name="name"
                required
                maxLength={20}
                placeholder={roster.length > 0 ? '不在上面？输入名字' : '例如：王师傅'}
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
              报工工序 · 点上面的工序可切换
            </p>
            <h2 className="text-[20px] font-semibold mt-1">
              {selectedStage ? stageLabel(selectedStage) : ''}
            </h2>
            <p className="text-[12px] text-[var(--color-ink-2)] mt-1">
              {selected && selected.doneQty > 0
                ? `已完成 ${selected.doneQty} 件，还剩 ${remaining} 件`
                : `共 ${view.qty} 件`}
            </p>

            {/* One control: the count arrives prefilled with everything still
                open (the default act is "finished the rest"); −10/−/+/+10 or
                typing adjusts it; one button reports. */}
            {selectedStage && selectedStage !== '检验' ? (
              <ReportForm
                token={token}
                src={src}
                stage={selectedStage}
                remaining={remaining}
              />
            ) : selectedStage === '检验' ? (
              <p className="mt-4 text-[12px] text-[var(--color-ink-2)]">
                检验为必经工序 · 请在检验台完成判定
              </p>
            ) : null}
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
      <MobileNav current="scan" authenticated={hasSession} />
    </main>
  )
}
