import Link from 'next/link'
import type { DueState, Rollup, StageState } from '@/lib/data'
import { STAGES, formatCny } from '@/lib/data'
import { today } from '@/lib/today'
import type { Role } from '@/lib/auth'
import type { OrderMoneyStatus } from '@/lib/order-money'
import { LogoutButton } from './_logout'

export type TabKey =
  | '商务'
  | '笔记'
  | '重点'
  | '现场'
  | '交接'
  | '采购'
  | '报工'
  | '财务'
  | '工单'
  | (typeof STAGES)[number]
  | '外协'
  | '退货'

type Tab = { key: TabKey; label: string; href: string }

// Admin/commerce gets the full per-stage nav. Production stations on the
// floor get NO tab nav — the StationSummary on the body carries the weight
// and the brand link top-left routes home. Less chrome on the floor, more
// headroom for the numbers that matter.
//
// 工程 head (PMC in shop terms) runs the boss-style holistic nav: drills
// into 外协, /退货, and every station to see what's happening across the
// floor — same shape as commerce (no money visibility).
function tabsForRole(role: Role, defaultStage?: string): Tab[] {
  if (role === 'production') {
    if (defaultStage === '工程') {
      // 工程 head's home tab IS bare / (their holistic master view), not
      // /station/工程 — same place but reads as "go home" in the nav.
      // Stage tabs after let them peek at any other station's workbench
      // the same way commerce can.
      return [
        { key: '工程', label: '工程', href: '/' },
        { key: '重点', label: '重点', href: '/daily' },
        { key: '现场', label: '现场', href: '/pulse' },
        { key: '交接', label: '交接', href: '/handover' },
        { key: '采购', label: '采购', href: '/procurement' },
        // 报工 deliberately omitted — the per-person merit scoreboard is a 商务
        // read only; 工程 head doesn't see it (gate: requireReportViewer).
        { key: '外协', label: '外协', href: '/station/outsource' },
        ...STAGES.filter((s) => s !== '工程').map((s) => ({
          key: s as TabKey,
          label: s,
          href: `/station/${encodeURIComponent(s)}`,
        })),
        { key: '退货', label: '退货', href: '/returns' },
      ]
    }
    // Pure-floor stations (焊接, 喷塑, 打磨, …) otherwise carry no tab nav —
    // the StationSummary on the body does the work. They still get the one
    // 采购 tab: the boss's rule is everyone on the floor buys things and must
    // be able to log/see what's on the way, regardless of station.
    return [{ key: '采购', label: '采购', href: '/procurement' }]
  }
  return [
    { key: '商务', label: '商务', href: '/' },
    // 笔记 — the boss's private scratchpad, right before 重点. Per-author, so
    // each 商务 user only ever sees their own notes (it reads as "his").
    { key: '笔记', label: '笔记', href: '/notes' },
    { key: '重点', label: '重点', href: '/daily' },
    { key: '现场', label: '现场', href: '/pulse' },
    { key: '交接', label: '交接', href: '/handover' },
    { key: '采购', label: '采购', href: '/procurement' },
    { key: '报工', label: '报工', href: '/report' },
    { key: '财务', label: '财务', href: '/finance' },
    { key: '外协', label: '外协', href: '/station/outsource' },
    ...STAGES.map((s) => ({
      key: s as TabKey,
      label: s,
      href: `/station/${encodeURIComponent(s)}`,
    })),
    { key: '退货', label: '退货', href: '/returns' },
  ]
}

export function TopBar({
  title,
  subtitle,
  currentTab,
  right,
  role,
  defaultStage,
  userName,
}: {
  title: string
  subtitle?: string
  /** Undefined when the bar carries no tab nav (production users). */
  currentTab?: TabKey
  right?: React.ReactNode
  role: Role
  defaultStage?: string
  userName: string
}) {
  const tabs = tabsForRole(role, defaultStage)
  const isCommerce = role === 'commerce'
  // 工程 head's "home" is the holistic master view at bare / (same as
   // commerce). Other production stations land on their station-filtered
   // master grid via ?stage=<their-stage>.
  const homeHref = isCommerce
    ? '/'
    : defaultStage && defaultStage !== '工程'
      ? `/?stage=${encodeURIComponent(defaultStage)}`
      : '/'
  return (
    <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="px-4 md:px-10 flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-8 py-3 md:py-0 md:h-[68px]">
        <div className="flex items-baseline gap-3 md:gap-6 flex-wrap">
          <Link
            href={homeHref}
            className="label tracking-[0.22em] text-[var(--color-ink)] hover:opacity-60"
          >
            思跃
          </Link>
          <h1 className="text-[14px] md:text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
            {title}
          </h1>
          {subtitle && (
            <span className="text-[11px] md:text-[12px] text-[var(--color-ink-3)]">
              {subtitle}
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-3 md:gap-8 text-[var(--color-ink-2)] flex-wrap">
          {right}
          <span className="label mono text-[var(--color-ink)]">{userName}</span>
          <LogoutButton name={userName} />
          <span className="label">今日 · {today()}</span>
        </div>
      </div>
      {tabs.length > 0 && (
        <nav className="border-t border-[var(--color-border)] bg-[var(--color-bg)]">
          <div className="px-4 md:px-10 flex items-stretch overflow-x-auto no-scrollbar">
            {tabs.map((tab) => {
              const active = tab.key === currentTab
              return (
                <Link
                  key={tab.key}
                  href={tab.href}
                  data-text={tab.label}
                  className={`tab-link relative shrink-0 px-3 md:px-5 py-3 text-[13px] tracking-wider transition-colors ${
                    active
                      ? 'text-[var(--color-ink)] font-semibold bg-[var(--color-surface)]'
                      : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
                  }`}
                  aria-current={active ? 'page' : undefined}
                >
                  {tab.label}
                  {active && (
                    <span className="absolute inset-x-0 -bottom-px h-[2px] bg-[var(--color-ink)]" />
                  )}
                </Link>
              )
            })}
          </div>
        </nav>
      )}
    </header>
  )
}

export function DueCell({
  date,
  state,
  daysOff,
  secondaryDate,
}: {
  date: string
  state: DueState
  daysOff: number
  // 二次交期 — rendered as a muted second line under the primary 交期 when
  // present. Display-only: it carries no urgency tone (the primary date owns
  // color/sort), so it stays ink-3 regardless of how far off it is.
  secondaryDate?: string
}) {
  const tone =
    state === 'overdue'
      ? 'text-[var(--color-overdue)]'
      : state === 'today'
        ? 'text-[var(--color-warning)]'
        : state === 'soon'
          ? 'text-[var(--color-warning)]'
          : 'text-[var(--color-ink)]'
  const sub =
    state === 'overdue'
      ? `逾期 ${Math.abs(daysOff)} 天`
      : state === 'today'
        ? '今日'
        : state === 'soon'
          ? `${daysOff} 天后`
          : `${daysOff} 天后`
  return (
    <div className="flex flex-col leading-tight">
      <span className={`mono text-[13px] whitespace-nowrap ${tone}`}>
        {date}
      </span>
      <span className="label mt-0.5 whitespace-nowrap">{sub}</span>
      {secondaryDate && (
        <span
          className="mono text-[11px] whitespace-nowrap text-[var(--color-ink-3)] mt-0.5"
          title="二次交期"
        >
          二次 {secondaryDate}
        </span>
      )}
    </div>
  )
}

export type PillTone =
  | 'overdue'
  | 'warning'
  | 'success'
  | 'neutral'
  | 'info'

export function Pill({
  tone,
  label,
  value,
}: {
  tone: PillTone
  label: string
  value: number | string
}) {
  const styles: Record<PillTone, string> = {
    overdue:
      'bg-[var(--color-overdue-soft)] text-[var(--color-overdue)] border-[var(--color-overdue)]/25',
    warning:
      'bg-[var(--color-warning-soft)] text-[var(--color-warning)] border-[var(--color-warning)]/25',
    success:
      'bg-[var(--color-success-soft)] text-[var(--color-success)] border-[var(--color-success)]/25',
    neutral:
      'bg-[var(--color-surface)] text-[var(--color-ink)] border-[var(--color-border-strong)]',
    info: 'bg-[var(--color-bg)] text-[var(--color-ink-2)] border-[var(--color-border)]',
  }
  return (
    <span
      className={`inline-flex items-baseline gap-1.5 rounded-[2px] border px-2.5 py-[3px] text-[10px] tracking-[0.14em] uppercase ${styles[tone]}`}
    >
      <span>{label}</span>
      <span className="mono text-[12px] tracking-normal font-medium">
        {value}
      </span>
    </span>
  )
}

export function StageHeader({ name }: { name: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-0.5">
      <span className="text-[12px] font-medium tracking-wider text-[var(--color-ink)]">
        {name}
      </span>
    </div>
  )
}

export function RollupCell({ rollup }: { rollup: Rollup }) {
  // No part in this job needs the stage. Render a diagonal slash across the
  // cell — visually unmistakable as "crossed out / not applicable", and
  // distinct from the en-dash that means "not started yet."
  if (rollup.kind === 'na') {
    return (
      <div
        className="relative h-full w-full"
        aria-label="该工段不适用"
      >
        <svg
          className="absolute inset-0 h-full w-full"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line
            x1="0%"
            y1="100%"
            x2="100%"
            y2="0%"
            stroke="var(--color-ink-4)"
            strokeWidth="1"
            shapeRendering="crispEdges"
          />
        </svg>
      </div>
    )
  }
  const outsourced = rollup.outsourcedOpen ?? 0
  // 全部送外协 (open) — vendor owns this stage entirely. Surface 外协 in
  // place of the green ✓ so the boss instantly sees the work is offsite,
  // not actually finished in-house.
  if (rollup.kind === 'done' && outsourced > 0 && outsourced === rollup.total) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-0.5 leading-none">
        <span className="text-[11px] tracking-wider font-semibold text-[var(--color-info)]">
          外协
        </span>
        <span className="mono text-[10px] text-[var(--color-ink-3)]">
          {outsourced} 件
        </span>
      </div>
    )
  }
  if (rollup.kind === 'pending') {
    // Nothing has happened at this stage yet — render a lowkey centered '—'
    // (faintest ink) so the cell reads as "in this job's route, not started"
    // rather than blank-and-ambiguous. Distinct from the diagonal-slash 'na'
    // cell above, which means the stage isn't in this job's route at all.
    return (
      <div className="flex h-full items-center justify-center text-[var(--color-ink-4)]">
        <span className="mono text-[13px]">—</span>
      </div>
    )
  }
  if (rollup.kind === 'partial') {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-1 leading-none relative"
        title={rollupByHint(rollup)}
      >
        <Pause size={9} className="text-[var(--color-warning)]" />
        <span className="mono text-[11px] text-[var(--color-warning)]">
          {rollup.done}/{rollup.total}
        </span>
        {outsourced > 0 && <OutsourceCorner count={outsourced} />}
      </div>
    )
  }
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-0.5 leading-none relative"
      title={rollupByHint(rollup)}
    >
      <span className="text-[16px] leading-none font-semibold text-[var(--color-success)]">
        ✓
      </span>
      {rollup.latestDate && (
        <span className="mono text-[10px] text-[var(--color-ink-3)]">
          {rollup.latestDate}
        </span>
      )}
      {outsourced > 0 && <OutsourceCorner count={outsourced} />}
    </div>
  )
}

// 收款 — the order's money light, the read-only twin of RollupCell. One glance
// answers "发了货、钱收了没有、有没有拖":
//   在产 (not shipped)  → blank, no money due yet, no noise
//   待开票 (uninvoiced)  → 出货了没开票 = a leak; amber label, no ¥ (nothing billed)
//   待回款 (unpaid)      → invoiced, waiting; warning label + 应收 ¥
//   逾期 (overdue)       → red wash + 应收 ¥ + 拖了 N 天 — the boss chases this
//   已结清 (settled)     → green ✓, fades to the bottom
// The boss scans this column for red. He reads it; he never operates it (entry
// stays in the 应收 ledger).
export function MoneyCell({
  status,
  outstandingCny,
  overdueDays,
}: {
  status?: OrderMoneyStatus
  outstandingCny?: number
  overdueDays?: number
}) {
  // 在产 / unknown → blank. 80% of the board is mid-production; an empty cell
  // here is the whole point (no money due yet ⇒ no noise).
  if (!status || status === 'in_production') {
    return <div className="h-full w-full" aria-hidden="true" />
  }
  if (status === 'settled') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-0.5 leading-none">
        <span className="text-[15px] leading-none font-semibold text-[var(--color-success)]">
          ✓
        </span>
        <span className="mono text-[10px] text-[var(--color-ink-3)]">已结清</span>
      </div>
    )
  }
  if (status === 'uninvoiced') {
    // Shipped, not invoiced — you can't collect without a 发票. The leak flag.
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-0.5 leading-none"
        title="已出货 · 尚未开票"
      >
        <span className="text-[12px] font-medium text-[var(--color-info)]">待开票</span>
      </div>
    )
  }
  const owed = outstandingCny ? formatCny(outstandingCny) : ''
  if (status === 'overdue') {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-0.5 leading-none bg-[var(--color-overdue-soft)]"
        title={`逾期未回款${overdueDays ? ` · 已拖 ${overdueDays} 天` : ''}`}
      >
        <span className="text-[12px] font-semibold text-[var(--color-overdue)]">
          逾期{overdueDays ? ` ${overdueDays}天` : ''}
        </span>
        {owed && (
          <span className="mono text-[11px] text-[var(--color-overdue)]">{owed}</span>
        )}
      </div>
    )
  }
  // unpaid — invoiced, within term, still owed.
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-0.5 leading-none"
      title="已开票 · 待回款"
    >
      <span className="text-[12px] font-medium text-[var(--color-warning)]">待回款</span>
      {owed && (
        <span className="mono text-[11px] text-[var(--color-ink-3)]">{owed}</span>
      )}
    </div>
  )
}

// 报工 hover hint for an aggregate master-grid cell: who most recently clicked
// ✓ here (经手), plus the date. Returns undefined when no in-house finisher is
// known — so the cell stays bare rather than showing an empty tooltip.
function rollupByHint(rollup: Rollup): string | undefined {
  if (!rollup.latestBy) return undefined
  return `最近经手 ${rollup.latestBy}${rollup.latestDate ? ` · ${rollup.latestDate}` : ''}`
}

// Small "外" pip in the top-right of a stage cell when *some* parts at this
// stage are at a vendor. Used in 'partial' (some in-house, some outsourced)
// and 'done' (all in-house finished, but some still being outsourced) — the
// pure-outsource case takes over the whole cell instead.
function OutsourceCorner({ count }: { count: number }) {
  return (
    <span
      className="absolute top-0.5 right-0.5 mono text-[9px] tracking-wider text-[var(--color-info)] font-semibold leading-none"
      title={`此工段 ${count} 件外协中`}
      aria-label={`${count} 件外协中`}
    >
      外{count}
    </span>
  )
}

export function Pause({
  size = 12,
  className = '',
}: {
  size?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <rect x="2.5" y="2" width="2.25" height="8" />
      <rect x="7.25" y="2" width="2.25" height="8" />
    </svg>
  )
}

// Clock face with a fading sweep — the "time is passing" symbol on each
// station-view row. No CSS animation: we re-render the parent every minute
// instead, so the icon stays stable while the elapsed string ticks. (This
// keeps GPU cost flat across hundreds of rows.)
export function ClockFading({
  size = 14,
  className = '',
}: {
  size?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.4 L8 8 L10.6 9.4" />
      <path d="M8 1.6 L8 2.6" opacity="0.35" />
      <path d="M14.4 8 L13.4 8" opacity="0.35" />
    </svg>
  )
}

export function StageCell({
  state,
  qty,
}: {
  state: StageState
  /** When provided, surfaces partial-progress as "N/qty" under the pause
   * icon during in_progress. Read-only twin of the editable cell — gives
   * commerce/other-station viewers the same one-glance read of "did 3 of 5"
   * without needing to open the detail page. */
  qty?: number
}) {
  if (state.status === 'pending') {
    return (
      <div className="flex h-full items-center justify-center text-[var(--color-ink-4)]">
        <span className="mono text-[13px]">—</span>
      </div>
    )
  }
  if (state.status === 'in_progress') {
    const showFraction =
      typeof qty === 'number' && qty > 1 && (state.doneQty ?? 0) >= 0
    return (
      <div className="flex h-full flex-col items-center justify-center gap-0.5 leading-none">
        <Pause size={10} className="text-[var(--color-warning)]" />
        {showFraction ? (
          <span className="mono text-[10px] text-[var(--color-warning)]/80">
            {state.doneQty ?? 0}/{qty}
          </span>
        ) : null}
      </div>
    )
  }
  // 报工 attribution: surface 经手人 on hover for the read-only twin too.
  // The grid stays a bare ✓+date at rest; the name only appears on the
  // native tooltip so the dense view never gains a column.
  const attribution = state.by
    ? `经手 ${state.by}${stageTimeHint(state.finishedAt)}`
    : undefined
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-0.5 leading-none"
      title={attribution}
      aria-label={attribution}
    >
      <span className="text-[16px] leading-none font-semibold text-[var(--color-success)]">
        ✓
      </span>
      {state.completedAt && (
        <span className="mono text-[10px] text-[var(--color-ink-3)]">
          {state.completedAt}
        </span>
      )}
    </div>
  )
}

// " · HH:MM" in factory-local time for a finish-event ISO timestamp, or '' if
// absent. Deterministic given the ISO string (fixed Asia/Shanghai zone), so
// SSR and client agree. Shared by the read-only StageCell tooltip and the
// editable cell's hover popover.
export function stageTimeHint(finishedAt?: string): string {
  if (!finishedAt) return ''
  const d = new Date(finishedAt)
  if (Number.isNaN(d.getTime())) return ''
  const t = d.toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
  })
  return ` · ${t}`
}
