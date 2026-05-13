'use client'

import Link from 'next/link'
import {
  effectiveStageState,
  isStageInRoute,
  stageDoneCount,
  type Component,
  type Job,
  type Stage,
} from '@/lib/data'

// One place to define the search field set. Component name + material are
// always searchable — production workers search their own parts even when
// jobNoOnly hides customer / product text from them. Both _master_filter
// and _workbench call this so the in-row strip below agrees with the row
// filter above.
export function searchHaystack(j: Job, jobNoOnly: boolean): string {
  const parts: string[] = [j.jobNo]
  if (!jobNoOnly) parts.push(j.customer, j.product)
  for (const c of j.components) {
    parts.push(c.name)
    if (c.material) parts.push(c.material)
  }
  return parts.join(' ').toLowerCase()
}

// Components in the job whose name or material contains the query. Returns
// [] when the query is empty or none match. Used to render the inline strip
// inside the job row.
export function matchedComponents(job: Job, q: string): Component[] {
  const query = q.trim().toLowerCase()
  if (!query) return []
  const out: Component[] = []
  for (const c of job.components) {
    if (c.name.toLowerCase().includes(query)) {
      out.push(c)
      continue
    }
    if (c.material && c.material.toLowerCase().includes(query)) {
      out.push(c)
    }
  }
  return out
}

export function Highlight({ text, q }: { text: string; q: string }) {
  const query = q.trim()
  if (!query) return <>{text}</>
  const lowerText = text.toLowerCase()
  const lowerQ = query.toLowerCase()
  const idx = lowerText.indexOf(lowerQ)
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-[var(--color-warning-soft)] text-[var(--color-ink)] px-0.5 rounded-[2px]">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  )
}

// Inline strip rendered inside the product / customer cell when search hit on
// one or more components in the row. Each entry deep-links to the component
// on the job detail page (#c-<id>) — the ComponentAnchorScroller on that page
// scrolls + pulses on arrival. Station-head viewers (viewerStage set, not
// 工程) get a tiny per-component stage chip on the right of each entry so they
// see at a glance whether the part is currently on their bench.
export function MatchedComponentsStrip({
  job,
  components,
  q,
  viewerStage,
}: {
  job: Job
  components: Component[]
  q: string
  /** When the page is filtered to a station (打磨 / 喷漆 / etc.), show that
   * stage's state on each matched component. Skip for commerce overview /
   * 工程 — the parent row already carries the rollup. */
  viewerStage?: Stage
}) {
  if (components.length === 0) return null
  const showBadge = viewerStage !== undefined && viewerStage !== '工程'
  return (
    <ul className="mt-1 space-y-0.5">
      {components.map((c) => (
        <li key={c.id} className="leading-tight">
          <Link
            href={`/jobs/${job.id}#c-${c.id}`}
            className="inline-flex items-baseline gap-1.5 max-w-full hover:bg-[#f7f5ee] -mx-1 px-1 rounded-sm transition-colors"
          >
            <span className="text-[var(--color-ink-3)] text-[11px]">↳</span>
            <span className="text-[12px] text-[var(--color-ink)] truncate">
              <Highlight text={c.name} q={q} />
            </span>
            <span className="mono text-[11px] text-[var(--color-ink-3)] tabular-nums shrink-0">
              ×{c.qty}
            </span>
            {c.material && (
              <span className="text-[11px] text-[var(--color-ink-3)] truncate">
                <Highlight text={c.material} q={q} />
              </span>
            )}
            {showBadge && (
              <ComponentStageBadge component={c} stage={viewerStage} />
            )}
          </Link>
        </li>
      ))}
    </ul>
  )
}

function ComponentStageBadge({
  component,
  stage,
}: {
  component: Component
  stage: Stage
}) {
  if (!isStageInRoute(component, stage)) {
    return (
      <span className="label text-[var(--color-ink-4)] shrink-0">n/a</span>
    )
  }
  const eff = effectiveStageState(component, stage)
  if (eff.kind === 'outsourced') {
    return (
      <span className="mono text-[10px] tracking-wider px-1 rounded-sm border border-[var(--color-info)] text-[var(--color-info)] shrink-0">
        外协
      </span>
    )
  }
  if (eff.kind === 'done') {
    return (
      <span className="text-[12px] leading-none font-semibold text-[var(--color-success)] shrink-0">
        ✓
      </span>
    )
  }
  if (eff.kind === 'in_progress') {
    const done = stageDoneCount(component, stage)
    return (
      <span className="mono text-[11px] text-[var(--color-warning)] tabular-nums shrink-0">
        {done}/{component.qty}
      </span>
    )
  }
  if (eff.kind === 'pending' && eff.canStart) {
    return (
      <span className="label text-[var(--color-ink)] shrink-0">在此</span>
    )
  }
  return (
    <span className="label text-[var(--color-ink-4)] shrink-0">上游</span>
  )
}

// Plain search input. The earlier popover-and-input pairing turned out to be
// two surfaces fired by one query — kept the input, dropped the floating list.
// Match results now show inline within each job row via MatchedComponentsStrip.
export function SearchInput({
  q,
  setQ,
  placeholder,
}: {
  q: string
  setQ: (s: string) => void
  placeholder: string
}) {
  return (
    <div className="relative inline-block">
      <span className="absolute left-0 top-1/2 -translate-y-1/2 text-[var(--color-ink-3)] pointer-events-none">
        <SearchIcon />
      </span>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className="w-[220px] md:w-[300px] h-8 pl-6 pr-6 bg-transparent border-0 border-b border-[var(--color-border-strong)] placeholder:text-[var(--color-ink-3)] focus:outline-none focus:border-[var(--color-ink)] transition-colors"
        style={{ fontSize: '14px' }}
      />
      {q && (
        <button
          type="button"
          onClick={() => setQ('')}
          aria-label="清除搜索"
          className="absolute right-0 top-1/2 -translate-y-1/2 h-5 w-5 inline-flex items-center justify-center rounded-full text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
        >
          <ClearIcon />
        </button>
      )}
    </div>
  )
}

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.4" />
      <line
        x1="10.5"
        y1="10.5"
        x2="14"
        y2="14"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function ClearIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 3 L9 9 M9 3 L3 9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}
