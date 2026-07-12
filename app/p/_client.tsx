'use client'

import { useRef, useState } from 'react'
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
  | { decision: 'match'; token: string; latencyMs?: number }
  | { decision: 'ambiguous'; candidates: Candidate[]; latencyMs?: number }
  | { decision: 'no_match'; latencyMs?: number; error?: string }

function mdCn(ymd?: string): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return ymd ?? ''
  const [, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return `${m}月${d}日`
}

// One button. Shoot → match → /s/<token>. The only branches a worker ever
// sees: "两个单子长得一样，选一下" (repeat orders of the same drawing) and
// "没认出来，再拍一张（拍正一点）".
export function ScanClient() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<'idle' | 'busy' | 'pick' | 'miss'>('idle')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [ms, setMs] = useState<number | undefined>()

  async function onPick(files: FileList | null) {
    const file = files?.[0]
    if (inputRef.current) inputRef.current.value = ''
    if (!file) return
    setPhase('busy')
    try {
      // 1600px is plenty for both the matcher and the OCR fallback, and keeps
      // upload + inference under a couple of seconds on factory wifi.
      const blob = await downscaleToJpeg(file, 1600, 0.8)
      const fd = new FormData()
      fd.append('image', blob, 'query.jpg')
      const res = await fetch(withBase('/api/match-photo'), { method: 'POST', body: fd })
      const json = (await res.json()) as MatchJson
      setMs(json.latencyMs)
      if (json.decision === 'match') {
        window.location.href = withBase(`/s/${json.token}?via=photo`)
        return
      }
      if (json.decision === 'ambiguous' && json.candidates.length > 0) {
        setCandidates(json.candidates)
        setPhase('pick')
        return
      }
      setPhase('miss')
    } catch {
      setPhase('miss')
    }
  }

  return (
    <div className="max-w-md mx-auto px-4 py-5 space-y-4">
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
            onClick={() => inputRef.current?.click()}
            className="w-full h-12 text-[14px] font-medium border border-[var(--color-border-strong)] rounded-[3px] bg-[var(--color-surface)]"
          >
            都不是 · 重拍一张
          </button>
        </>
      ) : (
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

          {phase === 'miss' ? (
            <section className="bg-[var(--color-surface)] border border-red-300 rounded-[3px] p-4 text-center">
              <p className="text-[13px] font-semibold text-red-600">没认出来</p>
              <p className="text-[11px] text-[var(--color-ink-2)] mt-1">
                再拍一张：整页入镜、拍正一点、别反光。
                <br />
                如果这单还没被编程录入过，先找编程拍照录入。
              </p>
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
      )}
    </div>
  )
}
