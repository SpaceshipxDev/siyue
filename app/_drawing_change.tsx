// 图纸变更 — the customer revised drawings mid-production; anyone still cutting
// to the old sheet is making scrap. This is now PER-PART: each affected part
// carries its own 一次/二次/三次 alarm (see _part_drawing_change). There is no
// whole-job alarm anymore — a single "the job changed" flag was too blunt, it
// froze the read on unaffected parts and hid WHICH part actually moved.
//
// What survives here is the headline: a derived red banner that lists the
// parts with an open change so the floor reads it before touching the job.
// Read-only — raising + clearing happens on the part, in its popup.

// The headline. First element on the job-detail page while ANY part has an
// open change. Names the affected parts (each a deep-link to its row, which
// the ComponentAnchorScroller pulses on arrival) so the floor goes straight
// to the part instead of scanning the whole sheet.
export function DrawingChangeBanner({
  parts,
}: {
  parts: { id: string; name: string }[]
}) {
  if (parts.length === 0) return null
  return (
    <div
      role="alert"
      className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1.5 border border-[var(--color-overdue)] bg-[var(--color-overdue-soft)] rounded-[2px] px-5 py-3.5"
    >
      <span className="label text-[var(--color-overdue)] shrink-0">图纸变更</span>
      <span className="text-[13px] font-medium text-[var(--color-ink)] shrink-0">
        {parts.length} 个零件已改图,请核对最新图纸后再加工:
      </span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {parts.map((p) => (
          <a
            key={p.id}
            href={`#c-${p.id}`}
            className="text-[13px] font-semibold text-[var(--color-overdue)] underline-offset-2 hover:underline"
          >
            {p.name?.trim() || '未命名零件'}
          </a>
        ))}
      </span>
    </div>
  )
}
