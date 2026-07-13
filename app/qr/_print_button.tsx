'use client'

// 打印 button for the /qr machine-card sheet. window.print() is fine here —
// unlike the editable 出货单/外协单 docs (which route through a PDF render),
// these cards are plain black-on-white static markup with their own print CSS.
export function PrintButton() {
  return (
    <div className="no-print fixed top-3 right-3 z-50">
      <button
        type="button"
        onClick={() => window.print()}
        className="px-4 py-2 text-[13px] font-semibold tracking-wider bg-[var(--color-ink)] text-[var(--color-surface)] rounded-[2px] hover:opacity-80"
      >
        打印
      </button>
    </div>
  )
}
