import Link from 'next/link'
import { daysFromToday, dueState } from '@/lib/data'

// 今日重点 strip — the boss's daily must-do list, mirrored onto the master
// dashboard AND every station view. Deliberately the SAME component (same
// rows, same order, same notes) everywhere: the boss and the welder are
// looking at the literal same list, so "today's priorities" never needs a
// WeChat blast to synchronize. Curation happens on /daily; this is the
// broadcast surface — read-only by design.
//
// Renders nothing when the day has no list: zero chrome on a normal day.

export type FocusStripRow = {
  id: string
  /** Job link target; undefined for free-text rows (rendered unlinked). */
  jobId?: string
  jobNo: string
  product?: string
  /** 交期 display text — the linked job's effectiveDueDate, or the board's
   * free-text override (which may be prose like "月底前"). Due-state tones
   * apply only when it parses as YYYY-MM-DD. */
  dueDate?: string
  feedback?: string
  isShipped?: boolean
}

export function DailyFocusStrip({
  rows,
  dayLabel,
  canManage,
}: {
  rows: FocusStripRow[]
  /** e.g. "6月4日" — rendered beside the 今日重点 label. */
  dayLabel: string
  /** Pulse viewers (商务 / 工程 head) get the 管理 link into /daily. */
  canManage: boolean
}) {
  if (rows.length === 0) return null
  const doneCount = rows.reduce((n, r) => (r.isShipped ? n + 1 : n), 0)
  return (
    <section
      aria-label="今日重点"
      className="mb-8 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <div className="flex items-baseline gap-3 border-b border-[var(--color-border)] px-4 py-2.5">
        {/* Warm accent square — the one bit of color, marks this band as the
            boss's list without shouting. */}
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 translate-y-[-1px] rounded-[2px] bg-[var(--color-warning)]"
        />
        <span className="label text-[var(--color-ink)]">今日重点</span>
        <span className="mono text-[11px] text-[var(--color-ink-4)]">
          {dayLabel} · {rows.length}
        </span>
        {doneCount > 0 && (
          <span className="mono text-[11px] text-[var(--color-ink-4)]">
            已出货 {doneCount}/{rows.length}
          </span>
        )}
        {canManage && (
          <Link
            href="/daily"
            className="ml-auto label text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
          >
            管理 →
          </Link>
        )}
      </div>
      <ul>
        {rows.map((r, i) => {
          const isIsoDate = r.dueDate ? /^\d{4}-\d{2}-\d{2}$/.test(r.dueDate) : false
          const ds = r.dueDate && isIsoDate ? dueState(r.dueDate) : undefined
          const dueTone =
            ds === 'overdue'
              ? 'text-[var(--color-overdue)]'
              : ds === 'today' || ds === 'soon'
                ? 'text-[var(--color-warning)]'
                : 'text-[var(--color-ink-2)]'
          const dueText = r.dueDate
            ? !isIsoDate
              ? r.dueDate // free-text 交期 ("月底前") renders verbatim
              : ds === 'overdue'
                ? `${r.dueDate.slice(5)} · 逾期 ${Math.abs(daysFromToday(r.dueDate))} 天`
                : ds === 'today'
                  ? `${r.dueDate.slice(5)} · 今日`
                  : r.dueDate.slice(5)
            : undefined
          const inner = (
            <>
              <span className="mono w-7 shrink-0 text-center text-[11px] text-[var(--color-ink-4)]">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span
                className={`mono shrink-0 text-[13px] font-medium ${
                  r.isShipped
                    ? 'text-[var(--color-ink-3)] line-through decoration-[var(--color-ink-4)]'
                    : 'text-[var(--color-ink)]'
                }`}
              >
                {r.jobNo}
              </span>
              {r.product && (
                <span className="hidden md:inline shrink-0 max-w-[220px] truncate text-[12px] text-[var(--color-ink-3)]">
                  {r.product}
                </span>
              )}
              {dueText && (
                <span
                  className={`mono shrink-0 text-[11px] whitespace-nowrap ${dueTone}`}
                >
                  {dueText}
                </span>
              )}
              {r.feedback && (
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-ink-2)]">
                  {r.feedback}
                </span>
              )}
              {r.isShipped && (
                <span className="row-badge ml-auto" data-tone="neutral">
                  已出货
                </span>
              )}
            </>
          )
          const rowCls =
            'flex items-baseline gap-3 px-4 py-2 border-b border-[var(--color-border)] last:border-b-0'
          // Curators (商务 / 工程 head) click THROUGH the panel, not straight
          // at the job: the row opens /daily scrolled to and pulsing this same
          // 重点, and they drill into the 工单 from there. The floor can't open
          // /daily (it redirects them), so their rows keep the direct job link.
          const href = canManage
            ? `/daily#focus-${r.id}`
            : r.jobId
              ? `/jobs/${r.jobId}`
              : undefined
          return (
            <li key={r.id}>
              {href ? (
                <Link
                  href={href}
                  className={`${rowCls} transition-colors hover:bg-[#f1eee4]`}
                >
                  {inner}
                </Link>
              ) : (
                <div className={rowCls}>{inner}</div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
