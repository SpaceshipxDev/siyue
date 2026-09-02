'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { withBase } from '@/lib/base-path'
import { mutate } from '@/lib/mutate'
import { EditableText } from '@/app/_editable'
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
//
// 单子开错了也是在这里改: 展开一张单能看到它发了哪几个零件、各几件, 数量当
// 场改, 整张作废就删掉。改动会连着把 出货 工段的进度倒回去 —— 数量退了、看
// 板上还挂着"已出货"是最坏的一种错。
//
// 有一件事不会跟着倒回去: 整单出完时系统会顺手把上游没点的工段一起标完成,
// 删单不会把那些取消 (东西确实做完过, 而且分不清哪些是顺手标的)。下面写了
// 这一句, 免得有人以为删单就等于什么都没发生过。

export function ShipmentHistoryButton({
  jobId,
  components,
  shipments,
  canEdit = false,
}: {
  jobId: string
  components: Component[]
  shipments: Shipment[]
  /** 改数量 / 删整单 — 商务和出货站, 见 lib/auth canEditShipment。 */
  canEdit?: boolean
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
          canEdit={canEdit}
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
  canEdit,
  onClose,
}: {
  jobId: string
  components: Component[]
  shipments: Shipment[]
  canEdit: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [openId, setOpenId] = useState<string | null>(null)
  const [armDelete, setArmDelete] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const byId = useMemo(
    () => new Map(components.map((c) => [c.id, c])),
    [components],
  )

  function removeShipment(shipmentId: string) {
    setError(null)
    start(async () => {
      try {
        await mutate({ kind: 'deleteShipment', shipmentId })
        setArmDelete(null)
        setOpenId(null)
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : '删不掉')
      }
    })
  }

  async function setQty(shipmentId: string, componentId: string, qty: number) {
    setError(null)
    try {
      await mutate({
        kind: 'updateShipmentPartQty',
        shipmentId,
        componentId,
        qty,
      })
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '改不上')
      throw e
    }
  }
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
        parts: s.parts,
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

        {error && (
          <p className="px-7 pt-3 text-[12px] text-[var(--color-overdue)]">
            {error}
          </p>
        )}

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
                <li
                  key={r.id}
                  className="rounded-[2px] border border-[var(--color-border)]"
                >
                  <div className="flex items-center gap-3 px-3.5 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="mono text-[13px] text-[var(--color-ink)]">
                          {formatShipmentTimestamp(r.createdAt)}
                        </span>
                        {i === 0 && (
                          <span className="text-[10px] leading-none font-medium tracking-[0.14em] text-[var(--color-success)]">
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
                    <a
                      href={withBase(
                        `/jobs/${jobId}/print/shipping?shipment=${r.id}`,
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 flex items-center gap-1 text-[11px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
                    >
                      出货单
                      <OpenIcon />
                    </a>
                    {/* 改 和 删 都摆在行上 — 开错一张单最想做的两件事, 不该
                        要先展开才找得到。 */}
                    {canEdit &&
                      (armDelete === r.id ? (
                        <>
                          <button
                            type="button"
                            onClick={() => removeShipment(r.id)}
                            disabled={pending}
                            className="shrink-0 text-[11px] font-medium text-[var(--color-overdue)] hover:underline disabled:opacity-50"
                          >
                            确认删整单
                          </button>
                          <button
                            type="button"
                            onClick={() => setArmDelete(null)}
                            className="shrink-0 text-[11px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)]"
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setArmDelete(null)
                              setError(null)
                              setOpenId(openId === r.id ? null : r.id)
                            }}
                            className="shrink-0 text-[11px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] transition-colors"
                          >
                            {openId === r.id ? '收起' : '改'}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setError(null)
                              setArmDelete(r.id)
                            }}
                            className="shrink-0 text-[11px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)] transition-colors"
                          >
                            删
                          </button>
                        </>
                      ))}
                  </div>

                  {/* 开错了 — 这一单发了哪几个零件、各几件, 就地改; 整张作废
                      就删。数量填 0 等于把这个零件从单子上拿掉。 */}
                  {canEdit && openId === r.id && (
                    <div className="border-t border-[var(--color-border)] bg-[#faf9f5] px-3.5 py-2.5">
                      {r.parts.map((sp) => {
                        const c = byId.get(sp.componentId)
                        return (
                          <div
                            key={sp.componentId}
                            className="flex items-baseline gap-3 border-b border-[var(--color-border)] py-1.5 last:border-b-0"
                          >
                            <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-ink)]">
                              {c?.name ?? sp.componentId}
                            </span>
                            <span className="mono w-[44px] shrink-0">
                              <EditableText
                                mono
                                align="right"
                                value={String(sp.qty)}
                                className="text-[12.5px] tabular-nums"
                                onSave={async (next) => {
                                  const n = Number(next.trim())
                                  if (!Number.isFinite(n) || n < 0)
                                    throw new Error('数量要填数字')
                                  await setQty(r.id, sp.componentId, Math.floor(n))
                                }}
                              />
                            </span>
                            <span className="mono shrink-0 text-[11.5px] text-[var(--color-ink-4)] tabular-nums">
                              / {c?.qty ?? '—'}
                            </span>
                            {/* 删这一行 — 等同把数量改成 0, 但不用让人自己想
                                到这一层。这一单最后一行删掉时整张单跟着走。 */}
                            <button
                              type="button"
                              onClick={() =>
                                setQty(r.id, sp.componentId, 0).catch(() => {})
                              }
                              disabled={pending}
                              className="shrink-0 text-[11px] text-[var(--color-ink-4)] hover:text-[var(--color-overdue)] disabled:opacity-50"
                            >
                              删
                            </button>
                          </div>
                        )
                      })}
                      <p className="mt-2 text-[11px] text-[var(--color-ink-4)]">
                        删掉最后一行，整张单一起没。
                      </p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && rows.length > 0 && (
            <p className="mt-3 px-1 text-[11px] leading-relaxed text-[var(--color-ink-4)]">
              改数量或删单会把「出货」工段的进度一起退回去。整单出完时被顺手
              标完成的上游工段不会取消——东西确实做过。
            </p>
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
