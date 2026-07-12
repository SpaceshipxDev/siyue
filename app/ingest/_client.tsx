'use client'

import { useRef, useState } from 'react'
import { withBase } from '@/lib/base-path'
import { downscaleToJpeg } from '../_camera'

type Shot = { blob: Blob; url: string }

type DoneInfo = {
  jobNo: string
  name: string
  partNo?: string
  qty: number
  opCount: number
  dueDate?: string
  attached: boolean
}

// One packet per submit. The flow is deliberately dumb: shoot, shoot, shoot,
// 完成. No review screen, no field editing — the programmer's context is the
// printer tray, not a form. Extraction mistakes get fixed by the PMC on the
// board, where editing already exists.
export function IngestClient() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [shots, setShots] = useState<Shot[]>([])
  const [phase, setPhase] = useState<'shoot' | 'busy' | 'done' | 'error'>('shoot')
  const [error, setError] = useState('')
  const [done, setDone] = useState<DoneInfo | null>(null)

  async function onPick(files: FileList | null) {
    if (!files || files.length === 0) return
    try {
      const next: Shot[] = []
      for (const f of Array.from(files)) {
        const blob = await downscaleToJpeg(f, 2000, 0.82)
        next.push({ blob, url: URL.createObjectURL(blob) })
      }
      setShots((s) => [...s, ...next].slice(0, 12))
    } catch (e) {
      setError(e instanceof Error ? e.message : '照片读取失败')
    }
    if (inputRef.current) inputRef.current.value = ''
  }

  function removeShot(i: number) {
    setShots((s) => {
      URL.revokeObjectURL(s[i]?.url ?? '')
      return s.filter((_, j) => j !== i)
    })
  }

  async function submit() {
    if (shots.length === 0) return
    setPhase('busy')
    setError('')
    try {
      const fd = new FormData()
      shots.forEach((s, i) => fd.append('images', s.blob, `page-${i}.jpg`))
      const res = await fetch(withBase('/api/packet-ingest'), {
        method: 'POST',
        body: fd,
      })
      const json = (await res.json()) as { ok: boolean; error?: string } & DoneInfo
      if (!res.ok || !json.ok) throw new Error(json.error || '录入失败')
      setDone(json)
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : '录入失败')
      setPhase('error')
    }
  }

  function reset() {
    shots.forEach((s) => URL.revokeObjectURL(s.url))
    setShots([])
    setDone(null)
    setError('')
    setPhase('shoot')
  }

  if (phase === 'done' && done) {
    return (
      <div className="max-w-md mx-auto px-4 py-6 space-y-4">
        <section className="bg-[var(--color-success-soft)] border border-[var(--color-success)] rounded-[3px] p-6 text-center">
          <p className="text-[28px] leading-none">✓</p>
          <p className="text-[16px] font-semibold text-[var(--color-success)] mt-2">
            已录入{done.attached ? '（并入已有订单）' : ''}
          </p>
          <p className="text-[13px] mt-3 font-semibold">{done.name}</p>
          <p className="text-[12px] text-[var(--color-ink-2)] mt-1 font-mono">
            {done.partNo ? `${done.partNo} · ` : ''}
            {done.qty} 件 · {done.opCount} 道CNC工序
            {done.dueDate ? ` · 交期 ${done.dueDate}` : ''}
          </p>
          <p className="text-[11px] text-[var(--color-ink-3)] mt-2 font-mono">{done.jobNo}</p>
        </section>
        <button
          onClick={reset}
          className="w-full h-14 text-[16px] font-semibold bg-[var(--color-ink)] text-[var(--color-surface)] rounded-[3px]"
        >
          录下一单
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-md mx-auto px-4 py-5 space-y-4">
      <section className="bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-[3px] p-5">
        <h1 className="text-[15px] font-semibold">拍下资料袋的每一页</h1>
        <p className="text-[12px] text-[var(--color-ink-2)] mt-1 leading-relaxed">
          图纸（盖章那张）+ 每张CNC程序单各拍一张。
          <br />
          拍完点 完成，系统自动建卡，不用填任何字。
        </p>
      </section>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="hidden"
        onChange={(e) => onPick(e.target.files)}
      />

      {shots.length > 0 ? (
        <section className="grid grid-cols-3 gap-2">
          {shots.map((s, i) => (
            <div key={s.url} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={s.url}
                alt={`第${i + 1}页`}
                className="w-full aspect-[4/3] object-cover rounded-[3px] border border-[var(--color-border-strong)]"
              />
              <button
                onClick={() => removeShot(i)}
                aria-label="删除这页"
                className="absolute top-1 right-1 w-6 h-6 text-[12px] leading-none bg-black/60 text-white rounded-full"
              >
                ×
              </button>
              <span className="absolute bottom-1 left-1 px-1.5 py-0.5 text-[10px] bg-black/60 text-white rounded">
                {i + 1}
              </span>
            </div>
          ))}
        </section>
      ) : null}

      <button
        onClick={() => inputRef.current?.click()}
        disabled={phase === 'busy'}
        className="w-full h-16 text-[17px] font-semibold border-2 border-dashed border-[var(--color-border-strong)] text-[var(--color-ink)] rounded-[3px] bg-[var(--color-surface)]"
      >
        📷 拍第 {shots.length + 1} 张
      </button>

      {shots.length > 0 ? (
        <button
          onClick={submit}
          disabled={phase === 'busy'}
          className="w-full h-14 text-[16px] font-semibold bg-[var(--color-success)] text-white rounded-[3px] disabled:opacity-60"
        >
          {phase === 'busy' ? '正在识别与建卡…' : `完成录入（${shots.length} 页）`}
        </button>
      ) : null}

      {error ? (
        <p className="text-[12px] text-red-600 text-center">
          {error} — 可以重试，照片已在手机里不会丢。
        </p>
      ) : null}
    </div>
  )
}
