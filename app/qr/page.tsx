import QRCode from 'qrcode'
import { requireUser } from '@/lib/auth'
import { BRAND } from '@/lib/brand'
import { PrintButton } from './_print_button'

export const dynamic = 'force-dynamic'

// /qr — printable 机台 QR cards. One card per machine (1#–20#, plus two
// unlabeled spares to hand-label later); every card carries the SAME QR:
// the public 拍照报工 entry (/p). The worker taps the code taped to their
// machine, photographs the sheet in their hand, and the matcher does the rest.
//
// The URL is deliberately hardcoded to the live domain — these cards get
// taped to physical machines, so they must point at production no matter
// where this page happens to be rendered from (localhost, LAN IP, preview).
const SCAN_URL = 'https://yingma.siyue.ai/p'

const MACHINE_COUNT = 20
const SPARE_COUNT = 2
const CARDS_PER_SHEET = 4

// Print geometry: A4 portrait sheets, 4 cards per sheet (2×2), generous
// gutters so scissors have room. Chunked into explicit .qr-sheet divs with
// page-break-after so browsers tile the pages deterministically (breaking
// inside one big grid is flaky across engines).
const QR_CSS = `
.qr-sheet {
  width: 210mm;
  min-height: 296mm;
  padding: 12mm;
  margin: 0 auto;
  background: #fff;
  color: #000;
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-auto-rows: 1fr;
  gap: 10mm;
}
.qr-card {
  border: 0.4mm solid #000;
  border-radius: 2mm;
  padding: 8mm 6mm;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  break-inside: avoid;
}
.qr-machine {
  font-size: 20mm;
  line-height: 1;
  font-weight: 700;
  letter-spacing: 0.02em;
  min-height: 20mm;
  font-variant-numeric: tabular-nums;
}
.qr-blank {
  width: 34mm;
  min-height: 20mm;
  border-bottom: 0.5mm solid #000;
}
.qr-img {
  width: 58mm;
  height: 58mm;
  margin: 6mm 0 5mm;
  image-rendering: pixelated;
}
.qr-caption {
  font-size: 5.6mm;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.qr-url {
  margin-top: 2mm;
  font-size: 3.4mm;
  color: #444;
  letter-spacing: 0.08em;
}
@media screen {
  .qr-sheet {
    margin: 24px auto;
    box-shadow: 0 0 0 1px var(--color-border), 0 12px 40px rgba(0, 0, 0, 0.06);
  }
}
@media print {
  @page { size: A4 portrait; margin: 0; }
  body { background: #fff !important; }
  .qr-sheet {
    margin: 0;
    height: 296mm;
    min-height: 0;
    box-shadow: none;
    page-break-after: always;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .qr-sheet:last-of-type { page-break-after: auto; }
}
`

export default async function QrCardsPage() {
  await requireUser()

  // All cards share one QR (same /p entry), so generate the data URI once.
  // 720px at 58mm print size ≈ 315 dpi — crisp modules, no external fetch.
  const qr = await QRCode.toDataURL(SCAN_URL, {
    margin: 0,
    width: 720,
    errorCorrectionLevel: 'M',
  })

  // '' = spare card: blank hand-writable label line instead of a machine no.
  const labels: string[] = [
    ...Array.from({ length: MACHINE_COUNT }, (_, i) => `${i + 1}#`),
    ...Array.from({ length: SPARE_COUNT }, () => ''),
  ]
  const sheets: string[][] = []
  for (let i = 0; i < labels.length; i += CARDS_PER_SHEET) {
    sheets.push(labels.slice(i, i + CARDS_PER_SHEET))
  }

  return (
    <>
      <style>{QR_CSS}</style>
      <PrintButton />
      {sheets.map((sheet, si) => (
        <div key={si} className="qr-sheet">
          {sheet.map((label, ci) => (
            <div key={ci} className="qr-card">
              {label ? (
                <p className="qr-machine">{label}</p>
              ) : (
                <span className="qr-blank" aria-hidden />
              )}
              {/* Data-URI QR — next/image adds nothing for an inline base64 PNG. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr} alt={`扫码报工 ${SCAN_URL}`} className="qr-img" />
              <p className="qr-caption">拍一下手里的单子 · 自动报工</p>
              <p className="qr-url">
                {BRAND.shortName} · yingma.siyue.ai/p
              </p>
            </div>
          ))}
        </div>
      ))}
    </>
  )
}
