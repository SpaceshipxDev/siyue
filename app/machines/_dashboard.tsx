'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { withBase } from '@/lib/base-path'
import type { MachineEventView, MachineState, MachineView } from '@/lib/machines'

type DashboardData = {
  machines: MachineView[]
  events: MachineEventView[]
  serverTime: string
}

type ApiPayload = DashboardData & { ok: boolean; error?: string }

const POLL_MS = 10_000
const STALE_MS = 90_000
const NUMBER = new Intl.NumberFormat('zh-CN')

const STATE_META: Record<MachineState, { label: string; dot: string; tone: string }> = {
  programming: { label: '程序更新中', dot: 'bg-[#d6ff5f]', tone: 'text-[#d6ff5f]' },
  ready: { label: '程序就绪', dot: 'bg-[#68d7a8]', tone: 'text-[#68d7a8]' },
  idle: { label: '待机', dot: 'bg-[#8e99a8]', tone: 'text-[#aeb7c4]' },
  offline: { label: '离线', dot: 'bg-[#ff716c]', tone: 'text-[#ff8b86]' },
  error: { label: '采集异常', dot: 'bg-[#ffb454]', tone: 'text-[#ffc272]' },
  unknown: { label: '状态未知', dot: 'bg-[#8e99a8]', tone: 'text-[#aeb7c4]' },
}

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

  const totals = useMemo(() => {
    const time = now?.getTime() ?? Date.parse(data.serverTime)
    const online = data.machines.filter((m) => isFresh(m, time) && m.connected).length
    const programming = data.machines.filter(
      (m) => isFresh(m, time) && m.connected && m.state === 'programming',
    ).length
    const estimatedSeconds = data.machines.reduce(
      (sum, machine) => sum + (machine.estimatedDurationSeconds ?? 0),
      0,
    )
    const workedTodaySeconds = data.machines.reduce(
      (sum, machine) => sum + (machine.telemetrySource !== 'unavailable'
        ? machine.cuttingTodaySeconds
        : machine.workedTodaySeconds),
      0,
    )
    return { online, programming, estimatedSeconds, workedTodaySeconds }
  }, [data.machines, data.serverTime, now])

  return (
    <main className="min-h-screen bg-[#0a0d11] text-[#f2f0e9] selection:bg-[#d6ff5f] selection:text-black">
      <header className="border-b border-white/[0.09] px-5 py-5 md:px-10 md:py-7">
        <div className="mx-auto flex max-w-[1680px] flex-wrap items-end justify-between gap-6">
          <div className="w-full md:w-auto">
            <div className="flex items-center gap-3 text-[10px] font-semibold tracking-[0.24em] text-white/40">
              <Link href="/" className="transition-colors hover:text-white">思跃</Link>
              <span className="h-px w-6 bg-white/20" />
              <span>YINGMA MACHINE ROOM</span>
            </div>
            <h1 className="mt-3 text-[clamp(34px,5vw,68px)] font-semibold leading-none tracking-[-0.055em]">
              机床实时状态
            </h1>
          </div>
          <div className="grid w-full grid-cols-[0.75fr_1.5fr_0.75fr] items-end gap-4 md:w-auto md:flex md:gap-12">
            <HeaderMetric label="在线" value={`${totals.online}/${data.machines.length || 3}`} accent />
            <HeaderMetric label="今日累计" value={formatDayCounter(totals.workedTodaySeconds)} />
            <HeaderMetric label="程序更新" value={String(totals.programming)} />
            <div className="col-span-3 flex items-end justify-between border-t border-white/[0.08] pt-4 text-left md:block md:border-0 md:pt-0 md:text-right">
              <div className="font-mono text-[clamp(28px,3vw,46px)] font-medium leading-none tabular-nums">
                {now ? shanghaiClock(now) : '--:--:--'}
              </div>
              <div className="text-right text-[10px] tracking-[0.18em] text-white/35 md:mt-2">
                {userName} · {feedError ? '数据重连中' : '10 秒自动更新'}
              </div>
            </div>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-[1680px] px-5 py-6 md:px-10 md:py-10">
        {feedError && (
          <div className="mb-5 border border-[#ffb454]/25 bg-[#ffb454]/[0.07] px-4 py-3 text-sm text-[#ffc272]">
            云端数据暂时不可用，保留最后一次有效读数 · {feedError}
          </div>
        )}

        {data.machines.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid gap-4 xl:grid-cols-3" data-testid="machine-grid">
            {data.machines.map((machine) => (
              <MachineCard key={machine.id} machine={machine} now={now} />
            ))}
          </div>
        )}

        <div className="mt-8 grid gap-4 lg:grid-cols-[1.45fr_0.75fr]">
          <ProgramOverview machines={data.machines} />
          <EventFeed events={data.events} machines={data.machines} now={now} />
        </div>
      </section>
    </main>
  )
}

function MachineCard({ machine, now }: { machine: MachineView; now: Date | null }) {
  const stale = now ? !isFresh(machine, now.getTime()) : false
  const effectiveState: MachineState = stale ? 'offline' : machine.state
  const state = STATE_META[effectiveState]
  const controllerRunning = !stale && machine.executionState === 'running'
  const controllerCutting = controllerRunning && machine.workSignal === 'controller_cutting_timer'
  const completed = machine.completedParts
  const totalCompleted = machine.totalCompletedParts
  const target = machine.targetParts
  const exactTelemetry = machine.telemetrySource !== 'unavailable'

  return (
    <article
      className="overflow-hidden rounded-[3px] border border-white/[0.1] bg-[#11161d]"
      data-testid={`machine-card-${machine.id}`}
    >
      <div className="flex items-start justify-between border-b border-white/[0.08] px-5 py-5 md:px-6">
        <div>
          <div className="font-mono text-[10px] tracking-[0.14em] text-white/35">
            {machine.ip} · {machine.controller || machine.manufacturer || 'CNC'}
          </div>
          <h2 className="mt-2 text-2xl font-semibold tracking-[-0.035em]">{machine.name}</h2>
        </div>
        <div className={`flex items-center gap-2 text-[11px] font-medium ${controllerRunning ? 'text-[#d6ff5f]' : state.tone}`}>
          <span className={`h-2 w-2 rounded-full ${controllerRunning ? 'bg-[#d6ff5f]' : state.dot} ${controllerRunning || effectiveState === 'programming' ? 'animate-pulse' : ''}`} />
          {stale ? '采集离线' : controllerCutting ? '实际切削中' : controllerRunning ? '循环加工中' : state.label}
        </div>
      </div>

      <div className="grid grid-cols-[1.35fr_0.85fr] border-b border-white/[0.08] bg-[#0d1218]">
        <div className="border-r border-white/[0.08] px-5 py-5 md:px-6">
          <div className="text-[9px] font-semibold tracking-[0.16em] text-white/30">
            {exactTelemetry ? '今日实际切削 · 00:00 起' : '今日累计工作 · 00:00 起'}
          </div>
          <div className="mt-2 font-mono text-[clamp(28px,3vw,42px)] font-semibold leading-none tabular-nums text-[#d6ff5f]">
            {formatDayCounter(exactTelemetry ? machine.cuttingTodaySeconds : machine.workedTodaySeconds)}
          </div>
          <div className="mt-2 text-[10px] text-white/35">{workSignalLabel(machine)}</div>
        </div>
        <div className="px-4 py-5 md:px-5">
          <div className="text-[9px] font-semibold tracking-[0.16em] text-white/30">今日在线</div>
          <div className="mt-3 font-mono text-lg font-semibold tabular-nums text-white/75">
            {formatDayCounter(machine.onlineTodaySeconds)}
          </div>
          <div className="mt-2 text-[10px] text-white/30">上海日 · {machine.workDay}</div>
        </div>
      </div>

      <div className="min-h-[176px] border-b border-white/[0.08] px-5 py-6 md:px-6">
        <div className="text-[10px] font-semibold tracking-[0.18em] text-white/30">CURRENT PROGRAM</div>
        <div className="mt-3 break-all font-mono text-[clamp(25px,2.2vw,36px)] font-semibold leading-tight tracking-[-0.04em] text-[#d6ff5f]">
          {machine.currentProgram || '无主程序'}
        </div>
        <div className="mt-3 min-h-10 break-all text-[13px] leading-5 text-white/55">
          {machine.sourcePart ? (
            <><span className="text-white/30">源零件</span><span className="mx-2 text-white/15">/</span>{machine.sourcePart}</>
          ) : '尚未从程序头读取到源零件'}
        </div>
      </div>

      <div className="grid grid-cols-3 border-b border-white/[0.08]">
        <CardMetric label="本循环" value={formatExactDuration(machine.currentCycleSeconds)} />
        <CardMetric label="实际切削" value={formatExactDuration(machine.currentCuttingSeconds)} accent={exactTelemetry} />
        <CardMetric label="开机循环累计" value={formatExactDuration(machine.controllerBootCycleSeconds)} />
      </div>
      <div className="grid grid-cols-3 border-b border-white/[0.08]">
        <CardMetric label="预计加工" value={formatDuration(machine.estimatedDurationSeconds)} />
        <CardMetric label="工序 / 刀具" value={`${machine.operationCount ?? '—'} / ${machine.toolNumbers.length || '—'}`} />
        <CardMetric label="程序上线" value={elapsed(machine.jobStartedAt, now)} />
      </div>

      <div className="px-5 py-5 md:px-6">
        <div className="flex items-center justify-between text-[10px] tracking-[0.14em] text-white/30">
          <span>机床工作计数</span>
          <span className="font-mono tracking-normal text-white/55">
            {completed == null ? '等待控制器映射' : `${NUMBER.format(completed)} 件`}
          </span>
        </div>
        <div className="mt-3 flex items-center justify-between text-[10px] text-white/30">
          <span>机床设定上限 · 非工单要求</span>
          <span className="font-mono text-white/55">{target == null ? '—' : NUMBER.format(target)}</span>
        </div>
        <div className="mt-3 flex items-center justify-between text-[10px] text-white/30">
          <span>控制器原始累计</span>
          <span className="font-mono text-white/55">{totalCompleted == null ? '—' : NUMBER.format(totalCompleted)}</span>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 text-[10px] text-white/30">
          <span>自动发现</span>
          <span className="truncate font-mono text-white/45" title={machine.discoveredServices.map((service) => `${service.name}:${service.port}`).join(', ')}>
            {machine.discoveredServices.length
              ? machine.discoveredServices.map((service) => `${service.name}:${service.port}`).join(' · ')
              : machine.discoveryStatus}
          </span>
        </div>
        <div className="mt-5 flex items-center justify-between gap-4 text-[10px] text-white/30">
          <span>程序更新 {relativeTime(machine.programModifiedAt, now)}</span>
          <span>采集 {relativeTime(machine.observedAt, now)} · {machine.ftpLatencyMs == null ? '—' : `${machine.ftpLatencyMs}ms`}</span>
        </div>
        {machine.runtimeError && <p className="mt-3 text-xs text-[#ffc272]">运行数据：{machine.runtimeError}</p>}
        {machine.error && <p className="mt-3 text-xs text-[#ff9a75]">采集：{machine.error}</p>}
      </div>
    </article>
  )
}

function ProgramOverview({ machines }: { machines: MachineView[] }) {
  const maxOps = Math.max(1, ...machines.map((m) => m.operationCount ?? 0))
  return (
    <section className="rounded-[3px] border border-white/[0.1] bg-[#11161d] p-5 md:p-7">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <div className="text-[10px] font-semibold tracking-[0.2em] text-white/30">PROGRAM LOAD</div>
          <h2 className="mt-2 text-xl font-semibold tracking-[-0.025em]">当前可编程作业</h2>
        </div>
        <span className="text-[11px] text-white/30">来自 NC 程序头 · 非推测</span>
      </div>
      <div className="mt-6 divide-y divide-white/[0.07]">
        {machines.map((machine) => (
          <div key={machine.id} className="grid gap-4 py-4 md:grid-cols-[112px_1fr_100px_110px] md:items-center">
            <div>
              <div className="font-semibold">{machine.name}</div>
              <div className="mt-1 font-mono text-[10px] text-white/30">{machine.currentProgram || '—'}</div>
            </div>
            <div>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate text-white/60">{machine.sourcePart || '未识别源零件'}</span>
                <span className="font-mono text-white/35">{machine.operationCount ?? 0} OP</span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.07]">
                <div
                  className="h-full rounded-full bg-[#68d7a8]"
                  style={{ width: `${Math.round(((machine.operationCount ?? 0) / maxOps) * 100)}%` }}
                />
              </div>
            </div>
            <div className="font-mono text-sm text-white/70">{formatDuration(machine.estimatedDurationSeconds)}</div>
            <div className="text-right text-xs text-white/35">
              {machine.programSizeBytes == null ? '—' : formatBytes(machine.programSizeBytes)}
            </div>
          </div>
        ))}
        {machines.length === 0 && <p className="py-10 text-center text-sm text-white/30">等待采集器首次上传</p>}
      </div>
    </section>
  )
}

function EventFeed({
  events,
  machines,
  now,
}: {
  events: MachineEventView[]
  machines: MachineView[]
  now: Date | null
}) {
  const names = new Map(machines.map((machine) => [machine.id, machine.name]))
  return (
    <section className="rounded-[3px] border border-white/[0.1] bg-[#11161d] p-5 md:p-7">
      <div className="text-[10px] font-semibold tracking-[0.2em] text-white/30">LIVE EVENTS</div>
      <h2 className="mt-2 text-xl font-semibold tracking-[-0.025em]">机床动态</h2>
      <div className="mt-5 divide-y divide-white/[0.07]">
        {events.slice(0, 8).map((event) => (
          <div key={event.id} className="py-3.5">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-medium">{names.get(event.machineId) || event.machineId}</span>
              <span className="font-mono text-[10px] text-white/30">{relativeTime(event.observedAt, now)}</span>
            </div>
            <p className="mt-1 truncate text-xs text-white/45">
              {eventLabel(event.eventType)}
              {event.programName ? ` · ${event.programName}` : ''}
              {event.sourcePart ? ` · ${event.sourcePart}` : ''}
            </p>
          </div>
        ))}
        {events.length === 0 && <p className="py-10 text-center text-sm text-white/30">暂无机床动态</p>}
      </div>
    </section>
  )
}

function EmptyState() {
  return (
    <div className="rounded-[3px] border border-dashed border-white/[0.15] bg-[#11161d] px-6 py-24 text-center" data-testid="machines-empty">
      <div className="mx-auto h-3 w-3 rounded-full bg-[#d6ff5f] shadow-[0_0_32px_#d6ff5f]" />
      <h2 className="mt-6 text-2xl font-semibold tracking-[-0.03em]">等待 Windows 采集器</h2>
      <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-white/40">
        采集器上线后，这里会自动出现 FANUC、三菱和 LYNUC 机床的程序、源零件、工序数、预计时长与连接状态。
        每台机床的今日工作和在线时间从上海时间 00:00 重新累计。
      </p>
    </div>
  )
}

function HeaderMetric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="text-left md:text-right">
      <div className="text-[10px] tracking-[0.18em] text-white/30">{label}</div>
      <div className={`mt-1 font-mono text-[clamp(22px,7vw,30px)] font-semibold leading-none tabular-nums ${accent ? 'text-[#d6ff5f]' : ''}`}>{value}</div>
    </div>
  )
}

function CardMetric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-h-20 border-r border-white/[0.08] px-4 py-4 last:border-r-0">
      <div className="text-[9px] font-semibold tracking-[0.15em] text-white/25">{label}</div>
      <div className={`mt-2 truncate font-mono text-[13px] font-medium ${accent ? 'text-[#d6ff5f]' : 'text-white/75'}`} title={value}>{value}</div>
    </div>
  )
}

function isFresh(machine: MachineView, nowMs: number) {
  const observed = Date.parse(machine.observedAt)
  return Number.isFinite(observed) && nowMs - observed < STALE_MS
}

function formatDuration(seconds: number | null) {
  if (seconds == null || seconds <= 0) return '—'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes.toString().padStart(2, '0')}m` : `${minutes}m`
}

function formatDayCounter(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const hours = Math.floor(safe / 3_600)
  const minutes = Math.floor((safe % 3_600) / 60)
  const remainder = safe % 60
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`
}

function workSignalLabel(machine: MachineView) {
  if (machine.workSignal === 'mtconnect_execution') return 'MTConnect Execution · 控制器实时状态'
  if (machine.workSignal === 'controller_cutting_timer') {
    return machine.executionState === 'running'
      ? 'LYNUC #33565 正在增加 · 控制器确认切削中'
      : 'LYNUC #33565 当前未增加 · 未在切削'
  }
  if (machine.telemetrySource === 'controller_macro_auto') {
    return `LYNUC 自动锁定 · ${machine.discoveryConfidence}% 置信度`
  }
  if (machine.telemetrySource === 'controller_macro') return 'LYNUC #33565 · 控制器实际切削时间'
  if (machine.workSignal === 'controller_cycle') return 'CNC CycleStart · 控制器确认'
  if (machine.workSignal === 'program_activity') return '程序活动 · 保守累计'
  return '等待控制器运行信号映射'
}

function formatExactDuration(seconds: number | null) {
  if (seconds == null || seconds < 0) return '—'
  return formatDayCounter(seconds)
}

function elapsed(iso: string | null, now: Date | null) {
  if (!iso || !now) return '—'
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1_000))
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3_600)}h`
}

function relativeTime(iso: string | null, now: Date | null) {
  if (!iso || !now) return '—'
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1_000))
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 10) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} 小时前`
  return `${Math.floor(seconds / 86_400)} 天前`
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

function formatBytes(bytes: number) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${Math.round(bytes / 1_000)} KB`
}

function eventLabel(type: MachineEventView['eventType']) {
  switch (type) {
    case 'first_seen': return '采集器发现机床'
    case 'program_changed': return '主程序更新'
    case 'state_changed': return '状态变化'
    case 'connected': return '恢复在线'
    case 'disconnected': return '连接中断'
  }
}
