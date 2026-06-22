'use client'

import { useCallback, useRef, useState, useTransition } from 'react'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { mutate } from '@/lib/mutate'
import { showToast } from '@/app/_toast'
import { JobShippingText } from '@/app/_editable'
import type { ContractFile } from '@/lib/data'

// 合同 — 财务 attaches the signed contract to an order, downloads it later, and
// sees who uploaded it and when. Many files per order. Mirrors the source-file
// widget's chrome (square icon buttons, drag-drop) but renders a metadata list.
// Local state mirrors every write so the row updates without an RSC refresh
// (the GFW kills full job-detail re-streams for mainland users on the HK VM).

const ICON_BTN =
  'shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-[2px] transition-colors'

const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.webp'

function formatBytes(n?: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// ISO → 'YYYY-MM-DD' in factory-local time. Deterministic given the string.
function dateLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
}

export function ContractFiles({
  jobId,
  initial,
  contractNo,
  canEdit = false,
}: {
  jobId: string
  initial: ContractFile[]
  contractNo?: string
  canEdit?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<ContractFile[]>(initial)
  const [drag, setDrag] = useState(false)
  const [pending, start] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)

  const upload = useCallback(
    (file: File) => {
      start(async () => {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('jobId', jobId)
        try {
          const r = await fetch('/api/upload-contract', {
            method: 'POST',
            body: fd,
          })
          const data = (await r.json()) as
            | { ok: true; contract: ContractFile }
            | { ok: false; error: string }
          if (!data.ok) {
            showToast(`上传失败 · ${data.error}`, 'warning')
            return
          }
          setFiles((prev) => [data.contract, ...prev])
        } catch (e) {
          showToast(
            `上传失败 · ${e instanceof Error ? e.message : '网络中断'}`,
            'warning',
          )
        }
      })
    },
    [jobId],
  )

  const remove = (id: string) => {
    setBusyId(id)
    start(async () => {
      try {
        await mutate({ kind: 'deleteContract', jobId, contractId: id })
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

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDrag(false)
    const f = e.dataTransfer.files?.[0]
    if (f) upload(f)
  }

  return (
    <div className="mt-12 max-w-3xl">
      <div className="flex items-center justify-between mb-3">
        <p className="label text-[var(--color-ink-3)]">合同</p>
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
          onClick={() => inputRef.current?.click()}
          disabled={pending}
          className="inline-flex items-center gap-1.5 text-[13px] text-[var(--color-ink-2)] hover:text-[var(--color-ink)] transition-colors disabled:opacity-50"
        >
          {pending ? <SpinnerIcon /> : <UploadIcon />}
          上传合同
        </button>
      </div>

      {/* 合同号 — sits WITH the contract files: a contract is a number AND a
          document. Commerce edits in place; 出货 reads it in the job header. */}
      <div className="mb-3 flex items-center gap-3">
        <span className="label shrink-0 text-[var(--color-ink-3)]">合同号</span>
        {canEdit ? (
          <JobShippingText
            jobId={jobId}
            field="contractNo"
            value={contractNo}
            className="mono text-[13px] text-[var(--color-ink)]"
            placeholder="—"
          />
        ) : (
          <span className="mono text-[13px] text-[var(--color-ink)]">
            {contractNo ?? '—'}
          </span>
        )}
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={`rounded-[2px] border transition-colors ${
          drag
            ? 'border-[var(--color-ink)] bg-[var(--color-active-bg)]'
            : 'border-[var(--color-border)] bg-[var(--color-surface)]'
        }`}
      >
        {files.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px] text-[var(--color-ink-4)]">
            尚未上传合同 · 拖拽文件到此或点击「上传合同」
          </div>
        ) : (
          <ul>
            {files.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-3 px-4 h-12 border-b border-[var(--color-border)] last:border-b-0"
              >
                <span className="shrink-0 text-[var(--color-ink-3)]">
                  <FileIcon />
                </span>
                <div className="flex-1 min-w-0">
                  <span
                    className="block text-[13px] text-[var(--color-ink)] truncate"
                    title={f.filename}
                  >
                    {f.filename}
                  </span>
                  <span className="block text-[11px] text-[var(--color-ink-3)] mono">
                    {dateLabel(f.createdAt)}
                    {f.uploadedBy ? ` · ${f.uploadedBy}` : ''}
                    {formatBytes(f.filesize) ? ` · ${formatBytes(f.filesize)}` : ''}
                  </span>
                </div>
                <a
                  href={proxiedStorageUrl(f.url)}
                  download={f.filename}
                  title={`下载 ${f.filename}`}
                  aria-label="下载合同"
                  className={`${ICON_BTN} text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:bg-[var(--color-active-bg)]`}
                >
                  <DownloadIcon />
                </a>
                <button
                  type="button"
                  onClick={() => remove(f.id)}
                  disabled={pending && busyId === f.id}
                  title="删除合同"
                  aria-label="删除合同"
                  className={`${ICON_BTN} text-[var(--color-ink-3)] hover:text-[var(--color-overdue)] hover:bg-[var(--color-active-bg)] ${
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
    </div>
  )
}

function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
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

function DownloadIcon() {
  return (
    <Glyph>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </Glyph>
  )
}

function UploadIcon() {
  return (
    <Glyph>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
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
      width="16"
      height="16"
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
