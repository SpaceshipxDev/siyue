'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { dispatchComponentImageUpdated } from './_image_uploader'

// Batch photo dropzone for the import-review page. Accepts a folder-dump of
// images, matches each filename (sans extension, normalized) against the
// AI-extracted component names, and shows a preview strip with the match
// resolution before the user commits. Unmatched files get a manual <select>;
// already-set components are flagged 替换 so an accidental overwrite is loud.
//
// Apply runs N parallel POSTs against the same /api/upload-image route the
// per-row picker uses, so production storage / auth paths are unchanged.

type ComponentLite = { id: string; name: string; imageUrl?: string }

type Match =
  | { kind: 'matched'; componentId: string; replace: boolean }
  | { kind: 'unmatched' }

type Staged = {
  id: string
  file: File
  previewUrl: string
  match: Match
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const
const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif'

// Strip the kinds of typographic noise that creep into shop filenames:
// hyphens, underscores, dots, brackets, full-width parens, slashes — but keep
// CJK characters as-is so 旁通板.jpg matches a component literally named 旁通板.
function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s\-_.()[\]{}【】（）·,，、|/\\]+/g, '')
    .trim()
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

function isImageFile(file: File): boolean {
  if (file.type && file.type.startsWith('image/')) return true
  return (IMAGE_EXTS as readonly string[]).includes(extOf(file.name))
}

// Some drag sources (Finder columns, certain terminals) drop files with an
// empty `type`. The upload route's MIME allowlist is strict, so we re-wrap
// the File with a type derived from the extension before sending.
function withRepairedType(file: File): File {
  if (file.type && file.type.startsWith('image/')) return file
  const ext = extOf(file.name)
  const mime =
    ext === 'png'
      ? 'image/png'
      : ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'gif'
            ? 'image/gif'
            : ''
  if (!mime) return file
  return new File([file], file.name, { type: mime, lastModified: file.lastModified })
}

export function BatchPhotoUploader({
  jobId,
  components,
}: {
  jobId: string
  components: ComponentLite[]
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  const [staged, setStaged] = useState<Staged[]>([])
  const [busy, startTransition] = useTransition()
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const indexByName = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of components) {
      const key = normalize(c.name || '')
      if (!key) continue
      // First-wins on duplicate normalized names — surfaces as 重复 on the
      // second card when two files target the same component.
      if (!m.has(key)) m.set(key, c.id)
    }
    return m
  }, [components])

  const componentImage = useMemo(() => {
    const m = new Map<string, string | undefined>()
    for (const c of components) m.set(c.id, c.imageUrl)
    return m
  }, [components])

  const componentName = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of components) m.set(c.id, c.name)
    return m
  }, [components])

  const stagedTargets = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of staged) {
      if (s.match.kind === 'matched') {
        m.set(s.match.componentId, (m.get(s.match.componentId) ?? 0) + 1)
      }
    }
    return m
  }, [staged])

  // Free object URLs on unmount so dragging hundreds of photos doesn't
  // leak. Per-item revokes happen inline in remove() / apply().
  useEffect(() => {
    return () => {
      for (const s of staged) URL.revokeObjectURL(s.previewUrl)
    }
    // staged is intentionally captured at unmount time, not as a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const accept = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files).filter(isImageFile)
      if (list.length === 0) return
      const next: Staged[] = list.map((f) => {
        const cid = indexByName.get(normalize(stripExt(f.name)))
        const match: Match = cid
          ? {
              kind: 'matched',
              componentId: cid,
              replace: Boolean(componentImage.get(cid)),
            }
          : { kind: 'unmatched' }
        return {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          file: f,
          previewUrl: URL.createObjectURL(f),
          match,
        }
      })
      setStaged((prev) => [...prev, ...next])
    },
    [componentImage, indexByName],
  )

  const remove = (id: string) => {
    setStaged((prev) => {
      const item = prev.find((s) => s.id === id)
      if (item) URL.revokeObjectURL(item.previewUrl)
      return prev.filter((s) => s.id !== id)
    })
    setErrors((e) => {
      if (!(id in e)) return e
      const copy = { ...e }
      delete copy[id]
      return copy
    })
  }

  const overrideTarget = (id: string, componentId: string | '') => {
    setStaged((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s
        if (!componentId) return { ...s, match: { kind: 'unmatched' } }
        return {
          ...s,
          match: {
            kind: 'matched',
            componentId,
            replace: Boolean(componentImage.get(componentId)),
          },
        }
      }),
    )
  }

  const clearAll = () => {
    for (const s of staged) URL.revokeObjectURL(s.previewUrl)
    setStaged([])
    setErrors({})
  }

  const apply = () => {
    const queue = staged.filter((s) => s.match.kind === 'matched')
    if (queue.length === 0) return
    setErrors({})
    setProgress({ done: 0, total: queue.length })
    startTransition(async () => {
      const failures: Record<string, string> = {}
      let cursor = 0
      let done = 0
      const CONCURRENCY = 4
      const worker = async () => {
        while (cursor < queue.length) {
          const i = cursor++
          const item = queue[i]
          try {
            const fd = new FormData()
            fd.append('file', withRepairedType(item.file))
            fd.append('jobId', jobId)
            fd.append(
              'componentId',
              (item.match as { componentId: string }).componentId,
            )
            const r = await fetch('/api/upload-image', {
              method: 'POST',
              body: fd,
            })
            const data = (await r.json()) as
              | { ok: true; url: string }
              | { ok: false; error: string }
            if (!('ok' in data) || !data.ok) {
              failures[item.id] = 'error' in data ? data.error : '失败'
            } else {
              // Tell sibling per-row uploaders to re-render with the new
              // URL — replaces the router.refresh() this used to call,
              // which was a fat RSC stream that the GFW would shred.
              dispatchComponentImageUpdated({
                componentId: (item.match as { componentId: string }).componentId,
                url: data.url,
              })
            }
          } catch (err) {
            failures[item.id] = err instanceof Error ? err.message : '失败'
          }
          done++
          setProgress({ done, total: queue.length })
        }
      }
      const workers = Array.from(
        { length: Math.min(CONCURRENCY, queue.length) },
        worker,
      )
      await Promise.all(workers)

      const succeededIds = new Set(
        queue.filter((q) => !failures[q.id]).map((q) => q.id),
      )
      // Revoke previews for the cards we're about to drop. Held-back failed
      // and unmatched cards keep their URLs so the user can still see them.
      for (const s of staged) {
        if (succeededIds.has(s.id)) URL.revokeObjectURL(s.previewUrl)
      }
      setStaged((prev) => prev.filter((s) => !succeededIds.has(s.id)))
      setErrors(failures)
      setProgress(null)
      // No router.refresh() — sibling thumbnails were updated via the
      // dispatchComponentImageUpdated events above, and the page-level
      // "已配图 N/M" badge will catch up on the next natural navigation
      // (the import page is force-dynamic).
    })
  }

  const stats = useMemo(() => {
    let matched = 0
    let unmatched = 0
    let replace = 0
    for (const s of staged) {
      if (s.match.kind === 'matched') {
        matched++
        if (s.match.replace) replace++
      } else unmatched++
    }
    return { matched, unmatched, replace }
  }, [staged])

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDrag(false)
    if (e.dataTransfer.files?.length) accept(e.dataTransfer.files)
  }

  if (components.length === 0) return null

  return (
    <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer px-4 py-3 transition-colors ${
          drag ? 'bg-[var(--color-active-bg)]' : 'hover:bg-[var(--color-bg)]'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) accept(e.target.files)
            e.target.value = ''
          }}
        />
        <div className="flex items-baseline justify-between gap-3">
          <p className="label">批量配图</p>
          {staged.length > 0 ? (
            <span className="label text-[var(--color-ink-3)]">
              <span className="mono mr-1 text-[12px] font-medium text-[var(--color-ink)]">
                {stats.matched}
              </span>
              匹配
              {stats.replace > 0 ? (
                <span className="ml-2 text-[var(--color-warning)]">
                  · {stats.replace} 替换
                </span>
              ) : null}
              {stats.unmatched > 0 ? (
                <span className="ml-2 text-[var(--color-overdue)]">
                  · {stats.unmatched} 未匹配
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-[13px] text-[var(--color-ink-2)]">
          {drag
            ? '松开以加入'
            : '拖入或点击 · 文件名 = 零件名 自动匹配 (.jpg .png .webp .gif)'}
        </p>
      </div>

      {staged.length > 0 ? (
        <>
          <div className="border-t border-[var(--color-border)] px-4 py-3">
            <div className="flex flex-wrap gap-3">
              {staged.map((s) => (
                <StagedCard
                  key={s.id}
                  item={s}
                  components={components}
                  componentName={componentName}
                  collision={
                    s.match.kind === 'matched' &&
                    (stagedTargets.get(s.match.componentId) ?? 0) > 1
                  }
                  error={errors[s.id]}
                  onRemove={() => remove(s.id)}
                  onPick={(cid) => overrideTarget(s.id, cid)}
                  disabled={busy}
                />
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
            <div className="label text-[var(--color-ink-3)]">
              {progress
                ? `上传中 · ${progress.done}/${progress.total}`
                : stats.unmatched > 0
                  ? '未匹配项请手动选择零件，或留空跳过'
                  : '点击「应用」上传匹配 · 替换会覆盖已有图'}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={clearAll}
                disabled={busy}
                className="px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-ink-3)] hover:text-[var(--color-ink)] disabled:opacity-50"
              >
                清空
              </button>
              <button
                type="button"
                onClick={apply}
                disabled={busy || stats.matched === 0}
                className="px-4 py-1.5 text-[12px] tracking-wider rounded-sm bg-[var(--color-ink)] text-[var(--color-surface)] hover:opacity-80 disabled:opacity-50"
              >
                {busy ? '上传中…' : `应用 ${stats.matched}`}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

function StagedCard({
  item,
  components,
  componentName,
  collision,
  error,
  onRemove,
  onPick,
  disabled,
}: {
  item: Staged
  components: ComponentLite[]
  componentName: Map<string, string>
  collision: boolean
  error?: string
  onRemove: () => void
  onPick: (id: string | '') => void
  disabled: boolean
}) {
  const matched = item.match.kind === 'matched' ? item.match : null
  return (
    <div
      className={`flex w-44 flex-col rounded-sm border bg-[var(--color-surface)] ${
        error
          ? 'border-[var(--color-overdue)]'
          : matched
            ? 'border-[var(--color-border)]'
            : 'border-dashed border-[var(--color-border-strong)]'
      }`}
    >
      <div className="relative h-24 w-full overflow-hidden rounded-t-sm bg-[var(--color-muted-bg)]">
        {/* Local object URL — next/image isn't appropriate for blob: sources. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.previewUrl}
          alt={item.file.name}
          className="h-full w-full object-contain"
        />
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label="移除"
          title="移除"
          className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-sm bg-[var(--color-surface)]/90 text-[var(--color-ink-2)] hover:bg-[var(--color-surface)] hover:text-[var(--color-overdue)] disabled:opacity-50"
        >
          ×
        </button>
      </div>
      <div className="flex flex-col gap-1 px-2 py-2">
        <p
          className="mono truncate text-[11px] text-[var(--color-ink-3)]"
          title={item.file.name}
        >
          {item.file.name}
        </p>
        {matched ? (
          <div className="flex items-baseline justify-between gap-1">
            <span
              className="truncate text-[12px] font-medium text-[var(--color-ink)]"
              title={componentName.get(matched.componentId) ?? ''}
            >
              {componentName.get(matched.componentId) || '(未命名)'}
            </span>
            {matched.replace ? (
              <span className="label shrink-0 text-[var(--color-warning)]">替换</span>
            ) : collision ? (
              <span className="label shrink-0 text-[var(--color-warning)]">重复</span>
            ) : (
              <span className="label shrink-0 text-[var(--color-success)]">✓</span>
            )}
          </div>
        ) : (
          <select
            disabled={disabled}
            value=""
            onChange={(e) => onPick(e.target.value)}
            className="w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-1 text-[12px] text-[var(--color-ink)] disabled:opacity-50"
          >
            <option value="">未匹配 · 选择零件</option>
            {components.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || '(未命名)'}
              </option>
            ))}
          </select>
        )}
        {matched ? (
          <button
            type="button"
            onClick={() => onPick('')}
            disabled={disabled}
            className="self-start label text-[var(--color-ink-3)] hover:text-[var(--color-ink)] disabled:opacity-50"
          >
            改选
          </button>
        ) : null}
        {error ? (
          <span className="label text-[var(--color-overdue)]" title={error}>
            失败 · {error}
          </span>
        ) : null}
      </div>
    </div>
  )
}
