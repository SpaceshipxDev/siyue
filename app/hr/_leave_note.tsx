'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { usePasteImage } from '@/app/_paste_image'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { withBase } from '@/lib/base-path'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import type { HrNoteFile } from '@/lib/data'

// 请假条 — 员工递上来的那张纸, 拍一张挂在这条记录上。
//
// 屏幕上那行「事假 8h」是人敲进去的; 月底跟工资对不上、事后要追一句"这个假
// 谁批的", 翻的是纸。纸以前夹在办公室的文件夹里, 要翻就得翻一整年。
//
// 做法跟 凭证 那一格一样, 一个道理: 不开新页面、不养新习惯 —— 明细行上一个
// 小钮, 点开拍一张就完了。有没有假条一眼看得见 (有就是缩略图 + 张数)。

const ACCEPT = 'image/*,application/pdf'

function isImage(v: HrNoteFile): boolean {
  if (v.contentType?.startsWith('image/')) return true
  return /\.(png|jpe?g|webp|heic)$/i.test(v.filename)
}

export function LeaveNoteCell({
  month,
  recordId,
  initial,
  canDelete,
}: {
  /** 这条记录所在的月份分片 YYYY-MM —— 假条跟记录存在同一个月里。 */
  month: string
  recordId: string
  initial: HrNoteFile[]
  /** 删一张 — 人事改删那一档 (canDeleteHrRecord)。传是谁都可以。 */
  canDelete: boolean
}) {
  const [files, setFiles] = useState<HrNoteFile[]>(initial)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const count = files.length
  const firstImage = files.find(isImage)

  return (
    <span
      ref={wrapRef}
      className="relative inline-block shrink-0"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={count > 0 ? `${count} 张假条` : '上传请假条'}
        className={`inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 text-[11.5px] transition-colors ${
          count > 0
            ? 'border-[var(--color-border)] text-[var(--color-ink-2)] hover:border-[var(--color-ink)]'
            : 'border-dashed border-[var(--color-border)] text-[var(--color-ink-4)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink-2)]'
        }`}
      >
        {firstImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={proxiedStorageUrl(firstImage.url)}
            alt=""
            className="h-4 w-4 rounded-[1px] object-cover"
          />
        ) : (
          <NoteIcon />
        )}
        {count > 1 ? (
          <span className="mono tabular-nums">{count}</span>
        ) : count === 0 ? (
          <span>假条</span>
        ) : null}
      </button>

      {open && (
        <NotePanel
          month={month}
          recordId={recordId}
          files={files}
          setFiles={setFiles}
          canDelete={canDelete}
        />
      )}
    </span>
  )
}

function NotePanel({
  month,
  recordId,
  files,
  setFiles,
  canDelete,
}: {
  month: string
  recordId: string
  files: HrNoteFile[]
  setFiles: React.Dispatch<React.SetStateAction<HrNoteFile[]>>
  canDelete: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const zoneRef = useRef<HTMLDivElement>(null)
  const [pending, start] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)

  const upload = useCallback(
    (file: File) => {
      start(async () => {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('month', month)
        fd.append('recordId', recordId)
        try {
          const r = await fetch(withBase('/api/upload-hr-note'), {
            method: 'POST',
            body: fd,
          })
          const data = (await r.json()) as
            | { ok: true; note: HrNoteFile }
            | { ok: false; error: string }
          if (!data.ok) {
            showToast(`上传失败 · ${data.error}`, 'warning')
            return
          }
          setFiles((prev) => [...prev, data.note])
        } catch (e) {
          showToast(
            `上传失败 · ${e instanceof Error ? e.message : '网络中断'}`,
            'warning',
          )
        }
      })
    },
    [month, recordId, setFiles],
  )

  const remove = (id: string) => {
    setBusyId(id)
    start(async () => {
      try {
        await mutate({ kind: 'deleteHrNote', month, recordId, noteId: id })
        setFiles((prev) => prev.filter((f) => f.id !== id))
      } catch (e) {
        showToast(
          `删除失败 · ${e instanceof Error ? e.message : '网络中断'}`,
          'warning',
        )
      } finally {
        setBusyId(null)
      }
    })
  }

  // 办公室这边的假条常常是微信里发来的图 —— 存一趟再选一遍是白走的路。
  usePasteImage(zoneRef, upload)

  return (
    <div
      ref={zoneRef}
      className="absolute right-0 z-30 mt-1 w-[260px] rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-surface)] text-left shadow-xl"
    >
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) upload(f)
          }}
        />
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) upload(f)
          }}
        />
        <button
          type="button"
          onClick={() => cameraRef.current?.click()}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-[2px] bg-[var(--color-ink)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
        >
          {pending ? <SpinnerIcon /> : <CameraIcon />}
          拍照
        </button>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-[2px] border border-[var(--color-border)] px-2.5 py-1.5 text-[12px] text-[var(--color-ink-2)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)] disabled:opacity-50"
        >
          选择文件
        </button>
      </div>

      {files.length === 0 ? (
        <p className="px-3 py-6 text-center text-[12px] leading-relaxed text-[var(--color-ink-4)]">
          还没有假条 · 拍一张手上那张纸,
          <br />
          或按 Ctrl+V 粘贴
        </p>
      ) : (
        <ul className="max-h-[280px] overflow-y-auto p-2">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 px-1 py-1.5">
              <a
                href={proxiedStorageUrl(f.url)}
                target="_blank"
                rel="noreferrer"
                className="shrink-0"
                title={`查看 ${f.filename}`}
              >
                {isImage(f) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={proxiedStorageUrl(f.url)}
                    alt={f.filename}
                    className="h-9 w-9 rounded-[2px] border border-[var(--color-border)] object-cover"
                  />
                ) : (
                  <span className="flex h-9 w-9 items-center justify-center rounded-[2px] border border-[var(--color-border)] text-[var(--color-ink-3)]">
                    <FileIcon />
                  </span>
                )}
              </a>
              <span className="min-w-0 flex-1">
                <span
                  className="block truncate text-[12px] text-[var(--color-ink-2)]"
                  title={f.filename}
                >
                  {f.filename}
                </span>
                {f.uploadedBy && (
                  <span className="block truncate text-[11px] text-[var(--color-ink-4)]">
                    {f.uploadedBy}
                  </span>
                )}
              </span>
              {canDelete && (
                <button
                  type="button"
                  onClick={() => remove(f.id)}
                  disabled={pending && busyId === f.id}
                  aria-label="删除假条"
                  title="删除假条"
                  className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[2px] text-[var(--color-ink-4)] transition-colors hover:text-[var(--color-overdue)] ${
                    pending && busyId === f.id ? 'opacity-50' : ''
                  }`}
                >
                  <TrashIcon />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

function NoteIcon() {
  return (
    <Glyph>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M8 13h6M8 17h4" />
    </Glyph>
  )
}

function CameraIcon() {
  return (
    <Glyph>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </Glyph>
  )
}

function FileIcon() {
  return (
    <Glyph>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </Glyph>
  )
}

function TrashIcon() {
  return (
    <Glyph>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </Glyph>
  )
}

function SpinnerIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="animate-spin"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}
