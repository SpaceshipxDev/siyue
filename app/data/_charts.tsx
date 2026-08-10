'use client'

import { useId, useState } from 'react'
import { WEEKS, type Week } from './_data'

// Charts for /data. Hand-rolled SVG on purpose — no chart library, no runtime
// download, renders identically on the sales guy's phone in a customer's lobby.
//
// One accent hue throughout (--color-info steel blue). These are all
// single-series magnitude charts, so colour carries no identity: the title
// names the series. 历史补录 weeks and the partial current week are drawn
// hatched so nobody quotes them as real output.

const ACCENT = 'var(--color-info)'
const VW = 720

type Metric = Exclude<keyof Week, 'w' | 'backfill' | 'partial'>

const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US'))

function niceMax(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1))))
  return Math.ceil(v / (p / 2)) * (p / 2)
}
const axisLabel = (v: number) => (v >= 1000 ? `${v / 1000}k` : `${v}`)

type Row = { label: string; metric: Metric }

function Tooltip({
  week,
  rows,
  x,
  side,
}: {
  week: Week
  rows: Row[]
  x: number
  side: 'left' | 'right'
}) {
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 min-w-[128px] rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-2 text-[11px] shadow-[0_4px_16px_rgba(20,19,15,0.12)]"
      style={{
        left: side === 'right' ? `${x}%` : undefined,
        right: side === 'left' ? `${100 - x}%` : undefined,
        transform: side === 'right' ? 'translateX(10px)' : 'translateX(-10px)',
      }}
    >
      <div className="mb-1 font-medium tracking-wide text-[var(--color-ink)]">
        {week.w} 当周
      </div>
      {rows.map((r) => (
        <div key={r.metric} className="flex justify-between gap-4 tabular-nums">
          <span className="text-[var(--color-ink-3)]">{r.label}</span>
          <span className="text-[var(--color-ink)]">{fmt(week[r.metric])}</span>
        </div>
      ))}
      {week.backfill && (
        <div className="mt-1.5 border-t border-[var(--color-border)] pt-1.5 text-[10px] leading-snug text-[var(--color-ink-3)]">
          历史补录周 · 非当周产出
        </div>
      )}
      {week.partial && (
        <div className="mt-1.5 border-t border-[var(--color-border)] pt-1.5 text-[10px] leading-snug text-[var(--color-ink-3)]">
          本周仅 1 天数据
        </div>
      )}
      {week[rows[0].metric] === null && (
        <div className="mt-1.5 border-t border-[var(--color-border)] pt-1.5 text-[10px] leading-snug text-[var(--color-ink-3)]">
          该周尚未接入埋点
        </div>
      )}
    </div>
  )
}

export function WeeklyBars({
  metric,
  title,
  unit,
  height = 132,
  every = 3,
  extra = [],
  hatchBackfill = false,
  aria,
}: {
  metric: Metric
  title: string
  unit?: string
  height?: number
  every?: number
  extra?: Row[]
  hatchBackfill?: boolean
  aria: string
}) {
  const uid = useId().replace(/[:]/g, '')
  const [hover, setHover] = useState<number | null>(null)

  const PT = 14
  const PB = 20
  const PL = 34
  const PR = 4
  const plotW = VW - PL - PR
  const plotH = height - PT - PB
  const max = niceMax(Math.max(...WEEKS.map((d) => (d[metric] as number) ?? 0)))
  const band = plotW / WEEKS.length
  const bw = Math.max(4, band - 5)
  const rows: Row[] = [{ label: title, metric }, ...extra]

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VW} ${height}`}
        role="img"
        aria-label={aria}
        className="block w-full"
      >
        <defs>
          <pattern
            id={`h${uid}`}
            width="5"
            height="5"
            patternTransform="rotate(45)"
            patternUnits="userSpaceOnUse"
          >
            <rect width="5" height="5" fill="var(--color-muted-bg)" />
            <line x1="0" y1="0" x2="0" y2="5" stroke={ACCENT} strokeWidth="2" opacity="0.45" />
          </pattern>
        </defs>

        {[0, 1, 2].map((i) => {
          const v = (max * i) / 2
          const y = PT + plotH - (v / max) * plotH
          return (
            <g key={i}>
              <line
                x1={PL}
                y1={y}
                x2={VW - PR}
                y2={y}
                stroke={i === 0 ? 'var(--color-border-strong)' : 'var(--color-border)'}
                strokeWidth="1"
              />
              <text
                x={PL - 6}
                y={y + 3}
                textAnchor="end"
                className="fill-[var(--color-ink-4)] text-[9px] tabular-nums"
              >
                {axisLabel(v)}
              </text>
            </g>
          )
        })}

        {WEEKS.map((d, i) => {
          const v = (d[metric] as number) ?? 0
          const h = (v / max) * plotH
          const x = PL + i * band + (band - bw) / 2
          const y = PT + plotH - h
          const hatched = (hatchBackfill && d.backfill) || d.partial
          return (
            <g key={d.w}>
              <rect
                x={x}
                y={y}
                width={bw}
                height={Math.max(h, v > 0 ? 1 : 0)}
                rx="1"
                fill={hatched ? `url(#h${uid})` : ACCENT}
                opacity={hover === null || hover === i ? 1 : 0.42}
              />
              {(i % every === 0 || i === WEEKS.length - 1) && (
                <text
                  x={x + bw / 2}
                  y={height - 6}
                  textAnchor="middle"
                  className="fill-[var(--color-ink-4)] text-[9px] tabular-nums"
                >
                  {d.w}
                </text>
              )}
              <rect
                x={PL + i * band}
                y={PT}
                width={band}
                height={plotH}
                fill="transparent"
                className="cursor-crosshair"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          )
        })}
      </svg>

      {unit && (
        <div className="mt-1 text-[10px] tracking-wide text-[var(--color-ink-4)]">{unit}</div>
      )}

      {hover !== null && (
        <Tooltip
          week={WEEKS[hover]}
          rows={rows}
          x={((PL + hover * band + band / 2) / VW) * 100}
          side={hover > WEEKS.length * 0.62 ? 'left' : 'right'}
        />
      )}
    </div>
  )
}

export function WeeklyLine({
  metric,
  title,
  height = 150,
  every = 2,
  extra = [],
  aria,
}: {
  metric: Metric
  title: string
  height?: number
  every?: number
  extra?: Row[]
  aria: string
}) {
  const uid = useId().replace(/[:]/g, '')
  const [hover, setHover] = useState<number | null>(null)

  const PT = 14
  const PB = 20
  const PL = 34
  const PR = 58
  const plotW = VW - PL - PR
  const plotH = height - PT - PB
  const max = niceMax(Math.max(...WEEKS.map((d) => (d[metric] as number) ?? 0)))
  const band = plotW / WEEKS.length
  const X = (i: number) => PL + i * band + band / 2
  const Y = (v: number) => PT + plotH - (v / max) * plotH

  const pts = WEEKS.map((d, i) => ({ i, v: d[metric] as number | null })).filter(
    (p) => p.v !== null,
  ) as { i: number; v: number }[]
  const line = pts.map((p) => `${X(p.i)} ${Y(p.v)}`).join(' L')
  const area =
    pts.length > 1
      ? `M${X(pts[0].i)} ${PT + plotH} L${line} L${X(pts[pts.length - 1].i)} ${PT + plotH} Z`
      : ''
  const last = pts[pts.length - 1]
  const rows: Row[] = [{ label: title, metric }, ...extra]

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VW} ${height}`}
        role="img"
        aria-label={aria}
        className="block w-full"
      >
        <defs>
          <linearGradient id={`g${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ACCENT} stopOpacity="0.16" />
            <stop offset="100%" stopColor={ACCENT} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {[0, 1, 2].map((i) => {
          const v = (max * i) / 2
          const y = Y(v)
          return (
            <g key={i}>
              <line
                x1={PL}
                y1={y}
                x2={VW - PR}
                y2={y}
                stroke={i === 0 ? 'var(--color-border-strong)' : 'var(--color-border)'}
                strokeWidth="1"
              />
              <text
                x={PL - 6}
                y={y + 3}
                textAnchor="end"
                className="fill-[var(--color-ink-4)] text-[9px] tabular-nums"
              >
                {axisLabel(v)}
              </text>
            </g>
          )
        })}

        {area && <path d={area} fill={`url(#g${uid})`} />}
        <path
          d={`M${line}`}
          fill="none"
          stroke={ACCENT}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {last && (
          <>
            <circle
              cx={X(last.i)}
              cy={Y(last.v)}
              r="4.5"
              fill={ACCENT}
              stroke="var(--color-surface)"
              strokeWidth="2"
            />
            <text
              x={X(last.i) + 9}
              y={Y(last.v) + 4}
              className="fill-[var(--color-ink-2)] text-[10px] font-medium"
            >
              {title}
            </text>
          </>
        )}

        {hover !== null && (
          <line
            x1={X(hover)}
            y1={PT}
            x2={X(hover)}
            y2={PT + plotH}
            stroke="var(--color-border-strong)"
            strokeWidth="1"
            strokeDasharray="2 3"
          />
        )}

        {WEEKS.map((d, i) => (
          <g key={d.w}>
            {(i % every === 0 || i === WEEKS.length - 1) && (
              <text
                x={X(i)}
                y={height - 6}
                textAnchor="middle"
                className="fill-[var(--color-ink-4)] text-[9px] tabular-nums"
              >
                {d.w}
              </text>
            )}
            {hover === i && d[metric] !== null && (
              <circle
                cx={X(i)}
                cy={Y(d[metric] as number)}
                r="4"
                fill="var(--color-surface)"
                stroke={ACCENT}
                strokeWidth="2"
              />
            )}
            <rect
              x={PL + i * band}
              y={PT}
              width={band}
              height={plotH}
              fill="transparent"
              className="cursor-crosshair"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          </g>
        ))}
      </svg>

      {hover !== null && (
        <Tooltip
          week={WEEKS[hover]}
          rows={rows}
          x={(X(hover) / VW) * 100}
          side={hover > WEEKS.length * 0.62 ? 'left' : 'right'}
        />
      )}
    </div>
  )
}
