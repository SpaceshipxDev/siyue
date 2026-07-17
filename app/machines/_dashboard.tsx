'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { withBase } from '@/lib/base-path'
import type { MachineView } from '@/lib/machines'

type DashboardData = {
  machines: MachineView[]
  events: unknown[]
  serverTime: string
}

type ApiPayload = DashboardData & { ok: boolean; error?: string }

type BossStatus = {
  label: string
  detail: string
  dot: string
  badge: string
  border: string
  running: boolean
  attention: boolean
}

const POLL_MS = 10_000
const STALE_MS = 90_000
const NUMBER = new Intl.NumberFormat('zh-CN')

export function MachineDashboard({
  initial,
  userName,
}: {
  initial: DashboardData
  userName: string
}) {
  const [data, setData] = useState(initial)
  const [now, setNow] = useState<Date | null>(null)
  const [feedError, setFeedError] = useState<string | null>(null)

  useEffect(() => {
    const initialTick = window.setTimeout(() => setNow(new Date()), 0)
    const tick = window.setInterval(() => setNow(new Date()), 1_000)
    return () => {
      window.clearTimeout(initialTick)
      window.clearInterval(tick)
    }
  }, [])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const response = await fetch(withBase('/api/machines'), { cache: 'no-store' })
        const payload = (await response.json()) as ApiPayload
        if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`)
        if (!alive) return
        setData(payload)
        setFeedError(null)
      } catch (error) {
        if (alive) setFeedError(error instanceof Error ? error.message : '采集服务连接失败')
      }
    }
    void load()
    const poll = window.setInterval(() => void load(), POLL_MS)
    return () => {
      alive = false
      window.clearInterval(poll)
    }
  }, [])

  const machines = useMemo(
    () => [...data.machines].sort((a, b) => a.id.localeCompare(b.id, 'zh-CN', { numeric: true })),
    [data.machines],
  )

  const totals = useMemo(() => {
    const time = now?.getTime() ?? Date.parse(data.serverTime)
    const statuses = machines.map((machine) => bossStatus(machine, time))
    return {
      total: machines.length,
      online: machines.filter((machine) => isFresh(machine, time) && machine.connected).length,
      running: statuses.filter((status) => status.running).length,
      paused: machines.filter((machine) => isFresh(machine, time) && machine.executionState === 'paused').length,
      attention: statuses.filter((status) => status.attention).length,
    }
  }, [data.serverTime, machines, now])

  return (
    <main className="min-h-screen bg-[#090d0c] text-[#f5f4ee] selection:bg-[#c9ff4a] selection:text-black">
      <header className="border-b border-white/10 bg-[#0d1210] px-4 py-5 sm:px-6 lg:px-10 lg:py-7">
        <div className="mx-auto max-w-[1760px]">
          <div className="flex flex-col gap-6 2xl:flex-row 2xl:items-end 2xl:justify-between">
            <div>
              <div className="flex items-center gap-3 text-[11px] font-semibold tracking-[0.2em] text-white/40">
                <Link href="/" className="transition-colors hover:text-white">思跃</Link>
                <span className="h-px w-7 bg-white/20" />
                <span>英玛工厂</span>
              </div>
              <h1 className="mt-3 text-[clamp(34px,5vw,64px)] font-semibold leading-none tracking-[-0.055em]">
                机床生产看板
              </h1>
              <p className="mt-3 text-sm text-white/45">每台机床正在做什么、运行多久、完成多少，一眼看清</p>
            </div>

            <div className="flex flex-col gap-4 xl:flex-row xl:items-end">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <SummaryMetric label="正在加工" value={totals.running} tone="green" />
                <SummaryMetric label="暂停" value={totals.paused} tone="amber" />
                <SummaryMetric label="需处理" value={totals.attention} tone="red" />
                <SummaryMetric label="在线机床" value={`${totals.online}/${totals.total}`} tone="neutral" />
              </div>
              <div className="min-w-52 border-l border-white/10 pl-5 text-left xl:text-right">
                <div className="font-mono text-[34px] font-semibold leading-none tabular-nums">
                  {now ? shanghaiClock(now) : '--:--:--'}
                </div>
                <div className="mt-2 text-[10px] tracking-[0.14em] text-white/35">
                  {userName} · 上海时间 · 10 秒自动刷新
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-[1760px] px-4 py-5 sm:px-6 lg:px-10 lg:py-8">
        {feedError && (
          <div className="mb-4 rounded-md border border-[#ffb454]/30 bg-[#ffb454]/10 px-4 py-3 text-sm text-[#ffd08a]">
            云端数据正在重连，画面暂时保留最后一次有效读数 · {feedError}
          </div>
        )}

        {machines.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3" data-testid="machine-grid">
            {machines.map((machine) => (
              <MachineCard key={machine.id} machine={machine} now={now} />
            ))}
          </div>
        )}
      </section>
    </main>
  )
}

function MachineCard({ machine, now }: { machine: MachineView; now: Date | null }) {
  const nowMs = now?.getTime() ?? Date.parse(machine.updatedAt)
  const status = bossStatus(machine, nowMs)
  const part = partBeingMade(machine)
  const count = machine.completedParts ?? machine.totalCompletedParts
  const duration = usefulDuration(machine)
  const todaySeconds = machine.telemetrySource === 'unavailable'
    ? machine.workedTodaySeconds
    : machine.cuttingTodaySeconds

  return (
    <article
      className={`overflow-hidden rounded-lg border bg-[#111714] shadow-[0_18px_50px_rgba(0,0,0,0.18)] ${status.border}`}
      data-testid={`machine-card-${machine.id}`}
    >
      <div className="flex items-start justify-between gap-5 border-b border-white/[0.08] px-5 py-4 sm:px-6">
        <div className="min-w-0">
          <h2 className="text-[28px] font-semibold leading-none tracking-[-0.04em]">{machine.name}</h2>
          <div className="mt-2 truncate text-[11px] text-white/35">
            {friendlyController(machine)} · {machine.ip}
          </div>
        </div>
        <div className={`shrink-0 rounded-full border px-3 py-2 text-xs font-semibold ${status.badge}`}>
          <span className={`mr-2 inline-block h-2 w-2 rounded-full align-middle ${status.dot} ${status.running ? 'animate-pulse' : ''}`} />
          {status.label}
        </div>
      </div>

      <div className="px-5 py-5 sm:px-6">
        <div className="text-[10px] font-semibold tracking-[0.18em] text-white/30">
          {part.inferred ? '正在生产 · 按程序名识别' : '正在生产'}
        </div>
        <div className="mt-2 min-h-[46px] break-all text-[clamp(24px,3vw,34px)] font-semibold leading-tight tracking-[-0.035em] text-white">
          {part.value}
        </div>

        <div className="mt-5 rounded-md border border-white/[0.08] bg-black/20 px-4 py-3">
          <div className="text-[9px] font-semibold tracking-[0.16em] text-white/30">NC 程序</div>
          <div className="mt-1.5 break-all font-mono text-[18px] font-semibold text-[#c9ff4a]">
            {machine.currentProgram || '未读取到程序'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 border-y border-white/[0.08] bg-[#0c110f]">
        <BossMetric
          label="完成计数"
          value={count == null ? '—' : NUMBER.format(count)}
          unit={count == null ? '未读取' : '机床计数'}
          accent
        />
        <BossMetric label={duration.label} value={duration.value} unit={duration.unit} />
        <BossMetric label="今日加工" value={formatClock(todaySeconds)} unit="从 00:00 起" />
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-3.5 text-[11px] sm:px-6">
        <div className="flex min-w-0 items-center gap-2 text-white/45">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.dot}`} />
          <span className="truncate">{status.detail}</span>
        </div>
        <span className="shrink-0 font-mono text-white/30">更新 {relativeTime(machine.observedAt, now)}</span>
      </div>

      {(machine.error || (status.attention && machine.runtimeError)) && (
        <div className="border-t border-[#ff8b86]/15 bg-[#ff8b86]/[0.06] px-5 py-3 text-xs text-[#ffaaa5] sm:px-6">
          {shortError(machine.error || machine.runtimeError)}
        </div>
      )}
    </article>
  )
}

function SummaryMetric({
  label,
  value,
  tone,
}: {
  label: string
  value: string | number
  tone: 'green' | 'amber' | 'red' | 'neutral'
}) {
  const color = tone === 'green'
    ? 'text-[#c9ff4a] border-[#c9ff4a]/20 bg-[#c9ff4a]/[0.06]'
    : tone === 'amber'
      ? 'text-[#ffd277] border-[#ffbd59]/20 bg-[#ffbd59]/[0.06]'
      : tone === 'red'
        ? 'text-[#ff928d] border-[#ff716c]/20 bg-[#ff716c]/[0.06]'
        : 'text-white border-white/10 bg-white/[0.03]'
  return (
    <div className={`min-w-28 rounded-md border px-4 py-3 ${color}`}>
      <div className="text-[10px] tracking-[0.12em] opacity-55">{label}</div>
      <div className="mt-1 font-mono text-[28px] font-semibold leading-none tabular-nums">{value}</div>
    </div>
  )
}

function BossMetric({
  label,
  value,
  unit,
  accent = false,
}: {
  label: string
  value: string
  unit: string
  accent?: boolean
}) {
  return (
    <div className="min-w-0 border-r border-white/[0.08] px-3 py-4 last:border-r-0 sm:px-5">
      <div className="text-[9px] font-semibold tracking-[0.12em] text-white/30">{label}</div>
      <div className={`mt-2 truncate font-mono text-[clamp(18px,2.3vw,26px)] font-semibold leading-none tabular-nums ${accent ? 'text-[#c9ff4a]' : 'text-white'}`} title={value}>
        {value}
      </div>
      <div className="mt-2 truncate text-[9px] text-white/25">{unit}</div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-white/15 bg-[#111714] px-6 py-24 text-center" data-testid="machines-empty">
      <div className="mx-auto h-3 w-3 rounded-full bg-[#c9ff4a] shadow-[0_0_32px_#c9ff4a]" />
      <h2 className="mt-6 text-2xl font-semibold">等待机床数据</h2>
      <p className="mt-3 text-sm text-white/40">采集器上传后，这里会自动出现所有机床。</p>
    </div>
  )
}

function bossStatus(machine: MachineView, nowMs: number): BossStatus {
  if (!isFresh(machine, nowMs)) {
    return {
      label: '采集断开', detail: '超过 90 秒没有新数据', running: false, attention: true,
      dot: 'bg-[#ff716c]', badge: 'border-[#ff716c]/30 bg-[#ff716c]/10 text-[#ff928d]', border: 'border-[#ff716c]/30',
    }
  }
  if (!machine.connected) {
    return {
      label: '机床未连接', detail: '采集电脑在线，当前无法读取控制器', running: false, attention: true,
      dot: 'bg-[#ff716c]', badge: 'border-[#ff716c]/30 bg-[#ff716c]/10 text-[#ff928d]', border: 'border-[#ff716c]/30',
    }
  }
  if (machine.executionState === 'running') {
    return {
      label: '正在加工', detail: '控制器确认循环运行中', running: true, attention: false,
      dot: 'bg-[#c9ff4a]', badge: 'border-[#c9ff4a]/30 bg-[#c9ff4a]/10 text-[#c9ff4a]', border: 'border-[#c9ff4a]/30',
    }
  }
  if (machine.executionState === 'paused') {
    return {
      label: '暂停', detail: '加工循环已暂停', running: false, attention: false,
      dot: 'bg-[#ffbd59]', badge: 'border-[#ffbd59]/30 bg-[#ffbd59]/10 text-[#ffd277]', border: 'border-[#ffbd59]/25',
    }
  }
  if (machine.state === 'error') {
    return {
      label: '采集异常', detail: '控制器返回了读取错误', running: false, attention: true,
      dot: 'bg-[#ff716c]', badge: 'border-[#ff716c]/30 bg-[#ff716c]/10 text-[#ff928d]', border: 'border-[#ff716c]/30',
    }
  }
  return {
    label: '待机', detail: machine.currentProgram ? '程序已装载，当前未运行' : '当前未运行', running: false, attention: false,
    dot: 'bg-[#7c8b84]', badge: 'border-white/10 bg-white/[0.04] text-white/60', border: 'border-white/10',
  }
}

function partBeingMade(machine: MachineView): { value: string; inferred: boolean } {
  if (machine.sourcePart?.trim()) return { value: machine.sourcePart.trim(), inferred: false }
  if (machine.currentProgram?.trim()) {
    const clean = machine.currentProgram.trim().split(/[\\/]/).pop()?.replace(/\.(?:nc|tap|cnc|txt)$/i, '')
    return { value: clean || machine.currentProgram.trim(), inferred: true }
  }
  return { value: '尚未识别加工件', inferred: false }
}

function usefulDuration(machine: MachineView): { label: string; value: string; unit: string } {
  if (machine.currentCycleSeconds != null && machine.currentCycleSeconds >= 0) {
    return { label: '本循环', value: formatClock(machine.currentCycleSeconds), unit: '控制器计时' }
  }
  if (machine.currentCuttingSeconds != null && machine.currentCuttingSeconds >= 0) {
    return { label: '加工时长', value: formatClock(machine.currentCuttingSeconds), unit: '控制器计时' }
  }
  return { label: '本循环', value: '—', unit: '未读取' }
}

function friendlyController(machine: MachineView) {
  const text = `${machine.manufacturer || ''} ${machine.controller || ''}`.toLowerCase()
  if (text.includes('mitsubishi') || text.includes('meldas')) return '三菱 CNC'
  if (text.includes('fanuc')) return 'FANUC CNC'
  if (machine.id.startsWith('lynuc-') || text.includes('lynuc')) return 'LYNUC CNC'
  return machine.controller || machine.manufacturer || 'CNC'
}

function shortError(value: string | null) {
  if (!value) return '控制器读取异常'
  if (value.includes('Fwlib32.dll')) return 'FANUC 读取组件尚未安装，机床数据暂不可读'
  if (value.length > 180) return `${value.slice(0, 180)}…`
  return value
}

function isFresh(machine: MachineView, nowMs: number) {
  const observed = Date.parse(machine.observedAt)
  return Number.isFinite(observed) && nowMs - observed < STALE_MS
}

function formatClock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const safe = Math.floor(seconds)
  const hours = Math.floor(safe / 3_600)
  const minutes = Math.floor((safe % 3_600) / 60)
  const remainder = safe % 60
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`
}

function relativeTime(iso: string | null, now: Date | null) {
  if (!iso || !now) return '—'
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1_000))
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 10) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟前`
  return `${Math.floor(seconds / 3_600)} 小时前`
}

function shanghaiClock(date: Date) {
  return date.toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}
