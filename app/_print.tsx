'use client'

import { withBase } from '@/lib/base-path'

// Toolbar shown on the editable doc pages (出货单 / 外协单). The 打印 button
// opens the deterministic PDF render in a new tab so the user prints from the
// browser's PDF viewer — much more reliable than window.print() on the live
// HTML, which broke styles and dropped borders across browsers/printers.
export function PrintToolbar({ pdfHref }: { pdfHref: string }) {
  return (
    <div className="no-print fixed top-3 right-3 flex items-center gap-2 z-50">
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
  )
}
