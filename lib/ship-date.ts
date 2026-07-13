// 送货日期 for the 交货单 — the batch's actual ship date (出库时间) rendered as
// YYYY-MM-DD in factory-local (Asia/Shanghai) time. Undefined/unparseable ⇒
// '—'. Shared by the printed PDF (lib/pdf/shipping.tsx) and the on-screen
// preview (app/jobs/[id]/print/shipping/page.tsx) so the two always agree.
export function formatShipDate(iso?: string): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(t))
}
