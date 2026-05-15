'use client'

import { useEffect, useRef, useState } from 'react'
import { STAGES, type Stage } from '@/lib/data'

export type StoredSource = {
  url: string
  name: string
  mimeType: string
}

export type StationCard = {
  stage: Stage
  applies: boolean
  keyPoints: string[]
  risks?: string[]
}

export type ComponentCard = {
  name: string
  summary?: string
  stations: StationCard[]
}

export type ProcessCard = {
  summary: string
  components: ComponentCard[]
}

export type StoredProcessCard = {
  jobId: string
  card: ProcessCard
  sourceFiles: StoredSource[]
  model: string
  generatedAt: string
  generatedBy?: string
}

const ACCEPT = '.pdf,application/pdf,image/png,image/jpeg,image/webp'
const MAX_FILES = 12
const MAX_FILE_BYTES = 12 * 1024 * 1024
const MAX_TOTAL_BYTES = 18 * 1024 * 1024
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
])

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fileKey(f: File): string {
  return `${f.name}::${f.size}::${f.lastModified}`
}

export function ProcessCardButton({
  jobId,
  jobNo,
  initial,
}: {
  jobId: string
  jobNo: string
  initial: StoredProcessCard | null
}) {
  const [open, setOpen] = useState(false)
  const hasCard = !!initial

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-[12px] tracking-wider border border-[var(--color-ink)] text-[var(--color-ink)] rounded-sm hover:bg-[var(--color-ink)] hover:text-[var(--color-surface)] transition-colors"
      >
        {hasCard ? '工艺卡' : '制造工艺卡'}
      </button>
      {open ? (
        <ProcessCardModal
          jobId={jobId}
          jobNo={jobNo}
          initial={initial}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

function ProcessCardModal({
  jobId,
  jobNo,
  initial,
  onClose,
}: {
  jobId: string
  jobNo: string
  initial: StoredProcessCard | null
  onClose: () => void
}) {
  const [stored, setStored] = useState<StoredProcessCard | null>(initial)
  const [mode, setMode] = useState<'view' | 'staging' | 'busy' | 'edit' | 'saving'>(
    initial ? 'view' : 'staging',
  )
  const [staged, setStaged] = useState<File[]>([])
  const [draft, setDraft] = useState<ProcessCard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && mode !== 'busy' && mode !== 'saving' && mode !== 'edit') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, mode])

  const addFiles = (files: FileList | File[]) => {
    const incoming = Array.from(files)
    if (incoming.length === 0) return
    setError(null)

    const seen = new Set(staged.map(fileKey))
    const accepted: File[] = []
    const rejected: string[] = []

    for (const f of incoming) {
      if (!ALLOWED_TYPES.has(f.type)) {
        rejected.push(`${f.name} 类型不支持`)
        continue
      }
      if (f.size > MAX_FILE_BYTES) {
        rejected.push(`${f.name} 超过 12MB`)
        continue
      }
      const k = fileKey(f)
      if (seen.has(k)) continue
      seen.add(k)
      accepted.push(f)
    }

    let next = [...staged, ...accepted]
    if (next.length > MAX_FILES) {
      rejected.push(`最多 ${MAX_FILES} 份，已截断`)
      next = next.slice(0, MAX_FILES)
    }
    const total = next.reduce((sum, f) => sum + f.size, 0)
    if (total > MAX_TOTAL_BYTES) {
      rejected.push('总大小超过 18MB，请删几份再加')
      setStaged(staged)
      setError(rejected.join('；'))
      return
    }

    setStaged(next)
    if (rejected.length > 0) setError(rejected.join('；'))
  }

  const removeStaged = (key: string) => {
    setStaged((prev) => prev.filter((f) => fileKey(f) !== key))
    setError(null)
  }

  const submit = async () => {
    if (staged.length === 0) return
    setError(null)
    setMode('busy')
    const fd = new FormData()
    fd.append('jobId', jobId)
    for (const f of staged) fd.append('files', f)
    try {
      const r = await fetch('/api/process-card', { method: 'POST', body: fd })
      const json = await r.json()
      if (!r.ok || !json.ok) {
        setError(json.error ?? '生成失败')
        setMode('staging')
        return
      }
      setStored(json.card as StoredProcessCard)
      setStaged([])
      setMode('view')
      // No router.refresh — the parent /jobs/[id] page only reads the card
      // for the toolbar button label, which it'll catch up on the next
      // navigation. Dropping refresh removes the GFW-fragile RSC stream.
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败')
      setMode('staging')
    }
  }

  const startEdit = () => {
    if (!stored) return
    setDraft(JSON.parse(JSON.stringify(stored.card)) as ProcessCard)
    setError(null)
    setMode('edit')
  }

  const cancelEdit = () => {
    setDraft(null)
    setError(null)
    setMode('view')
  }

  const saveEdit = async () => {
    if (!draft || !stored) return
    setError(null)
    setMode('saving')
    try {
      const r = await fetch('/api/process-card', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, card: draft }),
      })
      const json = await r.json()
      if (!r.ok || !json.ok) {
        setError(json.error ?? '保存失败')
        setMode('edit')
        return
      }
      setStored(json.card as StoredProcessCard)
      setDraft(null)
      setMode('view')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
      setMode('edit')
    }
  }

  const remove = async () => {
    if (!stored) return
    setError(null)
    setMode('saving')
    try {
      const r = await fetch(
        `/api/process-card?jobId=${encodeURIComponent(jobId)}`,
        { method: 'DELETE' },
      )
      const json = await r.json()
      if (!r.ok || !json.ok) {
        setError(json.error ?? '删除失败')
        setMode('view')
        return
      }
      setStored(null)
      setDraft(null)
      setStaged([])
      setMode('staging')
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
      setMode('view')
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/35 px-4 py-10"
      onClick={() => mode !== 'busy' && onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[760px] bg-[var(--color-surface)] rounded-sm shadow-2xl border border-[var(--color-border-strong)]"
      >
        <header className="flex items-baseline justify-between px-10 pt-8 pb-2">
          <div>
            <p className="label">工艺卡</p>
            <h2 className="mt-1 text-[18px] font-medium tracking-tight text-[var(--color-ink)]">
              {jobNo}
            </h2>
          </div>
          <button
            type="button"
            disabled={mode === 'busy'}
            onClick={onClose}
            className="text-[12px] tracking-wider text-[var(--color-ink-3)] hover:text-[var(--color-ink)] disabled:opacity-50"
          >
            关闭
          </button>
        </header>

        <div className="px-10 pb-10 pt-4">
          {mode === 'staging' ? (
            <StagingTray
              staged={staged}
              drag={drag}
              setDrag={setDrag}
              inputRef={inputRef}
              onAdd={addFiles}
              onRemove={removeStaged}
              onSubmit={submit}
              regenerating={!!stored}
              onCancel={
                stored
                  ? () => {
                      setStaged([])
                      setError(null)
                      setMode('view')
                    }
                  : undefined
              }
            />
          ) : null}

          {mode === 'busy' ? <Generating /> : null}

          {mode === 'saving' ? <Saving /> : null}

          {mode === 'view' && stored ? (
            <CardView
              stored={stored}
              onEdit={startEdit}
              onDelete={remove}
              onRegenerate={() => {
                setMode('staging')
                setError(null)
              }}
            />
          ) : null}

          {mode === 'edit' && draft ? (
            <CardEditor
              draft={draft}
              onChange={setDraft}
              onSave={saveEdit}
              onCancel={cancelEdit}
            />
          ) : null}

          {error ? (
            <p className="mt-6 text-[12px] text-[var(--color-overdue)]">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function StagingTray({
  staged,
  drag,
  setDrag,
  inputRef,
  onAdd,
  onRemove,
  onSubmit,
  regenerating,
  onCancel,
}: {
  staged: File[]
  drag: boolean
  setDrag: (b: boolean) => void
  inputRef: React.RefObject<HTMLInputElement | null>
  onAdd: (files: FileList | File[]) => void
  onRemove: (key: string) => void
  onSubmit: () => void
  regenerating: boolean
  onCancel?: () => void
}) {
  const empty = staged.length === 0
  const totalBytes = staged.reduce((sum, f) => sum + f.size, 0)

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDrag(false)
    if (e.dataTransfer.files?.length) onAdd(e.dataTransfer.files)
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) onAdd(e.target.files)
          e.target.value = ''
        }}
      />

      {empty ? (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDrag(true)
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          className={`flex min-h-[260px] cursor-pointer flex-col items-center justify-center rounded-sm border border-dashed transition-colors ${
            drag
              ? 'border-[var(--color-ink)] bg-[var(--color-active-bg)]'
              : 'border-[var(--color-border-strong)] bg-[var(--color-muted-bg)] hover:border-[var(--color-ink)]'
          }`}
        >
          <p className="text-[15px] text-[var(--color-ink)]">
            {regenerating ? '重新上传图纸生成新卡' : '拖入图纸 · 点击上传'}
          </p>
          <p className="mt-2 label text-[var(--color-ink-3)]">
            PDF · 图片 · 最多 {MAX_FILES} 份 · 总 18MB · 多份图纸 = 多个零件
          </p>
        </div>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDrag(true)
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={handleDrop}
          className={`rounded-sm border transition-colors ${
            drag
              ? 'border-[var(--color-ink)] bg-[var(--color-active-bg)]'
              : 'border-[var(--color-border-strong)] bg-[var(--color-muted-bg)]'
          }`}
        >
          <ul className="divide-y divide-[var(--color-border)]">
            {staged.map((f) => {
              const k = fileKey(f)
              return (
                <li
                  key={k}
                  className="flex items-center justify-between px-4 py-3"
                >
                  <div className="min-w-0 flex-1 pr-4">
                    <p className="truncate text-[13.5px] text-[var(--color-ink)]">
                      {f.name}
                    </p>
                    <p className="mt-0.5 label text-[var(--color-ink-3)]">
                      {formatBytes(f.size)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemove(k)}
                    className="text-[11px] tracking-wider text-[var(--color-ink-3)] hover:text-[var(--color-overdue)]"
                  >
                    移除
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="flex items-center justify-between border-t border-[var(--color-border)] px-4 py-3">
            <p className="label text-[var(--color-ink-3)]">
              {staged.length} / {MAX_FILES} 份 · {formatBytes(totalBytes)} / 18MB
            </p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="text-[12px] tracking-wider text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
            >
              + 添加更多
            </button>
          </div>
        </div>
      )}

      <div className="mt-6 flex items-center justify-end gap-4">
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="text-[12px] tracking-wider text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
          >
            取消
          </button>
        ) : null}
        <button
          type="button"
          disabled={empty}
          onClick={onSubmit}
          className="rounded-sm border border-[var(--color-ink)] bg-[var(--color-ink)] px-4 py-1.5 text-[12px] tracking-wider text-[var(--color-surface)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          开始生成
        </button>
      </div>
    </>
  )
}

function Generating() {
  return (
    <div className="py-20">
      <p className="text-center text-[15px] text-[var(--color-ink)]">
        工艺卡生成中
      </p>
      <p className="mt-2 text-center label text-[var(--color-ink-3)]">
        Gemini 3.1 Pro · 通常 20-60 秒
      </p>
      <div className="mx-auto mt-8 h-[2px] w-[200px] overflow-hidden bg-[var(--color-border)]">
        <div className="h-full w-1/3 bg-[var(--color-ink)] animate-[slide_1.4s_cubic-bezier(0.32,0.72,0.18,1)_infinite]" />
      </div>
      <style jsx>{`
        @keyframes slide {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  )
}

function ComponentTabs({
  components,
  active,
  onPick,
}: {
  components: { name: string }[]
  active: number
  onPick: (i: number) => void
}) {
  if (components.length <= 1) return null
  return (
    <div className="-mx-1 mb-6 flex flex-wrap items-center gap-x-1 gap-y-1 border-b border-[var(--color-border)]">
      {components.map((c, i) => {
        const on = i === active
        return (
          <button
            key={i}
            type="button"
            onClick={() => onPick(i)}
            className={`relative -mb-px px-3 py-2 text-[13px] tracking-tight transition-colors ${
              on
                ? 'text-[var(--color-ink)] border-b border-[var(--color-ink)]'
                : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'
            }`}
          >
            {c.name || `零件 ${i + 1}`}
          </button>
        )
      })}
    </div>
  )
}

function CardView({
  stored,
  onEdit,
  onDelete,
  onRegenerate,
}: {
  stored: StoredProcessCard
  onEdit: () => void
  onDelete: () => void
  onRegenerate: () => void
}) {
  const card = stored.card
  const components = card.components.length > 0 ? card.components : []
  const [active, setActive] = useState(0)
  const safeActive = Math.min(active, Math.max(0, components.length - 1))
  const current = components[safeActive]
  const [confirmDelete, setConfirmDelete] = useState(false)

  const applied = current ? current.stations.filter((s) => s.applies) : []
  const skipped = current
    ? current.stations.filter((s) => !s.applies).map((s) => s.stage)
    : []

  return (
    <article>
      {card.summary ? (
        <p className="text-[15px] leading-relaxed text-[var(--color-ink)]">
          {card.summary}
        </p>
      ) : null}

      <div className="mt-6">
        <ComponentTabs
          components={components}
          active={safeActive}
          onPick={setActive}
        />
      </div>

      {current ? (
        <>
          {current.summary ? (
            <p className="text-[13.5px] leading-relaxed text-[var(--color-ink-2)]">
              {current.summary}
            </p>
          ) : null}

          <div className="mt-6 space-y-7">
            {applied.map((s) => (
              <Station key={s.stage} station={s} />
            ))}
          </div>

          {skipped.length > 0 ? (
            <p className="mt-8 text-[11px] tracking-wider text-[var(--color-ink-3)]">
              不经过 · {skipped.join(' · ')}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-[13px] text-[var(--color-ink-3)]">未识别到零件</p>
      )}

      <footer className="mt-10 border-t border-[var(--color-border)] pt-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="label">附件</span>
          {stored.sourceFiles.length === 0 ? (
            <span className="text-[12px] text-[var(--color-ink-3)]">—</span>
          ) : (
            stored.sourceFiles.map((f) => (
              <a
                key={f.url}
                href={f.url}
                target="_blank"
                rel="noopener"
                className="text-[12px] text-[var(--color-ink-2)] underline-offset-2 hover:text-[var(--color-ink)] hover:underline"
              >
                {f.name}
              </a>
            ))
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-5 text-[12px] tracking-wider">
          {confirmDelete ? (
            <>
              <span className="text-[var(--color-overdue)]">确认删除？</span>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmDelete(false)
                  onDelete()
                }}
                className="text-[var(--color-overdue)] hover:underline"
              >
                删除
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="text-[var(--color-ink-3)] hover:text-[var(--color-overdue)]"
              >
                删除
              </button>
              <button
                type="button"
                onClick={onRegenerate}
                className="text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
              >
                重新生成
              </button>
              <button
                type="button"
                onClick={onEdit}
                className="text-[var(--color-ink)] hover:underline"
              >
                编辑
              </button>
            </>
          )}
        </div>
      </footer>
    </article>
  )
}

function Saving() {
  return (
    <div className="py-20">
      <p className="text-center text-[15px] text-[var(--color-ink)]">保存中</p>
      <div className="mx-auto mt-8 h-[2px] w-[160px] overflow-hidden bg-[var(--color-border)]">
        <div className="h-full w-1/3 bg-[var(--color-ink)] animate-[slide_1.4s_cubic-bezier(0.32,0.72,0.18,1)_infinite]" />
      </div>
      <style jsx>{`
        @keyframes slide {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  )
}

function CardEditor({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: ProcessCard
  onChange: (next: ProcessCard) => void
  onSave: () => void
  onCancel: () => void
}) {
  const [active, setActive] = useState(0)
  const safeActive = Math.min(active, Math.max(0, draft.components.length - 1))
  const current = draft.components[safeActive]

  const updateComponent = (idx: number, patch: Partial<ComponentCard>) => {
    onChange({
      ...draft,
      components: draft.components.map((c, i) =>
        i === idx ? { ...c, ...patch } : c,
      ),
    })
  }

  const updateStation = (stage: Stage, patch: Partial<StationCard>) => {
    if (!current) return
    updateComponent(safeActive, {
      stations: current.stations.map((s) =>
        s.stage === stage ? { ...s, ...patch } : s,
      ),
    })
  }

  const applied = current ? current.stations.filter((s) => s.applies) : []
  const skipped = current ? current.stations.filter((s) => !s.applies) : []

  return (
    <article>
      <textarea
        value={draft.summary}
        onChange={(e) => onChange({ ...draft, summary: e.target.value })}
        rows={2}
        placeholder="工单整体说明…"
        className="w-full resize-none rounded-sm border border-transparent bg-[var(--color-muted-bg)] px-3 py-2 text-[15px] leading-relaxed text-[var(--color-ink)] placeholder:text-[var(--color-ink-3)] focus:border-[var(--color-ink)] focus:bg-transparent focus:outline-none"
      />

      <div className="mt-6">
        <ComponentTabs
          components={draft.components}
          active={safeActive}
          onPick={setActive}
        />
      </div>

      {current ? (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
            <input
              type="text"
              value={current.name}
              onChange={(e) => updateComponent(safeActive, { name: e.target.value })}
              placeholder="零件名"
              className="rounded-sm border border-transparent bg-[var(--color-muted-bg)] px-2 py-1 text-[14px] font-medium text-[var(--color-ink)] placeholder:text-[var(--color-ink-3)] focus:border-[var(--color-ink)] focus:bg-transparent focus:outline-none"
            />
          </div>
          <textarea
            value={current.summary ?? ''}
            onChange={(e) =>
              updateComponent(safeActive, {
                summary: e.target.value || undefined,
              })
            }
            rows={2}
            placeholder="这件零件的一句话要点（可空）…"
            className="mt-2 w-full resize-none rounded-sm border border-transparent bg-[var(--color-muted-bg)] px-3 py-2 text-[13.5px] leading-relaxed text-[var(--color-ink-2)] placeholder:text-[var(--color-ink-3)] focus:border-[var(--color-ink)] focus:bg-transparent focus:outline-none"
          />

          <div className="mt-6 space-y-7">
            {applied.map((s) => (
              <StationEditor
                key={s.stage}
                station={s}
                onPatch={(patch) => updateStation(s.stage, patch)}
                onSkip={() =>
                  updateStation(s.stage, {
                    applies: false,
                    keyPoints: [],
                    risks: undefined,
                  })
                }
              />
            ))}
          </div>

          {skipped.length > 0 ? (
            <div className="mt-8 flex flex-wrap items-baseline gap-x-3 gap-y-2">
              <span className="text-[11px] tracking-wider text-[var(--color-ink-3)]">
                不经过
              </span>
              {skipped.map((s) => (
                <button
                  key={s.stage}
                  type="button"
                  onClick={() =>
                    updateStation(s.stage, {
                      applies: true,
                      keyPoints: s.keyPoints,
                    })
                  }
                  className="text-[11px] tracking-wider text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
                >
                  + {s.stage}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-[13px] text-[var(--color-ink-3)]">无零件</p>
      )}

      <footer className="mt-10 flex items-center justify-end gap-5 border-t border-[var(--color-border)] pt-4 text-[12px] tracking-wider">
        <button
          type="button"
          onClick={onCancel}
          className="text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onSave}
          className="rounded-sm border border-[var(--color-ink)] bg-[var(--color-ink)] px-4 py-1.5 text-[var(--color-surface)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
        >
          保存
        </button>
      </footer>
    </article>
  )
}

function StationEditor({
  station,
  onPatch,
  onSkip,
}: {
  station: StationCard
  onPatch: (patch: Partial<StationCard>) => void
  onSkip: () => void
}) {
  const risks = station.risks ?? []

  const setKeyPoint = (i: number, value: string) => {
    const next = [...station.keyPoints]
    next[i] = value
    onPatch({ keyPoints: next })
  }
  const removeKeyPoint = (i: number) => {
    onPatch({ keyPoints: station.keyPoints.filter((_, idx) => idx !== i) })
  }
  const addKeyPoint = () => {
    onPatch({ keyPoints: [...station.keyPoints, ''] })
  }

  const setRisk = (i: number, value: string) => {
    const next = [...risks]
    next[i] = value
    onPatch({ risks: next })
  }
  const removeRisk = (i: number) => {
    const next = risks.filter((_, idx) => idx !== i)
    onPatch({ risks: next.length > 0 ? next : undefined })
  }
  const addRisk = () => {
    onPatch({ risks: [...risks, ''] })
  }

  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h3 className="text-[11px] tracking-[0.18em] uppercase text-[var(--color-ink-3)]">
          {station.stage}
        </h3>
        <button
          type="button"
          onClick={onSkip}
          className="text-[11px] tracking-wider text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
        >
          标为不经过
        </button>
      </div>

      <ul className="mt-2 space-y-1">
        {station.keyPoints.map((p, i) => (
          <EditableRow
            key={i}
            value={p}
            onChange={(v) => setKeyPoint(i, v)}
            onRemove={() => removeKeyPoint(i)}
            placeholder="一条要点…"
            tone="ink"
          />
        ))}
      </ul>
      <button
        type="button"
        onClick={addKeyPoint}
        className="mt-1 text-[11px] tracking-wider text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
      >
        + 添加要点
      </button>

      <div className="mt-4">
        <p className="label text-[var(--color-warning)]">注意</p>
        <ul className="mt-1 space-y-1">
          {risks.map((r, i) => (
            <EditableRow
              key={i}
              value={r}
              onChange={(v) => setRisk(i, v)}
              onRemove={() => removeRisk(i)}
              placeholder="风险或冲突…"
              tone="ink-2"
            />
          ))}
        </ul>
        <button
          type="button"
          onClick={addRisk}
          className="mt-1 text-[11px] tracking-wider text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
        >
          + 添加注意
        </button>
      </div>
    </section>
  )
}

function EditableRow({
  value,
  onChange,
  onRemove,
  placeholder,
  tone,
}: {
  value: string
  onChange: (v: string) => void
  onRemove: () => void
  placeholder: string
  tone: 'ink' | 'ink-2'
}) {
  const color = tone === 'ink' ? 'var(--color-ink)' : 'var(--color-ink-2)'
  return (
    <li className="group flex items-start gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 rounded-sm border border-transparent bg-transparent px-2 py-1 text-[13.5px] leading-relaxed placeholder:text-[var(--color-ink-3)] hover:border-[var(--color-border)] focus:border-[var(--color-ink)] focus:outline-none"
        style={{ color }}
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label="删除"
        className="mt-1 text-[11px] text-[var(--color-ink-3)] opacity-0 transition-opacity hover:text-[var(--color-overdue)] group-hover:opacity-100 focus:opacity-100"
      >
        ×
      </button>
    </li>
  )
}

function Station({ station }: { station: StationCard }) {
  return (
    <section>
      <h3 className="text-[11px] tracking-[0.18em] uppercase text-[var(--color-ink-3)]">
        {station.stage}
      </h3>
      {station.keyPoints.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {station.keyPoints.map((p, i) => (
            <li
              key={i}
              className="text-[13.5px] leading-relaxed text-[var(--color-ink)]"
            >
              {p}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12px] text-[var(--color-ink-3)]">
          {STAGES.includes(station.stage) ? '—' : ''}
        </p>
      )}
      {station.risks && station.risks.length > 0 ? (
        <div className="mt-3">
          <p className="label text-[var(--color-warning)]">注意</p>
          <ul className="mt-1 space-y-1">
            {station.risks.map((r, i) => (
              <li
                key={i}
                className="text-[13px] leading-relaxed text-[var(--color-ink-2)]"
              >
                {r}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
