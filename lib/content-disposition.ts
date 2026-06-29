// Build a spec-safe Content-Disposition header value for a (possibly non-ASCII)
// filename.
//
// HTTP header values are limited to ISO-8859-1. Node's HTTP layer throws
// ERR_INVALID_CHAR the moment a multi-byte character — a 返修-… 工号, a Chinese
// 出货单 / 外协单 name — lands in a header, and the whole Response fails to
// construct. The nasty part: this fires AFTER all the real work (the PDF has
// already rendered), so the request dies with a generic "server can't take the
// request", and it only bites the orders whose name happens to contain
// non-Latin characters — every ASCII/numeric 工号 prints fine, which is exactly
// why it looks order-specific.
//
// We always emit BOTH forms (RFC 6266 / RFC 5987) so it can never throw and
// still shows nice names where supported:
//   - filename="<ascii>"      — pure-ASCII fallback (non-ASCII → '_'); every
//                               client understands it and it never throws.
//   - filename*=UTF-8''<pct>  — percent-encoded UTF-8; modern browsers prefer
//                               this and render the original characters.
export function contentDisposition(
  filename: string,
  disposition: 'inline' | 'attachment' = 'inline',
): string {
  // ASCII fallback: anything outside printable ASCII → '_', and neutralize the
  // quote / backslash that would break the quoted-string.
  const asciiFallback = filename
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
  // encodeURIComponent percent-encodes every multi-byte char into pure ASCII;
  // additionally escape the four chars it leaves untouched that RFC 5987's
  // attr-char set disallows, so strict parsers accept the ext-value.
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
}
