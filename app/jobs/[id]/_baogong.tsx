import type { ReportEvent } from '@/lib/packets'

// 报工 tab — the human story of the job: which workers touched it, how many
// pieces each contributed, and the full report timeline. Pure server render;
// the data is append-only history so there's nothing to mutate here.

const SH = 'Asia/Shanghai'

function fmtDay(iso: string): string {
  const d = new Date(iso)
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: SH,
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }).format(d)
}

function fmtTime(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: SH,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

export function BaogongPanel({
  events,
  partQtyById,
  partNameById,
  multiPart,
}: {
  events: ReportEvent[]
  partQtyById: Record<string, number>
  partNameById: Record<string, string>
  multiPart: boolean
}) {
  if (events.length === 0) {
    return (
      <section className="py-14 text-center">
        <p className="text-[14px] text-[var(--color-ink-3)]">
          还没有报工记录 — 工人拍照或扫码报工后会出现在这里。
        </p>
      </section>
    )
  }

  // Per-worker rollup, biggest contributor first.
  const byWorker = new Map<string, { pieces: number; reports: number; lastAt: string }>()
  for (const ev of events) {
    const cur = byWorker.get(ev.actor) ?? { pieces: 0, reports: 0, lastAt: ev.createdAt }
    cur.pieces += ev.qty
    cur.reports += 1
    if (ev.createdAt > cur.lastAt) cur.lastAt = ev.createdAt
    byWorker.set(ev.actor, cur)
  }
  const workers = [...byWorker.entries()]
    .map(([actor, v]) => ({ actor, ...v }))
    .sort((a, b) => b.pieces - a.pieces)

  // Timeline grouped by (Shanghai) day, newest day first; events arrive
  // newest-first already.
  const days: { day: string; items: ReportEvent[] }[] = []
  for (const ev of events) {
    const day = fmtDay(ev.createdAt)
    const last = days[days.length - 1]
    if (last && last.day === day) last.items.push(ev)
    else days.push({ day, items: [ev] })
  }

  return (
    <section>
      <div className="mb-6 flex flex-wrap gap-3">
        {workers.map((w) => (
          <div
            key={w.actor}
            className="flex items-center gap-3 bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-[3px] px-4 py-3"
          >
            <span className="w-9 h-9 rounded-full bg-[var(--color-ink)] text-[var(--color-surface)] flex items-center justify-center text-[13px] font-semibold shrink-0">
              {w.actor.slice(0, 1)}
            </span>
            <div>
              <p className="text-[13px] font-semibold leading-tight">{w.actor}</p>
              <p className="text-[11px] text-[var(--color-ink-2)] leading-tight mt-0.5">
                <span className="font-mono font-semibold text-[var(--color-ink)]">
                  {w.pieces}
                </span>{' '}
                件 · {w.reports} 次
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)]">
        {days.map((d, di) => (
          <div key={d.day}>
            <p
              className={`px-4 py-2 text-[11px] tracking-[0.12em] text-[var(--color-ink-3)] bg-[var(--color-bg)] ${
                di > 0 ? 'border-t border-[var(--color-border)]' : ''
              }`}
            >
              {d.day}
            </p>
            {d.items.map((ev) => {
              const total = partQtyById[ev.partId]
              return (
                <div
                  key={ev.id}
                  className="px-4 py-2.5 border-t border-[var(--color-border)] flex items-baseline gap-3"
                >
                  <span className="font-mono text-[11px] text-[var(--color-ink-3)] w-11 shrink-0">
                    {fmtTime(ev.createdAt)}
                  </span>
                  <span className="text-[13px] font-medium w-20 shrink-0 truncate">
                    {ev.actor}
                  </span>
                  <span className="text-[12px] text-[var(--color-ink-2)] w-16 shrink-0">
                    {ev.stageLabel}
                  </span>
                  <span className="text-[13px] font-mono">
                    <span className="font-semibold text-[var(--color-success)]">
                      +{ev.qty}
                    </span>
                    {total ? (
                      <span className="text-[var(--color-ink-3)]">
                        {' '}
                        → {ev.cumulative}/{total}
                      </span>
                    ) : null}
                  </span>
                  {multiPart ? (
                    <span className="text-[11px] text-[var(--color-ink-3)] truncate">
                      {partNameById[ev.partId] ?? ''}
                    </span>
                  ) : null}
                  {ev.source === 'photo' ? (
                    <span className="ml-auto text-[10px] text-[var(--color-ink-4)]">📷</span>
                  ) : null}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </section>
  )
}
