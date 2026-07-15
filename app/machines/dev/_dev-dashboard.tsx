'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { withBase } from '@/lib/base-path'
import type { MachineCapability, MachineEventView, MachineView } from '@/lib/machines'

type DashboardData = { machines: MachineView[]; events: MachineEventView[]; serverTime: string }
type ApiPayload = DashboardData & { ok: boolean; error?: string }

const FIELD_LABELS: Record<string, string> = {
  identity: '身份 / IP',
  execution: '程序运行状态',
  programName: '当前程序名',
  programSource: 'NC 源代码',
  partCount: '完成件数',
  cycleDuration: '循环时间',
}

export function MachineDevDashboard({ initial }: { initial: DashboardData }) {
  const [data, setData] = useState(initial)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const response = await fetch(withBase('/api/machines'), { cache: 'no-store' })
        const payload = (await response.json()) as ApiPayload
        if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`)
        if (active) { setData(payload); setError(null) }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : '读取失败')
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 10_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  return (
    <main className="min-h-screen bg-[#070a0d] px-4 py-6 text-[#eef1eb] md:px-8 md:py-10">
      <div className="mx-auto max-w-[1800px]">
        <header className="flex flex-wrap items-end justify-between gap-5 border-b border-white/10 pb-7">
          <div>
            <div className="font-mono text-[10px] tracking-[0.22em] text-[#7ee2b8]">READ-ONLY CNC NETWORK LAB</div>
            <h1 className="mt-2 text-4xl font-semibold tracking-[-0.045em] md:text-6xl">机床全字段读取</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-white/45">
              这里明确区分“现在能读”和“控制器接口没有开放”。绿色字段来自开放的 FTP、Modbus TCP 或 MTConnect 读取；黄色字段需要控制器已有的 OEM 接口。
            </p>
          </div>
          <div className="text-right text-xs text-white/35">
            <Link href="/machines" className="text-[#7ee2b8] hover:underline">返回生产看板</Link>
            <div className="mt-2">10 秒刷新 · {new Date(data.serverTime).toLocaleString('zh-CN')}</div>
          </div>
        </header>

        {error && <div className="mt-5 border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-sm text-amber-200">云端读取重试中：{error}</div>}
        {data.machines.length === 0 ? (
          <div className="mt-8 border border-dashed border-white/15 p-10 text-center text-white/45">Windows 采集器还没有上传任何机床。先运行一次安装包里的网络发现命令。</div>
        ) : (
          <div className="mt-7 grid gap-5 xl:grid-cols-2">
            {data.machines.map((machine) => <MachineDevCard key={machine.id} machine={machine} />)}
          </div>
        )}
      </div>
    </main>
  )
}

function MachineDevCard({ machine }: { machine: MachineView }) {
  const services = machine.discoveredServices.map((service) => `${service.name}:${service.port}`).join(' · ')
  return (
    <article className="overflow-hidden border border-white/10 bg-[#0e1318]">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 px-5 py-5">
        <div>
          <div className="font-mono text-xs text-[#7ee2b8]">{machine.ip} · {machine.driver.toUpperCase()}</div>
          <h2 className="mt-2 text-2xl font-semibold">{machine.name}</h2>
          <div className="mt-1 text-xs text-white/40">
            {[machine.manufacturer, machine.model, machine.controller].filter(Boolean).join(' · ') || '制造商尚未从开放接口返回'}
          </div>
        </div>
        <div className={`border px-3 py-1.5 text-xs ${machine.connected ? 'border-[#7ee2b8]/35 text-[#7ee2b8]' : 'border-red-300/30 text-red-300'}`}>
          {machine.connected ? '网络可读' : '当前不可达'} · {machine.discoveryConfidence}%
        </div>
      </div>

      <div className="grid grid-cols-2 border-b border-white/10 md:grid-cols-4">
        <Value label="当前程序" value={machine.currentProgram} />
        <Value label="运行状态" value={executionLabel(machine)} />
        <Value label="完成 / 目标" value={`${displayNumber(machine.completedParts)} / ${displayNumber(machine.targetParts)}`} />
        <Value label="当前循环" value={formatSeconds(machine.currentCycleSeconds)} />
      </div>

      <div className="p-5">
        <div className="text-[10px] font-semibold tracking-[0.18em] text-white/35">字段能力矩阵</div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(machine.capabilities).length > 0 ? Object.entries(machine.capabilities).map(([key, capability]) => (
            <Capability key={key} field={FIELD_LABELS[key] || key} capability={capability} />
          )) : <div className="col-span-full border border-amber-300/20 bg-amber-300/[0.05] px-3 py-3 text-xs text-amber-200">等待采集器 3.0 上传接口能力</div>}
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <Info label="发现的只读入口" value={services || '没有发现允许列表中的端口'} />
          <Info label="判断依据" value={machine.discoveryNotes.join('；') || machine.discoveryStatus} />
          <Info label="源零件" value={machine.sourcePartPath || machine.sourcePart || '未读到'} />
          <Info label="程序时间 / 大小" value={`${machine.programModifiedAt ? new Date(machine.programModifiedAt).toLocaleString('zh-CN') : '未知'} · ${machine.programSizeBytes == null ? '未知大小' : `${machine.programSizeBytes.toLocaleString()} B`}`} />
        </div>

        <details className="mt-5 border border-white/10 bg-black/25" open={Boolean(machine.programSource)}>
          <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-white/60">
            NC 源代码 {machine.programSource ? `· SHA-256 ${machine.programSourceSha256?.slice(0, 12) || '未计算'}` : '· 当前接口没有返回'}
          </summary>
          {machine.programSource ? (
            <pre className="max-h-[480px] overflow-auto border-t border-white/10 p-4 font-mono text-[11px] leading-5 text-[#c9f7dd]">
              {machine.programSource}{machine.programSourceTruncated ? '\n\n[采集器按安全上限截断；原文件仍未被修改]' : ''}
            </pre>
          ) : (
            <p className="border-t border-white/10 p-4 text-xs leading-5 text-white/40">MTConnect 通常只提供状态和计数，不定义 NC 文件下载。只有控制器已经开放只读 FTP，或另有已配置的文件接口，源码才会出现在这里。</p>
          )}
        </details>
      </div>
    </article>
  )
}

function Capability({ field, capability }: { field: string; capability: MachineCapability }) {
  return (
    <div className={`border px-3 py-3 ${capability.readable ? 'border-[#7ee2b8]/25 bg-[#7ee2b8]/[0.05]' : 'border-amber-300/20 bg-amber-300/[0.04]'}`}>
      <div className={`text-xs font-semibold ${capability.readable ? 'text-[#7ee2b8]' : 'text-amber-200'}`}>{capability.readable ? '可读' : '未开放'} · {field}</div>
      <div className="mt-1 font-mono text-[10px] text-white/40">{capability.source}</div>
      <p className="mt-2 text-[11px] leading-4 text-white/45">{capability.note}</p>
    </div>
  )
}

function Value({ label, value }: { label: string; value: string | null }) {
  return <div className="min-w-0 border-r border-white/10 px-4 py-4 last:border-r-0"><div className="text-[9px] tracking-[0.14em] text-white/30">{label}</div><div className="mt-2 truncate font-mono text-sm text-white/80" title={value || ''}>{value || '—'}</div></div>
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[9px] tracking-[0.14em] text-white/30">{label}</div><div className="mt-1 break-all text-xs leading-5 text-white/55">{value}</div></div>
}

function executionLabel(machine: MachineView) {
  if (machine.executionState === 'running') return '正在运行'
  if (machine.executionState === 'paused') return '暂停'
  if (machine.executionState === 'stopped') return '停止'
  return '接口未返回'
}

function displayNumber(value: number | null) { return value == null ? '—' : value.toLocaleString() }
function formatSeconds(value: number | null) {
  if (value == null) return '—'
  const seconds = Math.max(0, Math.floor(value))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`
}
