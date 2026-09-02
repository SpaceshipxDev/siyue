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
// - Short non-CJK runs stay whole. YNMX-26-8-17-231, a 料号, an SF tracking
//   code read as one thing and shouldn't be split for cosmetic reasons — the
//   reason hyphenation was disabled in the first place. But a run WIDER THAN
//   ITS COLUMN has to break somewhere: with no break opportunity at all
//   textkit prints it straight over the neighbouring column, which is worse
//   than a wrapped code. So runs of LONG_LEN+ get break points too — only
//   after a separator (- _ / .), where a person writing the code by hand
//   would wrap it. A break point is only an OFFER: textkit takes it when the
//   line won't fit and ignores it otherwise, so a 料号 that fits still prints
//   on one line exactly as before.
//
// Punctuation is welded to its neighbour (键- / -简 never opens a line), so a
// line breaks after the hyphen in 集成箱-简约双屏, the way a person would.

const CJK = '\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF\\u3000-\\u303F'
const HAS_CJK = new RegExp(`[${CJK}]`)
const TOKEN = new RegExp(`[${CJK}]|[^${CJK}]+`, 'g')

// U+FEFF ZERO WIDTH NO-BREAK SPACE — zero advance, whitespace to `trim()`.
export const CJK_GLUE = '﻿'
export const MIN_LEN = 8
// 非 CJK 的长串到这个长度才给断点 — 再短的整体留着更好读。
export const LONG_LEN = 12

// 断在分隔符后面: PN-2026-XY-0001-A → PN- / 2026- / XY- / 0001- / A
const ASCII_PARTS = /[^-\u2013\u2014_/\\.]*[-\u2013\u2014_/\\.]|[^-\u2013\u2014_/\\.]+/g

// A line must not start with these …
const NO_BREAK_BEFORE = /^[-–—_/\\,.:;!?)\]}%°）】」』》〉，。、：；！？…~·]/
// … nor end with these.
const NO_BREAK_AFTER = /[(\[{（【「『《〈¥$]$/

// Join boxes with the invisible glue so textkit sees a free break between
// each pair.
function glue(boxes: string[]): string[] {
  const out: string[] = []
  for (const b of boxes) {
    if (out.length) out.push(CJK_GLUE)
    out.push(b)
  }
  return out
}

// 又长又不含中文的串 (料号 / 快递单号 / 英文品名) — 在分隔符后面给断点。整串
// 连一个分隔符都没有的话就逐字符给, 否则它照样会压到隔壁列去。
function breakLongAscii(word: string): string[] {
  const parts = word.match(ASCII_PARTS) ?? [word]
  const boxes: string[] = []
  for (const p of parts) {
    if (p.length <= LONG_LEN) boxes.push(p)
    else for (const ch of p) boxes.push(ch)
  }
  return glue(boxes)
}

export function hyphenateCjk(word: string): string[] {
  if (!HAS_CJK.test(word)) {
    return word.length < LONG_LEN ? [word] : breakLongAscii(word)
  }
  if (word.length < MIN_LEN) return [word]
  const boxes: string[] = []
  for (const t of word.match(TOKEN) ?? [word]) {
    const prev = boxes[boxes.length - 1]
    if (prev !== undefined && (NO_BREAK_BEFORE.test(t) || NO_BREAK_AFTER.test(prev))) {
      boxes[boxes.length - 1] = prev + t
    } else {
      boxes.push(t)
    }
  }
  return glue(boxes)
}
