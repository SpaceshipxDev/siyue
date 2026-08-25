// Line-break opportunities for Chinese text in @react-pdf/renderer.
//
// textkit (react-pdf's text engine) breaks a line in exactly two places: at an
// ASCII space, or at a hyphenation point — and a hyphenation break prints a
// "-" glyph at the end of the line. Chinese has no spaces, so a long 产品名称
// such as 面板按键-智慧型哨位集成箱-简约双屏 is a single unbreakable box: it
// cannot wrap, so it runs straight across the 料号 column and overprints the
// code there (交货单 for shipment s-mt8935fw-cjht6j, 2026-08-25). The same
// pattern sits in the 外协单 and 检验报告 tables.
//
// The fix hands textkit a break opportunity between CJK characters that costs
// nothing and prints nothing. textkit treats any syllable with
// `s.trim() === ''` as glue — a free break, no hyphen drawn — and U+FEFF is
// the one zero-width character JavaScript's `trim()` strips. So a CJK word is
// returned as its characters joined by U+FEFF: the text wraps at any
// character, the glue is invisible, and nothing is hyphenated.
//
// Two guards keep the rest of the paperwork byte-for-byte the same:
//
// - Only words of MIN_LEN+ characters are split. The glue glyph still takes
//   `letterSpacing`, so a tracked label like 交货单 (letterSpacing 6) would
//   double its tracking if it were split. Every tracked string in lib/pdf is
//   ≤ 5 characters, and a name has to pass ~10 characters before it can
//   overflow a name column, so the threshold keeps the two cases apart.
// - Non-CJK runs stay whole. YNMX-26-8-17-231, a 料号, an SF tracking code
//   are never broken or soft-hyphenated — the reason hyphenation was disabled
//   in the first place.
//
// Punctuation is welded to its neighbour (键- / -简 never opens a line), so a
// line breaks after the hyphen in 集成箱-简约双屏, the way a person would.

const CJK = '\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF\\u3000-\\u303F'
const HAS_CJK = new RegExp(`[${CJK}]`)
const TOKEN = new RegExp(`[${CJK}]|[^${CJK}]+`, 'g')

// U+FEFF ZERO WIDTH NO-BREAK SPACE — zero advance, whitespace to `trim()`.
export const CJK_GLUE = '﻿'
export const MIN_LEN = 8

// A line must not start with these …
const NO_BREAK_BEFORE = /^[-–—_/\\,.:;!?)\]}%°）】」』》〉，。、：；！？…~·]/
// … nor end with these.
const NO_BREAK_AFTER = /[(\[{（【「『《〈¥$]$/

export function hyphenateCjk(word: string): string[] {
  if (word.length < MIN_LEN || !HAS_CJK.test(word)) return [word]
  const boxes: string[] = []
  for (const t of word.match(TOKEN) ?? [word]) {
    const prev = boxes[boxes.length - 1]
    if (prev !== undefined && (NO_BREAK_BEFORE.test(t) || NO_BREAK_AFTER.test(prev))) {
      boxes[boxes.length - 1] = prev + t
    } else {
      boxes.push(t)
    }
  }
  const out: string[] = []
  for (const b of boxes) {
    if (out.length) out.push(CJK_GLUE)
    out.push(b)
  }
  return out
}
