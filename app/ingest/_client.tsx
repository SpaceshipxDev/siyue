'use client'

import { useMemo, useRef, useState } from 'react'
import type { Stage } from '@/lib/data'
import { withBase } from '@/lib/base-path'
import { downscaleToJpeg } from '../_camera'

type Shot = { blob: Blob; url: string }
type PacketPage = {
  index: number
  kind: 'drawing' | 'program' | 'other'
  opNo?: number
}

type PacketDraft = {
  partNo?: string
  name: string
  drawingNo?: string
  qty: number
  dueDate: string
  material?: string
  customer?: string
  opCount: number
  pages: PacketPage[]
  notes?: string
}

type DoneInfo = {
  jobId: string
  jobNo: string
  name: string
  partNo?: string
  qty: number
  opCount: number
  dueDate?: string
  completedStage?: Stage
  attached: boolean
}

type Phase = 'shoot' | 'extracting' | 'review' | 'saving' | 'done'

const OP_STAGES: { key: Stage; label: string }[] = [
  { key: '编程', label: 'OP1' },
  { key: '操机', label: 'OP2' },
  { key: '手工', label: 'OP3' },
  { key: '打磨', label: 'OP4' },
  { key: '喷漆', label: 'OP5' },
  { key: '质量', label: 'OP6' },
]

const POST_STAGE = { key: '丝印' as Stage, label: '后处理' }

function stagesFor(opCount: number) {
  return [...OP_STAGES.slice(0, opCount), POST_STAGE]
}

function text(value: string | undefined): string {
  return value ?? ''
}

async function responseJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T
  } catch {
    throw new Error(`服务器返回异常（${res.status}）`)
  }
}

function Progress({ step }: { step: 1 | 2 | 3 }) {
  const items = ['拍资料', '核对', '上线']
  return (
    <div className="flex items-center px-1" aria-label={`录入进度：第 ${step} 步`}>
      {items.map((item, index) => {
        const number = index + 1
        const active = number <= step
        return (
          <div key={item} className="contents">
            {index > 0 && (
              <span
                className={`h-px flex-1 ${number <= step ? 'bg-[var(--color-ink)]' : 'bg-[var(--color-border-strong)]'}`}
              />
            )}
            <span className="flex items-center gap-1.5 px-2">
              <span
                className={`grid h-5 w-5 place-items-center rounded-full border text-[10px] mono ${
                  active
                    ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-surface)]'
                    : 'border-[var(--color-border-strong)] text-[var(--color-ink-3)]'
                }`}
              >
                {number < step ? '✓' : number}
              </span>
              <span
                className={`text-[11px] whitespace-nowrap ${
                  number === step
                    ? 'font-semibold text-[var(--color-ink)]'
                    : 'text-[var(--color-ink-3)]'
                }`}
              >
                {item}
              </span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  inputMode,
  placeholder,
  required,
  hint,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'number' | 'date'
  inputMode?: 'text' | 'numeric'
  placeholder?: string
  required?: boolean
  hint?: string
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 flex items-center justify-between gap-2 text-[11px] font-medium tracking-wide text-[var(--color-ink-2)]">
        <span>
          {label}
          {required ? <span className="ml-0.5 text-[var(--color-overdue)]">*</span> : null}
        </span>
        {hint ? <span className="font-normal text-[var(--color-ink-4)]">{hint}</span> : null}
      </span>
      <input
        type={type}
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        className="h-12 w-full rounded-[7px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3.5 text-[15px] text-[var(--color-ink)] outline-none transition focus:border-[var(--color-ink)] focus:ring-2 focus:ring-[var(--color-ink)]/10"
      />
    </label>
  )
}

export function IngestClient() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [shots, setShots] = useState<Shot[]>([])
  const [phase, setPhase] = useState<Phase>('shoot')
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<PacketDraft | null>(null)
  const [dueDateEstimated, setDueDateEstimated] = useState(false)
  const [completedThrough, setCompletedThrough] = useState(-1)
  const [done, setDone] = useState<DoneInfo | null>(null)

  const routeStages = useMemo(
    () => stagesFor(draft?.opCount ?? 1),
    [draft?.opCount],
  )

  const busy = phase === 'extracting' || phase === 'saving'

  async function onPick(files: FileList | null) {
    if (!files || files.length === 0) return
    setError('')
    try {
      const next: Shot[] = []
      for (const file of Array.from(files)) {
        const blob = await downscaleToJpeg(file, 2000, 0.82)
        next.push({ blob, url: URL.createObjectURL(blob) })
      }
      setShots((current) => [...current, ...next].slice(0, 12))
    } catch (err) {
      setError(err instanceof Error ? err.message : '照片读取失败')
    }
    if (inputRef.current) inputRef.current.value = ''
  }

  function removeShot(index: number) {
    setShots((current) => {
      URL.revokeObjectURL(current[index]?.url ?? '')
      return current.filter((_, itemIndex) => itemIndex !== index)
    })
  }

  function appendImages(fd: FormData) {
    shots.forEach((shot, index) => fd.append('images', shot.blob, `page-${index}.jpg`))
  }

  async function extract() {
    if (shots.length === 0) return
    setPhase('extracting')
    setError('')
    try {
      const fd = new FormData()
      fd.set('action', 'extract')
      appendImages(fd)
      const res = await fetch(withBase('/api/packet-ingest'), { method: 'POST', body: fd })
      const json = await responseJson<{
        ok: boolean
        error?: string
        draft?: PacketDraft
        dueDateEstimated?: boolean
      }>(res)
      if (!res.ok || !json.ok || !json.draft) {
        throw new Error(json.error || '识别失败')
      }
      setDraft(json.draft)
      setDueDateEstimated(Boolean(json.dueDateEstimated))
      setCompletedThrough(-1)
      setPhase('review')
    } catch (err) {
      setError(err instanceof Error ? err.message : '识别失败')
      setPhase('shoot')
    }
  }

  function updateDraft<K extends keyof PacketDraft>(key: K, value: PacketDraft[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current))
  }

  function updateOpCount(opCount: number) {
    updateDraft('opCount', opCount)
    setCompletedThrough((current) => Math.min(current, stagesFor(opCount).length - 1))
  }

  async function commit() {
    if (!draft) return
    if (!draft.name.trim()) {
      setError('请填写零件名称')
      return
    }
    setPhase('saving')
    setError('')
    try {
      const completedStage = routeStages[completedThrough]?.key
      const fd = new FormData()
      fd.set('action', 'commit')
      fd.set('draft', JSON.stringify({ ...draft, completedStage }))
      appendImages(fd)
      const res = await fetch(withBase('/api/packet-ingest'), { method: 'POST', body: fd })
      const json = await responseJson<{ ok: boolean; error?: string } & DoneInfo>(res)
      if (!res.ok || !json.ok) throw new Error(json.error || '录入失败')
      setDone(json)
      setPhase('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : '录入失败')
      setPhase('review')
    }
  }

  function reset() {
    shots.forEach((shot) => URL.revokeObjectURL(shot.url))
    setShots([])
    setDraft(null)
    setDone(null)
    setError('')
    setDueDateEstimated(false)
    setCompletedThrough(-1)
    setPhase('shoot')
  }

  if (phase === 'done' && done) {
    return (
      <div className="mx-auto max-w-md px-4 pb-28 pt-5">
        <Progress step={3} />
        <section className="mt-7 overflow-hidden rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-surface)]">
          <div className="px-6 pb-6 pt-8 text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[var(--color-success-soft)] text-[22px] font-semibold text-[var(--color-success)]">
              ✓
            </span>
            <h1 className="mt-4 text-[20px] font-semibold tracking-tight text-[var(--color-ink)]">
              已上线
            </h1>
            <p className="mt-1 text-[12px] text-[var(--color-ink-3)]">
              {done.attached ? '已并入现有订单' : '工单已进入生产看板'}
            </p>
          </div>
          <div className="border-t border-[var(--color-border)] px-5 py-4">
            <p className="text-[16px] font-medium text-[var(--color-ink)]">{done.name}</p>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-[var(--color-ink-2)]">
              {done.partNo ? <span className="mono">{done.partNo}</span> : null}
              <span>{done.qty} 件</span>
              <span>{done.opCount} 道 CNC</span>
              {done.completedStage ? (
                <span className="text-[var(--color-success)]">
                  已完成 {routeStages.find((stage) => stage.key === done.completedStage)?.label}
                </span>
              ) : null}
            </div>
            <p className="mt-2 text-[11px] text-[var(--color-ink-4)] mono">{done.jobNo}</p>
          </div>
        </section>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={reset}
            className="h-13 rounded-[7px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[14px] font-medium text-[var(--color-ink)]"
          >
            录下一单
          </button>
          <a
            href={withBase(`/jobs/${done.jobId}`)}
            className="grid h-13 place-items-center rounded-[7px] bg-[var(--color-ink)] text-[14px] font-semibold text-[var(--color-surface)]"
          >
            查看工单
          </a>
        </div>
      </div>
    )
  }

  if ((phase === 'review' || phase === 'saving') && draft) {
    return (
      <div className="mx-auto max-w-md px-4 pb-36 pt-5">
        <Progress step={2} />

        <div className="mt-6 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-[21px] font-semibold tracking-tight text-[var(--color-ink)]">
                核对后上线
              </h1>
              <span className="rounded-full bg-[var(--color-success-soft)] px-2 py-1 text-[10px] font-medium text-[var(--color-success)]">
                Gemini 已填写
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
              点任意字段直接修改。确认后才会进入生产看板。
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setError('')
              setPhase('shoot')
            }}
            disabled={busy}
            className="shrink-0 py-1 text-[12px] font-medium text-[var(--color-ink-2)] underline decoration-[var(--color-border-strong)] underline-offset-4"
          >
            重拍
          </button>
        </div>

        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          {shots.map((shot, index) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={shot.url}
              src={shot.url}
              alt={`资料第 ${index + 1} 页`}
              className="h-14 w-14 shrink-0 rounded-[5px] border border-[var(--color-border)] object-cover"
            />
          ))}
          <span className="grid h-14 min-w-14 place-items-center rounded-[5px] border border-dashed border-[var(--color-border-strong)] px-3 text-[11px] text-[var(--color-ink-3)]">
            {shots.length} 页
          </span>
        </div>

        <section className="mt-5 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">工单内容</h2>
            <span className="text-[10px] text-[var(--color-ink-4)]">全部可编辑</span>
          </div>
          <div className="space-y-4">
            <Field
              label="零件名称"
              value={draft.name}
              onChange={(value) => updateDraft('name', value)}
              placeholder="请输入零件名称"
              required
            />
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="料号"
                value={text(draft.partNo)}
                onChange={(value) => updateDraft('partNo', value)}
                placeholder="选填"
              />
              <Field
                label="图纸号"
                value={text(draft.drawingNo)}
                onChange={(value) => updateDraft('drawingNo', value)}
                placeholder="选填"
              />
              <Field
                label="数量"
                value={String(draft.qty)}
                onChange={(value) => updateDraft('qty', Math.max(1, Number(value) || 1))}
                type="number"
                inputMode="numeric"
                required
              />
              <Field
                label="交期"
                value={draft.dueDate}
                onChange={(value) => {
                  updateDraft('dueDate', value)
                  setDueDateEstimated(false)
                }}
                type="date"
                hint={dueDateEstimated ? '未识别 · 已估算' : undefined}
                required
              />
              <Field
                label="材料"
                value={text(draft.material)}
                onChange={(value) => updateDraft('material', value)}
                placeholder="选填"
              />
              <Field
                label="客户"
                value={text(draft.customer)}
                onChange={(value) => updateDraft('customer', value)}
                placeholder="禾牧"
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-medium tracking-wide text-[var(--color-ink-2)]">
                  CNC 加工次数
                </span>
                <span className="text-[11px] text-[var(--color-ink-4)]">决定 OP 工序数量</span>
              </div>
              <div className="grid grid-cols-6 gap-1.5 rounded-[8px] bg-[var(--color-bg)] p-1.5">
                {[1, 2, 3, 4, 5, 6].map((count) => (
                  <button
                    key={count}
                    type="button"
                    onClick={() => updateOpCount(count)}
                    className={`h-10 rounded-[6px] text-[13px] font-semibold transition ${
                      draft.opCount === count
                        ? 'bg-[var(--color-ink)] text-[var(--color-surface)] shadow-sm'
                        : 'text-[var(--color-ink-2)]'
                    }`}
                    aria-pressed={draft.opCount === count}
                  >
                    {count}
                  </button>
                ))}
              </div>
            </div>

            <label className="block">
              <span className="mb-1.5 block text-[11px] font-medium tracking-wide text-[var(--color-ink-2)]">
                备注
              </span>
              <textarea
                value={text(draft.notes)}
                onChange={(event) => updateDraft('notes', event.target.value)}
                placeholder="手写要求、先加工数量等"
                rows={3}
                className="w-full resize-none rounded-[7px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3.5 py-3 text-[14px] leading-relaxed text-[var(--color-ink)] outline-none transition focus:border-[var(--color-ink)] focus:ring-2 focus:ring-[var(--color-ink)]/10"
              />
            </label>
          </div>
        </section>

        <section className="mt-4 overflow-hidden rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="border-b border-[var(--color-border)] px-4 py-4">
            <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">现在做到哪了？</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-ink-3)]">
              勾选最后一个已完成工序，之前工序会一起勾选。未勾选则从 OP1 开始。
            </p>
          </div>
          <div>
            {routeStages.map((stage, index) => {
              const checked = index <= completedThrough
              const isNext = index === completedThrough + 1
              return (
                <label
                  key={stage.key}
                  className={`flex min-h-14 cursor-pointer items-center gap-3 border-b border-[var(--color-border)] px-4 last:border-b-0 ${
                    checked ? 'bg-[var(--color-success-soft)]/45' : 'bg-[var(--color-surface)]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) =>
                      setCompletedThrough(event.target.checked ? index : index - 1)
                    }
                    className="peer sr-only"
                  />
                  <span
                    className={`grid h-6 w-6 shrink-0 place-items-center rounded-[5px] border text-[13px] transition ${
                      checked
                        ? 'border-[var(--color-success)] bg-[var(--color-success)] font-semibold text-white'
                        : 'border-[var(--color-border-strong)] bg-[var(--color-surface)] text-transparent peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-ink)]/20'
                    }`}
                    aria-hidden="true"
                  >
                    ✓
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium text-[var(--color-ink)]">
                      {stage.label}
                    </span>
                    <span className="block text-[10px] text-[var(--color-ink-4)]">
                      {stage.key}
                    </span>
                  </span>
                  <span
                    className={`text-[11px] ${
                      checked
                        ? 'font-medium text-[var(--color-success)]'
                        : isNext
                          ? 'text-[var(--color-ink-2)]'
                          : 'text-[var(--color-ink-4)]'
                    }`}
                  >
                    {checked ? '已完成' : isNext ? '下一步' : '待开始'}
                  </span>
                </label>
              )
            })}
          </div>
        </section>

        {error ? (
          <p className="mt-4 rounded-[7px] border border-red-200 bg-red-50 px-3 py-2.5 text-[12px] leading-relaxed text-red-700">
            {error}
          </p>
        ) : null}

        <div className="sticky bottom-[68px] z-10 -mx-4 mt-5 border-t border-[var(--color-border)] bg-[var(--color-bg)]/95 px-4 pb-3 pt-3 backdrop-blur">
          <button
            type="button"
            onClick={commit}
            disabled={busy || !draft.name.trim()}
            className="h-14 w-full rounded-[8px] bg-[var(--color-ink)] text-[16px] font-semibold text-[var(--color-surface)] shadow-[0_8px_24px_rgba(0,0,0,0.16)] transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {phase === 'saving' ? '正在上线…' : '确认上线'}
          </button>
          <p className="mt-2 text-center text-[10px] text-[var(--color-ink-4)]">
            上线后立即出现在生产看板
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md px-4 pb-32 pt-5">
      <Progress step={1} />

      <section className="mt-7">
        <p className="text-[11px] font-medium tracking-[0.16em] text-[var(--color-ink-3)]">
          拍照录入
        </p>
        <h1 className="mt-2 text-[24px] font-semibold tracking-tight text-[var(--color-ink)]">
          拍下资料袋的每一页
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
          图纸和每张 CNC 程序单都拍清楚。Gemini 识别后，你可以核对并修改全部内容。
        </p>
      </section>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="hidden"
        onChange={(event) => onPick(event.target.files)}
      />

      {shots.length > 0 ? (
        <section className="mt-5 grid grid-cols-3 gap-2">
          {shots.map((shot, index) => (
            <div key={shot.url} className="group relative overflow-hidden rounded-[8px]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={shot.url}
                alt={`第 ${index + 1} 页`}
                className="aspect-[4/3] w-full border border-[var(--color-border-strong)] object-cover"
              />
              <button
                type="button"
                onClick={() => removeShot(index)}
                aria-label={`删除第 ${index + 1} 页`}
                className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/65 text-[15px] text-white backdrop-blur"
              >
                ×
              </button>
              <span className="absolute bottom-1.5 left-1.5 rounded-[4px] bg-black/60 px-1.5 py-0.5 text-[10px] text-white mono">
                {String(index + 1).padStart(2, '0')}
              </span>
            </div>
          ))}
        </section>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-6 flex min-h-52 w-full flex-col items-center justify-center rounded-[12px] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 text-center transition active:bg-[var(--color-lane)]"
        >
          <span className="grid h-11 w-11 place-items-center rounded-full bg-[var(--color-bg)] text-[22px] text-[var(--color-ink)]">
            +
          </span>
          <span className="mt-3 text-[15px] font-semibold text-[var(--color-ink)]">拍第一张</span>
          <span className="mt-1 text-[11px] text-[var(--color-ink-4)]">最多 12 页 · 自动压缩上传</span>
        </button>
      )}

      {shots.length > 0 ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy || shots.length >= 12}
          className="mt-3 h-12 w-full rounded-[7px] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[13px] font-medium text-[var(--color-ink-2)] disabled:opacity-50"
        >
          {shots.length >= 12 ? '已到 12 页上限' : `＋ 再拍一页 · 已有 ${shots.length} 页`}
        </button>
      ) : null}

      {error ? (
        <p className="mt-4 rounded-[7px] border border-red-200 bg-red-50 px-3 py-2.5 text-[12px] leading-relaxed text-red-700">
          {error}
        </p>
      ) : null}

      {shots.length > 0 ? (
        <button
          type="button"
          onClick={extract}
          disabled={busy}
          className="mt-5 h-14 w-full rounded-[8px] bg-[var(--color-ink)] text-[16px] font-semibold text-[var(--color-surface)] shadow-[0_8px_24px_rgba(0,0,0,0.14)] transition active:scale-[0.99] disabled:opacity-55"
        >
          {phase === 'extracting' ? 'Gemini 正在识别…' : '识别并核对'}
        </button>
      ) : null}

      {phase === 'extracting' ? (
        <div className="mt-3 flex items-center justify-center gap-2 text-[11px] text-[var(--color-ink-3)]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-success)]" />
          正在读取印章、图纸和加工次数
        </div>
      ) : null}
    </div>
  )
}
