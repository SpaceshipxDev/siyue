'use client'

// 返工工单只有文字和一张表, 浏览器直接打印就干净 —— 不像出货单那样必须靠服
// 务端渲染 PDF 才能保住边框和字体。
export function PrintButton() {
  return (
    <div className="no-print fixed right-3 top-3 z-50 flex items-center gap-2">
      <button
        type="button"
        onClick={() => window.print()}
        className="rounded-[2px] bg-[var(--color-ink)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-surface)] hover:opacity-80"
      >
        打印
      </button>
      <button
        type="button"
        onClick={() => window.close()}
        className="rounded-[2px] border border-[var(--color-border-strong)] px-3 py-1.5 text-[12px] tracking-wider text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
      >
        关闭
      </button>
    </div>
  )
}
