'use client'

import { useEffect, useState } from 'react'
import { withBase } from '@/lib/base-path'
import { BRAND } from '@/lib/brand'

// 大屏看板 — dark, huge, self-refreshing. Polls /api/tv every 30s; a stale
// poll keeps the last good data on screen (a network blip must never blank
// the boss's TV). One accent color, bars are plain divs — no chart library.

const POLL_MS = 30_000
const ACCENT = '#fbbf24'

type TvData = {
  ok: boolean
  today: { pieces: number; reports: number }
  inProduction: number
  overdue: number
  shippedToday: { parts: number; pieces: number }
  workers: { actor: string; pieces: number; reports: number }[]
  feed: { at: string; actor: string; part: string; stage: string; qty: number }[]
}

const NUM = new Intl.NumberFormat('zh-CN')

function shClock(d: Date): string {
  return d.toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function shHM(d: Date): string {
  return d.toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  })
}

function shDate(d: Date): string {
  return d.toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })
}

function timeAgo(iso: string, now: Date): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.floor((now.getTime() - t) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86_400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86_400)} 天前`
}

export function TvBoard() {
  const [data, setData] = useState<TvData | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [stale, setStale] = useState(false)
  // null until mounted — the clock renders client-side only, so the SSR
  // markup and the first client render never disagree (no hydration flash).
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    let alive = true
    const load = () => {
      fetch(withBase('/api/tv'), { cache: 'no-store' })
        .then((r) => r.json())
        .then((d: TvData) => {
          if (!alive) return
          if (d.ok) {
            setData(d)
            setUpdatedAt(new Date())
            setStale(false)
          } else {
            setStale(true)
          }
        })
        .catch(() => alive && setStale(true))
    }
    load()
    const t = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  useEffect(() => {
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const workers = data?.workers ?? []
  const maxPieces = workers.length > 0 ? Math.max(...workers.map((w) => w.pieces), 1) : 1
  const overdueHot = (data?.overdue ?? 0) > 0

  return (
    <div className="flex-1 flex flex-col bg-[#0b0e13] text-[#e8e6e1] px-6 md:px-12 py-6 md:py-8 select-none min-h-screen">
      {/* header — brand left, live clock right */}
      <header className="flex items-end justify-between gap-6">
        <div>
          <p className="text-[13px] md:text-[15px] tracking-[0.3em] text-[#8a8f98]">
            {BRAND.shortName} · 生产看板
          </p>
          <p className="mt-1 text-[15px] md:text-[18px] text-[#5c626c]">
            {now ? shDate(now) : '—'}
          </p>
        </div>
        <div className="text-right">
          <p className="mono text-[clamp(36px,4.5vw,64px)] font-semibold leading-none tabular-nums">
            {now ? shClock(now) : '--:--:--'}
          </p>
          <p className="mt-1.5 text-[12px] md:text-[14px] text-[#5c626c]">
            {updatedAt ? `更新 ${shHM(updatedAt)}` : '加载中…'}
            {stale && <span className="ml-2 text-[#8a8f98]">· 重连中</span>}
          </p>
        </div>
      </header>

      {/* stat tiles */}
      <section className="mt-6 md:mt-8 grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-5">
        <Tile label="今日报工" value={data ? NUM.format(data.today.pieces) : '—'} unit="件" accent
          sub={data ? `${NUM.format(data.today.reports)} 次报工` : ''} />
        <Tile label="在产零件" value={data ? NUM.format(data.inProduction) : '—'} unit="项"
          sub="未出货" />
        <Tile label="逾期" value={data ? NUM.format(data.overdue) : '—'} unit="项"
          sub="超交期未出货" hot={overdueHot} />
        <Tile label="今日出货" value={data ? NUM.format(data.shippedToday.pieces) : '—'} unit="件"
          sub={data ? `${NUM.format(data.shippedToday.parts)} 项零件` : ''} />
      </section>

      <div className="mt-6 md:mt-8 grid lg:grid-cols-2 gap-4 md:gap-6 flex-1 min-h-0">
        {/* per-worker today leaderboard */}
        <section className="border border-[#1d232c] bg-[#0f1319] rounded-[4px] p-5 md:p-7 flex flex-col">
          <h2 className="text-[13px] md:text-[15px] tracking-[0.25em] text-[#8a8f98]">
            今日报工 · 排行
          </h2>
          <div className="mt-4 md:mt-6 flex-1 space-y-3 md:space-y-4">
            {workers.length === 0 && (
              <p className="text-[20px] text-[#5c626c] mt-4">今日暂无报工</p>
            )}
            {workers.map((w, i) => (
              <div key={w.actor} className="flex items-center gap-3 md:gap-4">
                <span className="mono w-7 text-right text-[16px] md:text-[18px] text-[#5c626c]">
                  {i + 1}
                </span>
                <span className="w-[5.5em] shrink-0 truncate text-[20px] md:text-[26px] font-medium">
                  {w.actor}
                </span>
                <div className="flex-1 h-[16px] md:h-[20px] bg-[#161c25] rounded-[2px] overflow-hidden">
                  <div
                    className="h-full rounded-[2px]"
                    style={{
                      width: `${Math.max(3, Math.round((w.pieces / maxPieces) * 100))}%`,
                      background: ACCENT,
                    }}
                  />
                </div>
                <span className="mono w-[3.2em] text-right text-[22px] md:text-[28px] font-semibold tabular-nums">
                  {NUM.format(w.pieces)}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* live 报工 feed */}
        <section className="border border-[#1d232c] bg-[#0f1319] rounded-[4px] p-5 md:p-7 flex flex-col min-h-0">
          <h2 className="text-[13px] md:text-[15px] tracking-[0.25em] text-[#8a8f98]">
            实时动态
          </h2>
          <div className="mt-4 md:mt-5 flex-1 overflow-hidden divide-y divide-[#161c25]">
            {(data?.feed ?? []).length === 0 && (
              <p className="text-[20px] text-[#5c626c] mt-4">暂无报工记录</p>
            )}
            {(data?.feed ?? []).map((ev, i) => (
              <div key={`${ev.at}-${i}`} className="flex items-baseline gap-3 md:gap-4 py-2 md:py-2.5">
                <span className="w-[5em] shrink-0 text-[13px] md:text-[15px] text-[#5c626c]">
                  {now ? timeAgo(ev.at, now) : ''}
                </span>
                <span className="shrink-0 text-[17px] md:text-[20px] font-semibold">
                  {ev.actor}
                </span>
                <span className="flex-1 truncate text-[16px] md:text-[19px] text-[#aeb4bd]">
                  {ev.part}
                </span>
                <span className="shrink-0 text-[13px] md:text-[15px] text-[#5c626c]">
                  {ev.stage}
                </span>
                <span
                  className="mono shrink-0 text-[18px] md:text-[22px] font-semibold tabular-nums"
                  style={{ color: ACCENT }}
                >
                  +{NUM.format(ev.qty)}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function Tile({
  label,
  value,
  unit,
  sub,
  accent = false,
  hot = false,
}: {
  label: string
  value: string
  unit: string
  sub?: string
  accent?: boolean
  hot?: boolean
}) {
  return (
    <div className="border border-[#1d232c] bg-[#0f1319] rounded-[4px] px-5 md:px-7 py-4 md:py-6">
      <p className="text-[13px] md:text-[15px] tracking-[0.25em] text-[#8a8f98]">{label}</p>
      <p
        className="mono mt-2 md:mt-3 text-[clamp(44px,5.5vw,92px)] font-semibold leading-none tabular-nums"
        style={hot ? { color: '#f87171' } : accent ? { color: ACCENT } : undefined}
      >
        {value}
        <span className="ml-1.5 text-[0.28em] font-medium text-[#8a8f98] tracking-normal">
          {unit}
        </span>
      </p>
      {sub ? (
        <p className="mt-2 text-[12px] md:text-[14px] text-[#5c626c]">{sub}</p>
      ) : null}
    </div>
  )
}
