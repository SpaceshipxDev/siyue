'use client'

import { useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/mutate'
import { withBase } from '@/lib/base-path'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { showToast } from '@/app/_toast'
import { EditableText } from '@/app/_editable'
import type { QualityFile } from '@/lib/quality-files'

// 文件管理 — 质量的受控文件。
//
// 一行传一份: 文件名称 · 对应图名 · 签字人 · 文件本身。找文件的人手里一般只有
// 一个图名, 所以顶上一个搜索框什么都能搜。文件不按月看 —— 它是一直有效的东西,
// 不是某个月出的事。

const COLS = 'grid-cols-[72px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)_72px_28px]'

const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i
const PDF = /\.pdf$/i

export function FilesBoard({
  rows,
  todayStr,
  canEdit,
}: {
  rows: QualityFile[]
  todayStr: string
  /** 改填过的 / 删一份 — 工程 + 商务于海伟。传、补空格有账号就行。 */
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [q, setQ] = useState('')
  const [armDelete, setArmDelete] = useState<string | null>(null)

  const [date, setDate] = useState(todayStr)
  const [title, setTitle] = useState('')
  const [drawing, setDrawing] = useState('')
  const [signer, setSigner] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter((r) =>
      [r.title, r.drawing, r.signer, r.filename, r.by]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle),
    )
  }, [rows, q])

  async function upload() {
    if (!file) return setError('先选一个文件')
    setError(null)
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('date', date)
      fd.append('title', title.trim())
      fd.append('drawing', drawing.trim())
      fd.append('signer', signer.trim())
      const res = await fetch(withBase('/api/upload-quality-file'), { method: 'POST', body: fd })
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (!res.ok || !d.ok) throw new Error(d.error || '传不上')
      setTitle('')
      setDrawing('')
      setSigner('')
      setFile(null)
      setDate(todayStr)
      if (picker.current) picker.current.value = ''
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '传不上')
    } finally {
      setBusy(false)
    }
  }

  async function patch(id: string, p: Record<string, unknown>) {
    await mutate({ kind: 'updateQualityFile', fileId: id, patch: p })
    router.refresh()
  }

  function remove(id: string) {
    start(async () => {
      try {
        await mutate({ kind: 'deleteQualityFile', fileId: id })
        setArmDelete(null)
        router.refresh()
      } catch (e) {
        showToast(e instanceof Error ? e.message : '删不掉', 'warning')
      }
    })
  }

  const inp =
    'h-9 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]'

  return (
    <div>
      <div className="mb-5 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 md:px-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            type="date"
            value={date}
            max={todayStr}
            onChange={(e) => setDate(e.target.value || todayStr)}
            className={`mono ${inp}`}
          />
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="文件名称 · 不填就用文件名"
            className={`${inp} min-w-[180px] flex-1`}
          />
          <input
            value={drawing}
            onChange={(e) => setDrawing(e.target.value)}
            placeholder="图名"
            className={`${inp} min-w-[140px] flex-1`}
          />
          <input
            value={signer}
            onChange={(e) => setSigner(e.target.value)}
            placeholder="签字人"
            className={`${inp} w-[120px]`}
          />
          <input
            ref={picker}
            type="file"
            className="hidden"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null)
              setError(null)
            }}
          />
          <button
            type="button"
            onClick={() => picker.current?.click()}
            className={`${inp} max-w-[200px] truncate text-left ${file ? '' : 'text-[var(--color-ink-4)]'}`}
            title={file?.name}
          >
            {file ? file.name : '选文件…'}
          </button>
          <button
            type="button"
            onClick={upload}
            disabled={busy}
            className="h-9 shrink-0 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
          >
            {busy ? '上传中…' : '上传'}
          </button>
        </div>
        {error && <p className="mt-2 text-[12px] text-[var(--color-overdue)]">{error}</p>}
      </div>

      <div className="mb-6 flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <p className="text-[32px] font-semibold leading-none tracking-tight tabular-nums text-[var(--color-ink)]">
            {shown.length}
          </p>
          <p className="label mt-2.5">份文件</p>
        </div>
        <div className="ml-auto">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索 · 文件名 / 图名 / 签字人"
            className="h-9 w-[230px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div
          className={`hidden ${COLS} items-center gap-3 border-b border-[var(--color-border)] bg-[#f5f3ed] px-5 py-2 md:grid`}
        >
          <span className="label">日期</span>
          <span className="label">文件名称</span>
          <span className="label">图名</span>
          <span className="label">签字</span>
          <span className="label">上传人</span>
          <span />
        </div>

        {shown.length === 0 ? (
          <p className="px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
            {q ? '没有匹配的文件' : '还没有文件'}
          </p>
        ) : (
          shown.map((r) => {
            const href = proxiedStorageUrl(r.url)
            // 图片、PDF 在新页里直接看; 别的 (Word / Excel / 图纸) 下载, 带原来的文件名。
            const view = IMAGE.test(r.filename) || PDF.test(r.filename)
            return (
              <div
                key={r.id}
                className={`grid ${COLS} items-start gap-3 border-b border-[var(--color-border)] px-4 py-2.5 last:border-b-0 hover:bg-[#faf8f2] md:px-5`}
              >
                <span className="mono text-[12.5px] tabular-nums text-[var(--color-ink-2)]">
                  {r.date.slice(2)}
                </span>
                <span className="flex min-w-0 items-baseline gap-2">
                  <a
                    href={href}
                    {...(view ? { target: '_blank', rel: 'noreferrer' } : { download: r.filename })}
                    title={r.filename}
                    className="break-words text-[12.5px] font-medium text-[var(--color-ink)] underline decoration-[var(--color-border-strong)] underline-offset-2 hover:decoration-[var(--color-ink)]"
                  >
                    {r.title || r.filename}
                  </a>
                </span>
                <Cell canEdit={canEdit || !r.drawing} value={r.drawing} onSave={(v) => patch(r.id, { drawing: v })} />
                <Cell canEdit={canEdit || !r.signer} value={r.signer} placeholder="待签" onSave={(v) => patch(r.id, { signer: v })} />
                <span
                  className="break-words text-[12.5px] text-[var(--color-ink-2)]"
                  title={r.createdAt ? `传于 ${r.createdAt.slice(0, 10)}` : undefined}
                >
                  {r.by || '—'}
                </span>
                <span className="text-right">
                  {canEdit &&
                    (armDelete === r.id ? (
                      <button
                        type="button"
                        onClick={() => remove(r.id)}
                        disabled={pending}
                        className="text-[11.5px] font-medium text-[var(--color-overdue)] hover:underline disabled:opacity-50"
                      >
                        确认
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setArmDelete(r.id)}
                        className="text-[11.5px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)]"
                      >
                        删
                      </button>
                    ))}
                </span>
              </div>
            )
          })
        )}
      </div>

      <p className="mt-4 text-[12px] text-[var(--color-ink-3)]">
        点文件名称就能打开或下载。图名、签字人还空着的谁都能补，填过的要改找工程或于海伟。
      </p>
    </div>
  )
}

function Cell({
  canEdit,
  value,
  onSave,
  placeholder = '—',
}: {
  canEdit: boolean
  value?: string
  onSave: (v: string) => Promise<void>
  placeholder?: string
}) {
  const cls = 'text-[12.5px] text-[var(--color-ink-2)]'
  if (!canEdit) return <span className={`break-words ${cls}`}>{value || placeholder}</span>
  return <EditableText value={value} placeholder={placeholder} className={cls} onSave={onSave} />
}
