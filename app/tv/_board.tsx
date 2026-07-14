'use client'

import { useEffect, useState } from 'react'
import { withBase } from '@/lib/base-path'
import { BRAND } from '@/lib/brand'

// 大屏看板 — jobs, not people. Polls /api/tv every 30s; a stale poll
// keeps the last good data on screen (a network blip must never blank the TV).

const POLL_MS = 30_000
const ACCENT = '#fbbf24'

type TvData = {
  ok: boolean
  inProduction: number
  dueToday: { total: number; jobs: TvJob[] }
  overdue: { total: number; jobs: TvJob[] }
  shippedToday: { parts: number; pieces: number }
}

type TvJob = {
  jobId: string
  jobNo: string
  customer: string
  dueDate: string
  openParts: number
  openQty: number
  partNames: string[]
  stageSummary: string
  daysOverdue: number
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
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const overdueHot = (data?.overdue.total ?? 0) > 0

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
        <Tile label="今日到期" value={data ? NUM.format(data.dueToday.total) : '—'} unit="单" accent
          sub="今天必须交付" />
        <Tile label="逾期工单" value={data ? NUM.format(data.overdue.total) : '—'} unit="单"
          sub="未出货" hot={overdueHot} />
        <Tile label="在产工单" value={data ? NUM.format(data.inProduction) : '—'} unit="单"
          sub="含部分已出货" />
        <Tile label="今日出货" value={data ? NUM.format(data.shippedToday.pieces) : '—'} unit="件"
          sub={data ? `${NUM.format(data.shippedToday.parts)} 项零件` : ''} />
      </section>

      <div className="mt-6 md:mt-8 grid lg:grid-cols-2 gap-4 md:gap-6 flex-1 min-h-0">
        <JobPanel
          title="今日到期工单"
          total={data?.dueToday.total ?? 0}
          jobs={data?.dueToday.jobs ?? []}
          empty="今天没有到期工单"
          tone="today"
        />
        <JobPanel
          title="逾期最久工单"
          total={data?.overdue.total ?? 0}
          jobs={data?.overdue.jobs ?? []}
          empty="没有逾期工单"
          tone="overdue"
        />
      </div>
    </div>
  )
}

function JobPanel({
  title,
  total,
  jobs,
  empty,
  tone,
}: {
  title: string
  total: number
  jobs: TvJob[]
  empty: string
  tone: 'today' | 'overdue'
}) {
  const more = Math.max(0, total - jobs.length)
  return (
    <section className="min-h-[420px] overflow-hidden rounded-[4px] border border-[#1d232c] bg-[#0f1319] p-5 md:p-7">
      <header className="flex items-baseline justify-between gap-4 border-b border-[#1d232c] pb-4">
        <h2 className="text-[13px] md:text-[15px] tracking-[0.22em] text-[#8a8f98]">{title}</h2>
        <span className={`mono text-[28px] font-semibold ${tone === 'overdue' && total > 0 ? 'text-[#f87171]' : 'text-[#fbbf24]'}`}>
          {NUM.format(total)} <small className="text-[12px] font-medium text-[#5c626c]">单</small>
        </span>
      </header>
      {jobs.length === 0 ? (
        <div className="flex min-h-72 items-center justify-center text-[20px] text-[#5c626c]">{empty}</div>
      ) : (
        <div className="divide-y divide-[#161c25]">
          {jobs.map((job, index) => (
            <JobRow key={job.jobId} job={job} index={index + 1} tone={tone} />
          ))}
        </div>
      )}
      {more > 0 ? (
        <p className="border-t border-[#1d232c] pt-3 text-right text-[12px] text-[#5c626c]">
          还有 {NUM.format(more)} 单未展开
        </p>
      ) : null}
    </section>
  )
}

function JobRow({ job, index, tone }: { job: TvJob; index: number; tone: 'today' | 'overdue' }) {
  return (
    <article className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 py-3 md:gap-4 md:py-4">
      <span className="mono text-right text-[15px] text-[#454b55]">{index}</span>
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-3">
          <strong className="mono shrink-0 text-[18px] md:text-[22px] font-semibold text-[#e8e6e1]">
            {job.jobNo || job.jobId}
          </strong>
          <span className="truncate text-[14px] md:text-[16px] text-[#aeb4bd]">{job.customer || '客户未填'}</span>
        </div>
        <p className="mt-1 truncate text-[11px] md:text-[13px] text-[#5c626c]">
          {job.partNames.length > 0 ? job.partNames.join('、') : '零件未命名'}
          <span className="mx-2 text-[#2d333c]">/</span>
          {job.stageSummary || '待出货'}
        </p>
      </div>
      <div className="min-w-[7.5rem] text-right">
        <p className={`mono text-[17px] md:text-[20px] font-semibold ${tone === 'overdue' ? 'text-[#f87171]' : 'text-[#fbbf24]'}`}>
          {tone === 'overdue' ? `逾期 ${job.daysOverdue} 天` : '今天'}
        </p>
        <p className="mt-1 text-[10px] md:text-[12px] text-[#5c626c]">
          {NUM.format(job.openParts)} 项 · {NUM.format(job.openQty)} 件
        </p>
      </div>
    </article>
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
