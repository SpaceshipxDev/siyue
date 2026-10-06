'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { withBase } from '@/lib/base-path'

// 喷漆格子要知道底漆 / 面漆做到哪一步 (lib/spray-steps)。一页上几十上百个喷漆
// 格子, 不能一格一请求: 同一刻要的工单并成一批去拿, 拿回来放在这里, 格子从这
// 里读; 点了底漆先在这里改掉, 屏幕马上跟着变。

export type StepMark = { by: string; at: string }
export type PartSteps = { 底漆?: StepMark; 面漆?: StepMark }

const store = new Map<string, PartSteps>()
const loaded = new Set<string>()
const listeners = new Set<() => void>()
let version = 0
let queued = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null

function emit() {
  version += 1
  for (const l of listeners) l()
}

function request(jobId: string) {
  if (loaded.has(jobId)) return
  loaded.add(jobId)
  queued.add(jobId)
  if (timer) return
  timer = setTimeout(() => {
    const jobs = [...queued]
    queued = new Set()
    timer = null
    fetch(withBase(`/api/spray-steps?jobs=${encodeURIComponent(jobs.join(','))}`), {
      cache: 'no-store',
    })
      .then((r) => r.json())
      .then((d: { ok?: boolean; steps?: Record<string, PartSteps> }) => {
        if (!d.ok || !d.steps) return
        for (const [k, v] of Object.entries(d.steps)) store.set(k, v)
        emit()
      })
      .catch(() => {
        for (const j of jobs) loaded.delete(j)
      })
  }, 30)
}

export function setLocalStep(
  jobId: string,
  componentId: string,
  step: '底漆' | '面漆',
  mark: StepMark | null,
) {
  const k = `${jobId}|${componentId}`
  const cur = { ...(store.get(k) ?? {}) }
  if (mark) cur[step] = mark
  else delete cur[step]
  store.set(k, cur)
  emit()
}

export function useSpraySteps(jobId: string, componentId: string, enabled: boolean): PartSteps {
  useEffect(() => {
    if (enabled) request(jobId)
  }, [enabled, jobId])
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => version,
    () => 0,
  )
  return (enabled && store.get(`${jobId}|${componentId}`)) || {}
}
