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
  customer?: string
}

type MatchJson =
  | { decision: 'match'; token: string; latencyMs?: number; part?: { name?: string } }
  | { decision: 'ambiguous'; candidates: Candidate[]; latencyMs?: number }
  | { decision: 'no_match'; latencyMs?: number; error?: string }

function mdCn(ymd?: string): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return ymd ?? ''
  const [, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return `${m}月${d}日`
}

// The generic stage vocabulary a worker can claim on an unmatched photo.
// Free text on the server side — the PMC re-decides at 归档 time anyway.
const VALVE_STAGES = ['OP1', 'OP2', 'OP3', 'OP4', '后处理', '出货']

// The camera IS the page. /p opens straight into a live viewfinder that
// keeps matching frames until the sheet in view resolves — no shutter in the
// happy path (~0.4s per attempt, retries are free). Branches:
//   · ambiguous  → "两个单子长得一样，选一下" (repeat orders)
//   · 3 misses   → the valve slides up: 先记上，跟单员归档 (never a dead end)
//   · no camera  → the old tap-to-shoot flow (decade-old WeChat webviews)
export function ScanClient({ workerName }: { workerName?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const lastFrameRef = useRef<Blob | null>(null)
  const missesRef = useRef(0)
  const stopRef = useRef(false)
  const startedAtRef = useRef(0)

  const [phase, setPhase] = useState<
    'boot' | 'live' | 'paused' | 'pick' | 'valve' | 'sent' | 'fallback' | 'busy'
  >('boot')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [ms, setMs] = useState<number | undefined>()
  const [flash, setFlash] = useState<string | undefined>()
  const [showValveCta, setShowValveCta] = useState(false)
  const [valveThumb, setValveThumb] = useState<string | undefined>()

  const stopStream = useCallback(() => {
    stopRef.current = true
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  const handleResult = useCallback(
    (json: MatchJson): boolean => {
      setMs(json.latencyMs)
      if (json.decision === 'match') {
        navigator.vibrate?.(80)
        setFlash(json.part?.name ? `✓ ${json.part.name}` : '✓ 认到了')
        window.location.href = withBase(`/s/${json.token}?via=photo`)
        return true
      }
      if (json.decision === 'ambiguous' && json.candidates.length > 0) {
        navigator.vibrate?.([40, 60, 40])
        setCandidates(json.candidates)
        setPhase('pick')
        return true
      }
      missesRef.current += 1
      if (missesRef.current >= 3) setShowValveCta(true)
      return false
    },
    [],
  )

  // One frame in flight at a time; the next is scheduled only after the
  // previous answer. ~0.4s matcher + upload ≈ a fresh attempt every second.
  const pollLoop = useCallback(async () => {
    while (!stopRef.current) {
      const video = videoRef.current
      if (!video || video.readyState < 2 || document.hidden) {
        await new Promise((r) => setTimeout(r, 300))
        continue
      }
      if (Date.now() - startedAtRef.current > 90_000) {
        stopStream()
        setPhase('paused')
        return
      }
      try {
        const canvas = document.createElement('canvas')
        const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight))
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height)
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', 0.72),
        )
        if (!blob) continue
        lastFrameRef.current = blob
        const fd = new FormData()
        fd.append('image', blob, 'frame.jpg')
        const res = await fetch(withBase('/api/match-photo'), { method: 'POST', body: fd })
        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, 3000))
          continue
        }
        const json = (await res.json()) as MatchJson
        if (handleResult(json)) {
          stopStream()
          return
        }
      } catch {
        /* transient network/camera hiccup — keep scanning */
      }
      await new Promise((r) => setTimeout(r, 400))
    }
  }, [handleResult, stopStream])

  const startLive = useCallback(async () => {
    stopRef.current = false
    missesRef.current = 0
    setShowValveCta(false)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1440 } },
        audio: false,
      })
      streamRef.current = stream
      setPhase('live')
      startedAtRef.current = Date.now()
      // The <video> mounts with the 'live' render; attach on next tick.
      setTimeout(() => {
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        void video.play().catch(() => {})
        void pollLoop()
      }, 0)
    } catch {
      setPhase('fallback')
    }
  }, [pollLoop])

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase('fallback')
      return
    }
    void startLive()
    return () => stopStream()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Old-webview / manual high-res path: tap-to-shoot via the OS camera.
  async function onPick(files: FileList | null) {
    const file = files?.[0]
    if (inputRef.current) inputRef.current.value = ''
    if (!file) return
    setPhase('busy')
    try {
      const blob = await downscaleToJpeg(file, 1600, 0.8)
      lastFrameRef.current = blob
      const fd = new FormData()
      fd.append('image', blob, 'query.jpg')
      const res = await fetch(withBase('/api/match-photo'), { method: 'POST', body: fd })
      const json = (await res.json()) as MatchJson
      if (!handleResult(json)) {
        missesRef.current = 3
        setShowValveCta(true)
        setPhase('fallback')
      }
    } catch {
      setPhase('fallback')
    }
  }

  function openValve() {
    stopStream()
    const frame = lastFrameRef.current
    setValveThumb(frame ? URL.createObjectURL(frame) : undefined)
    setPhase('valve')
  }

  const resume = () => {
    setCandidates([])
    void startLive()
  }

  return (
    <div className="max-w-md mx-auto px-4 py-4 space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => onPick(e.target.files)}
      />

      {phase === 'pick' ? (
        <>
          <section className="bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-[3px] p-4">
            <p className="text-[14px] font-semibold">有 {candidates.length} 个很像的单子</p>
            <p className="text-[11px] text-[var(--color-ink-2)] mt-1">
              对一下纸上的数量和交期，点你手里这张。
            </p>
          </section>
          {candidates.map((c) => (
            <a
              key={c.token}
              href={withBase(`/s/${c.token}?via=photo`)}
              className="block bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-[3px] p-4 active:bg-[var(--color-bg)]"
            >
              <p className="text-[16px] font-semibold">{c.name}</p>
              {c.partNo || c.drawingNo ? (
                <p className="font-mono text-[11px] text-[var(--color-ink-2)] mt-0.5 break-all">
                  {c.partNo ?? c.drawingNo}
                </p>
              ) : null}
              <p className="text-[13px] mt-2">
                <span className="font-semibold">{c.qty} 件</span>
                {c.dueDate ? (
                  <span className="text-[var(--color-ink-2)]"> · 交期 {mdCn(c.dueDate)}</span>
                ) : null}
                {c.customer ? (
                  <span className="text-[var(--color-ink-2)]"> · {c.customer}</span>
                ) : null}
              </p>
            </a>
          ))}
          <button
            onClick={resume}
            className="w-full h-12 text-[14px] font-medium border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)]"
          >
            都不是 · 重新对准
          </button>
        </>
      ) : phase === 'valve' ? (
        <ValveForm
          thumb={valveThumb}
          frame={lastFrameRef.current}
          workerName={workerName}
          onSent={() => setPhase('sent')}
          onBack={resume}
        />
      ) : phase === 'sent' ? (
        <>
          <section className="bg-[var(--color-success-soft)] border border-[var(--color-success)] rounded-[3px] p-6 text-center">
            <p className="text-[16px] font-semibold text-[var(--color-success)]">✓ 已记上</p>
            <p className="text-[12px] text-[var(--color-ink-2)] mt-1 leading-relaxed">
              跟单员会把这单归档，件数不会丢。
            </p>
          </section>
          <button
            onClick={resume}
            className="w-full h-16 text-[17px] font-semibold bg-[var(--color-ink)] text-[var(--color-surface)] rounded-[3px]"
          >
            📷 拍下一单
          </button>
        </>
      ) : phase === 'paused' ? (
        <button
          onClick={resume}
          className="w-full h-[56dvh] text-[18px] font-semibold border-2 border-dashed border-[var(--color-border-strong)] rounded-[6px] bg-[var(--color-surface)]"
        >
          📷 点一下继续识别
        </button>
      ) : phase === 'fallback' || phase === 'busy' ? (
        <>
          <section className="bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-[3px] p-6 text-center">
            <p className="text-[40px] leading-none">📄</p>
            <h1 className="text-[17px] font-semibold mt-3">拍一下手里的单子</h1>
            <p className="text-[12px] text-[var(--color-ink-2)] mt-1 leading-relaxed">
              对准整页（图纸或程序单都行），
              <br />
              拍完自动认出是哪个零件，直接报工。
            </p>
          </section>
          {showValveCta ? (
            <section className="bg-[var(--color-surface)] border border-red-300 rounded-[3px] p-4 text-center">
              <p className="text-[13px] font-semibold text-red-600">没认出来</p>
              <p className="text-[11px] text-[var(--color-ink-2)] mt-1">
                再拍一张（整页入镜、拍正一点），或者：
              </p>
              <button
                onClick={openValve}
                className="mt-2 w-full h-11 text-[14px] font-semibold border border-red-300 text-red-600 rounded-[3px] bg-[var(--color-surface)]"
              >
                先记上 · 让跟单员归档
              </button>
            </section>
          ) : null}
          <button
            onClick={() => inputRef.current?.click()}
            disabled={phase === 'busy'}
            className="w-full h-20 text-[18px] font-semibold bg-[var(--color-ink)] text-[var(--color-surface)] rounded-[3px] disabled:opacity-60"
          >
            {phase === 'busy' ? '正在识别…' : '📷 拍照识别'}
          </button>
          {ms != null && phase !== 'busy' ? (
            <p className="text-center text-[10px] text-[var(--color-ink-4)]">
              识别用时 {(ms / 1000).toFixed(1)}s
            </p>
          ) : null}
        </>
      ) : (
        /* boot + live: the viewfinder IS the interface. */
        <>
          <div className="relative rounded-[6px] overflow-hidden bg-black h-[56dvh]">
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="absolute inset-0 w-full h-full object-cover"
            />
            {/* Corner guides + status line. */}
            <div className="absolute inset-3 border-2 border-white/40 rounded-[8px] pointer-events-none" />
            <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-4 pb-3 pt-8 text-center">
              <p className="text-white text-[15px] font-semibold drop-shadow">
                {flash ?? (phase === 'boot' ? '正在打开相机…' : '对准手里的单子 · 自动识别')}
              </p>
              {phase === 'live' && !flash ? (
                <p className="text-white/70 text-[11px] mt-0.5">
                  整页入镜，稳住一秒{ms != null ? ` · 上次 ${(ms / 1000).toFixed(1)}s` : ''}
                </p>
              ) : null}
            </div>
            {flash ? (
              <div className="absolute inset-0 bg-[var(--color-success)]/25 flex items-center justify-center">
                <p className="text-white text-[24px] font-bold drop-shadow-lg">{flash}</p>
              </div>
            ) : null}
          </div>

          {showValveCta ? (
            <section className="bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-[3px] p-3 flex items-center gap-3">
              <p className="flex-1 text-[12px] text-[var(--color-ink-2)] leading-snug">
                一直认不出来？可能这单还没录入。
              </p>
              <button
                onClick={openValve}
                className="h-11 px-4 shrink-0 text-[13px] font-semibold border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)]"
              >
                先记上
              </button>
            </section>
          ) : null}

          <button
            onClick={() => inputRef.current?.click()}
            className="w-full h-11 text-[13px] font-medium border border-[var(--color-border-strong)] text-[var(--color-ink-2)] rounded-[3px] bg-[var(--color-surface)]"
          >
            拍不清楚？拍一张高清照
          </button>
        </>
      )}
    </div>
  )
}

// The no-match valve: the photo + claimed stage + count land in the PMC's
// 待归档 queue. The worker is NEVER blocked by an un-ingested packet.
function ValveForm({
  thumb,
  frame,
  workerName,
  onSent,
  onBack,
}: {
  thumb?: string
  frame: Blob | null
  workerName?: string
  onSent: () => void
  onBack: () => void
}) {
  const [stage, setStage] = useState<string>('')
  const [qty, setQty] = useState<string>('')
  const [name, setName] = useState(workerName ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | undefined>()

  async function submit() {
    if (!frame) {
      setErr('没有照片，请返回重拍')
      return
    }
    const n = Number.parseInt(qty, 10)
    if (!stage || !Number.isFinite(n) || n <= 0 || !name.trim()) {
      setErr('选工序、填件数、填名字')
      return
    }
    setBusy(true)
    setErr(undefined)
    try {
      const fd = new FormData()
      fd.append('image', frame, 'unmatched.jpg')
      fd.append('stage', stage)
      fd.append('qty', String(n))
      fd.append('name', name.trim().slice(0, 20))
      const res = await fetch(withBase('/api/unmatched-report'), { method: 'POST', body: fd })
      if (!res.ok) throw new Error(String(res.status))
      onSent()
    } catch {
      setErr('没发出去，再点一次')
      setBusy(false)
    }
  }

  return (
    <section className="bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-[3px] p-4 space-y-3">
      <div className="flex items-center gap-3">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="拍到的单子" className="w-16 h-16 object-cover rounded-[3px] border border-[var(--color-border)]" />
        ) : null}
        <div>
          <p className="text-[14px] font-semibold">先记上，跟单员归档</p>
          <p className="text-[11px] text-[var(--color-ink-2)] mt-0.5">
            这单可能还没录入，件数照样算你的。
          </p>
        </div>
      </div>

      <div>
        <p className="text-[11px] text-[var(--color-ink-3)] mb-1.5">做到哪道工序？</p>
        <div className="grid grid-cols-3 gap-1.5">
          {VALVE_STAGES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStage(s)}
              className={`h-11 text-[13px] font-medium rounded-[3px] border ${
                stage === s
                  ? 'border-2 border-[var(--color-warning)] text-[var(--color-warning)] font-semibold bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)]'
                  : 'border-[var(--color-border-strong)] bg-[var(--color-surface)]'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <input
          type="number"
          inputMode="numeric"
          min={1}
          placeholder="完成件数"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          className="flex-1 h-12 px-3 text-[16px] font-mono border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] outline-none focus:border-[var(--color-ink)]"
        />
        <input
          maxLength={20}
          placeholder="你的名字"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 h-12 px-3 text-[15px] border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)] outline-none focus:border-[var(--color-ink)]"
        />
      </div>

      {err ? <p className="text-[12px] text-red-600">{err}</p> : null}

      <button
        onClick={submit}
        disabled={busy}
        className="w-full h-14 text-[16px] font-semibold bg-[var(--color-success)] text-white rounded-[3px] disabled:opacity-60"
      >
        {busy ? '发送中…' : '记上 · 交给跟单员'}
      </button>
      <button
        onClick={onBack}
        disabled={busy}
        className="w-full h-11 text-[13px] font-medium border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)]"
      >
        返回 · 再试一次识别
      </button>
    </section>
  )
}
