'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { withBase } from '@/lib/base-path'
import { mutate } from '@/lib/mutate'

// Toolbar shown on the editable doc pages (出货单 / 外协单). The 打印 button
// opens the deterministic PDF render in a new tab so the user prints from the
// browser's PDF viewer — much more reliable than window.print() on the live
// HTML, which broke styles and dropped borders across browsers/printers.
//
// 作废 sits here because THIS is the page you're looking at when you notice
// the mistake: 制作出货单 lands you straight on the finished note, and the
// only way back out used to be 工单 → 出货记录 → 找到那一张 → 删。A wrong
// delivery note is discovered by reading it, so it has to be undoable from
// where it's read.
export function PrintToolbar({
  pdfHref,
  shipmentId,
  jobId,
}: {
  pdfHref: string
  /** 传了才显示「作废」— 出货单专用, 外协单没有这一说。 */
  shipmentId?: string
  jobId?: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [arm, setArm] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function scrap() {
    if (!shipmentId) return
    setError(null)
    start(async () => {
      try {
        await mutate({ kind: 'deleteShipment', shipmentId })
        // 单没了, 这一页就没内容可显示 — 回工单。
        if (jobId) router.replace(withBase(`/jobs/${jobId}`))
        else window.close()
      } catch (e) {
        setArm(false)
        setError(e instanceof Error ? e.message : '删不掉')
      }
    })
  }

  return (
    <div className="no-print fixed top-3 right-3 z-50 flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
      {shipmentId &&
        (arm ? (
          <>
            <button
              type="button"
              onClick={scrap}
              disabled={pending}
              className="rounded-[2px] bg-[var(--color-overdue-soft)] px-3 py-1.5 text-[12px] font-medium tracking-wider text-[var(--color-overdue)] hover:opacity-85 disabled:opacity-50"
            >
              {pending ? '作废中…' : '确认作废这张单'}
            </button>
            <button
              type="button"
              onClick={() => setArm(false)}
              className="px-2 py-1.5 text-[12px] tracking-wider text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
            >
              取消
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setArm(true)}
            className="rounded-[2px] border border-[var(--color-border-strong)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-ink-3)] hover:border-[var(--color-overdue)] hover:text-[var(--color-overdue)]"
          >
            作废
          </button>
        ))}
      <a
        href={withBase(pdfHref)}
        target="_blank"
        rel="noopener"
        className="px-3 py-1.5 text-[12px] tracking-wider bg-[var(--color-ink)] text-[var(--color-surface)] rounded-[2px] hover:opacity-80"
      >
        打印 / 下载 PDF
      </a>
      <button
        type="button"
        onClick={() => window.close()}
        className="px-3 py-1.5 text-[12px] tracking-wider border border-[var(--color-border-strong)] text-[var(--color-ink-2)] rounded-[2px] hover:text-[var(--color-ink)]"
      >
        关闭
      </button>
      </div>
      {error && (
        <p className="max-w-[300px] rounded-[2px] bg-[var(--color-surface)] px-2 py-1 text-right text-[12px] text-[var(--color-overdue)] shadow-sm">
          {error}
        </p>
      )}
    </div>
  )
}
