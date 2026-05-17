import Link from 'next/link'
import type { DueState, Rollup, StageState } from '@/lib/data'
import { STAGES } from '@/lib/data'
import { today } from '@/lib/today'
import type { Role } from '@/lib/auth'
import { LogoutButton } from './_logout'

export type TabKey =
  | '商务'
  | '现场'
  | '月结'
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
// floor — same shape as commerce, minus the 月结 tab (no money visibility).
function tabsForRole(role: Role, defaultStage?: string): Tab[] {
  if (role === 'production') {
    if (defaultStage === '工程') {
      // 工程 head's home tab IS bare / (their holistic master view), not
      // /station/工程 — same place but reads as "go home" in the nav.
      // Stage tabs after let them peek at any other station's workbench
      // the same way commerce can.
      return [
        { key: '工程', label: '工程', href: '/' },
        { key: '现场', label: '现场', href: '/pulse' },
        { key: '外协', label: '外协', href: '/station/outsource' },
        ...STAGES.filter((s) => s !== '工程').map((s) => ({
          key: s as TabKey,
          label: s,
          href: `/station/${encodeURIComponent(s)}`,
        })),
        { key: '退货', label: '退货', href: '/returns' },
      ]
    }
    return []
  }
  return [
    { key: '商务', label: '商务', href: '/' },
    { key: '现场', label: '现场', href: '/pulse' },
    { key: '月结', label: '月结', href: '/month' },
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
      <div className="mx-auto max-w-[1500px] px-4 md:px-10 flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-8 py-3 md:py-0 md:h-[68px]">
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
          <div className="mx-auto max-w-[1500px] px-4 md:px-10 flex items-stretch overflow-x-auto no-scrollbar">
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
}: {
  date: string
  state: DueState
  daysOff: number
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
      className={`inline-flex items-baseline gap-1.5 rounded-full border px-2.5 py-[3px] text-[10px] tracking-[0.14em] uppercase ${styles[tone]}`}
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
    return (
      <div className="flex h-full items-center justify-center text-[var(--color-ink-4)]">
        <span className="mono text-[13px]">—</span>
      </div>
    )
  }
  if (rollup.kind === 'partial') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 leading-none relative">
        <Pause size={9} className="text-[var(--color-warning)]" />
        <span className="mono text-[11px] text-[var(--color-warning)]">
          {rollup.done}/{rollup.total}
        </span>
        {outsourced > 0 && <OutsourceCorner count={outsourced} />}
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-0.5 leading-none relative">
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
  return (
    <div className="flex h-full flex-col items-center justify-center gap-0.5 leading-none">
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
