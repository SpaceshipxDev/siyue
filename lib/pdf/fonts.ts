import 'server-only'
import { Font } from '@react-pdf/renderer'
import { hyphenateCjk } from './cjk-wrap'

// Font registration is process-global. This module is imported by the PDF
// renderers; the guard makes a re-import a no-op so we don't double-register
// in a warm Lambda.
//
// Why Noto Sans SC: it's the only widely available CJK font that ships with
// matching Latin glyphs in Regular/Medium/Bold weights, served as raw OTF
// (not woff2). pdfkit, which @react-pdf/renderer wraps, accepts TTF/OTF only.
//
// We pin to the upstream `notofonts/noto-cjk` GitHub repo at a known commit.
// jsDelivr's `/gh/` mirror used to be the source here, but jsDelivr now 403s
// large OTFs at pinned commits (see prod logs 2026-05 — "Failed to fetch font
// from cdn.jsdelivr.net/.../NotoSansSC-Regular.otf: 403 Forbidden"), so every
// PDF render returned 500. raw.githubusercontent.com serves the same bytes,
// is unmetered for low-volume reads, and the in-memory `registered` guard
// means we fetch at most three files per process lifetime (≈ once per deploy).

const SANS_REGULAR =
  'https://raw.githubusercontent.com/notofonts/noto-cjk/165c01b/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf'
const SANS_MEDIUM =
  'https://raw.githubusercontent.com/notofonts/noto-cjk/165c01b/Sans/SubsetOTF/SC/NotoSansSC-Medium.otf'
const SANS_BOLD =
  'https://raw.githubusercontent.com/notofonts/noto-cjk/165c01b/Sans/SubsetOTF/SC/NotoSansSC-Bold.otf'

let registered = false

export function ensureFontsRegistered(): void {
  if (registered) return
  Font.register({
    family: 'NotoSansSC',
    fonts: [
      { src: SANS_REGULAR, fontWeight: 400 },
      { src: SANS_MEDIUM, fontWeight: 500 },
      { src: SANS_BOLD, fontWeight: 700 },
    ],
  })
  // No English hyphenation — the default hyphenator inserts soft hyphens into
  // ASCII codes like job numbers (YNMX-26-4-30-001 → YNMX-26-4-30-­001), which
  // prints ugly. But textkit ALSO only breaks lines at spaces or hyphenation
  // points, so with hyphenation off a long Chinese 产品名称 (no spaces) could
  // never wrap and overprinted the next column. hyphenateCjk gives long CJK
  // words invisible, hyphen-free break points; ASCII stays whole. See cjk-wrap.
  Font.registerHyphenationCallback(hyphenateCjk)
  registered = true
}

export const PDF_FONT_FAMILY = 'NotoSansSC'
