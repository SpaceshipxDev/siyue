import type { Metadata } from 'next'
import Link from 'next/link'
import { cookies } from 'next/headers'
import { stageLabel, type Stage } from '@/lib/data'
import { getPartScanView } from '@/lib/db'
import { workerToday, listWorkers } from '@/lib/packets'
import { BRAND } from '@/lib/brand'
import { scanInspect, scanSetWorker } from './_actions'
import { ReportForm } from './_report_form'
import { TallyStrip } from './_tally'
import { resolveActor } from './_worker'
import { SESSION_COOKIE } from '@/lib/session'
import { MobileNav } from '@/app/_mobile_nav'

// 车间报工 — what a worker's phone shows after scanning the traveller QR.
// One part, its route, and exactly one act: 报数量. The stage rows ARE the
// stage picker (links, so no JS needed): every open stage is a full-width
// tick-box row, the next unfinished stage arrives pre-ticked with the count
// form nested inside its row, and the second guy who is already running OP2
// while OP1's tail is open just taps his row. 检验 is the one exception: its
// row carries a verdict form (合格/重做/返修/外修 + 备注) instead of the
// count. Done stages recede to muted one-liners. Green means 完成 and
// nothing else; the tick is ink — a choice color, never a status color. The
// count arrives prefilled with everything still open at the selected stage;
// −10/−/+/+10 adjust it.
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
  // scanReport rejections land back here with ?err= — the page must SAY the
  // report didn't stick. Re-showing the same form without a word reads as
  // success, and the pieces silently never reach the board.
  const err = typeof sp.err === 'string' ? sp.err : undefined
  const errText =
    err === 'name'
      ? '这次报工没有记上 — 请在数量上方填写你的名字，再报一次。'
      : err === 'qty'
        ? '这次报工没有记上 — 数量无效，请重新输入。'
        : err
          ? '这次报工没有记上 — 请再报一次，还不行就找管理员。'
          : undefined
  // 检验 verdict just recorded — echoed back so the inspector SEES what
  // landed (合格 releases the part; a hold paints the red tag on the board).
  const judged = typeof sp.judged === 'string' ? sp.judged : undefined

  const view = await getPartScanView(token)
  const jar = await cookies()
  // Same resolution scanReport uses — the form must only render for a name
  // the action will actually accept, or reports die silently on submit.
  const worker = await resolveActor()
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
  // stages; otherwise the first unfinished stage. Rows link back here.
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
  const stageHref = (stage: Stage) =>
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
        {errText ? (
          <div className="bg-[var(--color-overdue-soft)] border border-[var(--color-overdue)] rounded-[3px] px-4 py-3">
            <p className="text-[13px] font-semibold text-[var(--color-overdue)]">
              ✕ {errText}
            </p>
          </div>
        ) : null}

        {reported !== undefined && Number.isFinite(reported) ? (
          <div className="bg-[var(--color-success-soft)] border border-[var(--color-success)] rounded-[3px] px-4 py-3">
            <p className="text-[13px] font-semibold text-[var(--color-success)]">
              ✓ 已报工 +{reported} 件，进度表已同步更新
            </p>
          </div>
        ) : null}

        {judged ? (
          <div
            className={`border rounded-[3px] px-4 py-3 ${
              judged === 'OK'
                ? 'bg-[var(--color-success-soft)] border-[var(--color-success)]'
                : 'bg-[var(--color-overdue-soft)] border-[var(--color-overdue)]'
            }`}
          >
            <p
              className={`text-[13px] font-semibold ${
                judged === 'OK'
                  ? 'text-[var(--color-success)]'
                  : 'text-[var(--color-overdue)]'
              }`}
            >
              {judged === 'OK'
                ? '✓ 检验合格，进度表已同步更新'
                : `已记录 检验 ${judged} — 零件将留在检验，处理好后可再判合格`}
            </p>
          </div>
        ) : null}

        {/* Just reported → the next act is almost always "scan the next
            sheet". Give it the biggest button, right here at the top. */}
        {(reported !== undefined && Number.isFinite(reported)) || judged === 'OK' ? (
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
            line, then the stage rows. The rows are the stage picker: done
            stages recede to muted one-liners, open stages are tick-box rows,
            and the ticked row holds the count form so the input is physically
            attached to the stage it reports against. */}
        <section className="bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-[3px] p-5">
          {view.partNo ? <p className="font-mono text-[11px] text-[var(--color-ink-3)] break-all">{view.partNo}</p> : null}
          <h1 className="text-[24px] font-semibold tracking-tight mt-0.5">
            {view.partName || view.product}
          </h1>
          <p className="text-[14px] mt-1">
            <span className="font-semibold font-mono">{view.qty}</span> 件
          </p>
          <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
            {!allDone ? (
              <h2 className="text-[14px] font-semibold">这次报哪道工序？</h2>
            ) : null}
            <div className="mt-2 space-y-1.5">
              {view.stages.map((s) => {
                if (s.status === 'done') {
                  return (
                    <div
                      key={s.stage}
                      className="flex items-center gap-2 px-1 py-0.5 text-[13px] text-[var(--color-ink-3)]"
                    >
                      <span>{stageLabel(s.stage)}</span>
                      <span className="font-medium text-[var(--color-success)]">✓ 已完成</span>
                    </div>
                  )
                }
                if (s.stage === selectedStage) {
                  return (
                    <div
                      key={s.stage}
                      className="rounded-[3px] border-2 border-[var(--color-ink)] bg-[color-mix(in_srgb,var(--color-ink)_4%,transparent)]"
                    >
                      <div className="flex items-center gap-3 h-14 px-3">
                        <span className="w-6 h-6 shrink-0 rounded-[3px] bg-[var(--color-ink)] text-[var(--color-surface)] flex items-center justify-center text-[15px] font-bold">
                          ✓
                        </span>
                        <span className="flex-1 text-[16px] font-semibold">
                          {stageLabel(s.stage)}
                        </span>
                        <span className="font-mono tabular-nums text-[12px] text-[var(--color-ink-2)]">
                          {s.doneQty}/{view.qty}
                        </span>
                      </div>
                      {s.stage !== '检验' ? (
                        <div className="px-3 pb-3 border-t border-[var(--color-border)]">
                          <p className="text-[12px] text-[var(--color-ink-2)] mt-2">
                            {s.doneQty > 0
                              ? `已完成 ${s.doneQty} 件，还剩 ${remaining} 件`
                              : `共 ${view.qty} 件`}
                          </p>
                          {/* One control: the count arrives prefilled with
                              everything still open (the default act is
                              "finished the rest"); −10/−/+/+10 or typing
                              adjusts it; one button reports. */}
                          <ReportForm
                            token={token}
                            src={src}
                            stage={s.stage}
                            stageName={stageLabel(s.stage)}
                            remaining={remaining}
                            actor={worker || undefined}
                            roster={roster}
                          />
                        </div>
                      ) : worker && s.stage === '检验' ? (
                        /* 检验 posts a verdict, not a completion: 合格 releases
                           the part, 重做/返修/外修 hold it with a red tag.
                           Four submit buttons + one 备注 input — plain form
                           POST, works with zero JS. */
                        <div className="px-3 pb-3 border-t border-[var(--color-border)]">
                          <form action={scanInspect} className="mt-3">
                            <input type="hidden" name="token" value={token} />
                            <input
                              name="note"
                              maxLength={200}
                              placeholder="备注（可选）· 不合格请写不良原因"
                              className="w-full h-12 px-3 text-[14px] border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] outline-none focus:border-[var(--color-ink)]"
                            />
                            <button
                              type="submit"
                              name="verdict"
                              value="OK"
                              className="mt-2 w-full h-14 text-[16px] font-semibold bg-[var(--color-success)] text-white rounded-[3px]"
                            >
                              ✓ 合格
                            </button>
                            <p className="text-[11px] text-[var(--color-ink-3)] mt-3 mb-1.5">
                              不合格 — 选处理方式：
                            </p>
                            <div className="grid grid-cols-3 gap-1.5">
                              {(['重做', '返修', '外修'] as const).map((v) => (
                                <button
                                  key={v}
                                  type="submit"
                                  name="verdict"
                                  value={v}
                                  className="h-12 text-[14px] font-semibold border border-[var(--color-overdue)] text-[var(--color-overdue)] bg-[var(--color-surface)] active:bg-[var(--color-overdue-soft)] rounded-[3px]"
                                >
                                  {v}
                                </button>
                              ))}
                            </div>
                          </form>
                        </div>
                      ) : null}
                    </div>
                  )
                }
                // Open, not ticked → the whole row is a link that moves the
                // report target (and its nested form) here.
                return (
                  <Link
                    key={s.stage}
                    href={stageHref(s.stage)}
                    className="flex items-center gap-3 h-14 px-3 rounded-[3px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] active:bg-[var(--color-bg)]"
                  >
                    <span className="w-6 h-6 shrink-0 rounded-[3px] border-2 border-[var(--color-border-strong)]" />
                    <span className="flex-1 text-[15px] font-medium">
                      {stageLabel(s.stage)}
                    </span>
                    <span className="font-mono tabular-nums text-[12px] text-[var(--color-ink-3)]">
                      {s.doneQty}/{view.qty}
                    </span>
                  </Link>
                )
              })}
            </div>
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
        ) : !worker && selectedStage === '检验' ? (
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
        ) : null}

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
