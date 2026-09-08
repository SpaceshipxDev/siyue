'use client'

import { useRef, useState, useTransition } from 'react'
import { withBase } from '@/lib/base-path'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { mutate } from '@/lib/mutate'
import { usePasteImage } from '@/app/_paste_image'
import {
  commProgress,
  topicAgreed,
  topicFilled,
  COMM_AGREED_LABEL,
  COMM_STAGES,
  COMM_TOPIC_SPECS,
  type CommEntry,
  type CommPhoto,
  type CommSheet,
  type CommStage,
  type CommTopic,
} from '@/lib/comm-sheet'

// 工程部沟通确认单 —— 跟客户把技术细节谈定的那张纸, 长在工单上。
//
// 七项, 每项三段: 客户提的 → 我司的方案 → 双方最终结论。三段里最值钱的是第
// 三段: 前两段是各说各的, 只有"最终结论"是双方点过头的那一句 —— 半年后扯皮
// 时, 车间照着做的、质检照着判的、客户拿来对的, 都是它。所以结论那一格底色
// 单独描出来, 一眼能找到。
//
// 谁填: 工程和商务。谁看: 全厂 —— 喷漆房的人打开工单就能读到客户对喷涂那一
// 栏的结论, 不用再去问。凡是"谈好了但车间不知道"的事, 最后都变成返工。

export function CommSheetPanel({
  jobId,
  jobNo,
  productName,
  initial,
  canWrite,
  myStage,
}: {
  jobId: string
  jobNo: string
  productName: string
  initial?: CommSheet
  canWrite: boolean
  /** 车间账号自己的工段 —— 跟他有关的那一项会被点出来。 */
  myStage?: string
}) {
  const [sheet, setSheet] = useState<CommSheet>(
    initial ?? { jobId, items: {} },
  )
  const progress = commProgress(sheet)

  const save = async (patch: Record<string, unknown>) => {
    const res = await mutate<CommSheet>({ kind: 'saveCommSheet', jobId, patch })
    if (res.data) setSheet(res.data)
  }

  // 图片进出都只动那一项 —— 别的项正在编辑的内容不受影响。
  const addPhoto = (key: CommTopic, photo: CommPhoto) =>
    setSheet((cur) => {
      const e = { ...(cur.items?.[key] ?? {}) }
      e.photos = [...(e.photos ?? []), photo]
      return { ...cur, items: { ...cur.items, [key]: e } }
    })
  const dropPhoto = (key: CommTopic, photoId: string) =>
    setSheet((cur) => {
      const e = { ...(cur.items?.[key] ?? {}) }
      const rest = (e.photos ?? []).filter((p) => p.id !== photoId)
      e.photos = rest.length > 0 ? rest : undefined
      return { ...cur, items: { ...cur.items, [key]: e } }
    })

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="text-[15px] font-medium tracking-tight text-[var(--color-ink)]">
            工程部沟通确认单
          </h2>
          <p className="text-[12px] text-[var(--color-ink-2)]">
            {progress.agreed} / {progress.total} 项已有结论
            {progress.touched > progress.agreed && (
              <>
                <span className="mx-1.5 text-[var(--color-ink-4)]">·</span>
                {progress.touched - progress.agreed} 项谈了还没定
              </>
            )}
          </p>
        </div>
        <a
          href={withBase(`/jobs/${jobId}/comm/print`)}
          target="_blank"
          rel="noopener"
          className="rounded-[2px] border border-[var(--color-border-strong)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-ink-2)] transition-colors hover:text-[var(--color-ink)]"
        >
          打印 / 发客户签字
        </a>
      </div>

      {/* 抬头 —— 纸上那四格加一排阶段 */}
      <div className="grid grid-cols-1 gap-x-10 gap-y-3 border-y border-[var(--color-border)] py-4 md:grid-cols-2">
        <Head
          label="项目名称"
          value={sheet.projectName}
          placeholder={productName || jobNo}
          canWrite={canWrite}
          onSave={(v) => save({ projectName: v })}
        />
        <Head
          label="客户对接人"
          value={sheet.customerContact}
          canWrite={canWrite}
          onSave={(v) => save({ customerContact: v })}
        />
        <Head
          label="商务/工程对接人"
          value={sheet.ourContact}
          canWrite={canWrite}
          onSave={(v) => save({ ourContact: v })}
        />
        <HeadDate
          label="沟通日期"
          value={sheet.talkedAt}
          canWrite={canWrite}
          onSave={(v) => save({ talkedAt: v })}
        />
        <div className="md:col-span-2">
          <p className="label mb-1.5">项目当前阶段</p>
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
            {COMM_STAGES.map((st) => {
              const on = sheet.stage === st
              return (
                <button
                  key={st}
                  type="button"
                  disabled={!canWrite}
                  onClick={() => save({ stage: on ? '' : st })}
                  className={`text-[13px] transition-colors ${
                    on
                      ? 'font-semibold text-[var(--color-ink)] underline underline-offset-4'
                      : 'text-[var(--color-ink-3)] hover:text-[var(--color-ink)] disabled:hover:text-[var(--color-ink-3)]'
                  }`}
                >
                  {st}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* 七项 */}
      <div className="mt-1">
        {COMM_TOPIC_SPECS.map((spec, i) => (
          <TopicBlock
            key={spec.key}
            n={i + 1}
            jobId={jobId}
            spec={spec}
            entry={sheet.items?.[spec.key]}
            canWrite={canWrite}
            mine={!!spec.stage && spec.stage === myStage}
            onSave={(field, text) =>
              save({ topic: { key: spec.key, field, text } })
            }
            onPhotoAdded={(ph) => addPhoto(spec.key, ph)}
            onPhotoRemoved={(id) => dropPhoto(spec.key, id)}
          />
        ))}
      </div>

      {sheet.by && sheet.updatedAt && (
        <p className="mt-5 text-[11px] text-[var(--color-ink-3)]">
          最后一次由 {sheet.by} 于 {sheet.updatedAt.slice(0, 10)} 修改
        </p>
      )}
    </div>
  )
}

// ── 抬头一格 ───────────────────────────────────────────────────────────────

function Head({
  label,
  value,
  placeholder,
  canWrite,
  onSave,
}: {
  label: string
  value?: string
  placeholder?: string
  canWrite: boolean
  onSave: (v: string) => Promise<void>
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="label w-[104px] shrink-0">{label}</span>
      <span className="min-w-0 flex-1">
        <InlineText
          value={value}
          placeholder={placeholder ?? '—'}
          canWrite={canWrite}
          onSave={onSave}
        />
      </span>
    </div>
  )
}

function HeadDate({
  label,
  value,
  canWrite,
  onSave,
}: {
  label: string
  value?: string
  canWrite: boolean
  onSave: (v: string) => Promise<void>
}) {
  const [pending, start] = useTransition()
  return (
    <div className="flex items-baseline gap-3">
      <span className="label w-[104px] shrink-0">{label}</span>
      {canWrite ? (
        <input
          type="date"
          value={value ?? ''}
          disabled={pending}
          onChange={(e) => start(async () => void (await onSave(e.target.value)))}
          className="mono min-w-0 flex-1 border-b border-[var(--color-border-strong)] bg-transparent py-0.5 text-[13px] text-[var(--color-ink)] focus:border-[var(--color-ink)] focus:outline-none"
        />
      ) : (
        <span className="mono min-w-0 flex-1 border-b border-[var(--color-border)] pb-0.5 text-[13px]">
          {value || '—'}
        </span>
      )}
    </div>
  )
}

// ── 一项 ───────────────────────────────────────────────────────────────────

function TopicBlock({
  n,
  jobId,
  spec,
  entry,
  canWrite,
  mine,
  onSave,
  onPhotoAdded,
  onPhotoRemoved,
}: {
  n: number
  jobId: string
  spec: (typeof COMM_TOPIC_SPECS)[number]
  entry?: CommEntry
  canWrite: boolean
  mine: boolean
  onSave: (field: 'ask' | 'ours' | 'agreed', text: string) => Promise<void>
  onPhotoAdded: (p: CommPhoto) => void
  onPhotoRemoved: (id: string) => void
}) {
  const agreed = topicAgreed(entry)
  const filled = topicFilled(entry)
  return (
    <section className="flex gap-4 border-b border-[var(--color-border)] py-4">
      <span
        className={`mono mt-[2px] flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full text-[11px] ${
          agreed
            ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
            : filled
              ? 'border border-[var(--color-ink)] text-[var(--color-ink)]'
              : 'border border-[var(--color-border-strong)] text-[var(--color-ink-4)]'
        }`}
      >
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="text-[13.5px] font-medium text-[var(--color-ink)]">
            {spec.title}
          </span>
          {spec.stage && (
            <span
              className={`label ${
                mine ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-4)]'
              }`}
            >
              {spec.stage}
              {mine ? ' · 你这一段' : ''}
            </span>
          )}
          {!filled && (
            <span className="label text-[var(--color-ink-4)]">还没谈</span>
          )}
        </div>

        <Field
          label={spec.askLabel}
          value={entry?.ask}
          canWrite={canWrite}
          onSave={(v) => onSave('ask', v)}
        />
        <Field
          label={spec.oursLabel}
          value={entry?.ours}
          canWrite={canWrite}
          onSave={(v) => onSave('ours', v)}
        />
        {/* 最终结论 —— 车间和质检照着做的就是这一句, 所以它有自己的底。 */}
        <Field
          label={COMM_AGREED_LABEL}
          value={entry?.agreed}
          canWrite={canWrite}
          strong
          onSave={(v) => onSave('agreed', v)}
        />

        <Photos
          jobId={jobId}
          topic={spec.key}
          photos={entry?.photos ?? []}
          canWrite={canWrite}
          onAdded={onPhotoAdded}
          onRemoved={onPhotoRemoved}
        />
      </div>
    </section>
  )
}

// 这一项的图 —— 客户圈出来的那个圆角、色板照、丝印位置。一句话写半天还容易
// 理解偏, 一张图贴上去就没歧义, 而且跟着确认单一起印给客户签。
function Photos({
  jobId,
  topic,
  photos,
  canWrite,
  onAdded,
  onRemoved,
}: {
  jobId: string
  topic: CommTopic
  photos: CommPhoto[]
  canWrite: boolean
  onAdded: (p: CommPhoto) => void
  onRemoved: (id: string) => void
}) {
  const zoneRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async (files: FileList | File[] | null) => {
    if (!files) return
    const list = Array.from(files)
    if (list.length === 0 || busy) return
    setError(null)
    setBusy(true)
    for (const file of list) {
      try {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('jobId', jobId)
        fd.append('topic', topic)
        const r = await fetch(withBase('/api/upload-comm-photo'), {
          method: 'POST',
          body: fd,
        })
        const d = (await r.json()) as {
          ok?: boolean
          photo?: CommPhoto
          error?: string
        }
        if (!d.ok || !d.photo) throw new Error(d.error || '上传失败')
        onAdded(d.photo)
      } catch (e) {
        setError(e instanceof Error ? e.message : '上传失败')
      }
    }
    setBusy(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  usePasteImage(zoneRef, (f) => void send([f]), canWrite)

  if (photos.length === 0 && !canWrite) return null

  return (
    <div ref={zoneRef} className="mt-2 flex flex-wrap items-center gap-2">
      {photos.map((p) => (
        <span
          key={p.id}
          className="group relative block h-[68px] w-[68px] overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]"
        >
          <a
            href={proxiedStorageUrl(p.url)}
            target="_blank"
            rel="noreferrer"
            title={`${p.filename}${p.uploadedBy ? ` · ${p.uploadedBy}` : ''}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={proxiedStorageUrl(p.url)}
              alt={p.filename}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          </a>
          {canWrite && (
            <button
              type="button"
              aria-label="删除这张图"
              title="删除这张图"
              onClick={async () => {
                if (!confirm('删掉这张图?')) return
                await mutate({
                  kind: 'deleteCommPhoto',
                  jobId,
                  topic,
                  photoId: p.id,
                })
                onRemoved(p.id)
              }}
              className="absolute right-0.5 top-0.5 inline-flex h-5 w-5 items-center justify-center rounded-[2px] bg-[var(--color-surface)]/90 text-[var(--color-ink-2)] hover:text-[var(--color-overdue)]"
            >
              ×
            </button>
          )}
        </span>
      ))}
      {canWrite && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          title="点击选图 · 或鼠标停在这里按 Ctrl+V 粘贴"
          className="flex h-[68px] w-[68px] flex-col items-center justify-center gap-0.5 rounded-[2px] border border-dashed border-[var(--color-border-strong)] text-[var(--color-ink-3)] transition-colors hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] disabled:opacity-50"
        >
          <span className="text-[15px] leading-none">＋</span>
          <span className="text-[10px] tracking-wider">
            {busy ? '上传中' : '贴图'}
          </span>
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => void send(e.target.files)}
      />
      {error && (
        <span className="text-[12px] text-[var(--color-overdue)]">{error}</span>
      )}
    </div>
  )
}

function Field({
  label,
  value,
  canWrite,
  strong,
  onSave,
}: {
  label: string
  value?: string
  canWrite: boolean
  strong?: boolean
  onSave: (v: string) => Promise<void>
}) {
  return (
    <div
      className={`mt-1.5 rounded-[2px] px-2.5 py-2 ${
        strong
          ? 'bg-[var(--color-active-bg)]'
          : 'border-l border-[var(--color-border)]'
      }`}
    >
      <p
        className={`label mb-1 ${
          strong ? 'text-[var(--color-ink-2)]' : 'text-[var(--color-ink-3)]'
        }`}
      >
        {label}
      </p>
      <InlineText
        value={value}
        placeholder={canWrite ? '点这里写' : '—'}
        canWrite={canWrite}
        multiline
        onSave={onSave}
      />
    </div>
  )
}

// 点着就能改, 存下就是这张单的新内容 —— 跟系统里别处的行内编辑一个手势。
function InlineText({
  value,
  placeholder,
  canWrite,
  multiline,
  onSave,
}: {
  value?: string
  placeholder: string
  canWrite: boolean
  multiline?: boolean
  onSave: (v: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value ?? '')
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const commit = () => {
    setError(null)
    start(async () => {
      try {
        await onSave(text)
        setEditing(false)
      } catch (e) {
        setError(e instanceof Error ? e.message : '保存失败')
      }
    })
  }

  if (!editing) {
    const shown = value?.trim()
    return (
      <p
        onClick={() => {
          if (!canWrite) return
          setText(value ?? '')
          setEditing(true)
        }}
        className={`whitespace-pre-wrap break-words text-[13px] leading-relaxed ${
          shown ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-4)]'
        } ${canWrite ? 'cursor-text hover:opacity-70' : ''}`}
      >
        {shown || placeholder}
      </p>
    )
  }

  return (
    <div>
      {multiline ? (
        <textarea
          autoFocus
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-full resize-y rounded-[2px] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px] leading-relaxed text-[var(--color-ink)] focus:border-[var(--color-ink)] focus:outline-none"
        />
      ) : (
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="w-full border-b border-[var(--color-ink)] bg-transparent py-0.5 text-[13px] text-[var(--color-ink)] focus:outline-none"
        />
      )}
      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={commit}
          disabled={pending}
          className="rounded-[2px] bg-[var(--color-ink)] px-2.5 py-1 text-[12px] tracking-wider text-[var(--color-surface)] hover:opacity-80 disabled:opacity-40"
        >
          {pending ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={pending}
          className="px-2 py-1 text-[12px] tracking-wider text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
        >
          取消
        </button>
        {error && (
          <span className="text-[12px] text-[var(--color-overdue)]">{error}</span>
        )}
      </div>
    </div>
  )
}

export type { CommStage, CommTopic }
