import 'server-only'

// 出货单 (customer-facing) and 外协单 (vendor-facing) must never expose our
// internal 加工方式. Notes are free text the operator types — they sometimes
// jot "加工方式：CNC" alongside legitimate remarks. Strip any line or
// ;/；-delimited segment that mentions 加工方式 before rendering.
export function stripProcessMethodFromNotes(
  notes: string | null | undefined,
): string {
  if (!notes) return ''
  return notes
    .split(/\r?\n/)
    .map((line) =>
      line
        .split(/[;；]/)
        .map((seg) => seg.trim())
        .filter((seg) => seg.length > 0 && !seg.includes('加工方式'))
        .join('；'),
    )
    .filter((line) => line.trim().length > 0)
    .join('\n')
}
