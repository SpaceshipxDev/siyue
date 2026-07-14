'use client'

import { useCallback, useRef, useState } from 'react'
import { withBase } from '@/lib/base-path'
import { downscaleToJpeg } from '../_camera'

type Candidate = {
  token: string
  name: string
  partNo?: string
  drawingNo?: string
  qty: number
  dueDate?: string
}

type MatchJson =
  | { decision: 'match'; token: string; latencyMs?: number }
  | { decision: 'ambiguous'; candidates: Candidate[]; latencyMs?: number }
  | { decision: 'no_match'; latencyMs?: number }

const VALVE_STAGES = ['OP1', 'OP2', 'OP3', 'OP4', 'OP5', 'OP6', '铣床', '出货']

function mdCn(value?: string) {
  if (!value) return ''
  const [, month, day] = value.slice(0, 10).split('-')
  return `${Number(month)}月${Number(day)}日`
}

// One button, the phone's own camera. The native camera app focuses,
// stabilizes, and multi-frame-fuses the still — a getUserMedia video frame
// grab does none of that, and blurry input sinks both the matcher and the
// OCR fallback. The gallery input covers photos taken earlier.
export function ScanClient({ workerName }: { workerName?: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<'idle' | 'busy' | 'pick' | 'miss' | 'valve' | 'sent'>('idle')
  const [photo, setPhoto] = useState<Blob | null>(null)
  const [preview, setPreview] = useState<string>()
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [latency, setLatency] = useState<number>()
  const [error, setError] = useState<string>()

  const clearPhoto = useCallback(() => {
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current)
      return undefined
    })
    setPhoto(null)
    setCandidates([])
    setLatency(undefined)
    setError(undefined)
  }, [])

  // Must stay synchronous inside the tap handler — browsers only honor
  // programmatic input clicks within a user gesture.
  function openCamera() {
    clearPhoto()
    setPhase('idle')
    inputRef.current?.click()
  }

  async function match(blob: Blob) {
    setPhase('busy')
    setError(undefined)
    try {
      const body = new FormData()
      body.append('image', blob, 'job-photo.jpg')
      const response = await fetch(withBase('/api/match-photo'), { method: 'POST', body })
      if (!response.ok) throw new Error()
      const result = (await response.json()) as MatchJson
      setLatency(result.latencyMs)
      if (result.decision === 'match') {
        navigator.vibrate?.(80)
        window.location.href = withBase(`/s/${result.token}?via=photo`)
        return
      }
      if (result.decision === 'ambiguous' && result.candidates.length > 0) {
        setCandidates(result.candidates)
        setPhase('pick')
        return
      }
      setPhase('miss')
    } catch {
      setError('网络不稳定，请重拍')
      setPhase('miss')
    }
  }

  async function onPick(input: HTMLInputElement) {
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    clearPhoto()
    try {
      const blob = await downscaleToJpeg(file, 1600, 0.8)
      setPhoto(blob)
      setPreview(URL.createObjectURL(blob))
      await match(blob)
    } catch {
      setError('照片读取失败，请重拍')
      setPhase('idle')
    }
  }

  // Mounted in every branch so a tap on 重拍/扫下一单 can open the camera
  // from any screen.
  const pickers = (
    <>
      <input ref={inputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(event) => void onPick(event.currentTarget)} />
      <input ref={galleryRef} type="file" accept="image/*" className="hidden" onChange={(event) => void onPick(event.currentTarget)} />
    </>
  )

  if (phase === 'sent') {
    return (
      <div className="mx-auto max-w-md px-4 py-6">
        <section className="rounded-[8px] border border-[var(--color-success)] bg-[var(--color-success-soft)] p-8 text-center">
          <p className="text-[20px] font-semibold text-[var(--color-success)]">✓ 已记上</p>
          <p className="mt-2 text-[12px] text-[var(--color-ink-2)]">跟单员会把照片归档。</p>
        </section>
        <button onClick={openCamera} className="mt-4 h-16 w-full rounded-[8px] bg-[var(--color-ink)] text-[17px] font-semibold text-white">
          扫下一单
        </button>
        {pickers}
      </div>
    )
  }

  if (phase === 'valve') {
    return (
      <div className="mx-auto max-w-md px-4 py-5">
        <ValveForm photo={photo} preview={preview} workerName={workerName}
          onSent={() => setPhase('sent')} onBack={() => setPhase('miss')} />
      </div>
    )
  }

  if (phase === 'pick') {
    return (
      <div className="mx-auto max-w-md space-y-2 px-4 py-5">
        <div className="mb-3">
          <h1 className="text-[18px] font-semibold">请选择这张单</h1>
          <p className="mt-1 text-[12px] text-[var(--color-ink-2)]">有几张很像，对一下数量或交期。</p>
        </div>
        {candidates.map((candidate) => (
          <a key={candidate.token} href={withBase(`/s/${candidate.token}?via=photo`)}
            className="block rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-4 active:bg-[var(--color-muted-bg)]">
            <p className="text-[16px] font-semibold">{candidate.name}</p>
            <p className="mt-1 font-mono text-[11px] text-[var(--color-ink-3)]">{candidate.partNo || candidate.drawingNo}</p>
            <p className="mt-3 text-[13px]"><b>{candidate.qty} 件</b>{candidate.dueDate ? ` · 交期 ${mdCn(candidate.dueDate)}` : ''}</p>
          </a>
        ))}
        <button onClick={openCamera} className="mt-3 h-12 w-full rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold">都不是 · 重拍</button>
        {pickers}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md px-4 py-5">
      {pickers}

      {phase === 'idle' ? (
        <>
          <section className="flex h-[58dvh] flex-col items-center justify-center rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] px-6 text-center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-14 w-14 text-[var(--color-ink-3)]" aria-hidden>
              <path d="M4 7h3l2-2.5h6L17 7h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" />
              <circle cx="12" cy="13.5" r="3.5" />
            </svg>
            <p className="mt-5 text-[17px] font-semibold">拍工单纸，自动认单</p>
            <p className="mt-2 text-[12px] text-[var(--color-ink-2)]">图纸、程序单都可以 · 对准整张纸</p>
          </section>
          {error ? <p className="mt-3 text-center text-[12px] text-[var(--color-overdue)]">{error}</p> : null}
          <button onClick={openCamera} className="mt-4 h-20 w-full rounded-[10px] bg-[var(--color-ink)] text-[19px] font-semibold text-white">拍照识别</button>
          <button onClick={() => galleryRef.current?.click()} className="mt-2 h-12 w-full text-[13px] font-medium text-[var(--color-ink-2)]">从相册选择</button>
        </>
      ) : phase === 'busy' ? (
        <>
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="正在识别的工单照片" className="max-h-[55dvh] w-full rounded-[10px] border border-[var(--color-border-strong)] bg-black object-contain" />
          ) : null}
          <div className="py-8 text-center">
            <p className="text-[17px] font-semibold">正在识别…</p>
            <p className="mt-2 text-[12px] text-[var(--color-ink-3)]">请稍候</p>
          </div>
        </>
      ) : (
        <div className="pt-4 text-center">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="未匹配的工单照片" className="max-h-[45dvh] w-full rounded-[10px] border border-[var(--color-border-strong)] bg-black object-contain" />
          ) : null}
          <h1 className="mt-4 text-[18px] font-semibold text-[var(--color-overdue)]">没有找到对应工单</h1>
          <p className="mt-1 text-[12px] text-[var(--color-ink-2)]">请重拍，或在工单记录中搜索并添加这类照片。</p>
          {error ? <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p> : null}
          {latency != null ? <p className="mt-1 text-[10px] text-[var(--color-ink-4)]">识别用时 {(latency / 1000).toFixed(1)} 秒</p> : null}
          <button onClick={openCamera} className="mt-4 h-14 w-full rounded-[8px] bg-[var(--color-ink)] text-[16px] font-semibold text-white">重拍</button>
          <button onClick={() => setPhase('valve')} className="mt-2 h-12 w-full rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold">先保存，稍后归档</button>
        </div>
      )}
    </div>
  )
}

function ValveForm({ photo, preview, workerName, onSent, onBack }: {
  photo: Blob | null
  preview?: string
  workerName?: string
  onSent: () => void
  onBack: () => void
}) {
  const [stage, setStage] = useState('')
  const [qty, setQty] = useState('')
  const [name, setName] = useState(workerName || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function submit() {
    const count = Number.parseInt(qty, 10)
    if (!photo || !stage || !name.trim() || !Number.isFinite(count) || count < 1) {
      setError('请选择工序，并填写件数和姓名')
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const body = new FormData()
      body.append('image', photo, 'unmatched.jpg')
      body.append('stage', stage)
      body.append('qty', String(count))
      body.append('name', name.trim())
      const response = await fetch(withBase('/api/unmatched-report'), { method: 'POST', body })
      if (!response.ok) throw new Error()
      onSent()
    } catch {
      setError('保存失败，请再试一次')
      setBusy(false)
    }
  }

  return (
    <section className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center gap-3">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="未匹配照片" className="h-16 w-16 rounded-[5px] object-cover" />
        ) : null}
        <div><h1 className="text-[16px] font-semibold">保存待归档</h1><p className="mt-1 text-[11px] text-[var(--color-ink-2)]">补三项，件数会记到你名下。</p></div>
      </div>
      <p className="mt-4 text-[13px] font-semibold">哪道工序？</p>
      {/* Same tick-row grammar as /s/[token]: empty square = pickable, ink
          tick = your choice. Green stays reserved for 完成/save. */}
      <div className="mt-2 space-y-1.5">
        {VALVE_STAGES.map((value) => {
          const active = stage === value
          return (
            <button
              key={value}
              type="button"
              onClick={() => setStage(value)}
              className={`flex w-full items-center gap-3 h-12 px-3 rounded-[5px] text-left ${active ? 'border-2 border-[var(--color-ink)] bg-[color-mix(in_srgb,var(--color-ink)_4%,transparent)]' : 'border border-[var(--color-border-strong)] bg-[var(--color-surface)] active:bg-[var(--color-muted-bg)]'}`}
            >
              <span className={`w-5 h-5 shrink-0 rounded-[3px] flex items-center justify-center text-[12px] font-bold ${active ? 'bg-[var(--color-ink)] text-white' : 'border-2 border-[var(--color-border-strong)]'}`}>{active ? '✓' : ''}</span>
              <span className={`text-[14px] ${active ? 'font-semibold' : 'font-medium'}`}>{value}</span>
            </button>
          )
        })}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <input value={qty} onChange={(event) => setQty(event.target.value)} type="number" inputMode="numeric" placeholder="完成件数" className="h-12 min-w-0 rounded-[5px] border border-[var(--color-border-strong)] px-3 text-[16px]" />
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={20} placeholder="姓名" className="h-12 min-w-0 rounded-[5px] border border-[var(--color-border-strong)] px-3 text-[16px]" />
      </div>
      {error ? <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p> : null}
      <button onClick={() => void submit()} disabled={busy} className="mt-3 h-14 w-full rounded-[8px] bg-[var(--color-success)] text-[16px] font-semibold text-white disabled:opacity-60">{busy ? '保存中…' : '保存'}</button>
      <button onClick={onBack} disabled={busy} className="mt-2 h-11 w-full text-[13px] text-[var(--color-ink-2)]">返回</button>
    </section>
  )
}
