'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import type { VoucherFile } from '@/lib/data'

// 凭证 — the receipt the finance person attaches to a 支出 row. The whole point
// is that it's effortless: tap the cell, snap a photo (phone camera) or pick a
// file, done. At rest the cell shows a thumbnail + count so she can see at a
// glance which expenses already have proof. No new page, no new habit.

const ACCEPT = 'image/*,application/pdf'

function isImage(v: VoucherFile): boolean {
  if (v.contentType?.startsWith('image/')) return true
  return /\.(png|jpe?g|webp|heic)$/i.test(v.filename)
}

export function VoucherCell({
  expenseId,
  initial,
}: {
  expenseId: string
  initial: VoucherFile[]
}) {
  const [files, setFiles] = useState<VoucherFile[]>(initial)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Close on outside click / Esc.
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
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={count > 0 ? `${count} 张凭证` : '添加凭证'}
        className={`inline-flex items-center gap-1.5 h-8 rounded-[2px] border px-2 transition-colors ${
          count > 0
            ? 'border-[var(--color-border)] hover:border-[var(--color-ink)]'
            : 'border-dashed border-[var(--color-border)] text-[var(--color-ink-4)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink-2)]'
        }`}
      >
        {firstImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={proxiedStorageUrl(firstImage.url)}
            alt=""
            className="h-6 w-6 rounded-[2px] object-cover"
          />
        ) : (
          <ReceiptIcon />
        )}
        {count > 0 ? (
          <span className="mono text-[12px] text-[var(--color-ink-2)] tabular-nums">
            {count}
          </span>
        ) : (
          <span className="text-[12px]">凭证</span>
        )}
      </button>

      {open && (
        <VoucherPanel
          expenseId={expenseId}
          files={files}
          setFiles={setFiles}
        />
      )}
    </div>
  )
}

function VoucherPanel({
  expenseId,
  files,
  setFiles,
}: {
  expenseId: string
  files: VoucherFile[]
  setFiles: React.Dispatch<React.SetStateAction<VoucherFile[]>>
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const [pending, start] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)

  const upload = useCallback(
    (file: File) => {
      start(async () => {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('expenseId', expenseId)
        try {
          const r = await fetch('/api/upload-voucher', {
            method: 'POST',
            body: fd,
          })
          const data = (await r.json()) as
            | { ok: true; voucher: VoucherFile }
            | { ok: false; error: string }
          if (!data.ok) {
            showToast(`上传失败 · ${data.error}`, 'warning')
            return
          }
          setFiles((prev) => [data.voucher, ...prev])
        } catch (e) {
          showToast(
            `上传失败 · ${e instanceof Error ? e.message : '网络中断'}`,
            'warning',
          )
        }
      })
    },
    [expenseId, setFiles],
  )

  const remove = (id: string) => {
    setBusyId(id)
    start(async () => {
      try {
        await mutate({ kind: 'deleteVoucher', expenseId, voucherId: id })
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

  return (
    <div className="absolute right-0 z-30 mt-1 w-[260px] rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-surface)] shadow-xl">
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
        <p className="px-3 py-6 text-center text-[12px] text-[var(--color-ink-4)]">
          还没有凭证 · 拍张收据照片
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
              <span
                className="flex-1 min-w-0 truncate text-[12px] text-[var(--color-ink-2)]"
                title={f.filename}
              >
                {f.filename}
              </span>
              <button
                type="button"
                onClick={() => remove(f.id)}
                disabled={pending && busyId === f.id}
                aria-label="删除凭证"
                title="删除凭证"
                className={`shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-[2px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)] transition-colors ${
                  pending && busyId === f.id ? 'opacity-50' : ''
                }`}
              >
                <TrashIcon />
              </button>
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
      width="14"
      height="14"
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

function ReceiptIcon() {
  return (
    <Glyph>
      <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1V2l-2 1-2-1-2 1-2-1-2 1-2-1Z" />
      <path d="M8 7h8M8 11h8M8 15h5" />
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
      width="14"
      height="14"
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
