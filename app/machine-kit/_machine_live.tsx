'use client'

import { useCallback, useEffect, useState } from 'react'
import type { LynucMachineSnapshot } from '@/lib/lynuc'

type Payload = { machines: LynucMachineSnapshot[]; sampledAt: string }

export function MachineLive() {
  const [payload, setPayload] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(true)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const response = await fetch('/api/lynuc', { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setPayload(await response.json())
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取失败')
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0)
    const timer = window.setInterval(() => void refresh(), 5_000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [refresh])

  return (
    <main className="min-h-screen bg-[#f4f3ef] text-[#171713]">
      <header className="border-b border-black/10 bg-[#eeede8] px-5 py-5 md:px-10">
        <div className="mx-auto flex max-w-[1500px] items-end justify-between gap-6">
          <div>
            <div className="mb-2 font-mono text-[10px] tracking-[0.2em] text-black/45">YINGMA · LOCAL EDGE</div>
            <h1 className="text-3xl font-semibold tracking-[-0.04em] md:text-5xl">机床实时采集</h1>
            <p className="mt-2 text-sm text-black/55">LYNUC · 只读 FTP · 每 5 秒刷新</p>
          </div>
          <button
            onClick={() => void refresh()}
            className="border border-black/20 bg-white px-4 py-2 font-mono text-xs hover:bg-black hover:text-white"
          >
            {refreshing ? '读取中…' : '立即刷新'}
          </button>
        </div>
      </header>

      <section className="mx-auto max-w-[1500px] p-5 md:p-10">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-black/45">
          <span>真实数据源 · 无演示值</span>
          <span>{payload ? `采样 ${formatDate(payload.sampledAt)}` : '等待首次采样'}</span>
        </div>
        {error && <div className="mb-5 border border-red-700/30 bg-red-50 p-3 text-sm text-red-800">采集器：{error}</div>}
        <div className="grid gap-px bg-black/15 lg:grid-cols-2">
          {(payload?.machines ?? []).map((machine) => (
            <MachineCard key={machine.id} machine={machine} />
          ))}
          {!payload && <div className="col-span-2 min-h-80 bg-white p-8 text-black/45">正在连接机床…</div>}
        </div>
      </section>
    </main>
  )
}

function MachineCard({ machine }: { machine: LynucMachineSnapshot }) {
  const latest = machine.latestProgram
  return (
    <article className="bg-white">
      <div className="flex items-start justify-between border-b border-black/10 p-5 md:p-7">
        <div>
          <div className="font-mono text-[11px] text-black/45">{machine.ip}</div>
          <h2 className="mt-1 text-2xl font-semibold tracking-[-0.03em]">{machine.name}</h2>
        </div>
        <div className={`flex items-center gap-2 font-mono text-xs ${machine.connected ? 'text-emerald-700' : 'text-red-700'}`}>
          <span className={`h-2 w-2 rounded-full ${machine.connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
          {machine.connected ? `在线 · ${machine.latencyMs}ms` : '离线'}
        </div>
      </div>

      {!machine.connected ? (
        <div className="min-h-96 p-7 text-sm text-red-700">{machine.error ?? '无法连接'}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 border-b border-black/10 md:grid-cols-4">
            <Metric label="最新程序" value={latest?.name ?? '—'} wide />
            <Metric label="程序文件" value={String(machine.programCount)} />
            <Metric label="G-code 段" value={formatNumber(latest?.blockCount)} />
          </div>
          <div className="grid grid-cols-2 border-b border-black/10 md:grid-cols-4">
            <Metric label="程序号" value={latest?.programNumber ?? '—'} />
            <Metric label="刀具" value={latest?.toolNumbers.length ? latest.toolNumbers.map((v) => `T${v}`).join(' · ') : '—'} />
            <Metric label="S 指令" value={range(latest?.spindleCommands, 'rpm')} />
            <Metric label="F 指令" value={range(latest?.feedCommands, 'mm/min')} />
          </div>

          <div className="border-b border-black/10 p-5 md:p-7">
            <div className="mb-3 font-mono text-[10px] tracking-[0.16em] text-black/40">LATEST VERIFIED UPDATE</div>
            <div className="break-all text-lg font-medium">{latest?.name ?? '无 NC 文件'}</div>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-black/45">
              <span>{formatBytes(latest?.sizeBytes ?? 0)}</span>
              <span>{latest?.modifiedAt ? formatDate(latest.modifiedAt) : '时间未知'}</span>
            </div>
            {latest?.camSource && <div className="mt-3 break-all border-l-2 border-black/20 pl-3 font-mono text-[11px] text-black/55">{latest.camSource}</div>}
          </div>

          <div className="grid md:grid-cols-[1fr_1.05fr]">
            <div className="border-b border-black/10 p-5 md:border-b-0 md:border-r md:p-7">
              <div className="mb-4 font-mono text-[10px] tracking-[0.16em] text-black/40">RECENT PROGRAM UPDATES</div>
              <div className="space-y-3">
                {machine.recentPrograms.slice(0, 6).map((program) => (
                  <div key={`${program.name}-${program.modifiedAt}`} className="grid grid-cols-[1fr_auto] gap-3 border-b border-black/5 pb-2 text-sm">
                    <span className="truncate font-medium">{program.name}</span>
                    <span className="font-mono text-[10px] text-black/40">{program.modifiedAt ? shortDate(program.modifiedAt) : '—'}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="p-5 md:p-7">
              <div className="mb-4 font-mono text-[10px] tracking-[0.16em] text-black/40">CONTROLLER TELEMETRY</div>
              <div className="grid grid-cols-2 gap-px bg-black/10">
                <Unavailable label="运行状态" />
                <Unavailable label="当前执行程序" />
                <Unavailable label="完成 / 目标件数" />
                <Unavailable label="运行 / 加工时间" />
                <Unavailable label="实际主轴 / 进给" />
                <Unavailable label="当前刀具 / 报警" />
              </div>
              <p className="mt-4 text-xs leading-5 text-black/45">控制器遥测端口当前不可读；界面不使用推测值。FTP 程序与更新时间为机床实时读取。</p>
            </div>
          </div>
        </>
      )}
    </article>
  )
}

function Metric({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return <div className={`min-h-24 border-r border-black/10 p-4 last:border-r-0 ${wide ? 'col-span-2' : ''}`}><div className="font-mono text-[10px] text-black/40">{label}</div><div className="mt-3 break-all text-sm font-semibold">{value}</div></div>
}

function Unavailable({ label }: { label: string }) {
  return <div className="bg-[#f8f7f3] p-3"><div className="text-xs text-black/50">{label}</div><div className="mt-2 font-mono text-[11px] text-black/35">未开放</div></div>
}

function range(values: number[] | undefined, unit: string) {
  if (!values?.length) return '—'
  const min = Math.min(...values)
  const max = Math.max(...values)
  return `${min === max ? min : `${min}–${max}`} ${unit}`
}

function formatNumber(value: number | null | undefined) { return value == null ? '—' : value.toLocaleString('zh-CN') }
function formatBytes(value: number) { return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)} MB` : `${Math.round(value / 1_000)} KB` }
function formatDate(value: string) { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) }
function shortDate(value: string) { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) }
