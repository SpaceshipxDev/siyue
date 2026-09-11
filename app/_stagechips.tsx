'use client'

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import {
  DEFAULT_ROUTE_STAGES,
  OPT_IN_STAGES,
  STAGES,
  isStageUntouched,
  partRoute,
  routeAfterEnabling,
  type Component,
  type Stage,
} from '@/lib/data'
import { mutate } from '@/lib/mutate'
import { showToast } from './_toast'
import type { SetPartRouteResult } from '@/lib/db'

// 出货 也是一道可以关掉的工序: 加刀、电极这种后加的分支件是厂里自己留着用的,
// 不发给客户 —— 硬把出货挂在它头上, 它就永远停在最后一格, 整张工单看着没做完。
// 关得掉只在它还什么都没发生之前: 已经发过货 (出货那一格开始过, 或者这个零件
// 上过某张出货单) 就锁死, 显示"已出货"。外协覆盖的工段照旧锁着 —— 那几道归那
// 张外协单管, 选择器动不了。

type ConflictDialogState = {
  desired: Stage[]
  removing: { stage: Stage; status: 'in_progress' | 'done' }[]
}

// Collapsed-by-default route widget. The cell shows one line — the route the
// part actually takes, stages joined by arrows — instead of ten wrapping
// toggle chips. Clicking expands an anchored picker (portal + fixed, so the
// overflow-x-auto table container can't clip it) where each stage is a row
// toggle. Same optimistic-write semantics as the old chip strip.
export function StageChips({
  jobId,
  component,
  siblings,
  readOnly = false,
  onRouteChange,
}: {
  jobId: string
  component: Component
  /**
   * 本单其余的零件 —— 有它, 选择器底下就多一行「套用到本单其余 N 个零件」。
   *
   * 一张工单十几个零件, 工程十有八九是整单走同一条路线 (这单不用编程, 这单
   * 加表处)。以前那是一个零件一个零件点开、一道一道点, 几十下; 现在设好一
   * 个, 一下推到全单。会被服务端挡下的 (已报工要覆盖、已外协、已出货) 自动
   * 跳过, 只在结果里报个数 —— 批量绝不替人做那种删不掉的决定。
   */
  siblings?: { id: string }[]
  readOnly?: boolean
  // Rows whose `component` is held in client state (a part added this visit,
  // before any reload) pass this so the stage grid on the same row re-renders
  // its n/a slashes the instant the route changes. Server-rendered rows leave
  // it undefined — their grid is truth from the last load either way.
  onRouteChange?: (stages: Stage[]) => void
}) {
  const router = useRouter()
  const [bulkPending, setBulkPending] = useState(false)
  const [pending, start] = useTransition()
  const [optimistic, setOptimistic] = useState<Set<Stage> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<ConflictDialogState | null>(
    null,
  )
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const lockedByOutsource = new Set<Stage>()
  for (const b of component.outsourceBlocks ?? []) {
    for (const s of b.stages) lockedByOutsource.add(s)
  }

  const currentRoute = optimistic ?? new Set<Stage>(partRoute(component))

  const apply = async (next: Set<Stage>, force: boolean) => {
    setError(null)
    const before = STAGES.filter((s) => currentRoute.has(s))
    setOptimistic(next)
    const stages = STAGES.filter((s) => next.has(s))
    onRouteChange?.(stages)
    const revert = () => onRouteChange?.(before)
    return new Promise<void>((resolve) => {
      start(async () => {
        try {
          const r = await mutate<SetPartRouteResult>({
            kind: 'setPartRoute',
            jobId,
            componentId: component.id,
            stages,
            force,
          })
          const result = r.data
          if (result.ok) {
            setConfirmState(null)
            resolve()
            return
          }
          setOptimistic(null)
          revert()
          if (result.reason === 'needs_confirm') {
            setConfirmState({ desired: stages, removing: result.conflicts })
          } else if (result.reason === 'outsourced_locked') {
            setError(`已外协 · ${result.stages.join('、')} 不能取消`)
          } else if (result.reason === 'shipped_locked') {
            setError('已出货 · 出货不能取消')
          } else if (result.reason === 'not_found') {
            // Component id couldn't be resolved against the DB snapshot — the
            // part was deleted in another tab, or the page is showing a stale
            // pre-import state. Either way, refresh recovers.
            setError('零件未找到 · 请刷新页面')
          } else {
            setError('保存失败 · 请重试')
          }
          resolve()
        } catch (err) {
          setOptimistic(null)
          revert()
          // Surface the real reason when the action threw — likely an auth
          // redirect (lost session) or a supabase write error. The 10px
          // mono "保存失败" the user used to see was easy to miss; this
          // longer message is paired with a red wash on the row below.
          const msg = err instanceof Error ? err.message : ''
          setError(
            msg.includes('NEXT_REDIRECT')
              ? '会话已过期 · 请刷新登录'
              : '保存失败 · 请重试',
          )
          resolve()
        }
      })
    })
  }

  // 出货 发生过就摘不掉了 (服务端 setPartRoute 那一道同样挡着)。还没发生的,
  // 跟别的工序一样点一下就开关。
  const shippedLocked = !isStageUntouched(component, '出货')

  const onToggle = (stage: Stage) => {
    if (readOnly) return
    if (stage === '出货' && currentRoute.has(stage) && shippedLocked) return
    if (lockedByOutsource.has(stage)) return
    let next: Set<Stage>
    if (currentRoute.has(stage)) {
      next = new Set(currentRoute)
      next.delete(stage)
    } else {
      // Switching a stage ON isn't always a plain add — 采购 resets the route
      // to 工程·采购·编程·出货 whenever no 工段 it drops has 报工 on it
      // (routeAfterEnabling; 工程/编程 being done upstream never blocks it).
      // The picker stays open and every downstream 工段 stays clickable, so
      // switching one back on is the next click, not a different screen.
      next = new Set(routeAfterEnabling(component, currentRoute, stage))
    }
    void apply(next, false)
  }

  // 把眼前这条路线推到本单其余零件上。逐个走服务端那道 setPartRoute, 所以
  // 外协锁、出货锁、"这道工序已经报过工"全都照旧拦得住 —— 拦下来的跳过, 不
  // 强制。
  const others = (siblings ?? []).filter((c) => c.id !== component.id)
  const applyToAll = async () => {
    const stages = STAGES.filter((s) => currentRoute.has(s))
    if (others.length === 0 || stages.length === 0) return
    if (
      !confirm(
        `把这条工序套到本单其余 ${others.length} 个零件？\n${stages.join(' → ')}`,
      )
    )
      return
    setBulkPending(true)
    let done = 0
    let skipped = 0
    for (const o of others) {
      try {
        const r = await mutate<SetPartRouteResult>({
          kind: 'setPartRoute',
          jobId,
          componentId: o.id,
          stages,
          force: false,
        })
        if (r.data.ok) done += 1
        else skipped += 1
      } catch {
        skipped += 1
      }
    }
    setBulkPending(false)
    setAnchor(null)
    showToast(
      skipped === 0
        ? `已套用到 ${done} 个零件`
        : `已套用 ${done} 个 · ${skipped} 个跳过 (已报工 / 已外协 / 已出货)`,
      skipped === 0 ? 'success' : 'warning',
    )
    router.refresh()
  }

  const summary = (
    <RouteSummary route={currentRoute} lockedByOutsource={lockedByOutsource} />
  )

  if (readOnly) {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-1 leading-snug">
        {summary}
      </span>
    )
  }

  return (
    <span className="inline-flex flex-wrap items-center leading-snug -ml-1.5">
      <button
        ref={triggerRef}
        type="button"
        onClick={() =>
          setAnchor(
            anchor
              ? null
              : (triggerRef.current?.getBoundingClientRect() ?? null),
          )
        }
        aria-expanded={anchor !== null}
        aria-haspopup="dialog"
        title="点击选择工序"
        className="group inline-flex flex-wrap items-center gap-x-1 rounded-[2px] px-1.5 py-1 text-left transition-colors hover:bg-[var(--color-active-bg)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ink-3)]"
      >
        {summary}
        <Chevron open={anchor !== null} />
      </button>

      {anchor ? (
        <RoutePicker
          anchor={anchor}
          triggerRef={triggerRef}
          route={currentRoute}
          lockedByOutsource={lockedByOutsource}
          shippedLocked={shippedLocked}
          pending={pending}
          onToggle={onToggle}
          onClose={() => setAnchor(null)}
          othersCount={others.length}
          bulkPending={bulkPending}
          onApplyAll={others.length > 0 ? applyToAll : undefined}
        />
      ) : null}

      {error ? (
        <span
          role="alert"
          className="ml-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[2px] bg-[var(--color-overdue-soft)] text-[12px] font-medium text-[var(--color-overdue)] tracking-wide"
        >
          <span aria-hidden="true">!</span>
          {error}
        </span>
      ) : null}
      {confirmState ? (
        <ConfirmDialog
          conflicts={confirmState.removing}
          onConfirm={async () => {
            const next = new Set<Stage>(confirmState.desired)
            await apply(next, true)
          }}
          onCancel={() => setConfirmState(null)}
          pending={pending}
        />
      ) : null}
    </span>
  )
}

// The collapsed line. The table cells hosting this run ~80px wide, so
// enumerating a long route wraps into the exact vertical stack this widget
// exists to kill — instead the line says the *shortest true thing*:
//   · full default route        → 全部工段
//   · a few stages pruned       → 跳过 编程·操机   (the delta from default)
//   · short route (≤4 stages)   → 工程·检验·出货   (just list it)
//   · anything in between       → 6 道工序
// The full route always lives in the hover title and one click away in the
// picker. Outsourced stages add a warning-toned 外协 suffix.
function routeTitle(inRoute: Stage[], lockedByOutsource: Set<Stage>): string {
  if (inRoute.length === 0) return '未设工序'
  return inRoute
    .map((s) => (lockedByOutsource.has(s) ? `${s}(外协)` : s))
    .join(' → ')
}

function RouteSummary({
  route,
  lockedByOutsource,
}: {
  route: Set<Stage>
  lockedByOutsource: Set<Stage>
}) {
  const inRoute = STAGES.filter((s) => route.has(s))
  // The baseline is the DEFAULT route — 采购/表处 are opt-in, so a part that
  // simply never turned them on is NOT "skipping" anything. They surface as
  // a "+采购" suffix when switched on instead.
  const skipped = DEFAULT_ROUTE_STAGES.filter((s) => !route.has(s))
  const extras = OPT_IN_STAGES.filter((s) => route.has(s))
  const title = routeTitle(inRoute, lockedByOutsource)

  const extraSuffix =
    extras.length > 0 ? (
      <span className="whitespace-nowrap text-[var(--color-ink-2)]">
        {' '}+{extras.join('·')}
      </span>
    ) : null

  let main: ReactNode
  if (inRoute.length === 0) {
    main = <span className="text-[var(--color-ink-3)]">未设工序</span>
  } else if (skipped.length === 0) {
    main = (
      <span className="whitespace-nowrap">
        全部工段
        {extraSuffix}
      </span>
    )
  } else if (skipped.length <= 3 && inRoute.length > 4) {
    main = (
      <>
        <span className="text-[var(--color-ink-4)]">跳过 </span>
        <span className="text-[var(--color-ink-2)] line-through decoration-[var(--color-ink-4)]">
          {skipped.join('·')}
        </span>
        {extraSuffix}
      </>
    )
  } else if (inRoute.length <= 4) {
    main = <span>{inRoute.join('·')}</span>
  } else {
    main = (
      <span className="whitespace-nowrap">
        <span className="mono tabular-nums">{inRoute.length}</span> 道工序
      </span>
    )
  }

  return (
    <span
      title={title}
      className="text-[12px] tracking-wider leading-[1.5] text-[var(--color-ink)]"
    >
      {main}
    </span>
  )
}

// Expanded picker — one row per stage, in route order, toggled with a single
// click (writes are optimistic, same as the old chips). Locked rows say why
// instead of disabling silently. Rendered into <body> with fixed positioning
// so the table's scroll container can't clip it; flips above the trigger when
// there's no room below.
const PICKER_W = 224
const PICKER_EST_H = 36 + STAGES.length * 32 + 44 // header + rows + footer

function RoutePicker({
  anchor,
  triggerRef,
  route,
  lockedByOutsource,
  shippedLocked,
  pending,
  onToggle,
  onClose,
  othersCount,
  bulkPending,
  onApplyAll,
}: {
  anchor: DOMRect
  triggerRef: RefObject<HTMLButtonElement | null>
  route: Set<Stage>
  lockedByOutsource: Set<Stage>
  /** 这个零件已经发过货 —— 出货那一行锁着, 摘不掉。 */
  shippedLocked: boolean
  pending: boolean
  onToggle: (stage: Stage) => void
  onClose: () => void
  /** 本单其余零件的个数 —— 0 就不出现那一行。 */
  othersCount: number
  bulkPending: boolean
  onApplyAll?: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Dismiss on outside click / Escape / any scroll (the anchor rect goes
  // stale the moment the table scrolls under a fixed-position panel).
  // Clicks on the trigger are NOT outside — closing here would race the
  // trigger's own onClick toggle and instantly reopen the panel.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current && panelRef.current.contains(t)) return
      if (triggerRef.current && triggerRef.current.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onScroll = (e: Event) => {
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target))
        return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const left = Math.max(
    8,
    Math.min(anchor.left, window.innerWidth - PICKER_W - 8),
  )
  // Open toward whichever side has more room; cap the panel to that room so
  // the 完成 footer never falls below the fold (the stage list scrolls
  // internally instead).
  const spaceBelow = window.innerHeight - anchor.bottom - 14
  const spaceAbove = anchor.top - 14
  const openUp = spaceBelow < PICKER_EST_H && spaceAbove > spaceBelow
  const maxH = Math.min(PICKER_EST_H, openUp ? spaceAbove : spaceBelow)
  const pos: CSSProperties = openUp
    ? { left, bottom: window.innerHeight - anchor.top + 6 }
    : { left, top: anchor.bottom + 6 }

  const count = STAGES.filter((s) => route.has(s)).length

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="选择工序"
      style={{ ...pos, width: PICKER_W, maxHeight: maxH }}
      className="fixed z-40 flex flex-col rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_8px_28px_rgba(0,0,0,0.12),0_0_0_0.5px_rgba(0,0,0,0.04)]"
    >
      <div className="flex shrink-0 items-baseline justify-between px-3 pt-2.5 pb-1.5">
        <span className="label text-[var(--color-ink-3)]">工序 · 点选切换</span>
        <span className="mono text-[11px] tabular-nums text-[var(--color-ink-4)]">
          {count}/{STAGES.length}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {STAGES.map((stage) => {
          const inRoute = route.has(stage)
          const isOutsource = lockedByOutsource.has(stage)
          const isShipped = stage === '出货' && inRoute && shippedLocked
          const isLocked = isShipped || isOutsource
          const handledInHouse = inRoute && !isOutsource

          const boxCls = handledInHouse
            ? 'bg-[var(--color-ink)] border-[var(--color-ink)]'
            : isOutsource
              ? 'bg-transparent border-[var(--color-warning)]'
              : 'bg-transparent border-[var(--color-ink-4)]'

          return (
            <button
              key={stage}
              type="button"
              disabled={pending || isLocked}
              onClick={() => onToggle(stage)}
              aria-pressed={handledInHouse}
              className={`flex w-full items-center gap-2.5 rounded-[2px] px-2 h-[30px] text-left transition-colors ${
                isLocked
                  ? 'cursor-default'
                  : 'hover:bg-[var(--color-active-bg)] cursor-pointer'
              } disabled:opacity-100`}
            >
              <span
                aria-hidden="true"
                className={`block h-[8px] w-[8px] shrink-0 rounded-[2px] border transition-colors ${boxCls}`}
              />
              <span
                className={`flex-1 text-[13px] tracking-wider transition-colors ${
                  handledInHouse
                    ? 'text-[var(--color-ink)] font-medium'
                    : isOutsource
                      ? 'text-[var(--color-warning)]'
                      : 'text-[var(--color-ink-3)]'
                }`}
              >
                {stage}
              </span>
              <span className="label text-[10px] text-[var(--color-ink-4)]">
                {isShipped ? '已出货' : isOutsource ? '已外协' : ''}
              </span>
            </button>
          )
        })}
      </div>

      <div className="shrink-0 border-t border-[var(--color-border)] px-1.5 py-1.5">
        {/* 一张单十几个零件多半走同一条路线 —— 设好一个, 一下推到全单。 */}
        {onApplyAll ? (
          <button
            type="button"
            disabled={pending || bulkPending}
            onClick={onApplyAll}
            className="mb-0.5 w-full rounded-[2px] py-1.5 text-[12px] tracking-wider text-[var(--color-ink-2)] transition-colors hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink)] disabled:opacity-40"
          >
            {bulkPending
              ? '套用中…'
              : `套用到本单其余 ${othersCount} 个零件`}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-[2px] py-1.5 text-[12px] tracking-wider text-[var(--color-ink-2)] hover:bg-[var(--color-active-bg)] hover:text-[var(--color-ink)] transition-colors"
        >
          完成
        </button>
      </div>
    </div>,
    document.body,
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      className={`ml-0.5 shrink-0 text-[var(--color-ink-4)] transition-transform group-hover:text-[var(--color-ink-2)] ${
        open ? 'rotate-180' : ''
      }`}
    >
      <path
        d="M2.5 3.75 L5 6.5 L7.5 3.75"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ConfirmDialog({
  conflicts,
  onConfirm,
  onCancel,
  pending,
}: {
  conflicts: { stage: Stage; status: 'in_progress' | 'done' }[]
  onConfirm: () => void
  onCancel: () => void
  pending: boolean
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[400px] max-w-[92vw] bg-[var(--color-surface)] border border-[var(--color-ink)] rounded-[2px] p-6 shadow-xl"
      >
        <p className="label text-[var(--color-warning)] mb-2">确认关闭工段</p>
        <h3 className="text-[16px] font-semibold tracking-tight text-[var(--color-ink)] mb-3">
          以下工段已开始或完成，关闭将丢失工时记录
        </h3>
        <ul className="text-[13px] text-[var(--color-ink-2)] mb-6 space-y-1 leading-relaxed">
          {conflicts.map((c) => (
            <li key={c.stage} className="flex items-baseline gap-3">
              <span className="mono font-medium text-[var(--color-ink)] w-12">
                {c.stage}
              </span>
              <span className="label text-[var(--color-ink-3)]">
                {c.status === 'in_progress' ? '进行中' : '已完成'}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="px-3 py-1.5 text-[12px] tracking-wider border border-[var(--color-border)] text-[var(--color-ink-2)] hover:bg-[#f1eee4] rounded-[2px] disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="px-3 py-1.5 text-[12px] tracking-wider bg-[var(--color-overdue)] text-[var(--color-surface)] rounded-[2px] hover:opacity-80 disabled:opacity-60"
          >
            确认关闭
          </button>
        </div>
      </div>
    </div>
  )
}
