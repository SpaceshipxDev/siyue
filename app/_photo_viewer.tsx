'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { proxiedStorageUrl } from '@/lib/storage-url'

// 看大图 —— 点一张缩略图, 整屏黑底铺开看清楚 (签名、金额、日期都认得出)。
//
// 样子跟采购里看请购图那一个一样: 左上「‹ 返回」、Esc 或点黑底空白处关掉。
// 一次挂了好几张的, 左右键 / 两边的箭头翻。PDF 不在这儿开 —— 调用方直接开新
// 窗口, 那是浏览器自己的阅读器。

export type ViewerItem = { url: string; filename: string }

export function PhotoViewer({
  items,
  start = 0,
  onClose,
}: {
  items: ViewerItem[]
  start?: number
  onClose: () => void
}) {
  const [i, setI] = useState(Math.min(Math.max(0, start), items.length - 1))
  const n = items.length
  const cur = items[i]

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft' && n > 1) setI((x) => (x - 1 + n) % n)
      if (e.key === 'ArrowRight' && n > 1) setI((x) => (x + 1) % n)
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose, n])

  if (!cur) return null

  const arrow =
    'absolute top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center rounded-full border border-white/30 text-[22px] text-white/80 hover:bg-white/10'

  return createPortal(
    <div className="fixed inset-0 z-[70] flex flex-col bg-black/85">
      <div className="flex shrink-0 items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-[2px] border border-white/40 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-white/10"
        >
          ‹ 返回
        </button>
        <span className="truncate text-[12.5px] text-white/60">{cur.filename}</span>
        {n > 1 && (
          <span className="ml-auto mono text-[12.5px] text-white/60">
            {i + 1} / {n}
          </span>
        )}
      </div>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center p-4 pb-8"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={proxiedStorageUrl(cur.url)}
          alt={cur.filename}
          className="max-h-full max-w-full object-contain"
        />
        {n > 1 && (
          <>
            <button
              type="button"
              aria-label="上一张"
              onClick={() => setI((x) => (x - 1 + n) % n)}
              className={`${arrow} left-4`}
            >
              ‹
            </button>
            <button
              type="button"
              aria-label="下一张"
              onClick={() => setI((x) => (x + 1) % n)}
              className={`${arrow} right-4`}
            >
              ›
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
