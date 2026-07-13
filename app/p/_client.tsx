'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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

// The camera is the page: open directly into a live viewfinder, then one tap
// captures a still and starts matching. The file input is only a compatibility
// fallback for older embedded browsers without getUserMedia.
export function ScanClient({ workerName }: { workerName?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const cameraRequestRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<'boot' | 'live' | 'busy' | 'fallback' | 'pick' | 'miss' | 'valve' | 'sent'>('boot')
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

  const stopCamera = useCallback(() => {
    cameraRequestRef.current += 1
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [])

  const startCamera = useCallback(async () => {
    clearPhoto()
    stopCamera()
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase('fallback')
      return
    }
    setPhase('boot')
    const requestId = cameraRequestRef.current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1440 },
        },
        audio: false,
      })
      if (requestId !== cameraRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      setPhase('live')
    } catch {
      setPhase('fallback')
    }
  }, [clearPhoto, stopCamera])

  useEffect(() => {
    const timer = window.setTimeout(() => void startCamera(), 0)
    return () => {
      window.clearTimeout(timer)
      stopCamera()
    }
  }, [startCamera, stopCamera])

  useEffect(() => {
    if (phase !== 'live' || !videoRef.current || !streamRef.current) return
    videoRef.current.srcObject = streamRef.current
    void videoRef.current.play().catch(() => {})
  }, [phase])

  async function match(blob: Blob) {
    setPhase('busy')
    setError(undefined)
    try {
      const body = new FormData()
      body.append('image', blob, 'drawing.jpg')
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

  function snap() {
    const video = videoRef.current
    if (!video || video.readyState < 2 || video.videoWidth === 0) return
    const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((blob) => {
      if (!blob) {
        setError('照片读取失败，请重拍')
        return
      }
      stopCamera()
      setPhoto(blob)
      setPreview(URL.createObjectURL(blob))
      void match(blob)
    }, 'image/jpeg', 0.8)
  }

  async function onPick(files: FileList | null) {
    const file = files?.[0]
    if (inputRef.current) inputRef.current.value = ''
    if (!file) return
    try {
      const blob = await downscaleToJpeg(file, 1600, 0.8)
      setPhoto(blob)
      setPreview(URL.createObjectURL(blob))
      await match(blob)
    } catch {
      setError('照片读取失败，请重拍')
      setPhase('fallback')
    }
  }

  if (phase === 'sent') {
    return (
      <div className="mx-auto max-w-md px-4 py-6">
        <section className="rounded-[8px] border border-[var(--color-success)] bg-[var(--color-success-soft)] p-8 text-center">
          <p className="text-[20px] font-semibold text-[var(--color-success)]">✓ 已记上</p>
          <p className="mt-2 text-[12px] text-[var(--color-ink-2)]">跟单员会把照片归档。</p>
        </section>
        <button onClick={() => void startCamera()} className="mt-4 h-16 w-full rounded-[8px] bg-[var(--color-ink)] text-[17px] font-semibold text-white">
          扫下一单
        </button>
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
        <button onClick={() => void startCamera()} className="mt-3 h-12 w-full rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-semibold">都不是 · 重拍</button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md px-4 py-5">
      <input ref={inputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(event) => void onPick(event.target.files)} />

      {phase === 'boot' || phase === 'live' ? (
        <>
          <div className="relative h-[62dvh] overflow-hidden rounded-[10px] bg-black">
            <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-cover" />
            <div className="pointer-events-none absolute inset-3 rounded-[8px] border-2 border-white/45" />
            {phase === 'boot' ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-[16px] font-semibold text-white">正在打开相机…</div>
            ) : (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-4 pb-4 pt-12 text-center text-[13px] text-white">让整张2D图纸进入框内</div>
            )}
          </div>
          <button onClick={snap} disabled={phase !== 'live'} className="mt-3 h-20 w-full rounded-[10px] bg-[var(--color-ink)] text-[19px] font-semibold text-white disabled:opacity-50">拍照识别</button>
        </>
      ) : phase === 'fallback' ? (
        <>
          <section className="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-8 text-center">
            <h1 className="text-[18px] font-semibold">无法直接打开相机</h1>
            <p className="mt-2 text-[12px] text-[var(--color-ink-2)]">请允许相机权限，或使用手机相机拍摄2D图纸。</p>
          </section>
          {error ? <p className="mt-3 text-center text-[12px] text-[var(--color-overdue)]">{error}</p> : null}
          <button onClick={() => inputRef.current?.click()} className="mt-4 h-20 w-full rounded-[10px] bg-[var(--color-ink)] text-[19px] font-semibold text-white">拍照识别</button>
        </>
      ) : phase === 'busy' ? (
        <>
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="正在识别的2D图纸" className="max-h-[55dvh] w-full rounded-[10px] border border-[var(--color-border-strong)] bg-black object-contain" />
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
            <img src={preview} alt="未匹配的2D图纸" className="max-h-[45dvh] w-full rounded-[10px] border border-[var(--color-border-strong)] bg-black object-contain" />
          ) : null}
          <h1 className="mt-4 text-[18px] font-semibold text-[var(--color-overdue)]">没有认出这张图纸</h1>
          <p className="mt-1 text-[12px] text-[var(--color-ink-2)]">请拍清楚整张2D图纸。</p>
          {error ? <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p> : null}
          {latency != null ? <p className="mt-1 text-[10px] text-[var(--color-ink-4)]">识别用时 {(latency / 1000).toFixed(1)} 秒</p> : null}
          <button onClick={() => void startCamera()} className="mt-4 h-14 w-full rounded-[8px] bg-[var(--color-ink)] text-[16px] font-semibold text-white">重拍</button>
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
      <div className="mt-4 grid grid-cols-3 gap-2">
        {VALVE_STAGES.map((value) => <button key={value} type="button" onClick={() => setStage(value)} className={`h-11 rounded-[5px] border text-[13px] font-semibold ${stage === value ? 'border-[var(--color-warning)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]' : 'border-[var(--color-border)]'}`}>{value}</button>)}
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
