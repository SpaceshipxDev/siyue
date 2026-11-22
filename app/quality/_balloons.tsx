'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { withBase } from '@/lib/base-path'
import { usePasteImage } from '@/app/_paste_image'

// 气泡图 —— 传一张 2D 图纸 (截图、扫描件、导出的图片; 也能直接 Ctrl+V 粘贴
// 截图), 系统自动识别图上的尺寸、形位、粗糙度, 一项标一个编号气泡, 进去填实测
// 值, 出质检报表。只从零件进 (检验弹窗、工单零件那一行的「气泡图」), 一个零件
// 一张 —— 质量模块里原来那个总列表取消了 (于海伟 2026-11-22)。

/** 从工单零件那一行建的 —— 挂到这个零件上, 表头带上工单号、客户、材料。 */
export type BalloonLink = {
  jobId: string
  componentId: string
  jobNo: string
  customer: string
  material: string
}

// 传图纸那一块。零件已经有图片格式的图纸, 列在上面点一下就用它。
export function BalloonUpload({
  link,
  defaultTitle = '',
  drawings = [],
}: {
  link?: BalloonLink
  defaultTitle?: string
  drawings?: { url: string; filename: string }[]
}) {
  const router = useRouter()
  const [title, setTitle] = useState(defaultTitle)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
      if (link) for (const [k, v] of Object.entries(link)) fd.append(k, v)
      const r = await fetch(withBase('/api/quality-balloon'), { method: 'POST', body: fd })
      const j = (await r.json()) as { ok: boolean; id?: string; detected?: boolean; error?: string }
      if (!j.ok || !j.id) throw new Error(j.error ?? '上传失败')
      // replace: 退回去不再落到这一页 —— 它见到已有的那张会直接跳回来。
      router.replace(`/quality/balloon/${j.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败')
      setBusy(false)
    }
  }
  usePasteImage(dropRef, (f) => void upload(f), !busy)

  // 零件上已经挂着的图纸 —— 取回来当文件传一遍。
  const pickDrawing = async (d: { url: string; filename: string }) => {
    try {
      const res = await fetch(withBase(d.url))
      const blob = await res.blob()
      await upload(new File([blob], d.filename, { type: blob.type || 'image/png' }))
    } catch {
      setError('这张图纸读不出来，换一张或者截图粘贴')
    }
  }

  return (
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
        {drawings.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] text-[var(--color-ink-3)]">用零件上的图纸：</span>
            {drawings.map((d) => (
              <button
                key={d.url}
                type="button"
                disabled={busy}
                onClick={() => void pickDrawing(d)}
                className="rounded-[2px] border border-[var(--color-border-strong)] px-2.5 py-1 text-[12.5px] text-[var(--color-ink)] hover:border-[var(--color-ink)] disabled:opacity-50"
              >
                {d.filename}
              </button>
            ))}
          </div>
        )}
        {error && <p className="mt-2 text-[12.5px] text-[var(--color-overdue)]">{error}</p>}
      </div>

  )
}
