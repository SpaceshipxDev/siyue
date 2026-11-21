'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { withBase } from '@/lib/base-path'
import { usePasteImage } from '@/app/_paste_image'
import type { BalloonSheetSummary } from '@/lib/balloon-store'

// 质量 · 气泡图 —— 传一张 2D 图纸 (截图、扫描件、导出的图片; 也能直接 Ctrl+V
// 粘贴截图), 系统自动识别图上的尺寸、形位、粗糙度, 一项标一个编号气泡, 进去
// 填实测值, 出质检报表。下面是做过的那些。

export function BalloonsBoard({ rows }: { rows: BalloonSheetSummary[] }) {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)

  const upload = async (file: File) => {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file, file.name || 'drawing.png')
      fd.append('title', title)
      const r = await fetch(withBase('/api/quality-balloon'), { method: 'POST', body: fd })
      const j = (await r.json()) as { ok: boolean; id?: string; detected?: boolean; error?: string }
      if (!j.ok || !j.id) throw new Error(j.error ?? '上传失败')
      router.push(`/quality/balloon/${j.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败')
      setBusy(false)
    }
  }
  usePasteImage(dropRef, (f) => void upload(f), !busy)

  const needle = q.trim()
  const shown = needle
    ? rows.filter((r) => [r.title, r.drawingNo, r.jobNo, r.customer].some((v) => v.includes(needle)))
    : rows

  return (
    <div>
      <div
        ref={dropRef}
        tabIndex={0}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const f = e.dataTransfer.files?.[0]
          if (f) void upload(f)
        }}
        className="mb-6 rounded-[2px] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-5 py-6 outline-none focus:border-[var(--color-ink)]"
      >
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="图名 / 零件名（可空）"
            className="h-9 w-[220px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 text-[13px] outline-none focus:border-[var(--color-border-strong)]"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="h-9 rounded-[2px] bg-[var(--color-ink)] px-4 text-[13px] font-medium text-[var(--color-surface)] hover:opacity-85 disabled:opacity-50"
          >
            {busy ? '识别图纸中…' : '传图纸，生成气泡图'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void upload(f)
            }}
          />
          <span className="text-[12.5px] text-[var(--color-ink-3)]">
            或者把图纸截图直接 Ctrl+V 粘贴、拖进这个框
          </span>
        </div>
        <p className="mt-2 text-[12px] text-[var(--color-ink-4)]">
          图纸要是图片（截图、扫描件、PNG/JPG）。PDF 图纸先截一张图再传。识别要十几秒。
        </p>
        {error && <p className="mt-2 text-[12.5px] text-[var(--color-overdue)]">{error}</p>}
      </div>

      <div className="mb-3 flex items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索 · 图名 / 图号 / 工单号 / 客户"
          className="h-9 w-[240px] rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] outline-none placeholder:text-[var(--color-ink-4)] focus:border-[var(--color-border-strong)]"
        />
        <span className="text-[12.5px] text-[var(--color-ink-3)]">{shown.length} 张</span>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-12 text-center text-[13px] text-[var(--color-ink-3)]">
          {rows.length === 0 ? '还没有气泡图 —— 传一张图纸试试' : '没有匹配的'}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((r) => (
            <Link
              key={r.id}
              href={`/quality/balloon/${r.id}`}
              className="flex gap-3 rounded-[2px] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 hover:border-[var(--color-border-strong)]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={withBase(r.imageUrl)}
                alt=""
                className="h-[72px] w-[96px] shrink-0 rounded-[2px] border border-[var(--color-border)] bg-white object-contain"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[14px] font-medium text-[var(--color-ink)]">{r.title || '未命名图纸'}</span>
                <span className="mono truncate text-[11.5px] text-[var(--color-ink-3)]">
                  {[r.drawingNo, r.jobNo].filter(Boolean).join(' · ') || '—'}
                </span>
                <span className="text-[12px] text-[var(--color-ink-3)]">
                  {r.count} 项 ·{' '}
                  <span
                    className={
                      r.verdict === '不合格'
                        ? 'font-medium text-[var(--color-overdue)]'
                        : r.verdict === '合格'
                          ? 'font-medium text-[var(--color-success)]'
                          : ''
                    }
                  >
                    {r.verdict || '未检'}
                  </span>
                </span>
                <span className="text-[11.5px] text-[var(--color-ink-4)]">
                  {r.createdAt.slice(5, 10)} · {r.createdBy}
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
