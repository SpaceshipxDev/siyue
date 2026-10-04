'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { proxiedStorageUrl } from '@/lib/storage-url'
import { PhotoViewer } from '@/app/_photo_viewer'
import type { PartPhoto } from '@/lib/data'

// 点开一条不良 —— 这一条的全部信息, 加上判不良时拍的那几张照片。照片点一下
// 铺满屏幕看清楚 (看大图那一个, 跟借支单同一个)。
//
// 质量异常、来料异常 (检验转过来的那几条) 共用这一个。

export function DefectDetail({
  title,
  subtitle,
  fields,
  photos,
  jobHref,
  onClose,
}: {
  title: string
  subtitle?: string
  /** 一行一样: [标签, 内容]。内容空的显示「—」。 */
  fields: [string, string | undefined][]
  photos: PartPhoto[]
  /** 这条不良出在哪张单 —— 点过去就是那张单。 */
  jobHref?: string
  onClose: () => void
}) {
  const [viewing, setViewing] = useState<number | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && viewing === null) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, viewing])

  // 看大图那一层放在弹窗外面 —— 放在里面, 它上面的点击会冒到弹窗的底板上,
  // 把整个详情一起关掉。
  return createPortal(
    <>
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[86vh] w-[520px] max-w-full overflow-y-auto rounded-[2px] border border-[var(--color-ink)] bg-[var(--color-surface)] p-6 shadow-xl"
      >
        <p className="label mb-1 text-[var(--color-ink-3)]">不良详情</p>
        <h3 className="text-[16px] font-semibold tracking-tight text-[var(--color-ink)]">{title}</h3>
        {subtitle ? (
          <p className="mt-0.5 text-[12.5px] text-[var(--color-ink-3)]">{subtitle}</p>
        ) : null}

        <dl className="mt-5 grid grid-cols-[76px_1fr] gap-x-4 gap-y-2 text-[13px]">
          {fields.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="label pt-[2px]">{k}</dt>
              <dd className="break-words text-[var(--color-ink)]">{v || '—'}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-5">
          <p className="label mb-2">不良照片</p>
          {photos.length === 0 ? (
            <p className="text-[12.5px] text-[var(--color-ink-4)]">判的时候没拍照片</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {photos.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setViewing(i)}
                  title="点开看大图"
                  className="block h-[84px] w-[84px] overflow-hidden rounded-[2px] border border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-ink-3)]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={proxiedStorageUrl(p.url)}
                    alt="不良照片"
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          {jobHref ? (
            <Link
              href={jobHref}
              className="text-[13px] font-medium text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
            >
              去这张单 →
            </Link>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-[2px] border border-[var(--color-border)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-ink-2)] hover:bg-[#f1eee4]"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
    {viewing !== null && (
      <PhotoViewer
        items={photos.map((p) => ({ url: p.url, filename: '不良照片' }))}
        start={viewing}
        onClose={() => setViewing(null)}
      />
    )}
    </>,
    document.body,
  )
}
