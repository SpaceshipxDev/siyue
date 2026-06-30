'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  formatShipmentTimestamp,
  type Component,
  type Shipment,
} from '@/lib/data'

// 出货记录 — the full shipment ledger for one job. 制作出货单 writes one
// Shipment row per batch; this surfaces every one: when it was made, who made
// it, how many parts left in that batch, and a deep-link straight into that
// exact batch's printable 出货单 / PDF (?shipment=<id>). The headline always
// shows X / Y — total parts shipped over the order's total part count.

export function ShipmentHistoryButton({
  jobId,
  components,
  shipments,
}: {
  jobId: string
  components: Component[]
  shipments: Shipment[]
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] tracking-wider border border-[var(--color-border-strong)] text-[var(--color-ink-2)] rounded-[2px] hover:bg-[#f1eee4] hover:text-[var(--color-ink)] transition-colors"
      >
        <ClockIcon />
        出货记录
      </button>
      {open && (
        <ShipmentHistoryDialog
          jobId={jobId}
          components={components}
          shipments={shipments}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function ShipmentHistoryDialog({
  jobId,
  components,
  shipments,
  onClose,
}: {
  jobId: string
  components: Component[]
  shipments: Shipment[]
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { rows, totalShipped, totalUnits, pct } = useMemo(() => {
    const totalUnits = components.reduce((s, c) => s + c.qty, 0)
    // Newest batch first — the ledger reads top-down as "most recent shipment".
    const rows = [...shipments]
      .map((s) => ({
        id: s.id,
        docNo: s.docNo,
        createdAt: s.createdAt,
        createdBy: s.createdBy,
        qty: s.parts.reduce((a, p) => a + p.qty, 0),
      }))
      .sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      )
    const totalShipped = rows.reduce((s, r) => s + r.qty, 0)
    const pct = totalUnits > 0 ? Math.round((totalShipped / totalUnits) * 100) : 0
    return { rows, totalShipped, totalUnits, pct }
  }, [components, shipments])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="出货记录"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] max-h-[85vh] flex flex-col bg-[var(--color-surface)] border border-[var(--color-ink)] rounded-[2px] shadow-xl"
      >
        {/* Header + always-on progress */}
        <header className="px-7 pt-6 pb-6 border-b border-[var(--color-border)]">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-[16px] font-semibold tracking-tight text-[var(--color-ink)]">
                出货记录
              </h2>
              <p className="label mt-0.5 text-[var(--color-ink-3)]">
                SHIPPING HISTORY
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="-mr-1.5 -mt-1 p-1.5 text-[var(--color-ink-3)] hover:text-[var(--color-ink)] rounded-[2px] transition-colors"
            >
              <CloseIcon />
            </button>
          </div>

          {/* X / Y — parts shipped over total parts. Always shown. */}
          <div className="mt-6">
            <div className="flex items-baseline justify-between">
              <span className="label text-[var(--color-ink-3)]">已出货</span>
              <span className="mono text-[12px] text-[var(--color-ink-3)]">
                {pct}%
              </span>
            </div>
            <div className="mt-1.5 flex items-baseline gap-1.5">
              <span className="mono text-[28px] leading-none font-semibold text-[var(--color-ink)] tabular-nums">
                {totalShipped}
              </span>
              <span className="mono text-[16px] text-[var(--color-ink-3)] tabular-nums">
                / {totalUnits}
              </span>
              <span className="text-[12px] text-[var(--color-ink-3)] ml-0.5">
                件
              </span>
            </div>
            <div className="mt-3 h-1.5 w-full rounded-[2px] bg-[var(--color-border)] overflow-hidden">
              <div
                className="h-full bg-[var(--color-ink)] transition-[width] duration-500"
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
          </div>
        </header>

        {/* Ledger */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {rows.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-[13px] text-[var(--color-ink-3)]">
                还没有出货记录
              </p>
              <p className="mt-1 label text-[var(--color-ink-4)]">
                点击「制作出货单」开始出货
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((r, i) => (
                <li key={r.id}>
                  <a
                    href={`/jobs/${jobId}/print/shipping?shipment=${r.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-center gap-3 px-3.5 py-3 rounded-[2px] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] hover:bg-[#faf9f5] transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="mono text-[13px] text-[var(--color-ink)]">
                          {formatShipmentTimestamp(r.createdAt)}
                        </span>
                        {i === 0 && (
                          <span className="label text-[10px] leading-none text-[var(--color-success)]">
                            最新
                          </span>
                        )}
                      </div>
                      {(r.docNo || r.createdBy) && (
                        <div className="mt-1 text-[11px] text-[var(--color-ink-3)] truncate">
                          {r.docNo && (
                            <span className="mono">单号 {r.docNo}</span>
                          )}
                          {r.docNo && r.createdBy && ' · '}
                          {r.createdBy}
                        </div>
                      )}
                    </div>
                    <span className="shrink-0 text-right">
                      <span className="mono text-[14px] text-[var(--color-ink)] tabular-nums">
                        {r.qty}
                      </span>
                      <span className="text-[11px] text-[var(--color-ink-3)] ml-0.5">
                        件
                      </span>
                    </span>
                    <span className="shrink-0 flex items-center gap-1 text-[11px] text-[var(--color-ink-3)] group-hover:text-[var(--color-ink)] transition-colors">
                      出货单
                      <OpenIcon />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function ClockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.4" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M7 4v3.2L9 8.6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M3.5 3.5l7 7M10.5 3.5l-7 7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

function OpenIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M5 3.5h5.5V9"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.5 3.5L4 10"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
